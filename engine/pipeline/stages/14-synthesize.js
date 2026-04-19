import { callActorJson, clean, ensureArray } from "./common.js";

export const STAGE_ID = "stage_14_synthesize";
export const STAGE_TITLE = "Synthesize";

function norm(value) {
  return clean(value).toLowerCase();
}

function scoreValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function changedMatrixUnits(state = {}) {
  const beforeCells = ensureArray(state?.assessment?.matrix?.cells);
  const afterCells = ensureArray(state?.resolved?.assessment?.matrix?.cells);
  if (!beforeCells.length || !afterCells.length) return false;

  const beforeByKey = new Map(beforeCells.map((cell) => [`${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`, cell]));
  return afterCells.some((cell) => {
    const key = `${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`;
    const prior = beforeByKey.get(key) || {};
    return norm(cell?.value) !== norm(prior?.value)
      || norm(cell?.confidence) !== norm(prior?.confidence)
      || norm(cell?.confidenceReason) !== norm(prior?.confidenceReason);
  });
}

function changedScorecardUnits(state = {}) {
  const beforeById = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? state.assessment.scorecard.byId
    : {};
  const afterById = state?.resolved?.assessment?.scorecard?.byId && typeof state.resolved.assessment.scorecard.byId === "object"
    ? state.resolved.assessment.scorecard.byId
    : {};
  const ids = [...new Set([...Object.keys(beforeById), ...Object.keys(afterById)])];
  return ids.some((id) => {
    const before = beforeById[id] || {};
    const after = afterById[id] || {};
    return scoreValue(before?.score) !== scoreValue(after?.score)
      || norm(before?.confidence) !== norm(after?.confidence)
      || norm(before?.confidenceReason) !== norm(after?.confidenceReason);
  });
}

function didCounterCaseChangeFinalUnits(state = {}) {
  if (!ensureArray(state?.critique?.counterCase?.entries).length) return false;
  if (state?.outputType === "matrix") return changedMatrixUnits(state);
  return changedScorecardUnits(state);
}

function compactCriticSummary(state = {}) {
  const outcomes = ensureArray(state?.resolved?.flagOutcomes);
  const flags = ensureArray(state?.critique?.flags);

  const bySeverity = { high: 0, medium: 0, low: 0 };
  flags.forEach((flag) => {
    const severity = clean(flag?.severity).toLowerCase();
    if (bySeverity[severity] != null) bySeverity[severity] += 1;
  });

  const unresolved = outcomes.filter((item) => !item?.resolved).length;
  const resolved = outcomes.length - unresolved;

  const topConcerns = flags
    .slice()
    .sort((a, b) => {
      const rank = { high: 3, medium: 2, low: 1 };
      return (rank[clean(b?.severity).toLowerCase()] || 0) - (rank[clean(a?.severity).toLowerCase()] || 0);
    })
    .slice(0, 3)
    .map((flag) => clean(flag?.note).slice(0, 120))
    .filter(Boolean);

  return {
    countsBySeverity: bySeverity,
    unresolvedCount: unresolved,
    resolvedCount: resolved,
    topConcerns,
    counterCaseChangedFinalUnits: didCounterCaseChangeFinalUnits(state),
  };
}

function buildFinalAssessmentSnapshot(state = {}) {
  if (clean(state?.outputType).toLowerCase() === "matrix") {
    const cells = ensureArray(state?.resolved?.assessment?.matrix?.cells || state?.assessment?.matrix?.cells);
    return cells.slice(0, 220).map((cell) => ({
      unitKey: `${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`,
      subjectId: clean(cell?.subjectId),
      attributeId: clean(cell?.attributeId),
      value: clean(cell?.value),
      full: clean(cell?.full).slice(0, 900),
      confidence: clean(cell?.confidence),
      confidenceReason: clean(cell?.confidenceReason),
      missingEvidence: clean(cell?.missingEvidence),
      sources: ensureArray(cell?.sources).slice(0, 6).map((source) => ({
        name: clean(source?.name),
        url: clean(source?.url),
      })),
      risks: clean(cell?.risks),
    }));
  }

  const byId = state?.resolved?.assessment?.scorecard?.byId && typeof state.resolved.assessment.scorecard.byId === "object"
    ? state.resolved.assessment.scorecard.byId
    : (state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
      ? state.assessment.scorecard.byId
      : {});
  return Object.values(byId).map((unit) => ({
    unitId: clean(unit?.id),
    score: Number.isFinite(Number(unit?.score)) ? Number(unit.score) : null,
    confidence: clean(unit?.confidence),
    confidenceReason: clean(unit?.confidenceReason),
    brief: clean(unit?.brief).slice(0, 420),
    full: clean(unit?.full).slice(0, 900),
    missingEvidence: clean(unit?.missingEvidence),
    risks: clean(unit?.risks),
    sources: ensureArray(unit?.sources).slice(0, 6).map((source) => ({
      name: clean(source?.name),
      url: clean(source?.url),
    })),
  }));
}

