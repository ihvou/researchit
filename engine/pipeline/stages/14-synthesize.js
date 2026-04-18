import { callActorJson, clean, ensureArray } from "./common.js";

export const STAGE_ID = "stage_14_synthesize";
export const STAGE_TITLE = "Synthesize";

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
    counterCaseChangedFinalUnits: ensureArray(state?.critique?.counterCase?.entries).length > 0,
  };
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
  const prompt = `Produce an independent executive synthesis.\nObjective: ${clean(state?.request?.objective)}\nDecision question: ${clean(state?.request?.decisionQuestion) || "not provided"}\nCritic summary: ${JSON.stringify(criticSummary)}\n\nReturn JSON:\n{
  "executiveSummary": "",
  "decisionImplication": "",
  "dissent": "",
  "decisionAnswer": "",
  "closestThreats": "",
  "whitespace": "",
  "strategicClassification": "",
  "keyRisks": "",
  "providerAgreementHighlights": ""
}`;

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
    schemaHint: '{"executiveSummary":"","decisionImplication":"","dissent":""}',
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
