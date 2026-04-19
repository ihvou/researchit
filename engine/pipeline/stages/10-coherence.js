import { callActorJson, clean, ensureArray } from "./common.js";

export const STAGE_ID = "stage_10_coherence";
export const STAGE_TITLE = "Coherence";

function buildSummaryInput(state = {}) {
  const compactSources = (sources = []) => ensureArray(sources).slice(0, 8).map((source) => ({
    name: clean(source?.name),
    url: clean(source?.url),
    quote: clean(source?.quote).slice(0, 180),
    sourceType: clean(source?.sourceType),
    displayStatus: clean(source?.displayStatus),
  })).filter((source) => source.name || source.url || source.quote);
  const compactClaims = (items = []) => ensureArray(items).slice(0, 8).map((item) => ({
    claim: clean(item?.claim),
    detail: clean(item?.detail).slice(0, 260),
  })).filter((item) => item.claim);

  if (state?.outputType === "matrix") {
    const cells = ensureArray(state?.assessment?.matrix?.cells);
    return cells.slice(0, 120).map((cell) => ({
      unitKey: `${cell.subjectId}::${cell.attributeId}`,
      value: clean(cell?.value),
      full: clean(cell?.full).slice(0, 1200),
      confidence: clean(cell?.confidence),
      confidenceReason: clean(cell?.confidenceReason),
      sources: compactSources(cell?.sources),
      arguments: {
        supporting: compactClaims(cell?.arguments?.supporting),
        limiting: compactClaims(cell?.arguments?.limiting),
      },
      risks: clean(cell?.risks),
      missingEvidence: clean(cell?.missingEvidence),
    }));
  }
  const byId = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? state.assessment.scorecard.byId
    : {};
  return Object.values(byId).map((unit) => ({
    unitKey: clean(unit?.id),
    score: Number.isFinite(Number(unit?.score)) ? Number(unit.score) : null,
    value: clean(unit?.brief || unit?.full).slice(0, 500),
    full: clean(unit?.full).slice(0, 1200),
    confidence: clean(unit?.confidence),
    confidenceReason: clean(unit?.confidenceReason),
    sources: compactSources(unit?.sources),
    arguments: {
      supporting: compactClaims(unit?.arguments?.supporting),
      limiting: compactClaims(unit?.arguments?.limiting),
    },
    risks: clean(unit?.risks),
    missingEvidence: clean(unit?.missingEvidence),
  }));
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const summary = buildSummaryInput(state);
  const prompt = `Review cross-unit coherence for this assessment and flag contradictions or internal logic breaks.
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
