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

function chooseTransportCall(transport, actor = "analyst") {
  const key = clean(actor).toLowerCase();
  if (key === "critic") return transport.callCritic.bind(transport);
  if (key === "synthesizer") return transport.callSynthesizer.bind(transport);
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
    provider: route.provider,
    model: route.model,
    webSearchModel: route.webSearchModel,
    liveSearch: !!liveSearch,
    includeMeta: true,
    retry: { maxRetries: 0 },
    timeoutMs,
  };

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
        const err = new Error(parseErr?.message || "JSON parse failed");
        err.reasonCode = REASON_CODES.RESPONSE_PARSE_FAILED;
        throw err;
      }

      return {
        parsed,
        text,
        meta: response?.meta || null,
      };
    },
    {
      timeoutMs,
      maxRetries,
      initialBackoffMs: 300,
      backoffFactor: 2,
      onRetry: async ({ failureType }) => {
        if (failureType !== "parse") return;
        parseRepairNotice = "Previous response failed JSON parsing. Return strict JSON only. No prose, no markdown, no code fences.";
        workingPromptBody = promptSplitHalf(workingPromptBody);
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
    err.reasonCodes = normalizeReasonCodes([
      ...reasonCodes,
      ...executionCodes,
      err.reasonCode,
    ]);
    throw err;
  }

  return {
    ...execution.result,
    route,
    retries: Math.max(0, Number(execution.attemptsUsed || 1) - 1),
    durationMs: execution.durationMs,
    reasonCodes: normalizeReasonCodes(reasonCodes),
    tokenDiagnostics: {
      estimatedInput: promptPrep.estimatedTokens,
      tokenBudget,
      splitApplied: !!promptPrep.splitApplied,
      compactionApplied: reasonCodes.includes(REASON_CODES.PROMPT_COMPACTION_APPLIED),
    },
  };
}

export function compactText(value, maxLen = 1400) {
  const text = clean(value);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(64, maxLen)).trimEnd()}...`;
}

export function normalizeConfidence(value) {
  const lower = clean(value).toLowerCase();
  if (lower.startsWith("h")) return "high";
  if (lower.startsWith("m")) return "medium";
  return "low";
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
