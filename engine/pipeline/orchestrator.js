import {
  createRunState,
  toUseCaseState,
} from "./contracts/run-state.js";
import { REASON_CODES, normalizeReasonCodes } from "./contracts/reason-codes.js";
import { runRoutePreflight } from "../lib/routing/route-preflight.js";
import {
  createStageRecord,
  completeStageRecord,
  appendStageRecord,
  updateStageRecord,
  appendIoRecord,
  appendProgressRecord,
  pushReasonCodes,
  finalizeStageDiagnostics,
} from "../lib/diagnostics/stage-logger.js";
import { buildDebugBundle } from "../lib/diagnostics/debug-bundle.js";
import { estimateStageCost } from "../lib/diagnostics/cost-estimator.js";
import { hashCanonicalValue } from "../lib/cache/stage-hash.js";

import { runStage as run01, STAGE_ID as STAGE_01_ID, STAGE_TITLE as STAGE_01_TITLE } from "./stages/01-intake.js";
import { runStage as run01b, STAGE_ID as STAGE_01B_ID, STAGE_TITLE as STAGE_01B_TITLE } from "./stages/01b-subject-discovery.js";
import { runStage as run02, STAGE_ID as STAGE_02_ID, STAGE_TITLE as STAGE_02_TITLE } from "./stages/02-plan.js";
import {
  runStage as run03a,
  STAGE_ID as STAGE_03A_ID,
  STAGE_TITLE as STAGE_03A_TITLE,
  PROMPT_VERSION as STAGE_03A_PROMPT_VERSION,
} from "./stages/03a-evidence-memory.js";
import {
  runStage as run03b,
  STAGE_ID as STAGE_03B_ID,
  STAGE_TITLE as STAGE_03B_TITLE,
  PROMPT_VERSION as STAGE_03B_PROMPT_VERSION,
} from "./stages/03b-evidence-web.js";
import { runStage as run03c, STAGE_ID as STAGE_03C_ID, STAGE_TITLE as STAGE_03C_TITLE } from "./stages/03c-evidence-deep-assist.js";
import { runStage as run04, STAGE_ID as STAGE_04_ID, STAGE_TITLE as STAGE_04_TITLE } from "./stages/04-merge.js";
import { runStage as run05, STAGE_ID as STAGE_05_ID, STAGE_TITLE as STAGE_05_TITLE } from "./stages/05-score-confidence.js";
import { runStage as run06, STAGE_ID as STAGE_06_ID, STAGE_TITLE as STAGE_06_TITLE } from "./stages/06-source-verify.js";
import { runStage as run07, STAGE_ID as STAGE_07_ID, STAGE_TITLE as STAGE_07_TITLE } from "./stages/07-source-assess.js";
import {
  runStage as run08,
  STAGE_ID as STAGE_08_ID,
  STAGE_TITLE as STAGE_08_TITLE,
  PROMPT_VERSION as STAGE_08_PROMPT_VERSION,
} from "./stages/08-recover.js";
import { runStage as run09, STAGE_ID as STAGE_09_ID, STAGE_TITLE as STAGE_09_TITLE } from "./stages/09-rescore.js";
import { runStage as run10, STAGE_ID as STAGE_10_ID, STAGE_TITLE as STAGE_10_TITLE } from "./stages/10-coherence.js";
import { runStage as run11, STAGE_ID as STAGE_11_ID, STAGE_TITLE as STAGE_11_TITLE } from "./stages/11-challenge.js";
import { runStage as run12, STAGE_ID as STAGE_12_ID, STAGE_TITLE as STAGE_12_TITLE } from "./stages/12-counter.js";
import { runStage as run13, STAGE_ID as STAGE_13_ID, STAGE_TITLE as STAGE_13_TITLE } from "./stages/13-defend.js";
import { runStage as run14, STAGE_ID as STAGE_14_ID, STAGE_TITLE as STAGE_14_TITLE } from "./stages/14-synthesize.js";
import { runStage as run15, STAGE_ID as STAGE_15_ID, STAGE_TITLE as STAGE_15_TITLE } from "./stages/15-finalize.js";

