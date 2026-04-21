import { runCanonicalPipeline, reprocessStage } from "./orchestrator.js";
import { runMatrixAnalysis } from "./matrix.js";

function clean(value) {
  return String(value || "").trim();
}

export async function runAnalysis(input, config, callbacks = {}) {
  const transport = callbacks?.transport;
  if (!transport?.callAnalyst || !transport?.callCritic) {
    throw new Error("runAnalysis requires callbacks.transport with callAnalyst/callCritic.");
  }

  const outputMode = clean(config?.outputMode).toLowerCase() === "matrix" ? "matrix" : "scorecard";
  if (outputMode === "matrix") {
    return runMatrixAnalysis(input, config, callbacks);
  }

  return runCanonicalPipeline(input, {
    ...(config || {}),
    outputMode: "scorecard",
  }, callbacks);
}

export { reprocessStage };
