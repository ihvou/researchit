import { callActorJson, clean, ensureArray, normalizeSources } from "./common.js";

export const STAGE_ID = "stage_11_challenge";
export const STAGE_TITLE = "Challenge";

function normalizeSeverity(value) {
  const level = clean(value).toLowerCase();
  if (level === "high" || level === "medium" || level === "low") return level;
  return "medium";
}

function normalizeCategory(value) {
  const category = clean(value).toLowerCase();
  const allowed = new Set(["overclaim", "missing_evidence", "contradiction", "stale_source", "missed_risk", "other"]);
  return allowed.has(category) ? category : "other";
}

function normalizeFlagType(value, category = "other") {
  const explicit = clean(value).toLowerCase();
  const allowed = new Set(["factual", "coherence", "coverage", "structural"]);
  if (allowed.has(explicit)) return explicit;
  if (category === "missing_evidence" || category === "stale_source") return "coverage";
  if (category === "contradiction") return "coherence";
  if (category === "missed_risk") return "structural";
  return "factual";
}

function normalizeEvidence(payload = {}) {
  const evidence = payload && typeof payload === "object" ? payload : {};
  const correctingSource = evidence?.correctingSource && typeof evidence.correctingSource === "object"
    ? normalizeSources([evidence.correctingSource])[0]
    : null;
  const explicitSources = normalizeSources(evidence?.sources || []);
  const sources = [...(correctingSource ? [correctingSource] : []), ...explicitSources];
  return {
    citedClaim: clean(evidence?.citedClaim),
    correctingSource,
    searchQueriesUsed: ensureArray(evidence?.searchQueriesUsed).map((item) => clean(item)).filter(Boolean).slice(0, 8),
    sources,
  };
}

function mergeSources(a = [], b = []) {
  const map = new Map();
  [...ensureArray(a), ...ensureArray(b)].forEach((source) => {
    const key = `${clean(source?.name)}|${clean(source?.url)}|${clean(source?.quote)}`;
    if (!key.replace(/\|/g, "")) return;
    if (!map.has(key)) map.set(key, source);
  });
  return [...map.values()];
}

function normalizeFlags(parsed = {}, state = {}) {
  const raw = ensureArray(parsed?.flags);
  const isMatrix = clean(state?.outputType).toLowerCase() === "matrix";
  const flags = raw.map((flag, idx) => {
    const category = normalizeCategory(flag?.category);
    const evidence = normalizeEvidence(flag?.evidence);
    return {
      id: clean(flag?.id) || `flag-${idx + 1}`,
      unitKey: clean(flag?.unitKey),
      flagged: flag?.flagged !== false,
      severity: normalizeSeverity(flag?.severity),
      category,
      flagType: normalizeFlagType(flag?.flagType, category),
      note: clean(flag?.note),
      suggestedScore: !isMatrix && Number.isFinite(Number(flag?.suggestedScore)) ? Number(flag.suggestedScore) : undefined,
      suggestedValue: clean(flag?.suggestedValue) || undefined,
      suggestedConfidence: clean(flag?.suggestedConfidence) ? clean(flag?.suggestedConfidence).toLowerCase() : undefined,
      evidence,
      sources: mergeSources(normalizeSources(flag?.sources || []), evidence.sources),
    };
  }).filter((flag) => flag.unitKey && flag.note);

  const byUnit = {};
  flags.forEach((flag) => {
    if (!byUnit[flag.unitKey]) byUnit[flag.unitKey] = { flags: [] };
    byUnit[flag.unitKey].flags.push(flag);
  });

  return {
    flags,
    flagsByUnit: byUnit,
  };
}