function clean(value) {
  return String(value || "").trim();
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (!isPlainObject(base)) return patch;
  if (!isPlainObject(patch)) return patch;

  const out = { ...base };
  Object.keys(patch).forEach((key) => {
    const next = patch[key];
    const current = out[key];
    if (Array.isArray(next)) {
      out[key] = next;
      return;
    }
    if (isPlainObject(next) && isPlainObject(current)) {
      out[key] = deepMerge(current, next);
      return;
    }
    out[key] = next;
  });
  return out;
}

function applyStatePatch(state = {}, patch = {}) {
  if (!isPlainObject(patch)) return state;
  const next = { ...state };
  Object.keys(patch).forEach((key) => {
    if (isPlainObject(patch[key]) && isPlainObject(next[key])) {
      next[key] = deepMerge(next[key], patch[key]);
    } else {
      next[key] = patch[key];
    }
  });
  return next;
}

const STAGE_BUDGETS = {
  [STAGE_01B_ID]: { timeoutMs: 60000, retryMax: 1, tokenBudget: 4000 },
  [STAGE_02_ID]: { timeoutMs: 90000, retryMax: 1, tokenBudget: 3000 },
  [STAGE_03A_ID]: { timeoutMs: 180000, retryMax: 2, tokenBudget: 24000 },
  [STAGE_03B_ID]: { timeoutMs: 150000, retryMax: 2, tokenBudget: 28000 },
  [STAGE_03C_ID]: { timeoutMs: 20 * 60 * 1000, retryMax: 0, tokenBudget: 12000 },
  [STAGE_04_ID]: { timeoutMs: 45000, retryMax: 1, tokenBudget: 6000 },
  [STAGE_05_ID]: { timeoutMs: 60000, retryMax: 1, tokenBudget: 8000 },
  [STAGE_06_ID]: { timeoutMs: 60000, retryMax: 0, tokenBudget: 0 },
  [STAGE_07_ID]: { timeoutMs: 15000, retryMax: 0, tokenBudget: 0 },
  [STAGE_08_ID]: { timeoutMs: 90000, retryMax: 2, tokenBudget: 16000 },
  [STAGE_09_ID]: { timeoutMs: 60000, retryMax: 1, tokenBudget: 6000 },
  [STAGE_10_ID]: { timeoutMs: 75000, retryMax: 1, tokenBudget: 8000 },
  [STAGE_11_ID]: { timeoutMs: 75000, retryMax: 1, tokenBudget: 8000 },
  [STAGE_12_ID]: { timeoutMs: 90000, retryMax: 1, tokenBudget: 8000 },
  [STAGE_13_ID]: { timeoutMs: 75000, retryMax: 1, tokenBudget: 8000 },
  [STAGE_14_ID]: { timeoutMs: 60000, retryMax: 1, tokenBudget: 6000 },
  [STAGE_15_ID]: { timeoutMs: 45000, retryMax: 1, tokenBudget: 4000 },
};

const STAGES = [
  { id: STAGE_01_ID, title: STAGE_01_TITLE, run: run01, optional: false, promptVersion: "v1" },
  { id: STAGE_01B_ID, title: STAGE_01B_TITLE, run: run01b, optional: true, promptVersion: "v1" },
  { id: STAGE_02_ID, title: STAGE_02_TITLE, run: run02, optional: false, promptVersion: "v1" },
  { id: STAGE_03A_ID, title: STAGE_03A_TITLE, run: run03a, optional: false, mode: "native", promptVersion: STAGE_03A_PROMPT_VERSION || "v1" },
  { id: STAGE_03B_ID, title: STAGE_03B_TITLE, run: run03b, optional: false, mode: "native", promptVersion: STAGE_03B_PROMPT_VERSION || "v1" },
  { id: STAGE_03C_ID, title: STAGE_03C_TITLE, run: run03c, optional: false, mode: "deep-research-x3", promptVersion: "v1" },
  { id: STAGE_04_ID, title: STAGE_04_TITLE, run: run04, optional: false, promptVersion: "v1" },
  { id: STAGE_05_ID, title: STAGE_05_TITLE, run: run05, optional: false, promptVersion: "v1" },
  { id: STAGE_06_ID, title: STAGE_06_TITLE, run: run06, optional: false, promptVersion: "v1" },
  { id: STAGE_07_ID, title: STAGE_07_TITLE, run: run07, optional: false, promptVersion: "v1" },
  { id: STAGE_08_ID, title: STAGE_08_TITLE, run: run08, optional: false, promptVersion: STAGE_08_PROMPT_VERSION || "v1" },
  { id: STAGE_09_ID, title: STAGE_09_TITLE, run: run09, optional: false, promptVersion: "v1" },
  { id: STAGE_10_ID, title: STAGE_10_TITLE, run: run10, optional: false, promptVersion: "v1" },
  { id: STAGE_11_ID, title: STAGE_11_TITLE, run: run11, optional: false, promptVersion: "v1" },
  { id: STAGE_12_ID, title: STAGE_12_TITLE, run: run12, optional: false, promptVersion: "v1" },
  { id: STAGE_13_ID, title: STAGE_13_TITLE, run: run13, optional: false, promptVersion: "v1" },
  { id: STAGE_14_ID, title: STAGE_14_TITLE, run: run14, optional: false, promptVersion: "v1" },
  { id: STAGE_15_ID, title: STAGE_15_TITLE, run: run15, optional: false, promptVersion: "v1" },
];

