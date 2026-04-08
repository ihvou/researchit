import { handleFollowUp as handleEngineFollowUp } from "@researchit/engine";
import defaultConfig from "../../../configs/research-configurations.js";
import { appTransport } from "../lib/api";

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

export async function handleFollowUp(ucId, dimId, challenge, dims, ucRef, updateUC, options = {}) {
  const uc = ucRef.current.find((u) => u.id === ucId);
  if (!uc) throw new Error(`Use case not found: ${ucId}`);

  const config = mergeConfig(options?.config || defaultConfig, dims);

  const updated = await handleEngineFollowUp(
    {
      ucId,
      dimId,
      challenge,
      ucState: uc,
      options,
    },
    config,
    {
      transport: appTransport,
      onProgress: (_phase, nextState) => {
        updateUC(ucId, (prevState) => mergeProgressState(prevState, nextState, config));
      },
    }
  );

  return updated;
}
