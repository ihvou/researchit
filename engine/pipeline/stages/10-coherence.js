import { clean, ensureArray, normalizeSources } from "./common.js";
import {
  CRITIC_COMPACT_RETRY_REASON,
  callCriticJsonWithFallback,
  serializeBoundedJsonArray,
} from "./critic-utils.js";

export const STAGE_ID = "stage_10_coherence";
export const STAGE_TITLE = "Coherence";

function normalizeSeverity(value = "") {
  const level = clean(value).toLowerCase();
  if (level === "high" || level === "medium" || level === "low") return level;
  return "medium";
}

function normalizeFlagType(value = "") {
  const kind = clean(value).toLowerCase();
  const allowed = new Set(["factual", "coherence", "coverage", "structural"]);
  return allowed.has(kind) ? kind : "coherence";
}

function normalizeQueries(value = []) {
  return ensureArray(value).map((item) => clean(item)).filter(Boolean).slice(0, 8);
}

function normalizeCoherenceFindings(parsed = {}) {
  const findings = ensureArray(parsed?.findings).map((finding, idx) => {
    const evidence = finding?.evidence && typeof finding.evidence === "object" ? finding.evidence : {};
    const correctingSource = evidence?.correctingSource && typeof evidence.correctingSource === "object"
      ? evidence.correctingSource
      : null;
    const explicitSources = normalizeSources(finding?.sources || []);
    const evidenceSources = correctingSource ? normalizeSources([correctingSource]) : [];
    const mergedSources = [...explicitSources, ...evidenceSources];
    return {
      id: clean(finding?.id) || `coherence-${idx + 1}`,
      unitKey: clean(finding?.unitKey),
      note: clean(finding?.note),
      severity: normalizeSeverity(finding?.severity),
      flagType: normalizeFlagType(finding?.flagType),
      sources: mergedSources,
      evidence: {
        citedClaim: clean(evidence?.citedClaim),
        correctingSource: evidenceSources[0] || null,
        searchQueriesUsed: normalizeQueries(evidence?.searchQueriesUsed),
      },
    };
  }).filter((finding) => finding.unitKey && finding.note);

  return {
    findings,
    overallFeedback: clean(parsed?.overallFeedback),
  };
}

function buildSummaryInput(state = {}, options = {}) {
  const maxSources = Math.max(1, Number(options?.maxSourcesPerUnit || 8));
  const maxClaims = Math.max(1, Number(options?.maxClaimsPerSide || 8));
  const fullChars = Math.max(200, Number(options?.fullChars || 1200));
  const quoteChars = Math.max(80, Number(options?.quoteChars || 180));
  const valueChars = Math.max(120, Number(options?.valueChars || 500));
  const detailChars = Math.max(120, Number(options?.claimDetailChars || 260));
  const maxMatrixUnits = Math.max(8, Number(options?.maxMatrixUnits || 120));
  const compactSources = (sources = []) => ensureArray(sources).slice(0, maxSources).map((source) => ({
    name: clean(source?.name),
    url: clean(source?.url),
    quote: clean(source?.quote).slice(0, quoteChars),
    sourceType: clean(source?.sourceType),
    displayStatus: clean(source?.displayStatus),
  })).filter((source) => source.name || source.url || source.quote);
  const compactClaims = (items = []) => ensureArray(items).slice(0, maxClaims).map((item) => ({
    claim: clean(item?.claim),
    detail: clean(item?.detail).slice(0, detailChars),
  })).filter((item) => item.claim);

  if (state?.outputType === "matrix") {
    const cells = ensureArray(state?.assessment?.matrix?.cells);
    return cells.slice(0, maxMatrixUnits).map((cell) => ({
      unitKey: `${cell.subjectId}::${cell.attributeId}`,
      value: clean(cell?.value).slice(0, valueChars),
      full: clean(cell?.full).slice(0, fullChars),
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
    value: clean(unit?.brief || unit?.full).slice(0, valueChars),
    full: clean(unit?.full).slice(0, fullChars),
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

function buildPromptFromSummary(summary = [], maxChars = 26000) {
  const serialized = serializeBoundedJsonArray(summary, maxChars);
  return {
    prompt: `Review cross-unit coherence and factual consistency for this assessment.
Use web search only when needed to validate factual uncertainty or likely stale claims.
Return JSON:
{
  "findings": [{
    "id":"",
    "unitKey":"",
    "note":"",
    "severity":"high|medium|low",
    "flagType":"factual|coherence|coverage|structural",
    "sources": [],
    "evidence": {
      "citedClaim":"",
      "correctingSource":{"name":"","url":"","quote":"","sourceType":""},
      "searchQueriesUsed":[""]
    }
  }],
  "overallFeedback": ""
}
Assessment snapshot:
${serialized.json}`,
    diagnostics: serialized.diagnostics,
  };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const stageBudget = runtime?.budgets?.[STAGE_ID] || {};
  const tokenBudget = stageBudget?.tokenBudget || 8000;
  const timeoutMs = stageBudget?.timeoutMs || 240000;
  const schemaHint = '{"findings":[{"id":"","unitKey":"","note":"","severity":"medium","flagType":"coherence","sources":[],"evidence":{"citedClaim":"","correctingSource":{"name":"","url":"","quote":"","sourceType":""},"searchQueriesUsed":[]}}],"overallFeedback":""}';

  const primarySummary = buildSummaryInput(state);
  const primary = buildPromptFromSummary(primarySummary, 26000);
  const compactSummary = buildSummaryInput(state, {
    maxSourcesPerUnit: 4,
    maxClaimsPerSide: 4,
    fullChars: 600,
    quoteChars: 120,
    valueChars: 240,
    claimDetailChars: 180,
    maxMatrixUnits: 90,
  });
  const compact = buildPromptFromSummary(compactSummary, 14000);
  const criticCall = await callCriticJsonWithFallback({
    state,
    runtime,
    stageId: STAGE_ID,
    systemPrompt: runtime?.prompts?.critic || "You check coherence and contradictions.",
    primaryPrompt: primary.prompt,
    compactPrompt: compact.prompt,
    tokenBudget,
    timeoutMs,
    liveSearch: true,
    searchMaxUses: 3,
    schemaHint,
  });
  const result = criticCall.result;
  const usedCompactRetry = criticCall.usedCompactRetry;
  const prompt = usedCompactRetry ? compact.prompt : primary.prompt;
  const normalized = normalizeCoherenceFindings(result?.parsed || {});
  const factualFindings = normalized.findings.filter((finding) => finding.flagType === "factual").length;
  const reasonCodes = [
    ...ensureArray(result?.reasonCodes),
    ...(usedCompactRetry ? [CRITIC_COMPACT_RETRY_REASON] : []),
  ];

  return {
    stageStatus: "ok",
    reasonCodes: [...new Set(reasonCodes)],
    statePatch: {
      ui: { phase: STAGE_ID },
      critique: {
        ...(state?.critique || {}),
        coherenceFindings: normalized.findings,
        overallFeedback: normalized.overallFeedback,
      },
    },
    diagnostics: {
      findings: normalized.findings.length,
      factualFindings,
      compactRetryUsed: usedCompactRetry,
      criticRetryAttempts: criticCall.attempts,
      promptSnapshot: usedCompactRetry ? compact.diagnostics : primary.diagnostics,
      primaryPromptSnapshot: primary.diagnostics,
      compactPromptSnapshot: compact.diagnostics,
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