function stageEnabled(stage = {}, state = {}) {
  if (!stage?.mode) return true;
  if (stage.mode === "native") return clean(state?.mode).toLowerCase() === "native";
  if (stage.mode === "deep-research-x3") {
    const m = clean(state?.mode).toLowerCase();
    return m === "deep-research-x3" || m === "deep-assist";
  }
  return true;
}

function shouldAbortOnError(state = {}, reasonCodes = [], stage = {}) {
  const codes = normalizeReasonCodes(reasonCodes);
  const strict = !!state?.strictQuality;
  if (strict) return true;
  if (!stage?.optional) return true;

  const hardAbortInNonStrict = new Set([
    REASON_CODES.ROUTE_MISMATCH_PREFLIGHT,
    REASON_CODES.RESPONSE_PARSE_FAILED,
    REASON_CODES.COVERAGE_CATASTROPHIC,
  ]);
  return codes.some((code) => hardAbortInNonStrict.has(code));
}

function emitProgress(state, callbacks = {}) {
  const onProgress = typeof callbacks?.onProgress === "function" ? callbacks.onProgress : null;
  if (!onProgress) return;
  const uiState = toUseCaseState(state);
  onProgress(uiState.phase, uiState);
}

function emitDebugSnapshot(state, callbacks = {}, extras = {}, meta = {}) {
  const onDebugSession = typeof callbacks?.onDebugSession === "function" ? callbacks.onDebugSession : null;
  if (!onDebugSession) return;
  const debugBundle = buildDebugBundle(state, extras);
  onDebugSession(debugBundle, {
    incremental: meta?.incremental === true,
    final: meta?.final === true,
    downloadRequested: !!meta?.downloadRequested,
  });
}

function appendRoutingDiagnostics(state = {}, routes = []) {
  state.diagnostics.routing = Array.isArray(routes) ? routes : [];
  return state;
}

function appendQualityReasonCodes(state = {}, reasonCodes = []) {
  const merged = normalizeReasonCodes([
    ...(Array.isArray(state?.quality?.reasonCodes) ? state.quality.reasonCodes : []),
    ...(Array.isArray(reasonCodes) ? reasonCodes : []),
  ]);
  state.quality = {
    ...(state.quality || {}),
    reasonCodes: merged,
  };
  return state;
}

