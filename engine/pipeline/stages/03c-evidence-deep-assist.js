import {
  callActorJson,
  clean,
  combineTokenDiagnostics,
  ensureArray,
  normalizeArguments,
  normalizeConfidence,
  normalizeSources,
} from "./common.js";
import { normalizeReasonCodes } from "../contracts/reason-codes.js";

export const STAGE_ID = "stage_03c_evidence_deep_assist";
export const STAGE_TITLE = "Evidence Deep Research x3";

function normalizeProviders(config = {}) {
  const defaults = config?.deepAssist?.defaults && typeof config.deepAssist.defaults === "object"
    ? config.deepAssist.defaults
    : {};
  const providers = Array.isArray(defaults.providers) ? defaults.providers : ["chatgpt", "claude", "gemini"];
  return [...new Set(providers.map((provider) => clean(provider).toLowerCase()).filter(Boolean))];
}

function normalizeDraftFromParsed(parsed = {}, state = {}) {
  if (state?.outputType === "matrix") {
    const subjects = ensureArray(state?.request?.matrix?.subjects);
    const attributes = ensureArray(state?.request?.matrix?.attributes);
    const byKey = new Map(ensureArray(parsed?.cells).map((cell) => [`${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`, cell]));
    const cells = [];
    subjects.forEach((subject) => {
      attributes.forEach((attribute) => {
        const raw = byKey.get(`${subject.id}::${attribute.id}`) || {};
        cells.push({
          subjectId: subject.id,
          attributeId: attribute.id,
          value: clean(raw?.value),
          full: clean(raw?.full),
          confidence: normalizeConfidence(raw?.confidence),
          confidenceReason: clean(raw?.confidenceReason),
          sources: normalizeSources(raw?.sources || []),
          arguments: normalizeArguments(raw?.arguments || {}, `${subject.id}-${attribute.id}-da`),
          risks: clean(raw?.risks),
          missingEvidence: clean(raw?.missingEvidence),
        });
      });
    });
    return { matrix: { cells } };
  }

  const dimensions = ensureArray(state?.request?.scorecard?.dimensions);
  const byId = new Map(ensureArray(parsed?.dimensions).map((unit) => [clean(unit?.id || unit?.unitId), unit]));
  const rows = dimensions.map((dim) => {
    const raw = byId.get(dim.id) || {};
    return {
      id: dim.id,
      brief: clean(raw?.brief),
      full: clean(raw?.full),
      confidence: normalizeConfidence(raw?.confidence),
      confidenceReason: clean(raw?.confidenceReason),
      sources: normalizeSources(raw?.sources || []),
      arguments: normalizeArguments(raw?.arguments || {}, `${dim.id}-da`),
      risks: clean(raw?.risks),
      missingEvidence: clean(raw?.missingEvidence),
    };
  });
  return { scorecard: { dimensions: rows } };
}

function providerOverride(config = {}, providerId = "") {
  const value = clean(providerId).toLowerCase();
  return config?.deepAssist?.providers?.[value]?.analyst || {};
}

function providerToLabel(providerId = "") {
  const key = clean(providerId).toLowerCase();
  if (key === "chatgpt") return "openai";
  if (key === "claude") return "anthropic";
  if (key === "gemini") return "gemini";
  return key;
}

function pruneEmptyObject(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  Object.entries(value).forEach(([key, item]) => {
    if (item == null) return;
    if (typeof item === "object" && !Array.isArray(item) && !Object.keys(item).length) return;
    out[key] = item;
  });
  return Object.keys(out).length ? out : null;
}

function buildPlanContext(plan = {}, unitIds = []) {
  const units = ensureArray(plan?.units).filter((u) => !unitIds.length || unitIds.includes(clean(u?.unitId)));
  if (!units.length) return "";
  const niche = clean(plan?.niche);
  const lines = ["Research plan context (use as directional guidance, not a constraint):"];
  if (niche) lines.push(`Niche: ${niche}`);
  units.forEach((u) => {
    const unitId = clean(u?.unitId);
    if (!unitId) return;
    const angles = [
      ...ensureArray(u?.supportingQueries).slice(0, 2).map((q) => clean(q)),
      ...ensureArray(u?.counterfactualQueries).slice(0, 1).map((q) => clean(q)),
    ].filter(Boolean);
    const targets = ensureArray(u?.sourceTargets).slice(0, 3).map((t) => clean(t)).filter(Boolean);
    const gap = clean(u?.gapHypothesis);
    lines.push(`- ${unitId}:`);
    if (gap) lines.push(`  gap hypothesis: ${gap}`);
    if (angles.length) lines.push(`  research angles: ${angles.join(" | ")}`);
    if (targets.length) lines.push(`  preferred sources: ${targets.join(", ")}`);
  });
  return lines.join("\n");
}

