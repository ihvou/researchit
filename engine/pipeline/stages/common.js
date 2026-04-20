import { safeParseJSON } from "../../lib/json.js";
import { preparePromptWithinBudget } from "../../lib/guards/token-preflight.js";
import { executeWithRetry } from "../../lib/guards/timeout-retry.js";
import { resolveActorRoute } from "../../lib/routing/actor-resolver.js";
import { REASON_CODES, normalizeReasonCodes } from "../contracts/reason-codes.js";

export function clean(value) {
  return String(value || "").trim();
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function estimateTokensFromText(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return 0;
  return Math.max(1, Math.ceil(raw.length / 4));
}

function normalizeUsage(meta = {}) {
  const usage = meta?.usage && typeof meta.usage === "object"
    ? meta.usage
    : (meta?.tokenUsage && typeof meta.tokenUsage === "object" ? meta.tokenUsage : {});
  const inputTokens = toFiniteNumber(
    usage?.inputTokens
    ?? usage?.input_tokens
    ?? usage?.prompt_tokens
    ?? usage?.promptTokenCount,
    0
  );
  const outputTokens = toFiniteNumber(
    usage?.outputTokens
    ?? usage?.output_tokens
    ?? usage?.completion_tokens
    ?? usage?.candidatesTokenCount,
    0
  );
  const totalTokens = toFiniteNumber(
    usage?.totalTokens
    ?? usage?.total_tokens
    ?? usage?.totalTokenCount
    ?? (inputTokens + outputTokens),
    0
  );
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens || (inputTokens + outputTokens),
  };
}

function normalizeFinishReason(value = "") {
  const raw = clean(value).toLowerCase();
  if (!raw) return "unknown";
  if (["stop", "completed", "end_turn"].includes(raw)) return "stop";
  if (["length", "max_tokens", "max_output_tokens", "incomplete"].includes(raw)) return "length";
  if (["content_filter", "safety", "blocked"].includes(raw)) return "content_filter";
  if (raw.includes("tool")) return "tool_use";
  if (raw.includes("error")) return "error";
  return "unknown";
}

export function uniqBy(items = [], keyFn = (item) => item) {
  const out = [];
  const seen = new Set();
  ensureArray(items).forEach((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  });
  return out;
}

export function combineTokenDiagnostics(items = []) {
  const list = ensureArray(items).filter((item) => item && typeof item === "object");
  if (!list.length) return null;

  let estimatedInput = 0;
  let estimatedOutput = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let retries = 0;
  let tokenBudget = 0;
  let splitApplied = false;
  let compactionApplied = false;
  let webSearchCalls = 0;
  let groundedSourceCount = 0;
  let confidenceScaleCoerced = 0;
  let outputTruncatedCount = 0;
  let sawProviderUsage = false;
  let sawEstimated = false;

  list.forEach((item) => {
    estimatedInput += toFiniteNumber(item?.estimatedInput, 0);
    estimatedOutput += toFiniteNumber(item?.estimatedOutput, 0);
    inputTokens += toFiniteNumber(item?.inputTokens, 0);
    outputTokens += toFiniteNumber(item?.outputTokens, 0);
    totalTokens += toFiniteNumber(item?.totalTokens, 0);
    retries += toFiniteNumber(item?.retries, 0);
    tokenBudget += toFiniteNumber(item?.tokenBudget, 0);
    splitApplied = splitApplied || !!item?.splitApplied;
    compactionApplied = compactionApplied || !!item?.compactionApplied;
    webSearchCalls += toFiniteNumber(item?.webSearchCalls, 0);
    groundedSourceCount += toFiniteNumber(item?.groundedSourceCount, 0);
    confidenceScaleCoerced += toFiniteNumber(item?.confidenceScaleCoerced, 0);
    outputTruncatedCount += item?.outputTruncated ? 1 : 0;
    const source = clean(item?.tokenSource).toLowerCase();
    if (source === "provider_usage") sawProviderUsage = true;
    if (source === "estimated_text") sawEstimated = true;
    if (source === "mixed") {
      sawProviderUsage = true;
      sawEstimated = true;
    }
  });

  const inferredTotal = totalTokens || (inputTokens + outputTokens);
  let tokenSource = "estimated_text";
  if (sawProviderUsage && sawEstimated) tokenSource = "mixed";
  else if (sawProviderUsage) tokenSource = "provider_usage";

  return {
    estimatedInput,
    estimatedOutput,
    inputTokens,
    outputTokens,
    totalTokens: inferredTotal,
    retries,
    tokenBudget: tokenBudget || null,
    splitApplied,
    compactionApplied,
    webSearchCalls,
    groundedSourceCount,
    confidenceScaleCoerced,
    outputTruncatedCount,
    outputTruncatedRate: list.length > 0 ? outputTruncatedCount / list.length : 0,
    tokenSource,
    calls: list.length,
  };
}