function appendCostDiagnostics(state = {}, stageRecord = {}) {
  if (!state?.diagnostics || typeof state.diagnostics !== "object") return state;
  const stageId = clean(stageRecord?.stage);
  const stageCost = stageRecord?.cost && typeof stageRecord.cost === "object"
    ? stageRecord.cost
    : null;
  if (!stageId || !stageCost) return state;

  const current = state.diagnostics.cost && typeof state.diagnostics.cost === "object"
    ? state.diagnostics.cost
    : {};

  const estimatedByStage = current.estimatedByStage && typeof current.estimatedByStage === "object"
    ? { ...current.estimatedByStage }
    : {};
  const stageCostByStage = current.stageCostByStage && typeof current.stageCostByStage === "object"
    ? { ...current.stageCostByStage }
    : {};
  const estimatedByProvider = current.estimatedByProvider && typeof current.estimatedByProvider === "object"
    ? { ...current.estimatedByProvider }
    : {};

  estimatedByStage[stageId] = Number(stageCost?.estimatedCostUsd || 0);
  stageCostByStage[stageId] = stageCost;

  const registerProviderCost = (providerKey, amount) => {
    const provider = clean(providerKey).toLowerCase() || "unknown";
    const currentAmount = Number(estimatedByProvider[provider] || 0);
    estimatedByProvider[provider] = currentAmount + Number(amount || 0);
  };

  if (Array.isArray(stageCost?.breakdown) && stageCost.breakdown.length) {
    stageCost.breakdown.forEach((entry) => {
      registerProviderCost(entry?.provider, entry?.estimatedCostUsd);
    });
  } else if (stageCost?.provider) {
    registerProviderCost(stageCost.provider, stageCost.estimatedCostUsd);
  }

  const totalEstimated = Object.values(estimatedByStage).reduce(
    (sum, value) => sum + Number(value || 0),
    0
  );

  state.diagnostics.cost = {
    currency: clean(stageCost?.currency) || clean(current?.currency) || "USD",
    pricingVersion: clean(current?.pricingVersion) || "v1",
    estimatedByStage,
    stageCostByStage,
    estimatedByProvider,
    totalEstimated,
  };
  return state;
}

function enforceStrictReasonCodeInvariant(state = {}, reasonCodes = []) {
  const normalized = normalizeReasonCodes(reasonCodes);
  if (!state?.strictQuality) return normalized;
  return normalized.filter((code) => code !== REASON_CODES.RUN_COMPLETED_DEGRADED);
}

function toIdList(items = [], key = "id") {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => clean(item?.[key]))
    .filter(Boolean);
}

function stageCacheDisabled(runtime = {}) {
  if (runtime?.stageCacheDisabled === true) return true;
  const envValue = String(
    runtime?.config?.cache?.disabled
    ?? globalThis?.RESEARCHIT_STAGE_CACHE_DISABLED
    ?? (typeof process !== "undefined" ? process?.env?.RESEARCHIT_STAGE_CACHE_DISABLED : "")
    ?? ""
  ).trim().toLowerCase();
  return envValue === "1" || envValue === "true" || envValue === "yes";
}

function buildStageHashInputs({ state = {}, stage = {}, upstreamHash = "" } = {}) {
  const isMatrix = state?.outputType === "matrix";
  const subjects = isMatrix ? toIdList(state?.request?.matrix?.subjects, "id") : [];
  const attributes = isMatrix ? toIdList(state?.request?.matrix?.attributes, "id") : [];
  const dimensions = !isMatrix ? toIdList(state?.request?.scorecard?.dimensions, "id") : [];
  return {
    stageId: clean(stage?.id),
    configId: clean(state?.request?.researchConfigId || state?.config?.id),
    promptVersion: clean(stage?.promptVersion || "v1"),
    outputType: clean(state?.outputType),
    mode: clean(state?.mode),
    subjects,
    attributes,
    dimensions,
    modelRouteConfig: state?.config?.models || {},
    globalSeed: clean(state?.runId),
    upstreamHash: clean(upstreamHash || "seed"),
  };
}

function toSerializableStageResult(result = {}) {
  return {
    stageStatus: clean(result?.stageStatus || "ok"),
    reasonCodes: normalizeReasonCodes(result?.reasonCodes || []),
    statePatch: result?.statePatch && typeof result.statePatch === "object" ? result.statePatch : {},
    diagnostics: result?.diagnostics && typeof result.diagnostics === "object" ? result.diagnostics : {},
    modelRoute: result?.modelRoute || null,
    tokens: result?.tokens || null,
    retries: Number(result?.retries || 0),
    io: result?.io && typeof result.io === "object" ? result.io : null,
  };
}

