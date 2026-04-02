import { DEFAULT_DIMS } from "../engine/configs/ai-use-case-dims.js";
import {
  SYS_ANALYST,
  SYS_CRITIC,
  SYS_ANALYST_RESPONSE,
  SYS_FOLLOWUP,
} from "../engine/prompts/defaults.js";

export const AI_USE_CASE_PRIORITIZER_CONFIG = {
  id: "ai-use-case-prioritizer",
  name: "AI Use Case Prioritizer",
  engineVersion: "1.0.0",

  dimensions: DEFAULT_DIMS,
  relatedDiscovery: true,

  prompts: {
    analyst: SYS_ANALYST,
    critic: SYS_CRITIC,
    analystResponse: SYS_ANALYST_RESPONSE,
    followUp: SYS_FOLLOWUP,
  },

  models: {
    analyst: { provider: "openai", model: "gpt-5.4-mini" },
    critic: { provider: "openai", model: "gpt-5.4" },
  },

  limits: {
    maxSourcesPerDim: 14,
    discoveryMaxCandidates: 5,
    tokenLimits: {
      phase1Evidence: 10000,
      phase1Scoring: 12000,
      critic: 6000,
      phase3Response: 6000,
      followUpQuestion: 1400,
      followUpChallenge: 2100,
      intentClassification: 450,
    },
  },
};

export default AI_USE_CASE_PRIORITIZER_CONFIG;
