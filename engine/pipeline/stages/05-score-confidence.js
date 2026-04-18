import {
  clean,
  ensureArray,
  normalizeConfidence,
  normalizeSources,
  summarizeSourceUniverse,
} from "./common.js";

export const STAGE_ID = "stage_05_score_confidence";
export const STAGE_TITLE = "Score Confidence";

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function scoreFromEvidence(unit = {}) {
  const sourceCount = ensureArray(unit?.sources).length;
  const supporting = ensureArray(unit?.arguments?.supporting).length;
  const limiting = ensureArray(unit?.arguments?.limiting).length;
  const net = sourceCount + supporting - Math.floor(limiting / 2);
  if (net >= 6) return 5;
  if (net >= 4) return 4;
  if (net >= 2) return 3;
  if (net >= 1) return 2;
  return 1;
}

function confidenceFromEvidence(unit = {}) {
  const sourceCount = ensureArray(unit?.sources).length;
  if (sourceCount >= 4) return "high";
  if (sourceCount >= 2) return "medium";
  return "low";
}

function normalizeScorecardAssessment(evidence = {}, dimensions = []) {
  const byId = {};
  const units = ensureArray(evidence?.scorecard?.dimensions);
  const map = new Map(units.map((unit) => [clean(unit?.id), unit]));

  dimensions.forEach((dim) => {
    const unit = map.get(dim.id) || {};
    const confidence = normalizeConfidence(unit?.confidence || confidenceFromEvidence(unit));
    const score = clampScore(unit?.score || scoreFromEvidence(unit));
    byId[dim.id] = {
      id: dim.id,
      score,
      confidence,
      confidenceReason: clean(unit?.confidenceReason) || `Based on ${ensureArray(unit?.sources).length} cited sources.`,
      brief: clean(unit?.brief),
      full: clean(unit?.full),
      sources: normalizeSources(unit?.sources || []),
      arguments: {
        supporting: ensureArray(unit?.arguments?.supporting),
        limiting: ensureArray(unit?.arguments?.limiting),
      },
      risks: clean(unit?.risks),
      missingEvidence: confidence === "low" ? "More independent sources needed." : "",
      providerAgreement: clean(unit?.providerAgreement),
    };
  });

  return { scorecard: { byId } };
}

function normalizeMatrixAssessment(evidence = {}, request = {}) {
  const cells = ensureArray(evidence?.matrix?.cells).map((cell) => ({
    subjectId: clean(cell?.subjectId),
    attributeId: clean(cell?.attributeId),
    value: clean(cell?.value),
    full: clean(cell?.full),
    confidence: normalizeConfidence(cell?.confidence || confidenceFromEvidence(cell)),
    confidenceReason: clean(cell?.confidenceReason) || `Based on ${ensureArray(cell?.sources).length} cited sources.`,
    sources: normalizeSources(cell?.sources || []),
    arguments: {
      supporting: ensureArray(cell?.arguments?.supporting),
      limiting: ensureArray(cell?.arguments?.limiting),
    },
    risks: clean(cell?.risks),
    providerAgreement: clean(cell?.providerAgreement),
  }));

  const expectedKeys = new Set();
  ensureArray(request?.matrix?.subjects).forEach((subject) => {
    ensureArray(request?.matrix?.attributes).forEach((attribute) => {
      expectedKeys.add(`${subject.id}::${attribute.id}`);
    });
  });
  const byKey = new Map(cells.map((cell) => [`${cell.subjectId}::${cell.attributeId}`, cell]));
  expectedKeys.forEach((key) => {
    if (byKey.has(key)) return;
    const [subjectId, attributeId] = key.split("::");
    cells.push({
      subjectId,
      attributeId,
      value: "insufficient evidence",
      full: "No reliable evidence collected yet.",
      confidence: "low",
      confidenceReason: "No sources available.",
      sources: [],
      arguments: { supporting: [], limiting: [] },
      risks: "",
      providerAgreement: "none",
    });
  });

  return { matrix: { cells } };
}

export async function runStage(context = {}) {
  const { state } = context;
  const evidence = state?.evidence || {};
  const request = state?.request || {};

  const assessment = state?.outputType === "matrix"
    ? normalizeMatrixAssessment(evidence, request)
    : normalizeScorecardAssessment(evidence, ensureArray(request?.scorecard?.dimensions));

  const units = state?.outputType === "matrix"
    ? ensureArray(assessment?.matrix?.cells)
    : Object.values(assessment?.scorecard?.byId || {});

  const sourceUniverse = summarizeSourceUniverse(units);

  return {
    stageStatus: "ok",
    reasonCodes: [],
    statePatch: {
      ui: { phase: STAGE_ID },
      assessment,
      quality: {
        sourceUniverse,
      },
    },
    diagnostics: {
      outputType: state?.outputType,
      assessedUnits: units.length,
      sourceUniverse,
    },
  };
}