function ensureCacheDiagnosticsContainer(state = {}) {
  if (!state?.diagnostics || typeof state.diagnostics !== "object") return {};
  const existing = state.diagnostics.cacheDiagnostics && typeof state.diagnostics.cacheDiagnostics === "object"
    ? state.diagnostics.cacheDiagnostics
    : null;
  if (existing) return existing;
  state.diagnostics.cacheDiagnostics = {
    totalHits: 0,
    totalMisses: 0,
    totalBytes: 0,
    stagesCached: [],
    stagesMissed: [],
  };
  return state.diagnostics.cacheDiagnostics;
}

function appendCacheAggregate(state = {}, stageId = "", cacheDiagnostics = {}, bytes = 0) {
  const aggregate = ensureCacheDiagnosticsContainer(state);
  if (!aggregate || typeof aggregate !== "object") return;
  const id = clean(stageId);
  if (cacheDiagnostics?.cacheHit) {
    aggregate.totalHits = Number(aggregate.totalHits || 0) + 1;
    aggregate.stagesCached = [...new Set([...(aggregate.stagesCached || []), id])];
  } else {
    aggregate.totalMisses = Number(aggregate.totalMisses || 0) + 1;
    aggregate.stagesMissed = [...new Set([...(aggregate.stagesMissed || []), id])];
  }
  aggregate.totalBytes = Number(aggregate.totalBytes || 0) + Math.max(0, Number(bytes) || 0);
}

