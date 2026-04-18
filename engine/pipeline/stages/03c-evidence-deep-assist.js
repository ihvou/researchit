import {
  callActorJson,
  clean,
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

function minProviders(config = {}) {
  const raw = Number(config?.deepAssist?.defaults?.minProviders);
  if (!Number.isFinite(raw) || raw <= 0) return 2;
  return Math.max(1, Math.floor(raw));
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
    ? `Objective: ${clean(state?.request?.objective)}\nGenerate full matrix evidence for all subject x attribute cells. Return JSON {"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":""}]}`
    : `Objective: ${clean(state?.request?.objective)}\nGenerate full scorecard evidence for all dimensions. Return JSON {"dimensions":[{"id":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":""}]}`;

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
        ? '{"cells":[{"subjectId":"","attributeId":"","value":"","sources":[]}]}'
        : '{"dimensions":[{"id":"","brief":"","sources":[]}]}',
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

  const minRequired = minProviders(runtime?.config || state?.config || {});
  if (failures.length && (state?.strictQuality || successes.length < minRequired)) {
    const first = failures[0]?.error || new Error("Deep Assist provider failed.");
    throw first;
  }

  const providerContributions = successes.map((item) => ({
    provider: item.providerId,
    success: true,
    durationMs: 0,
  }));

  return {
    stageStatus: failures.length ? "recovered" : "ok",
    reasonCodes: failures.length ? ["deep_assist_partial_provider_failure"] : [],
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
    },
    io: {
      prompt,
      providerResponses: successes.map((item) => ({ provider: item.providerId, response: item.response })),
      providerFailures: failures.map((item) => ({ provider: item.providerId, error: String(item?.error?.message || item?.error || "") })),
    },
  };
}
