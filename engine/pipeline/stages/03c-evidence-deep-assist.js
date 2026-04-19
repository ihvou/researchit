import {
  callActorJson,
  clean,
  combineTokenDiagnostics,
  ensureArray,
  normalizeArguments,
  normalizeConfidence,
  normalizeSources,
} from "./common.js";

export const STAGE_ID = "stage_03c_evidence_deep_assist";
export const STAGE_TITLE = "Evidence Deep Assist";

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

export async function runStage(context = {}) {
  const { state, runtime } = context;
  if (clean(state?.mode).toLowerCase() !== "deep-assist") {
    return {
      stageStatus: "ok",
      reasonCodes: [],
      statePatch: { ui: { phase: STAGE_ID } },
      diagnostics: { skipped: true, reason: "native_mode" },
    };
  }

  const providers = normalizeProviders(runtime?.config || state?.config || {});
  const prompt = state?.outputType === "matrix"
    ? `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Generate full matrix evidence for all listed subject x attribute cells.
Subjects:
${ensureArray(state?.request?.matrix?.subjects).map((subject) => `- ${subject.id}: ${subject.label}`).join("\n")}
Attributes:
${ensureArray(state?.request?.matrix?.attributes).map((attribute) => `- ${attribute.id}: ${attribute.label}${clean(attribute?.brief) ? ` - ${clean(attribute.brief)}` : ""}`).join("\n")}

Rules:
- Cover every listed subject x attribute cell.
- If reliable evidence is unavailable, keep "sources" empty, use low confidence, and record the gap in "missingEvidence".

Return JSON {"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`
    : `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Generate full scorecard evidence for all listed dimensions.
Dimensions:
${ensureArray(state?.request?.scorecard?.dimensions).map((dim) => `- ${dim.id}: ${dim.label}${clean(dim?.brief) ? ` - ${clean(dim.brief)}` : ""}`).join("\n")}

Rules:
- Ground each unit in concrete, source-backed evidence.
- If reliable evidence is unavailable, keep "sources" empty and explain the gap in "missingEvidence".

Return JSON {"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;

  const tasks = providers.map(async (providerId) => {
    const override = providerOverride(runtime?.config || state?.config || {}, providerId);
    const result = await callActorJson({
      state,
      runtime,
      stageId: STAGE_ID,
      actor: "analyst",
      systemPrompt: runtime?.prompts?.analyst || "You produce independent provider drafts.",
      userPrompt: prompt,
      tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 12000,
      timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || (20 * 60 * 1000),
      maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 0,
      liveSearch: true,
      routeOverride: {
        provider: clean(override?.provider) || providerToLabel(providerId),
        model: clean(override?.model),
        webSearchModel: clean(override?.webSearchModel),
      },
      schemaHint: state?.outputType === "matrix"
        ? '{"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}'
        : '{"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
    });

    return {
      providerId,
      route: result.route,
      draft: normalizeDraftFromParsed(result?.parsed, state),
      response: result.text,
      retries: result.retries,
      tokenDiagnostics: result.tokenDiagnostics,
      reasonCodes: result.reasonCodes,
      success: true,
    };
  });

  const settled = await Promise.allSettled(tasks);
  const successes = [];
  const failures = [];
  settled.forEach((entry, idx) => {
    if (entry.status === "fulfilled") {
      successes.push(entry.value);
    } else {
      failures.push({
        providerId: providers[idx],
        error: entry.reason,
      });
    }
  });

  if (failures.length) {
    const first = failures[0]?.error || new Error("Deep Assist provider failed.");
    throw first;
  }

  const providerContributions = successes.map((item) => ({
    provider: item.providerId,
    success: true,
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
    },
    diagnostics: {
      providersRequested: providers,
      providersSucceeded: successes.map((item) => item.providerId),
      providersFailed: failures.map((item) => item.providerId),
      retries: totalRetries,
      tokenDiagnostics: aggregatedTokens,
      providerTokenBreakdown: tokenBreakdown,
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
