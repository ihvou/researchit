import {
  runAnalysis as runEngineAnalysis,
  createAnalysisDebugSession,
  appendAnalysisDebugEvent,
  finalizeAnalysisDebugSession,
} from "@researchit/engine";
import defaultConfig from "../../../configs/research-configurations.js";
import { appTransport } from "../lib/api";
import {
  storeCompletedAnalysisDebugSession,
  downloadAnalysisDebugSession,
  startRunDebugCapture,
  stopRunDebugCapture,
} from "../lib/debugUI";

function mergeConfig(baseConfig, dims) {
  return {
    ...baseConfig,
    dimensions: Array.isArray(dims) && dims.length ? dims : baseConfig.dimensions,
    prompts: {
      ...(baseConfig.prompts || {}),
    },
    limits: {
      ...(baseConfig.limits || {}),
      tokenLimits: {
        ...(baseConfig.limits?.tokenLimits || {}),
      },
    },
  };
}

function mergeProgressState(prevState = {}, nextState = {}, config = null) {
  return {
    ...prevState,
    ...nextState,
    researchConfigId: nextState?.researchConfigId || prevState?.researchConfigId || config?.id || null,
    researchConfigName: nextState?.researchConfigName || prevState?.researchConfigName || config?.name || null,
    rawInput: nextState?.rawInput || prevState?.rawInput || "",
    outputMode: nextState?.outputMode || prevState?.outputMode || String(config?.outputMode || "").trim().toLowerCase() || null,
    origin: nextState?.origin ?? prevState?.origin ?? null,
  };
}

export async function runAnalysis(desc, dims, updateUC, id, options = {}) {
  const config = mergeConfig(options?.config || defaultConfig, dims);
  const rawEvMode = String(options?.evidenceMode || "native").trim().toLowerCase();
  const evidenceMode = (rawEvMode === "deep-research-x3" || rawEvMode === "deep-assist")
    ? "deep-research-x3"
    : "native";
  const resolvedAnalysisMode = String(config?.outputMode || "scorecard").trim().toLowerCase() === "matrix"
    ? (evidenceMode === "deep-research-x3" ? "matrix-deep-assist" : "matrix")
    : (evidenceMode === "deep-research-x3" ? "deep-assist" : "hybrid");
  const debugDims = String(config?.outputMode || "").trim().toLowerCase() === "matrix"
    ? (Array.isArray(config?.attributes) ? config.attributes : [])
    : (Array.isArray(config?.dimensions) ? config.dimensions : []);
  startRunDebugCapture({
    useCaseId: id,
    analysisMode: resolvedAnalysisMode,
    rawInput: desc,
  });
  const fallbackDebugSession = createAnalysisDebugSession({
    useCaseId: id,
    analysisMode: resolvedAnalysisMode,
    rawInput: desc,
    dims: debugDims,
  });
  appendAnalysisDebugEvent(fallbackDebugSession, {
    type: "analysis_start",
    phase: String(config?.outputMode || "scorecard").trim().toLowerCase() === "matrix"
      ? "matrix_plan"
      : (evidenceMode === "deep-research-x3" ? "deep_assist_collect" : "analyst_baseline"),
  });
  let debugSessionFinalized = false;
  let caughtError = null;

  let latest = null;
  try {
    await runEngineAnalysis(
      {
        id,
        description: desc,
        origin: options?.origin || null,
        initialState: options?.initialState || null,
        options: {
          downloadDebugLog: !!options?.downloadDebugLog,
          matrixSubjects: Array.isArray(options?.matrixSubjects) ? options.matrixSubjects : [],
          researchSetup: options?.researchSetup || null,
          evidenceMode: options?.evidenceMode || "native",
          deepAssist: options?.deepAssist || null,
          strictQuality: !!options?.strictQuality,
        },
      },
      config,
      {
        transport: appTransport,
        onProgress: (phase, nextState) => {
          appendAnalysisDebugEvent(fallbackDebugSession, {
            type: "phase_update",
            phase: String(phase || ""),
            status: String(nextState?.status || ""),
          });
          updateUC(id, (prevState) => {
            const merged = mergeProgressState(prevState, nextState, config);
            latest = merged;
            return merged;
          });
        },
        onDebugSession: (session, meta = {}) => {
          const isIncremental = meta?.incremental === true && meta?.final !== true;
          if (isIncremental) {
            storeCompletedAnalysisDebugSession(session);
            return;
          }
          debugSessionFinalized = true;
          const networkCapture = stopRunDebugCapture(id);
          storeCompletedAnalysisDebugSession(session, { networkCapture });
          if (meta?.downloadRequested) {
            downloadAnalysisDebugSession(session, { networkCapture });
          }
        },
      }
    );
  } catch (err) {
    caughtError = err;
    throw err;
  } finally {
    if (!debugSessionFinalized) {
      const status = latest?.status || "error";
      const networkCapture = stopRunDebugCapture(id);
      const payload = finalizeAnalysisDebugSession(fallbackDebugSession, {
        status,
        error: status === "error"
          ? (caughtError || new Error(latest?.errorMsg || "Analysis failed before debug session was finalized."))
          : null,
        analysisMeta: latest?.analysisMeta || null,
      });
      storeCompletedAnalysisDebugSession(payload, { networkCapture });
      if (options?.downloadDebugLog) {
        downloadAnalysisDebugSession(payload, { networkCapture });
      }
    }
  }

  return latest;
}
