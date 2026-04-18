import { callActorJson, clean, ensureArray } from "./common.js";

export const STAGE_ID = "stage_10_coherence";
export const STAGE_TITLE = "Coherence";

function buildSummaryInput(state = {}) {
  if (state?.outputType === "matrix") {
    const cells = ensureArray(state?.assessment?.matrix?.cells);
    return cells.slice(0, 120).map((cell) => ({
      unitKey: `${cell.subjectId}::${cell.attributeId}`,
      value: clean(cell?.value),
      confidence: clean(cell?.confidence),
      confidenceReason: clean(cell?.confidenceReason),
    }));
  }
  const byId = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? state.assessment.scorecard.byId
    : {};
  return Object.values(byId).map((unit) => ({
    unitKey: clean(unit?.id),
    value: clean(unit?.brief || unit?.full),
    confidence: clean(unit?.confidence),
    confidenceReason: clean(unit?.confidenceReason),
  }));
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const summary = buildSummaryInput(state);
  const prompt = `Review cross-unit coherence for this assessment and flag contradictions.
Return JSON:
{
  "findings": [{"unitKey":"", "note":"", "severity":"high|medium|low"}],
  "overallFeedback": ""
}
Assessment snapshot:
${JSON.stringify(summary).slice(0, 26000)}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "critic",
    systemPrompt: runtime?.prompts?.critic || "You check coherence and contradictions.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 8000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 75000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 1,
    liveSearch: false,
    schemaHint: '{"findings":[{"unitKey":"","note":"","severity":"medium"}],"overallFeedback":""}',
  });

  return {
    stageStatus: "ok",
    reasonCodes: result.reasonCodes,
    statePatch: {
      ui: { phase: STAGE_ID },
      critique: {
        ...(state?.critique || {}),
        coherenceFindings: ensureArray(result?.parsed?.findings),
        overallFeedback: clean(result?.parsed?.overallFeedback),
      },
    },
    diagnostics: {
      findings: ensureArray(result?.parsed?.findings).length,
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
