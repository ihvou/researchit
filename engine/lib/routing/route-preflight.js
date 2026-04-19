import { REASON_CODES } from "../../pipeline/contracts/reason-codes.js";
import { resolveActorRoute } from "./actor-resolver.js";

function clean(value) {
  return String(value || "").trim();
}

const EXPECTED_PROVIDER_BY_STAGE = {
  stage_01b_subject_discovery: "gemini",
  stage_02_plan: "openai",
  stage_03a_evidence_memory: "openai",
  stage_03b_evidence_web: "gemini",
  stage_04_merge: "openai",
  stage_05_score_confidence: "openai",
  stage_08_recover: "gemini",
  stage_09_rescore: "openai",
  stage_10_coherence: "anthropic",
  stage_11_challenge: "anthropic",
  stage_12_counter_case: "anthropic",
  stage_13_defend: "openai",
  stage_14_synthesize: "gemini",
  stage_15_finalize: "openai",
};

function assertRoute(route, expectedProvider, details = {}) {
  const provider = clean(route?.provider).toLowerCase();
  if (expectedProvider && provider !== expectedProvider) {
    const err = new Error(
      `Route mismatch: expected ${expectedProvider} for ${clean(route?.stageId)} but got ${provider || "unknown"}.`
    );
    err.reasonCode = REASON_CODES.ROUTE_MISMATCH_PREFLIGHT;
    err.details = details;
    throw err;
  }
}

function normalizeDeepAssistProviders(raw = {}) {
  const defaults = raw?.defaults && typeof raw.defaults === "object" ? raw.defaults : {};
  const list = Array.isArray(defaults.providers) ? defaults.providers : ["chatgpt", "claude", "gemini"];
  return [...new Set(list.map((value) => clean(value).toLowerCase()).filter(Boolean))];
}

export function runRoutePreflight({ state = {}, config = {} } = {}) {
  const output = {
    ok: true,
    routes: [],
    reasonCodes: [],
  };

  const stageIds = Object.keys(EXPECTED_PROVIDER_BY_STAGE);
  stageIds.forEach((stageId) => {
    const actor = stageId.startsWith("stage_10")
      || stageId.startsWith("stage_11")
      || stageId.startsWith("stage_12")
      ? "critic"
      : "analyst";
    const route = resolveActorRoute({ actor, stageId, config, mode: state?.mode });
    assertRoute(route, EXPECTED_PROVIDER_BY_STAGE[stageId], { actor, stageId });
    output.routes.push(route);
  });

  const preflightMode = clean(state?.mode).toLowerCase();
  if (preflightMode === "deep-research-x3" || preflightMode === "deep-assist") {
    const providers = normalizeDeepAssistProviders(config?.deepAssist || state?.config?.deepAssist || {});
    const required = ["chatgpt", "claude", "gemini"];
    const missing = required.filter((provider) => !providers.includes(provider));
    if (missing.length) {
      const err = new Error(`Stage 03c preflight failed; missing deep-assist providers: ${missing.join(", ")}.`);
      err.reasonCode = REASON_CODES.ROUTE_MISMATCH_PREFLIGHT;
      throw err;
    }

    required.forEach((providerId) => {
      const providerConfig = config?.deepAssist?.providers?.[providerId]?.analyst || {};
      const route = resolveActorRoute({
        actor: "analyst",
        stageId: "stage_03c_evidence_deep_assist",
        config,
        mode: state?.mode,
        override: providerConfig,
      });
      if (!clean(route?.provider) || !clean(route?.model)) {
        const err = new Error(`Stage 03c preflight failed; invalid route for provider ${providerId}.`);
        err.reasonCode = REASON_CODES.ROUTE_MISMATCH_PREFLIGHT;
        throw err;
      }
      output.routes.push({ ...route, deepAssistProvider: providerId });
    });
  }

  return output;
}
