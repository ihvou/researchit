import { clean, ensureArray, normalizeConfidence, summarizeSourceUniverse } from "./common.js";
import { REASON_CODES } from "../contracts/reason-codes.js";

export const STAGE_ID = "stage_07_source_assess";
export const STAGE_TITLE = "Source Assessment";

function assessSourceStatus(source = {}) {
  const verification = clean(source?.verificationStatus).toLowerCase();
  const type = clean(source?.sourceType).toLowerCase();

  if (verification === "verified_in_page") return "cited";
  if (verification === "name_only_in_page") return "corroborating";
  if (type === "marketing" || type === "press_release") return "excluded_marketing";
  return "unverified";
}

function applyAssessmentToUnit(unit = {}) {
  const sources = ensureArray(unit?.sources).map((source) => ({
    ...source,
    displayStatus: assessSourceStatus(source),
  }));

  const cited = sources.filter((source) => clean(source?.displayStatus) === "cited").length;
  const corroborating = sources.filter((source) => clean(source?.displayStatus) === "corroborating").length;
  const confidenceCap = cited === 0 && corroborating <= 1 ? "low" : (cited <= 1 ? "medium" : unit?.confidence);

  return {
    ...unit,
    sources,
    confidence: normalizeConfidence(confidenceCap || unit?.confidence),
    confidenceReason: clean(unit?.confidenceReason) || (confidenceCap === "low" ? "Evidence quality cap applied after source verification." : ""),
  };
}

function applyToAssessment(assessment = {}) {
  if (assessment?.matrix?.cells) {
    const cells = ensureArray(assessment.matrix.cells).map((cell) => applyAssessmentToUnit(cell));
    return {
      assessment: { matrix: { cells } },
      units: cells,
    };
  }

  const byId = assessment?.scorecard?.byId && typeof assessment.scorecard.byId === "object"
    ? assessment.scorecard.byId
    : {};
  const updated = {};
  Object.keys(byId).forEach((id) => {
    updated[id] = applyAssessmentToUnit(byId[id]);
  });
  return {
    assessment: { scorecard: { byId: updated } },
    units: Object.values(updated),
  };
}

export async function runStage(context = {}) {
  const { state } = context;
  const applied = applyToAssessment(state?.assessment || {});
  const sourceUniverse = summarizeSourceUniverse(applied.units);

  return {
    stageStatus: "ok",
    reasonCodes: sourceUniverse.unverified > (sourceUniverse.cited + sourceUniverse.corroborating)
      ? [REASON_CODES.SOURCE_QUALITY_CAPPED]
      : [],
    statePatch: {
      ui: { phase: STAGE_ID },
      assessment: applied.assessment,
      quality: {
        sourceUniverse,
      },
    },
    diagnostics: {
      sourceUniverse,
      assessedUnits: applied.units.length,
    },
  };
}
