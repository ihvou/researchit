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
      researchHints: attr?.researchHints || null,
    }));
  }
  return (Array.isArray(request?.scorecard?.dimensions) ? request.scorecard.dimensions : []).map((dim) => ({
    unitId: dim.id,
    label: dim.label,
    brief: dim.brief,
    researchHints: dim?.researchHints || null,
  }));
}

function normalizePlan(parsed = {}, fallbackUnits = []) {
  const byId = new Map();
  (Array.isArray(parsed?.units) ? parsed.units : []).forEach((unit) => {
    const key = clean(unit?.unitId || unit?.id);
    if (key) byId.set(key, unit);
  });
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

function formatUnitContext(units = []) {
  if (!units.length) return "- none";
  return units.map((unit) => {
    const whereToLook = Array.isArray(unit?.researchHints?.whereToLook)
      ? unit.researchHints.whereToLook.map((item) => clean(item)).filter(Boolean).slice(0, 6)
      : [];
    const queryTemplates = Array.isArray(unit?.researchHints?.queryTemplates)
      ? unit.researchHints.queryTemplates.map((item) => clean(item)).filter(Boolean).slice(0, 6)
      : [];

    const lines = [
      `- ${unit.unitId}: ${unit.label}`,
      `  brief: ${clean(unit?.brief) || "not provided"}`,
    ];
    if (whereToLook.length) lines.push(`  whereToLook: ${whereToLook.join(" | ")}`);
    if (queryTemplates.length) lines.push(`  queryTemplates: ${queryTemplates.join(" | ")}`);
    return lines.join("\n");
  }).join("\n");
}

function summarizePlanInputDiagnostics(parsed = {}, fallbackUnits = [], outputType = "scorecard") {
  const expectedUnitIds = new Set(fallbackUnits.map((unit) => clean(unit?.unitId)).filter(Boolean));
  const rawUnitIds = (Array.isArray(parsed?.units) ? parsed.units : [])
    .map((unit) => clean(unit?.unitId || unit?.id))
    .filter(Boolean);
  const discardedUnknownUnitIds = [...new Set(rawUnitIds.filter((id) => !expectedUnitIds.has(id)))];
  const discardedCellLevelUnitIds = outputType === "matrix"
    ? discardedUnknownUnitIds.filter((id) => id.includes("::"))
    : [];

  return {
    plannerReturnedUnits: rawUnitIds.length,
    discardedUnknownUnitIds,
    discardedCellLevelUnitIds,
    discardedUnitsCount: discardedUnknownUnitIds.length,
  };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const units = planUnitsFromRequest(state?.request || {});
  const plannerSystemPrompt = runtime?.prompts?.planner
    || "You are a strategic research planner. Return concise, strict JSON only.";

  const prompt = `Build a research plan for this objective.
Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Output mode: ${state?.outputType === "matrix" ? "matrix (attribute-level planning only)" : "scorecard"}

Units (plan at unit level only; never matrix cell level):
${formatUnitContext(units)}

Rules:
- For matrix mode, each "unitId" MUST be an attribute id only. Never return "subject::attribute" ids.
- Generate concrete supporting and counterfactual search queries tailored to each unit brief.
- Use "sourceTargets" to list source classes most likely to produce decision-grade evidence.
- "gapHypothesis" must state why this unit may end up weak or disputed and what evidence could close the gap.

Return JSON:
{
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
    systemPrompt: plannerSystemPrompt,
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 4000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 45000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 1,
    liveSearch: false,
    schemaHint: '{"niche":"","aliases":[""],"units":[{"unitId":"","supportingQueries":[""],"counterfactualQueries":[""],"sourceTargets":[""]}]}',
  });

  const planInputDiagnostics = summarizePlanInputDiagnostics(result?.parsed, units, state?.outputType);
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
      ...planInputDiagnostics,
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
