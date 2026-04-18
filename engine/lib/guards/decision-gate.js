import { REASON_CODES } from "../../pipeline/contracts/reason-codes.js";
import { collectCoverageMetrics } from "./coverage-gate.js";

function clean(value) {
  return String(value || "").trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isIndependentSource(source = {}) {
  const type = clean(source?.sourceType).toLowerCase();
  return type === "independent" || type === "research" || type === "news";
}

function getUnits(state = {}) {
  if (state?.outputType === "matrix") {
    return Array.isArray(state?.resolved?.assessment?.matrix?.cells)
      ? state.resolved.assessment.matrix.cells
      : (Array.isArray(state?.assessment?.matrix?.cells) ? state.assessment.matrix.cells : []);
  }
  const byId = state?.resolved?.assessment?.scorecard?.byId && typeof state.resolved.assessment.scorecard.byId === "object"
    ? state.resolved.assessment.scorecard.byId
    : (state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
      ? state.assessment.scorecard.byId
      : {});
  return Object.values(byId);
}

function unresolvedCriticCounts(state = {}) {
  const outcomes = Array.isArray(state?.resolved?.flagOutcomes) ? state.resolved.flagOutcomes : [];
  const unresolved = outcomes.filter((item) => !item?.resolved);
  const unresolvedHigh = unresolved.filter((item) => clean(item?.flag?.severity).toLowerCase() === "high");
  const unresolvedHighWithoutMitigation = unresolvedHigh.filter((item) => !clean(item?.mitigationNote));
  return {
    unresolvedCount: unresolved.length,
    unresolvedHighCount: unresolvedHigh.length,
    unresolvedHighWithoutMitigationCount: unresolvedHighWithoutMitigation.length,
  };
}

export function evaluateDecisionGate(state = {}, options = {}) {
  const defaults = {
    enabled: true,
    minCoverageRatio: 0.75,
    maxLowConfidenceRatio: 0.2,
    minSourcesPerCriticalUnit: 2,
    minIndependentSourcesPerCriticalUnit: 1,
    maxUnresolvedCriticFlags: 0,
  };
  const gate = {
    ...defaults,
    ...(options && typeof options === "object" ? options : {}),
  };

  const coverage = collectCoverageMetrics(state);
  const totalUnits = Math.max(1, toNumber(coverage.totalUnits, 0));
  const coverageRatio = toNumber(coverage.coveredUnits, 0) / totalUnits;
  const lowConfidenceRatio = toNumber(coverage.lowConfidenceUnits, 0) / totalUnits;

  const units = getUnits(state);
  const criticalUnits = units;
  const sourceCheckFailed = criticalUnits.some((unit) => {
    const sources = Array.isArray(unit?.sources) ? unit.sources : [];
    const independentCount = sources.filter(isIndependentSource).length;
    return sources.length < gate.minSourcesPerCriticalUnit
      || independentCount < gate.minIndependentSourcesPerCriticalUnit;
  });

  const critic = unresolvedCriticCounts(state);

  const checks = {
    coverage: coverageRatio >= gate.minCoverageRatio,
    confidence: lowConfidenceRatio <= gate.maxLowConfidenceRatio,
    sourceSufficiency: !sourceCheckFailed,
    criticResolution: critic.unresolvedCount <= gate.maxUnresolvedCriticFlags,
    highSeverityCoverage: critic.unresolvedHighWithoutMitigationCount === 0,
  };

  const passed = Object.values(checks).every(Boolean);
  const reasonCodes = passed ? [] : [REASON_CODES.DECISION_GATE_FAILED];

  return {
    passed,
    checks,
    gate,
    coverage,
    critic,
    reasonCodes,
    summary: {
      coverageRatio,
      lowConfidenceRatio,
    },
  };
}