function normalizeProviderSuccess(item = {}, state = {}) {
  if (!item || typeof item !== "object") return null;
  const providerId = clean(item?.providerId).toLowerCase();
  if (!providerId) return null;
  const route = item?.route && typeof item.route === "object" ? item.route : null;
  const draft = item?.draft && typeof item.draft === "object"
    ? item.draft
    : normalizeDraftFromParsed(item?.parsed || {}, state);
  return {
    providerId,
    route,
    draft,
    response: clean(item?.response),
    retries: Number(item?.retries || 0),
    tokenDiagnostics: item?.tokenDiagnostics && typeof item.tokenDiagnostics === "object"
      ? item.tokenDiagnostics
      : null,
    providerDiagnostics: item?.providerDiagnostics && typeof item.providerDiagnostics === "object"
      ? item.providerDiagnostics
      : null,
    reasonCodes: ensureArray(item?.reasonCodes),
    success: true,
  };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const mode = clean(state?.mode).toLowerCase();
  if (mode !== "deep-research-x3" && mode !== "deep-assist") {
    return {
      stageStatus: "ok",
      reasonCodes: [],
      statePatch: { ui: { phase: STAGE_ID } },
      diagnostics: { skipped: true, reason: "native_mode" },
    };
  }

  const providers = normalizeProviders(runtime?.config || state?.config || {});
  const plan = state?.plan || {};
  const priorProviderRuns = ensureArray(state?.evidenceDrafts?.deepAssist?.providers)
    .map((item) => normalizeProviderSuccess(item, state))
    .filter(Boolean);
  const priorByProvider = new Map(priorProviderRuns.map((item) => [item.providerId, item]));
  const providersToRun = providers.filter((providerId) => !priorByProvider.has(providerId));

  const prompt = state?.outputType === "matrix"
    ? (() => {
      const attrIds = ensureArray(state?.request?.matrix?.attributes).map((a) => clean(a?.id));
      const planContext = buildPlanContext(plan, attrIds);
      return `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
${planContext ? `\n${planContext}\n` : ""}
Generate full matrix evidence for all listed subject x attribute cells. Use web search to find real, current, source-backed evidence.
Subjects:
${ensureArray(state?.request?.matrix?.subjects).map((subject) => `- ${subject.id}: ${subject.label}`).join("\n")}
Attributes:
${ensureArray(state?.request?.matrix?.attributes).map((attribute) => `- ${attribute.id}: ${attribute.label}${clean(attribute?.brief) ? ` - ${clean(attribute.brief)}` : ""}`).join("\n")}

Rules:
- Cover every listed subject x attribute cell.
- Cite real named sources with URLs wherever possible; prefer independent, third-party sources.
- For each non-empty source, include a valid https URL, concise quote/snippet, and "sourceType".
- sourceType must be one of: independent, research, news, analyst, government, registry, vendor, press_release, marketing.
- If reliable evidence is unavailable after searching, keep "sources" empty, use low confidence, and record the gap in "missingEvidence".

Return JSON {"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;
    })()
    : (() => {
      const dimIds = ensureArray(state?.request?.scorecard?.dimensions).map((d) => clean(d?.id));
      const planContext = buildPlanContext(plan, dimIds);
      return `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
${planContext ? `\n${planContext}\n` : ""}
Generate full scorecard evidence for all listed dimensions. Use web search to find real, current, source-backed evidence.
Dimensions:
${ensureArray(state?.request?.scorecard?.dimensions).map((dim) => `- ${dim.id}: ${dim.label}${clean(dim?.brief) ? ` - ${clean(dim.brief)}` : ""}`).join("\n")}

Rules:
- Ground each unit in concrete, source-backed evidence with real named sources and URLs.
- Prefer independent, third-party sources; flag vendor claims appropriately.
- For each non-empty source, include a valid https URL, concise quote/snippet, and "sourceType".
- sourceType must be one of: independent, research, news, analyst, government, registry, vendor, press_release, marketing.
- If reliable evidence is unavailable after searching, keep "sources" empty and explain the gap in "missingEvidence".

Return JSON {"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;
    })();

  const tasks = providersToRun.map(async (providerId) => {
    const override = providerOverride(runtime?.config || state?.config || {}, providerId);
    const result = await callActorJson({
      state,
      runtime,
      stageId: STAGE_ID,
      actor: "analyst",
      systemPrompt: runtime?.prompts?.analystDeepResearch || runtime?.prompts?.analyst || "You are a senior research analyst conducting independent deep research. Use your web search capability to find comprehensive, current, authoritative evidence.",
      userPrompt: prompt,
      // Deep research responses are comprehensive — 32k gives adequate room.
      tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 32000,
      timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || (20 * 60 * 1000),
      maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 0,
      liveSearch: true,
      deepResearch: true,
      routeOverride: {
        provider: clean(override?.provider) || providerToLabel(providerId),
        model: clean(override?.model),
        webSearchModel: clean(override?.webSearchModel),
      },
      schemaHint: state?.outputType === "matrix"
        ? '{"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}'
        : '{"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
      callContext: {
        chunkId: providerId,
        promptVersion: "v1",
      },
    });

    return {
      providerId,
      route: result.route,
      draft: normalizeDraftFromParsed(result?.parsed, state),
      response: result.text,
      retries: result.retries,
      tokenDiagnostics: result.tokenDiagnostics,
      providerDiagnostics: pruneEmptyObject({
        openaiDeepResearch: result?.meta?.openaiDeepResearch,
        geminiDeepResearch: result?.meta?.geminiDeepResearch,
        deepResearchParity: result?.meta?.deepResearchParity,
        rawResponseKey: result?.meta?.rawResponseKey,
      }),
      reasonCodes: result.reasonCodes,
      success: true,
    };
  });

  const settled = await Promise.allSettled(tasks);
  const successes = [...priorProviderRuns];
  const failures = [];
  settled.forEach((entry, idx) => {
    if (entry.status === "fulfilled") {
      const normalized = normalizeProviderSuccess(entry.value, state);
      if (normalized) successes.push(normalized);
    } else {
      failures.push({
        providerId: providersToRun[idx],
        error: entry.reason,
      });
    }
  });

  if (failures.length) {
    const first = failures[0]?.error instanceof Error
      ? failures[0].error
      : new Error("Deep Research x3 provider failed.");
    const partialProviderContributions = providers.map((providerId) => ({
      provider: providerId,
      success: successes.some((item) => clean(item?.providerId) === clean(providerId)),
      durationMs: 0,
    }));
    first.statePatch = {
      ui: { phase: STAGE_ID },
      evidenceDrafts: {
        deepAssist: {
          providers: successes,
        },
      },
      evidence: {
        providerContributions: partialProviderContributions,
      },
    };
    first.io = {
      prompt,
      providerResponses: successes.map((item) => ({ provider: item.providerId, response: item.response })),
      providerFailures: failures.map((item) => ({ provider: item.providerId, error: String(item?.error?.message || item?.error || "") })),
    };
    first.reasonCodes = normalizeReasonCodes([
      ...(Array.isArray(first?.reasonCodes) ? first.reasonCodes : []),
    ]);
    throw first;
  }

  const providerContributions = providers.map((providerId) => ({
    provider: providerId,
    success: successes.some((item) => clean(item?.providerId) === clean(providerId)),
    durationMs: 0,
  }));
  const tokenBreakdown = successes.map((item) => ({
    provider: clean(item?.route?.provider) || providerToLabel(item?.providerId),
    model: clean(item?.route?.model),
    retries: Number(item?.retries || 0),
    ...item.tokenDiagnostics,
  }));
  const aggregatedTokens = combineTokenDiagnostics(tokenBreakdown);
  if (aggregatedTokens) {
    aggregatedTokens.breakdown = tokenBreakdown;
  }
  const totalRetries = successes.reduce((sum, item) => sum + Number(item?.retries || 0), 0);
  const providerDiagnostics = {};
  successes.forEach((item) => {
    if (item?.providerDiagnostics && typeof item.providerDiagnostics === "object") {
      providerDiagnostics[item.providerId] = item.providerDiagnostics;
    }
  });
  const openaiDiagnostics = providerDiagnostics.chatgpt?.openaiDeepResearch
    || providerDiagnostics.openai?.openaiDeepResearch
    || null;
  const geminiDiagnostics = providerDiagnostics.gemini?.geminiDeepResearch || null;
  const geminiParity = providerDiagnostics.gemini?.deepResearchParity || null;
  const deepResearchParity = pruneEmptyObject({
    openaiBackgroundUsed: !!openaiDiagnostics?.requestBackground,
    openaiFinalStatus: openaiDiagnostics?.finalStatus,
    geminiAgent: geminiDiagnostics?.agent,
    geminiCapabilities: geminiParity?.geminiCapabilities || geminiDiagnostics?.capabilitiesEnabled,
  });

  return {
    stageStatus: "ok",
    reasonCodes: [],
    statePatch: {
      ui: { phase: STAGE_ID },
      evidenceDrafts: {
        deepAssist: {
          providers: successes,
        },
      },
      evidence: {
        providerContributions,
      },
      analysisMeta: {
        deepResearchParity,
      },
    },
    diagnostics: {
      providersRequested: providers,
      providersSucceeded: successes.map((item) => item.providerId),
      providersFailed: failures.map((item) => item.providerId),
      retries: totalRetries,
      tokenDiagnostics: aggregatedTokens,
      providerTokenBreakdown: tokenBreakdown,
      providerDiagnostics,
      deepResearchParity,
    },
    io: {
      prompt,
      providerResponses: successes.map((item) => ({ provider: item.providerId, response: item.response })),
      providerFailures: failures.map((item) => ({ provider: item.providerId, error: String(item?.error?.message || item?.error || "") })),
    },
    tokens: aggregatedTokens,
    retries: totalRetries,
  };
}