function chooseTransportCall(transport, actor = "analyst") {
  const key = clean(actor).toLowerCase();
  if (key === "critic") return transport.callCritic.bind(transport);
  return transport.callAnalyst.bind(transport);
}

function promptSplitHalf(text) {
  const lines = String(text || "").split("\n");
  if (lines.length <= 1) return String(text || "").slice(0, Math.ceil(String(text || "").length / 2));
  const half = Math.ceil(lines.length / 2);
  return lines.slice(0, half).join("\n");
}

function buildPromptPayload(promptBody = "", schemaHint = "", parseRepairNotice = "") {
  const parts = [];
  if (clean(parseRepairNotice)) parts.push(clean(parseRepairNotice));
  if (clean(promptBody)) parts.push(clean(promptBody));
  if (clean(schemaHint)) parts.push(`Schema: ${clean(schemaHint)}`);
  return parts.join("\n\n");
}

export async function callActorJson({
  state,
  runtime,
  stageId,
  actor,
  systemPrompt,
  userPrompt,
  tokenBudget = 6000,
  timeoutMs = 60000,
  maxRetries = 1,
  liveSearch = false,
  deepResearch = false,
  routeOverride = {},
  schemaHint = "",
} = {}) {
  const transport = runtime?.transport;
  if (!transport) throw new Error("Missing transport in runtime.");

  const route = resolveActorRoute({
    actor,
    stageId,
    config: runtime?.config || state?.config || {},
    mode: state?.mode,
    override: routeOverride,
  });

  const reasonCodes = [];
  let workingPromptBody = clean(userPrompt);
  let parseRepairNotice = "";
  let promptPrep = preparePromptWithinBudget({
    promptText: buildPromptPayload(workingPromptBody, schemaHint, parseRepairNotice),
    tokenBudget,
    splitStrategy: promptSplitHalf,
  });
  reasonCodes.push(...(promptPrep.reasonCodes || []));
  if (!promptPrep.ok) {
    const err = new Error("Prompt compaction exhausted stage token budget.");
    err.reasonCode = REASON_CODES.PROMPT_COMPACTION_EXHAUSTED;
    throw err;
  }

  const callFn = chooseTransportCall(transport, actor);
  const payloadOptions = {
    stageId: clean(stageId),
    provider: route.provider,
    model: route.model,
    webSearchModel: route.webSearchModel,
    liveSearch: !!liveSearch,
    deepResearch: !!deepResearch,
    includeMeta: true,
    retry: { maxRetries: 0 },
    timeoutMs,
  };
  let parseFailureCount = 0;
  let parseFailureTruncationSuspected = false;

  const execution = await executeWithRetry(
    async () => {
      const response = await callFn(
        [{ role: "user", content: promptPrep.text }],
        clean(systemPrompt),
        tokenBudget,
        payloadOptions
      );
      const text = clean(response?.text || response);
      if (!text) {
        const err = new Error("Empty model response.");
        err.reasonCode = REASON_CODES.PARTIAL_PAYLOAD_REJECTED;
        throw err;
      }

      let parsed;
      try {
        parsed = safeParseJSON(text);
      } catch (parseErr) {
        const responseMeta = response?.meta && typeof response.meta === "object"
          ? response.meta
          : {};
        const usage = normalizeUsage(responseMeta);
        const finishReason = normalizeFinishReason(responseMeta?.finishReason || responseMeta?.stopReason);
        const outputTokens = Number(
          responseMeta?.outputTokens
          ?? usage?.outputTokens
          ?? 0
        ) || 0;
        const outputTokensCap = Number(responseMeta?.outputTokensCap ?? tokenBudget) || 0;
        const outputTruncated = finishReason === "length"
          || (outputTokensCap > 0 && outputTokens >= Math.floor(outputTokensCap * 0.95));
        const err = new Error(parseErr?.message || "JSON parse failed");
        err.reasonCode = REASON_CODES.RESPONSE_PARSE_FAILED;
        err.finishReason = finishReason;
        err.outputTokens = outputTokens;
        err.outputTokensCap = outputTokensCap;
        err.outputTruncated = outputTruncated;
        throw err;
      }

      return {
        parsed,
        text,
        meta: {
          ...(response?.meta && typeof response.meta === "object" ? response.meta : {}),
          groundedSources: ensureArray(response?.sources || response?.meta?.groundedSources),
        },
      };
    },
    {
      timeoutMs,
      maxRetries,
      initialBackoffMs: 300,
      backoffFactor: 2,
      onRetry: async ({ failureType, error }) => {
        if (failureType !== "parse") return;
        const truncated = !!error?.outputTruncated;
        if (truncated) {
          parseFailureTruncationSuspected = true;
          reasonCodes.push(REASON_CODES.TRUNCATION_SUSPECTED);
        }
        parseRepairNotice = truncated
          ? "Previous response appears truncated. Return strict JSON only and keep it concise. No prose, no markdown, no code fences."
          : "Previous response failed JSON parsing. Return strict JSON only. No prose, no markdown, no code fences.";
        parseFailureCount += 1;
        if (parseFailureCount >= 2) {
          workingPromptBody = promptSplitHalf(workingPromptBody);
        }
        promptPrep = preparePromptWithinBudget({
          promptText: buildPromptPayload(workingPromptBody, schemaHint, parseRepairNotice),
          tokenBudget,
          splitStrategy: promptSplitHalf,
        });
        reasonCodes.push(...(promptPrep.reasonCodes || []));
        if (!promptPrep.ok) {
          const err = new Error("Prompt compaction exhausted stage token budget after parse-repair.");
          err.reasonCode = REASON_CODES.PROMPT_COMPACTION_EXHAUSTED;
          throw err;
        }
      },
    }
  );

  if (!execution.ok) {
    const err = execution.error || new Error("Stage actor call failed.");
    const executionCodes = execution.reasonCodes || [];
    if (err?.abortReason && typeof err.abortReason === "object") {
      err.abortReason = {
        source: clean(err.abortReason?.source) || "unknown",
        layer: clean(err.abortReason?.layer) || undefined,
        deadlineMs: Number.isFinite(Number(err.abortReason?.deadlineMs)) ? Number(err.abortReason.deadlineMs) : undefined,
        elapsedMs: Number.isFinite(Number(err.abortReason?.elapsedMs)) ? Number(err.abortReason.elapsedMs) : undefined,
      };
    }
    err.reasonCodes = normalizeReasonCodes([
      ...reasonCodes,
      ...executionCodes,
      err.reasonCode,
    ]);
    throw err;
  }

  const estimatedInput = toFiniteNumber(promptPrep.estimatedTokens, 0);
  const estimatedOutput = estimateTokensFromText(execution?.result?.text || "");
  const usage = normalizeUsage(execution?.result?.meta || {});
  const meta = execution?.result?.meta && typeof execution.result.meta === "object"
    ? execution.result.meta
    : {};
  const finishReason = normalizeFinishReason(meta?.finishReason || meta?.stopReason);
  const outputTokensCap = toFiniteNumber(meta?.outputTokensCap, tokenBudget);

  let inputTokens = usage?.inputTokens ?? estimatedInput;
  let outputTokens = usage?.outputTokens ?? estimatedOutput;
  let totalTokens = usage?.totalTokens ?? (inputTokens + outputTokens);

  if (usage?.totalTokens != null && usage.inputTokens != null && usage.outputTokens == null) {
    outputTokens = Math.max(0, usage.totalTokens - inputTokens);
  }
  if (usage?.totalTokens != null && usage.outputTokens != null && usage.inputTokens == null) {
    inputTokens = Math.max(0, usage.totalTokens - outputTokens);
  }
  if (!totalTokens) totalTokens = inputTokens + outputTokens;
  const outputTruncated = finishReason === "length"
    || (outputTokensCap > 0 && Number(outputTokens || 0) >= Math.floor(outputTokensCap * 0.95));
  if (parseFailureTruncationSuspected) {
    reasonCodes.push(REASON_CODES.TRUNCATION_SUSPECTED);
  }

  return {
    ...execution.result,
    route,
    retries: Math.max(0, Number(execution.attemptsUsed || 1) - 1),
    durationMs: execution.durationMs,
    reasonCodes: normalizeReasonCodes(reasonCodes),
    tokenDiagnostics: {
      estimatedInput,
      estimatedOutput,
      inputTokens: toFiniteNumber(inputTokens, 0),
      outputTokens: toFiniteNumber(outputTokens, 0),
      totalTokens: toFiniteNumber(totalTokens, 0),
      tokenBudget,
      splitApplied: !!promptPrep.splitApplied,
      compactionApplied: reasonCodes.includes(REASON_CODES.PROMPT_COMPACTION_APPLIED),
      tokenSource: usage ? "provider_usage" : "estimated_text",
      usage,
      provider: clean(meta?.providerId || route.provider).toLowerCase(),
      model: clean(meta?.model || route.model),
      webSearchCalls: toFiniteNumber(meta?.webSearchCalls, 0),
      groundedSourceCount: groundedSourceCount(meta?.groundedSources),
      liveSearchUsed: !!meta?.liveSearchUsed,
      finishReason,
      outputTokensCap: toFiniteNumber(outputTokensCap, 0),
      outputTruncated,
    },
  };
}

