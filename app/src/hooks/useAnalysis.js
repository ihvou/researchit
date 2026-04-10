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
  const evidenceMode = String(options?.evidenceMode || "native").trim().toLowerCase() === "deep-assist"
    ? "deep-assist"
    : "native";
  const debugDims = String(config?.outputMode || "").trim().toLowerCase() === "matrix"
    ? (Array.isArray(config?.attributes) ? config.attributes : [])
    : (Array.isArray(config?.dimensions) ? config.dimensions : []);
  const fallbackDebugSession = createAnalysisDebugSession({
    useCaseId: id,
    analysisMode: String(config?.outputMode || "scorecard").trim().toLowerCase() === "matrix"
      ? (evidenceMode === "deep-assist" ? "matrix-deep-assist" : "matrix")
      : (evidenceMode === "deep-assist" ? "deep-assist" : "hybrid"),
    rawInput: desc,
    dims: debugDims,
  });
  appendAnalysisDebugEvent(fallbackDebugSession, {
    type: "analysis_start",
    phase: String(config?.outputMode || "scorecard").trim().toLowerCase() === "matrix"
      ? "matrix_plan"
      : (evidenceMode === "deep-assist" ? "deep_assist_collect" : "analyst_baseline"),
  });
  let debugSessionReceived = false;
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
          debugSessionReceived = true;
          storeCompletedAnalysisDebugSession(session);
          if (meta?.downloadRequested) {
            downloadAnalysisDebugSession(session);
          }
        },
      }
    );
  } catch (err) {
    caughtError = err;
    throw err;
  } finally {
    if (!debugSessionReceived) {
      const status = latest?.status || "error";
      const payload = finalizeAnalysisDebugSession(fallbackDebugSession, {
        status,
        error: status === "error"
          ? (caughtError || new Error(latest?.errorMsg || "Analysis failed before debug session was finalized."))
          : null,
        analysisMeta: latest?.analysisMeta || null,
      });
      storeCompletedAnalysisDebugSession(payload);
      if (options?.downloadDebugLog) {
        downloadAnalysisDebugSession(payload);
      }
    }
  }

  return latest;
}
