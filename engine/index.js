export { runAnalysis } from "./pipeline/analysis.js";
export { reprocessStage } from "./pipeline/analysis.js";
export { handleFollowUp } from "./pipeline/followUp.js";
export { runMatrixAnalysis, resolveMatrixResearchInput } from "./pipeline/matrix.js";

export { createTransport } from "./lib/transport.js";
export { callOpenAI } from "./providers/openai.js";

export { DEFAULT_DIMS } from "./configs/researchit-dimensions.js";

export * from "./lib/json.js";
export * from "./lib/arguments.js";
export * from "./lib/followUpIntent.js";
export * from "./lib/dimensionView.js";
export * from "./lib/scoring.js";
export * from "./lib/confidence.js";
export * from "./lib/rubric.js";
export * from "./lib/researchBrief.js";
export * from "./lib/debug.js";
export * from "./lib/transport.js";
export * from "./lib/serialize.js";

export {
  SYS_ANALYST,
  SYS_CRITIC,
  SYS_ANALYST_RESPONSE,
  SYS_RED_TEAM,
  SYS_FOLLOWUP,
} from "./prompts/defaults.js";
