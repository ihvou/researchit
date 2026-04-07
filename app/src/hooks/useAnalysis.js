import { runAnalysis as runEngineAnalysis } from "@researchit/engine";
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

export async function runAnalysis(desc, dims, updateUC, id, options = {}) {
  const config = mergeConfig(options?.config || defaultConfig, dims);

  let latest = null;
  await runEngineAnalysis(
    {
      id,
      description: desc,
      origin: options?.origin || null,
      options: {
        downloadDebugLog: !!options?.downloadDebugLog,
        matrixSubjects: Array.isArray(options?.matrixSubjects) ? options.matrixSubjects : [],
      },
    },
    config,
    {
      transport: appTransport,
      onProgress: (_phase, nextState) => {
        latest = nextState;
        updateUC(id, () => nextState);
      },
      onDebugSession: (session, meta = {}) => {
        storeCompletedAnalysisDebugSession(session);
        if (meta?.downloadRequested) {
          downloadAnalysisDebugSession(session);
        }
      },
    }
  );

  return latest;
}