function buildFlagOutcomesSnapshot(state = {}) {
  return ensureArray(state?.resolved?.flagOutcomes).slice(0, 180).map((outcome) => ({
    flagId: clean(outcome?.flagId),
    unitKey: clean(outcome?.flag?.unitKey),
    severity: clean(outcome?.flag?.severity),
    category: clean(outcome?.flag?.category),
    resolved: !!outcome?.resolved,
    disposition: clean(outcome?.disposition),
    analystNote: clean(outcome?.analystNote).slice(0, 320),
    mitigationNote: clean(outcome?.mitigationNote).slice(0, 240),
  }));
}

function buildMatrixExecutiveSummary(parsed = {}) {
  return {
    decisionAnswer: clean(parsed?.decisionAnswer || parsed?.executiveSummary),
    closestThreats: clean(parsed?.closestThreats),
    whitespace: clean(parsed?.whitespace),
    strategicClassification: clean(parsed?.strategicClassification),
    keyRisks: clean(parsed?.keyRisks),
    decisionImplications: clean(parsed?.decisionImplication || parsed?.decisionImplications),
    uncertaintyNotes: clean(parsed?.dissent || parsed?.uncertaintyNotes),
    providerAgreementHighlights: clean(parsed?.providerAgreementHighlights),
  };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const criticSummary = compactCriticSummary(state);
  const finalAssessment = buildFinalAssessmentSnapshot(state);
  const flagOutcomes = buildFlagOutcomesSnapshot(state);
  const prompt = `Produce an independent executive synthesis.
Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Output mode: ${clean(state?.outputType)}

Rules:
- Use final assessed positions (post-critic response), not draft evidence.
- Surface uncertainty and unresolved risks explicitly.
- Distinguish confirmed evidence from remaining assumptions.
- For matrix mode, include subjectSummaries aligned to listed subjectIds.

Return JSON:
{
  "executiveSummary": "",
  "decisionImplication": "",
  "dissent": "",
  "decisionAnswer": "",
  "closestThreats": "",
  "whitespace": "",
  "strategicClassification": "",
  "keyRisks": "",
  "providerAgreementHighlights": "",
  "subjectSummaries": [{
    "subjectId": "",
    "summary": "",
    "strengths": "",
    "risks": "",
    "recommendedAction": ""
  }]
}
Final assessment snapshot:
${JSON.stringify(finalAssessment).slice(0, 32000)}
Critic summary:
${JSON.stringify(criticSummary)}
Flag outcomes:
${JSON.stringify(flagOutcomes).slice(0, 14000)}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "synthesizer",
    systemPrompt: runtime?.prompts?.synthesizer || runtime?.prompts?.analyst || "You provide independent synthesis.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 6000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 60000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 1,
    liveSearch: false,
    schemaHint: '{"executiveSummary":"","decisionImplication":"","dissent":"","decisionAnswer":"","closestThreats":"","whitespace":"","strategicClassification":"","keyRisks":"","providerAgreementHighlights":"","subjectSummaries":[{"subjectId":"","summary":"","strengths":"","risks":"","recommendedAction":""}]}',
  });

  const synthesis = {
    executiveSummary: clean(result?.parsed?.executiveSummary || result?.parsed?.decisionAnswer),
    decisionImplication: clean(result?.parsed?.decisionImplication || result?.parsed?.decisionImplications),
    dissent: clean(result?.parsed?.dissent || result?.parsed?.uncertaintyNotes),
    matrixExecutiveSummary: buildMatrixExecutiveSummary(result?.parsed || {}),
    subjectSummaries: ensureArray(result?.parsed?.subjectSummaries),
  };

  return {
    stageStatus: "ok",
    reasonCodes: result.reasonCodes,
    statePatch: {
      ui: { phase: STAGE_ID },
      synthesis,
    },
    diagnostics: {
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