export function compactText(value, maxLen = 1400) {
  const text = clean(value);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(64, maxLen)).trimEnd()}...`;
}

export function normalizeConfidence(value, stats = null) {
  const raw = value;
  const lower = clean(raw).toLowerCase();
  if (lower.startsWith("h")) return "high";
  if (lower.startsWith("m")) return "medium";
  if (lower.startsWith("l")) return "low";

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (typeof raw === "number" || /^[+-]?\d+(\.\d+)?$/.test(String(raw || "").trim())) {
      if (stats && typeof stats === "object") {
        stats.coerced = Number(stats.coerced || 0) + 1;
      }
      if (numeric <= 2) return "low";
      if (numeric >= 4) return "high";
      return "medium";
    }
  }
  return "low";
}

export function normalizeConfidenceSource(value) {
  const lower = clean(value).toLowerCase();
  if (lower === "verification_penalty") return "verification_penalty";
  return "model";
}

export function normalizeCitationStatus(value) {
  const lower = clean(value).toLowerCase();
  if (lower === "verified") return "verified";
  if (lower === "unverifiable") return "unverifiable";
  return "not_found";
}

export function normalizeSource(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const name = clean(raw?.name || raw?.title || raw?.source || "");
  const url = clean(raw?.url || raw?.link || "");
  const quote = clean(raw?.quote || raw?.snippet || "");
  if (!name && !url && !quote) return null;
  return {
    name: name || "Unknown source",
    url: url || undefined,
    quote: quote || undefined,
    sourceType: clean(raw?.sourceType || raw?.type || "").toLowerCase() || undefined,
    provider: clean(raw?.provider || "") || undefined,
    verificationStatus: clean(raw?.verificationStatus || "") || undefined,
    verificationTier: clean(raw?.verificationTier || "") || undefined,
    citationStatus: normalizeCitationStatus(raw?.citationStatus),
    groundedByProvider: raw?.groundedByProvider === true,
    groundedSetAvailable: raw?.groundedSetAvailable === true,
    displayStatus: clean(raw?.displayStatus || "") || undefined,
    publishedYear: Number.isFinite(Number(raw?.publishedYear)) ? Number(raw.publishedYear) : null,
  };
}

export function normalizeSources(items = []) {
  const normalized = ensureArray(items)
    .map((item) => normalizeSource(item))
    .filter(Boolean);
  return uniqBy(normalized, (source) => `${source.name}|${source.url || ""}|${source.quote || ""}`);
}

export function normalizeArguments(raw = {}, fallbackPrefix = "arg") {
  const toList = (items, side) => ensureArray(items).map((item, idx) => ({
    id: clean(item?.id) || `${fallbackPrefix}-${side}-${idx + 1}`,
    claim: clean(item?.claim || item?.point || ""),
    detail: clean(item?.detail || item?.explanation || "") || undefined,
    side,
    sources: normalizeSources(item?.sources || []),
  })).filter((item) => item.claim);

  return {
    supporting: toList(raw?.supporting || raw?.pros || [], "supporting"),
    limiting: toList(raw?.limiting || raw?.cons || [], "limiting"),
  };
}

export function summarizeSourceUniverse(units = []) {
  const allSources = uniqBy(
    ensureArray(units).flatMap((unit) => normalizeSources(unit?.sources || [])),
    (source) => `${source.name}|${source.url || ""}|${source.quote || ""}`
  );

  const summary = {
    cited: 0,
    corroborating: 0,
    unverified: 0,
    excludedMarketing: 0,
    excludedStale: 0,
  };

  allSources.forEach((source) => {
    const status = clean(source?.displayStatus).toLowerCase();
    if (status === "cited") summary.cited += 1;
    else if (status === "corroborating") summary.corroborating += 1;
    else if (status === "excluded_marketing") summary.excludedMarketing += 1;
    else if (status === "excluded_stale") summary.excludedStale += 1;
    else summary.unverified += 1;
  });

  summary.total = Object.values(summary).reduce((acc, value) => acc + Number(value || 0), 0);
  return summary;
}

export function normalizeUrlForCompare(value = "") {
  const raw = clean(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const host = clean(url.hostname).toLowerCase();
    const pathname = clean(url.pathname).replace(/\/+$/, "") || "/";
    const search = clean(url.search);
    return `${host}${pathname}${search}`;
  } catch {
    return clean(raw).toLowerCase().replace(/\/+$/, "");
  }
}

export function groundedSourceCount(value = []) {
  return ensureArray(value).filter((item) => clean(item?.url)).length;
}

export function buildGroundedSourceSet(items = []) {
  return new Set(
    ensureArray(items)
      .map((item) => normalizeUrlForCompare(item?.url || item))
      .filter(Boolean)
  );
}

export function annotateSourcesWithGrounding(sources = [], groundedSources = []) {
  const groundedSet = buildGroundedSourceSet(groundedSources);
  const groundedSetAvailable = groundedSet.size > 0;
  const annotated = normalizeSources(sources).map((source) => {
    const normalizedUrl = normalizeUrlForCompare(source?.url);
    const groundedByProvider = groundedSetAvailable && !!normalizedUrl && groundedSet.has(normalizedUrl);
    return {
      ...source,
      groundedByProvider,
      groundedSetAvailable,
    };
  });
  return {
    sources: annotated,
    groundedSetAvailable,
    groundedCount: annotated.filter((source) => source?.groundedByProvider).length,
  };
}

export function fabricationSignalFromSources(sources = [], { liveSearchUsed = false, groundedSourceCount: count = 0 } = {}) {
  const normalized = normalizeSources(sources);
  if (!normalized.length) return "low";
  const considered = normalized.filter((source) => clean(source?.url));
  if (!considered.length) return liveSearchUsed ? "medium" : "low";
  const grounded = considered.filter((source) => source?.groundedByProvider === true).length;
  if (!liveSearchUsed || count <= 0) return grounded ? "low" : "medium";
  if (grounded === considered.length) return "low";
  if (grounded === 0) return "high";
  return "medium";
}