export async function runCanonicalPipeline(input, config, callbacks = {}) {
  const transport = callbacks?.transport;
  if (!transport?.callAnalyst || !transport?.callCritic) {
    throw new Error("runCanonicalPipeline requires transport with analyst and critic calls.");
  }

  let state = createRunState({ input, config, runId: input?.id });
  state = applyStatePatch(state, {
    ui: {
      status: "analyzing",
      phase: STAGE_01_ID,
    },
  });

  const runtime = {
    transport,
    config,
    stageCache: callbacks?.stageCache || null,
    stageCacheDisabled: callbacks?.stageCacheDisabled === true,
    prompts: {
      analyst: config?.prompts?.analyst,
      critic: config?.prompts?.critic,
      analystResponse: config?.prompts?.analystResponse,
      analystSynthesis: config?.prompts?.analystSynthesis || config?.prompts?.synthesizer,
      followUp: config?.prompts?.followUp,
    },
    budgets: STAGE_BUDGETS,
  };

  appendProgressRecord(state, {
    stageId: STAGE_01_ID,
    title: STAGE_01_TITLE,
    status: "started",
  });
  emitProgress(state, callbacks);

  try {
    const preflight = runRoutePreflight({ state, config });
    appendRoutingDiagnostics(state, preflight.routes);
  } catch (err) {
    const reasonCode = clean(err?.reasonCode) || REASON_CODES.ROUTE_MISMATCH_PREFLIGHT;
    appendQualityReasonCodes(state, [reasonCode, REASON_CODES.RUN_ABORTED_STRICT_QUALITY]);
    state = applyStatePatch(state, {
      ui: {
        status: "error",
        phase: STAGE_01_ID,
        errorMsg: clean(err?.message) || "Route preflight failed.",
      },
    });
    pushReasonCodes(state, [reasonCode, REASON_CODES.RUN_ABORTED_STRICT_QUALITY]);

    emitDebugSnapshot(state, callbacks, { status: "error", error: err }, {
      final: true,
      downloadRequested: !!input?.options?.downloadDebugLog,
    });
    emitProgress(state, callbacks);
    throw err;
  }

  let pipelineError = null;
  let upstreamHash = hashCanonicalValue({
    runId: state?.runId,
    seed: "pipeline_start",
  });

  for (const stage of STAGES) {
    if (!stageEnabled(stage, state)) continue;

    const stageRecord = createStageRecord(stage.id, { title: stage.title });
    appendStageRecord(state, stageRecord);
    appendProgressRecord(state, {
      stageId: stage.id,
      title: stage.title,
      status: "started",
    });
    state = applyStatePatch(state, {
      ui: { phase: stage.id },
    });
    emitProgress(state, callbacks);
    emitDebugSnapshot(state, callbacks, { status: state?.ui?.status || "analyzing" }, {
      incremental: true,
    });

    try {
      const stageHashInputs = buildStageHashInputs({
        state,
        stage,
        upstreamHash,
      });
      const cacheHash = hashCanonicalValue(stageHashInputs);
      const cacheEnabled = !stageCacheDisabled(runtime) && runtime?.stageCache
        && typeof runtime.stageCache.get === "function";
      const skipSubjectDiscovery = stage.id === STAGE_01B_ID
        && state?.outputType === "matrix"
        && Array.isArray(state?.request?.matrix?.subjects)
        && state.request.matrix.subjects.length > 0
        && !state?.discovery?.autoDiscoverSubjects;

      let cacheDiagnostics = {
        cacheKey: clean(stage?.id),
        hash: cacheHash,
        cacheHit: false,
        cacheAgeMs: 0,
        hashInputs: stageHashInputs,
        missReason: cacheEnabled ? "no_entry" : "cache_disabled",
      };
      let result;
      let fromCache = false;
      let cacheBytes = 0;

      if (skipSubjectDiscovery) {
        result = {
          stageStatus: "ok",
          reasonCodes: [],
          statePatch: {
            ui: { phase: stage.id },
            discovery: {
              ...(state?.discovery || {}),
              autoDiscoverSubjects: false,
              usedSubjectDiscovery: false,
            },
          },
          diagnostics: {
            skipped: true,
            reason: "subjects_provided",
            subjectCount: state?.request?.matrix?.subjects?.length || 0,
          },
          retries: 0,
          tokens: null,
          modelRoute: null,
        };
      } else if (cacheEnabled) {
        try {
          const entry = await runtime.stageCache.get({
            runId: state?.runId,
            stageId: stage.id,
            hashInputs: stageHashInputs,
          });
          if (entry && typeof entry === "object") {
            cacheDiagnostics = {
              cacheKey: clean(entry?.cacheKey || stage.id),
              hash: clean(entry?.hash || cacheHash),
              cacheHit: entry?.cacheHit === true,
              cacheAgeMs: Number(entry?.cacheAgeMs || 0),
              hashInputs: stageHashInputs,
              missReason: clean(entry?.missReason) || (entry?.cacheHit ? null : "no_entry"),
            };
            if (entry?.cacheHit && entry?.output && typeof entry.output === "object") {
              result = entry.output;
              fromCache = true;
              cacheBytes = JSON.stringify(entry.output).length;
            }
          }
        } catch (cacheErr) {
          cacheDiagnostics = {
            cacheKey: clean(stage.id),
            hash: cacheHash,
            cacheHit: false,
            cacheAgeMs: 0,
            hashInputs: stageHashInputs,
            missReason: "cache_unavailable",
            error: clean(cacheErr?.message),
          };
        }
      }

      if (!result) {
        result = await stage.run({ state, runtime, callbacks });
      }

      const reasonCodes = enforceStrictReasonCodeInvariant(state, [
        ...(result?.reasonCodes || []),
        ...(fromCache ? [REASON_CODES.CACHE_HIT] : []),
      ]);
      const statePatch = result?.statePatch && typeof result.statePatch === "object"
        ? result.statePatch
        : {};

      state = applyStatePatch(state, statePatch);
      state = applyStatePatch(state, {
        ui: { phase: stage.id },
      });
      appendQualityReasonCodes(state, reasonCodes);
      pushReasonCodes(state, reasonCodes);

      if (result?.io) appendIoRecord(state, { stageId: stage.id, ...result.io });

      if (!fromCache && cacheEnabled && typeof runtime.stageCache?.set === "function") {
        try {
          const serializable = toSerializableStageResult(result);
          cacheBytes = JSON.stringify(serializable).length;
          await runtime.stageCache.set({
            runId: state?.runId,
            stageId: stage.id,
            hashInputs: stageHashInputs,
            output: serializable,
          });
        } catch (cacheErr) {
          cacheDiagnostics = {
            ...cacheDiagnostics,
            missReason: cacheDiagnostics?.missReason || "cache_write_failed",
            error: clean(cacheErr?.message),
          };
        }
      }

      const stageDiagnostics = finalizeStageDiagnostics({
        ...(result?.diagnostics && typeof result.diagnostics === "object" ? result.diagnostics : {}),
        cacheDiagnostics,
      });

      const completedRecord = completeStageRecord(stageRecord, {
        status: fromCache ? "cached" : (result?.stageStatus || "ok"),
        reasonCodes,
        retries: Number(result?.retries || 0),
        modelRoute: result?.modelRoute || stageRecord.modelRoute,
        tokens: result?.tokens || null,
        diagnostics: stageDiagnostics,
      });
      completedRecord.cost = estimateStageCost({
        tokens: completedRecord.tokens,
        modelRoute: completedRecord.modelRoute,
        config: runtime?.config || state?.config || {},
      });
      updateStageRecord(state, completedRecord);
      appendCostDiagnostics(state, completedRecord);
      appendCacheAggregate(state, stage.id, cacheDiagnostics, cacheBytes);

      appendProgressRecord(state, {
        stageId: stage.id,
        title: stage.title,
        status: fromCache ? "cached" : (result?.stageStatus || "ok"),
        reasonCodes,
      });
      upstreamHash = hashCanonicalValue({
        stage: stage.id,
        reasonCodes,
        statePatch,
        tokens: result?.tokens || null,
      });

      emitProgress(state, callbacks);
      emitDebugSnapshot(state, callbacks, { status: state?.ui?.status || "analyzing" }, {
        incremental: true,
      });
    } catch (err) {
      pipelineError = err;
      const reasonCodes = enforceStrictReasonCodeInvariant(state, [
        ...(Array.isArray(err?.reasonCodes) ? err.reasonCodes : []),
        clean(err?.reasonCode),
      ]);

      const completedRecord = completeStageRecord(stageRecord, {
        status: "failed",
        reasonCodes,
        retries: Number(err?.attempts || 0),
        diagnostics: finalizeStageDiagnostics({
          error: clean(err?.message),
          abortReason: err?.abortReason || null,
          finishReason: clean(err?.finishReason) || undefined,
          outputTokens: Number(err?.outputTokens || 0) || undefined,
          outputTokensCap: Number(err?.outputTokensCap || 0) || undefined,
          outputTruncated: err?.outputTruncated === true,
        }),
      });
      updateStageRecord(state, completedRecord);
      appendCostDiagnostics(state, completedRecord);
      appendQualityReasonCodes(state, reasonCodes);
      pushReasonCodes(state, reasonCodes);
      appendProgressRecord(state, {
        stageId: stage.id,
        title: stage.title,
        status: "failed",
        reasonCodes,
      });

      const abort = shouldAbortOnError(state, reasonCodes, stage);
      if (abort) {
        const failureCodes = state?.strictQuality
          ? normalizeReasonCodes([...reasonCodes, REASON_CODES.RUN_ABORTED_STRICT_QUALITY])
          : reasonCodes;

        appendQualityReasonCodes(state, failureCodes);
        pushReasonCodes(state, failureCodes);

        state = applyStatePatch(state, {
          ui: {
            status: "error",
            phase: stage.id,
            errorMsg: clean(err?.message) || `Stage failed: ${stage.id}`,
          },
        });
        emitProgress(state, callbacks);
        emitDebugSnapshot(state, callbacks, { status: "error", error: err }, {
          incremental: true,
        });
        break;
      }

      state = applyStatePatch(state, {
        ui: { phase: stage.id },
      });
      emitProgress(state, callbacks);
      emitDebugSnapshot(state, callbacks, { status: state?.ui?.status || "analyzing", error: err }, {
        incremental: true,
      });
    }
  }

  if (state?.ui?.status !== "error" && clean(state?.ui?.status) !== "complete") {
    state = applyStatePatch(state, {
      ui: {
        status: "complete",
        phase: STAGE_15_ID,
      },
    });
  }

  state.diagnostics.run.finishedAt = new Date().toISOString();
  emitDebugSnapshot(state, callbacks, {
    status: state?.ui?.status,
    error: pipelineError,
  }, {
    final: true,
    incremental: false,
    downloadRequested: !!input?.options?.downloadDebugLog,
  });

  const output = toUseCaseState(state);
  emitProgress(state, callbacks);

  if (state?.ui?.status === "error") {
    const error = pipelineError || new Error(state?.ui?.errorMsg || "Pipeline failed.");
    error.reasonCodes = normalizeReasonCodes(state?.quality?.reasonCodes || []);
    throw error;
  }

  return output;
}
