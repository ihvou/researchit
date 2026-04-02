import { handleFollowUp as handleEngineFollowUp } from "@researchit/engine";
import defaultConfig from "../../../configs/ai-use-case-prioritizer.js";
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
        updateUC(ucId, () => nextState);
      },
    }
  );

  return updated;
}
