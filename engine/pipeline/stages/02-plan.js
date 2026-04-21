import { callActorJson, clean, combineTokenDiagnostics, ensureArray } from "./common.js";
import { REASON_CODES, normalizeReasonCodes } from "../contracts/reason-codes.js";

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
    plannerReturnedUnitIds: rawUnitIds,
    discardedUnknownUnitIds,
    discardedCellLevelUnitIds,
    discardedUnitsCount: discardedUnknownUnitIds.length,
  };
}

function missingUnitIds(plannerUnitIds = [], fallbackUnits = []) {
  const expected = new Set(ensureArray(fallbackUnits).map((unit) => clean(unit?.unitId)).filter(Boolean));
  const returned = new Set(ensureArray(plannerUnitIds).map((id) => clean(id)).filter(Boolean));
  return [...expected].filter((id) => !returned.has(id));
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

  const expectedUnitCount = units.length;
  const stageBudget = runtime?.budgets?.[STAGE_ID] || {};
  const callPlanner = async (userPrompt) => callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: plannerSystemPrompt,
    userPrompt,
    tokenBudget: stageBudget?.tokenBudget || 4000,
    timeoutMs: stageBudget?.timeoutMs || 45000,
    maxRetries: stageBudget?.retryMax || 1,
    liveSearch: false,
    schemaHint: '{"niche":"","aliases":[""],"units":[{"unitId":"","supportingQueries":[""],"counterfactualQueries":[""],"sourceTargets":[""]}]}',
  });

  const firstResult = await callPlanner(prompt);
  const firstDiag = summarizePlanInputDiagnostics(firstResult?.parsed, units, state?.outputType);
  const firstCount = Number(firstDiag?.plannerReturnedUnits || 0);
  const firstMissing = missingUnitIds(firstDiag?.plannerReturnedUnitIds, units);
  const truncationSuspected = firstResult?.tokenDiagnostics?.parseFailureTruncationSuspected === true;
  const mismatch = firstCount !== expectedUnitCount;

  let finalResult = firstResult;
  let finalDiag = firstDiag;
  const stageReasonCodes = [
    ...ensureArray(firstResult?.reasonCodes),
    ...(truncationSuspected ? [REASON_CODES.PLAN_TRUNCATION_RETRIED] : []),
  ];
  const tokenDiagnosticsList = [firstResult?.tokenDiagnostics];
  let secondCount = null;
  let secondMissing = [];
  let retries = Number(firstResult?.retries || 0);

  if (truncationSuspected || mismatch) {
    const retryPrompt = `${prompt}

Retry requirements (strict):
- Return exactly ${expectedUnitCount} unit entries.
- Unit ids must match this exact set: ${units.map((unit) => unit.unitId).join(", ")}.
- Missing from previous response: ${firstMissing.length ? firstMissing.join(", ") : "none"}.
- Do not omit any unit.`;

    const secondResult = await callPlanner(retryPrompt);
    finalResult = secondResult;
    finalDiag = summarizePlanInputDiagnostics(secondResult?.parsed, units, state?.outputType);
    secondCount = Number(finalDiag?.plannerReturnedUnits || 0);
    secondMissing = missingUnitIds(finalDiag?.plannerReturnedUnitIds, units);
    stageReasonCodes.push(...ensureArray(secondResult?.reasonCodes));
    tokenDiagnosticsList.push(secondResult?.tokenDiagnostics);
    retries += Number(secondResult?.retries || 0);

    if (secondCount !== expectedUnitCount) {
      const err = new Error(`Planner unit count mismatch: expected ${expectedUnitCount}, got ${secondCount}.`);
      err.reasonCode = REASON_CODES.PLAN_UNIT_COUNT_MISMATCH;
      err.reasonCodes = normalizeReasonCodes([
        ...stageReasonCodes,
        REASON_CODES.PLAN_UNIT_COUNT_MISMATCH,
        REASON_CODES.PIPELINE_STRUCTURAL_FAILURE,
      ]);
      err.planUnitCountMismatch = {
        expected: expectedUnitCount,
        returned: secondCount,
        missingUnitIds: secondMissing,
        firstAttemptCount: firstCount,
        secondAttemptCount: secondCount,
      };
      throw err;
    }
  }

  const planInputDiagnostics = {
    ...finalDiag,
    expectedUnitCount,
    firstAttemptUnitCount: firstCount,
    secondAttemptUnitCount: secondCount,
    firstAttemptMissingUnitIds: firstMissing,
    secondAttemptMissingUnitIds: secondMissing,
    truncationRetryTriggered: truncationSuspected,
  };
  const plan = normalizePlan(finalResult?.parsed, units);
  const unresolved = plan.units.filter((unit) => !unit.supportingQueries.length || !unit.counterfactualQueries.length);
  if (unresolved.length) {
    const err = new Error("Plan did not cover all required units.");
    err.reasonCode = REASON_CODES.CRITICAL_UNITS_UNRESOLVED;
    throw err;
  }

  return {
    stageStatus: "ok",
    reasonCodes: normalizeReasonCodes(stageReasonCodes),
    statePatch: {
      ui: { phase: STAGE_ID },
      plan,
    },
    diagnostics: {
      unitCount: plan.units.length,
      retries,
      modelRoute: finalResult.route,
      tokenDiagnostics: combineTokenDiagnostics(tokenDiagnosticsList),
      ...planInputDiagnostics,
    },
    io: {
      prompt,
      response: finalResult.text,
    },
    modelRoute: finalResult.route,
    tokens: combineTokenDiagnostics(tokenDiagnosticsList),
    retries,
  };
}
