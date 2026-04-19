import {
  clean,
  ensureArray,
  normalizeCitationStatus,
  normalizeConfidence,
  normalizeConfidenceSource,
  summarizeSourceUniverse,
} from "./common.js";
import { REASON_CODES } from "../contracts/reason-codes.js";

export const STAGE_ID = "stage_07_source_assess";
export const STAGE_TITLE = "Source Assessment";

function assessSourceStatus(source = {}) {
  const sourceType = clean(source?.sourceType).toLowerCase();
  if (sourceType === "marketing" || sourceType === "press_release") return "excluded_marketing";

  const citationStatus = normalizeCitationStatus(source?.citationStatus);
  if (citationStatus === "verified") {
    const verification = clean(source?.verificationStatus).toLowerCase();
    return verification === "name_only_in_page" ? "corroborating" : "cited";
  }

  const verification = clean(source?.verificationStatus).toLowerCase();
  if (verification === "verified_in_page") return "cited";
  if (verification === "name_only_in_page") return "corroborating";
  return "unverified";
}

function unitCitationStatus(sources = []) {
  const statuses = ensureArray(sources).map((source) => normalizeCitationStatus(source?.citationStatus));
  if (!statuses.length) return "not_found";
  if (statuses.includes("verified")) return "verified";
  if (statuses.includes("unverifiable")) return "unverifiable";
  return "not_found";
}

function applyAssessmentToUnit(unit = {}) {
  const sources = ensureArray(unit?.sources).map((source) => ({
    ...source,
    citationStatus: normalizeCitationStatus(source?.citationStatus),
    displayStatus: assessSourceStatus(source),
  }));

  return {
    ...unit,
    sources,
    confidence: normalizeConfidence(unit?.confidence),
    confidenceSource: normalizeConfidenceSource(unit?.confidenceSource || "model"),
    confidenceReason: clean(unit?.confidenceReason),
    citationStatus: unitCitationStatus(sources),
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
