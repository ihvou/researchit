import { REASON_CODES } from "../../pipeline/contracts/reason-codes.js";

function clean(value) {
  return String(value || "").trim();
}

function isLowConfidence(value) {
  return clean(value).toLowerCase() === "low";
}

function countZeroEvidence(units = []) {
  return units.filter((unit) => !(Array.isArray(unit?.sources) && unit.sources.length)).length;
}

export function collectCoverageMetrics(state = {}) {
  if (state?.outputType === "matrix") {
    const cells = Array.isArray(state?.assessment?.matrix?.cells) ? state.assessment.matrix.cells : [];
    const total = cells.length;
    const covered = cells.filter((cell) => Array.isArray(cell?.sources) && cell.sources.length > 0).length;
    const low = cells.filter((cell) => isLowConfidence(cell?.confidence)).length;
    const zero = countZeroEvidence(cells);
    return {
      totalUnits: total,
      coveredUnits: covered,
      lowConfidenceUnits: low,
      zeroEvidenceUnits: zero,
    };
  }

  const byId = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? state.assessment.scorecard.byId
    : {};
  const units = Object.values(byId);
  const total = units.length;
  const covered = units.filter((unit) => Array.isArray(unit?.sources) && unit.sources.length > 0).length;
  const low = units.filter((unit) => isLowConfidence(unit?.confidence)).length;
  const zero = countZeroEvidence(units);
  return {
    totalUnits: total,
    coveredUnits: covered,
    lowConfidenceUnits: low,
    zeroEvidenceUnits: zero,
  };
}

export function evaluateCoverageGate(state = {}, options = {}) {
  const metrics = collectCoverageMetrics(state);
  const total = Math.max(1, Number(metrics.totalUnits || 0));
  const ratio = Number(metrics.coveredUnits || 0) / total;
  const hardAbortCoverageFloor = Number(options?.hardAbortCoverageFloor ?? 0.3);

  const failed = ratio < hardAbortCoverageFloor;
  return {
    failed,
    metrics,
    hardAbortCoverageFloor,
    reasonCodes: failed ? [REASON_CODES.COVERAGE_CATASTROPHIC] : [],
  };
}
