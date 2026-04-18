import { callActorJson, clean } from "./common.js";
import { REASON_CODES } from "../contracts/reason-codes.js";

export const STAGE_ID = "stage_02_plan";
export const STAGE_TITLE = "Research Planning";

function planUnitsFromRequest(request = {}) {
  if (request?.outputType === "matrix") {
    return (Array.isArray(request?.matrix?.attributes) ? request.matrix.attributes : []).map((attr) => ({
      unitId: attr.id,
      label: attr.label,
      brief: attr.brief,
    }));
  }
  return (Array.isArray(request?.scorecard?.dimensions) ? request.scorecard.dimensions : []).map((dim) => ({
    unitId: dim.id,
    label: dim.label,
    brief: dim.brief,
  }));
}

function normalizePlan(parsed = {}, fallbackUnits = []) {
  const byId = new Map((Array.isArray(parsed?.units) ? parsed.units : []).map((unit) => [clean(unit?.unitId), unit]));
  return {
    niche: clean(parsed?.niche),
    aliases: Array.isArray(parsed?.aliases) ? parsed.aliases.map((item) => clean(item)).filter(Boolean) : [],
    units: fallbackUnits.map((fallback) => {
      const candidate = byId.get(fallback.unitId) || {};
      const supportingQueries = Array.isArray(candidate?.supportingQueries)
        ? candidate.supportingQueries.map((item) => clean(item)).filter(Boolean)
        : [];
      const counterfactualQueries = Array.isArray(candidate?.counterfactualQueries)
        ? candidate.counterfactualQueries.map((item) => clean(item)).filter(Boolean)
        : [];
      const sourceTargets = Array.isArray(candidate?.sourceTargets)
        ? candidate.sourceTargets.map((item) => clean(item)).filter(Boolean)
        : [];

      return {
        unitId: fallback.unitId,
        supportingQueries: supportingQueries.length ? supportingQueries : [
          `${fallback.label} evidence`,
          `${fallback.label} benchmark`,
        ],
        counterfactualQueries: counterfactualQueries.length ? counterfactualQueries : [
          `${fallback.label} failure mode`,
          `${fallback.label} downside risk`,
        ],
        sourceTargets: sourceTargets.length ? sourceTargets : [
          "independent research",
          "company documentation",
          "news coverage",
        ],
        gapHypothesis: clean(candidate?.gapHypothesis),
      };
    }),
  };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const units = planUnitsFromRequest(state?.request || {});

  const prompt = `Build a research plan for this objective.\nObjective: ${clean(state?.request?.objective)}\nDecision question: ${clean(state?.request?.decisionQuestion) || "not provided"}\n\nUnits:\n${units.map((unit) => `- ${unit.unitId}: ${unit.label}`).join("\n")}\n\nReturn JSON:\n{
  "niche": "",
  "aliases": [""],
  "units": [{
    "unitId": "",
    "supportingQueries": [""],
    "counterfactualQueries": [""],
    "sourceTargets": [""],
    "gapHypothesis": ""
  }]
}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: runtime?.prompts?.analyst || "You are a research planner.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 4000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 45000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 1,
    liveSearch: false,
    schemaHint: '{"niche":"","aliases":[""],"units":[{"unitId":"","supportingQueries":[""],"counterfactualQueries":[""],"sourceTargets":[""]}]}',
  });

  const plan = normalizePlan(result?.parsed, units);
  const unresolved = plan.units.filter((unit) => !unit.supportingQueries.length || !unit.counterfactualQueries.length);
  if (unresolved.length) {
    const err = new Error("Plan did not cover all required units.");
    err.reasonCode = REASON_CODES.CRITICAL_UNITS_UNRESOLVED;
    throw err;
  }

  return {
    stageStatus: "ok",
    reasonCodes: result.reasonCodes,
    statePatch: {
      ui: { phase: STAGE_ID },
      plan,
    },
    diagnostics: {
      unitCount: plan.units.length,
      retries: result.retries,
      modelRoute: result.route,
      tokenDiagnostics: result.tokenDiagnostics,
    },
    io: {
      prompt,
      response: result.text,
    },
    modelRoute: result.route,
    tokens: result.tokenDiagnostics,
    retries: result.retries,
  };
}