function buildAssessmentSnapshot(state = {}) {
  const compactSources = (sources = []) => ensureArray(sources).slice(0, 8).map((source) => ({
    name: clean(source?.name),
    url: clean(source?.url),
    quote: clean(source?.quote).slice(0, 180),
  })).filter((source) => source.name || source.url || source.quote);

  const compactClaims = (items = []) => ensureArray(items).slice(0, 8).map((item) => ({
    claim: clean(item?.claim),
    detail: clean(item?.detail).slice(0, 220),
  })).filter((item) => item.claim);

  if (clean(state?.outputType).toLowerCase() === "matrix") {
    return ensureArray(state?.assessment?.matrix?.cells).map((cell) => ({
      unitKey: `${cell.subjectId}::${cell.attributeId}`,
      value: clean(cell?.value),
      full: clean(cell?.full).slice(0, 1200),
      confidence: clean(cell?.confidence),
      confidenceReason: clean(cell?.confidenceReason),
      missingEvidence: clean(cell?.missingEvidence),
      sources: compactSources(cell?.sources),
      arguments: {
        supporting: compactClaims(cell?.arguments?.supporting),
        limiting: compactClaims(cell?.arguments?.limiting),
      },
      risks: clean(cell?.risks),
    }));
  }

  const byId = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? state.assessment.scorecard.byId
    : {};

  return Object.values(byId).map((unit) => ({
    unitKey: clean(unit?.id),
    score: Number.isFinite(Number(unit?.score)) ? Number(unit.score) : null,
    brief: clean(unit?.brief).slice(0, 420),
    full: clean(unit?.full).slice(0, 1200),
    confidence: clean(unit?.confidence),
    confidenceReason: clean(unit?.confidenceReason),
    missingEvidence: clean(unit?.missingEvidence),
    sources: compactSources(unit?.sources),
    arguments: {
      supporting: compactClaims(unit?.arguments?.supporting),
      limiting: compactClaims(unit?.arguments?.limiting),
    },
    risks: clean(unit?.risks),
  }));
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const coherence = ensureArray(state?.critique?.coherenceFindings);
  const assessmentSnapshot = buildAssessmentSnapshot(state);
  const isMatrix = clean(state?.outputType).toLowerCase() === "matrix";
  const flagSchema = isMatrix
    ? `{
  "flags": [{
    "id":"",
    "unitKey":"",
    "flagged": true,
    "flagType":"factual|coherence|coverage|structural",
    "severity":"high|medium|low",
    "category":"overclaim|missing_evidence|contradiction|stale_source|missed_risk|other",
    "note":"",
    "suggestedValue": "",
    "suggestedConfidence": "high|medium|low",
    "sources": [],
    "evidence": {
      "citedClaim":"",
      "correctingSource":{"name":"","url":"","quote":"","sourceType":""},
      "searchQueriesUsed":[""],
      "sources":[]
    }
  }]
}`
    : `{
  "flags": [{
    "id":"",
    "unitKey":"",
    "flagged": true,
    "flagType":"factual|coherence|coverage|structural",
    "severity":"high|medium|low",
    "category":"overclaim|missing_evidence|contradiction|stale_source|missed_risk|other",
    "note":"",
    "suggestedScore": 1,
    "suggestedConfidence": "high|medium|low",
    "sources": [],
    "evidence": {
      "citedClaim":"",
      "correctingSource":{"name":"","url":"","quote":"","sourceType":""},
      "searchQueriesUsed":[""],
      "sources":[]
    }
  }]
}`;

  const prompt = `Challenge overclaims and confidence calibration using the full assessment context.

Include a factual accuracy pass:
- Flag claims that appear imprecise, overstated, or inconsistent with known public information.
- Use web search for factual uncertainty and stale-claim checks.
- For factual challenges, state what appears more accurate and reference supporting sources.

Severity definitions:
- high: materially changes the decision, invalidates a central claim, or leaves a high-impact risk unaddressed.
- medium: meaningfully weakens confidence or quality but may not flip the decision alone.
- low: minor calibration issue with limited decision impact.

Category definitions:
- overclaim: claim strength exceeds evidence quality.
- missing_evidence: key claim lacks sufficient evidence.
- contradiction: claim conflicts with other units or within-unit evidence.
- stale_source: claim relies on stale or outdated evidence.
- missed_risk: material downside is absent from assessment.
- other: issue outside the categories above.

Flag type definitions:
- factual: claim appears incorrect, overstated, or materially imprecise versus known public information.
- coherence: internal inconsistency across units or within a unit.
- coverage: insufficient evidence, stale evidence, or weak support depth.
- structural: framing, decision-logic, or risk-structure weakness.

Rules:
- Evaluate each unit using its current score/value, confidence, sources, and arguments.
- Flag only concrete issues and cite why.
- ${isMatrix
    ? "For matrix units, suggest text updates using suggestedValue and do not return suggestedScore."
    : "For scorecard units, use suggestedScore only when proposing a score change."}

Return JSON:
${flagSchema}
Assessment:
${JSON.stringify(assessmentSnapshot).slice(0, 26000)}
Coherence findings:
${JSON.stringify(coherence).slice(0, 12000)}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "critic",
    systemPrompt: runtime?.prompts?.critic || "You challenge overclaims.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 8000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 75000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 1,
    liveSearch: true,
    searchMaxUses: 5,
    schemaHint: isMatrix
      ? '{"flags":[{"id":"","unitKey":"","flagType":"coverage","severity":"medium","category":"other","note":"","suggestedValue":"","suggestedConfidence":"medium","sources":[],"evidence":{"citedClaim":"","correctingSource":{"name":"","url":"","quote":"","sourceType":""},"searchQueriesUsed":[],"sources":[]}}]}'
      : '{"flags":[{"id":"","unitKey":"","flagType":"coverage","severity":"medium","category":"other","note":"","suggestedScore":3,"suggestedConfidence":"medium","sources":[],"evidence":{"citedClaim":"","correctingSource":{"name":"","url":"","quote":"","sourceType":""},"searchQueriesUsed":[],"sources":[]}}]}',
  });

  const normalized = normalizeFlags(result?.parsed, state);
  const flagTypeCounts = normalized.flags.reduce((acc, flag) => {
    const key = clean(flag?.flagType).toLowerCase() || "unknown";
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});
  const factualFlagsWithEvidence = normalized.flags.filter((flag) => (
    clean(flag?.flagType).toLowerCase() === "factual"
      && (flag?.evidence?.correctingSource?.url || ensureArray(flag?.evidence?.searchQueriesUsed).length > 0)
  )).length;

  return {
    stageStatus: "ok",
    reasonCodes: result.reasonCodes,
    statePatch: {
      ui: { phase: STAGE_ID },
      critique: {
        ...(state?.critique || {}),
        flags: normalized.flags,
        flagsByUnit: normalized.flagsByUnit,
      },
    },
    diagnostics: {
      flags: normalized.flags.length,
      flagTypeCounts,
      factualFlagsWithEvidence,
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
