import { REASON_CODES } from "../../pipeline/contracts/reason-codes.js";
import { collectCoverageMetrics } from "./coverage-gate.js";
import {
  isIndependentSource,
  sourceRequiresStrictCitationCheck,
} from "../sources/source-type.js";

function clean(value) {
  return String(value || "").trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeVerificationTier(value = "") {
  const tier = clean(value).toLowerCase();
  if (tier === "verified") return "verified";
  if (tier === "fabricated") return "fabricated";
  if (tier === "unreachable_infrastructure") return "unreachable_infrastructure";
  if (tier === "unreachable_stale") return "unreachable_stale";
  if (tier === "unverifiable") return "unverifiable";
  return "";
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
  const missingResponse = outcomes.filter((item) => (
    clean(item?.disposition).toLowerCase() === "unresolved_missing_response"
    || item?.responseMissing === true
  ));
  return {
    unresolvedCount: unresolved.length,
    unresolvedHighCount: unresolvedHigh.length,
    unresolvedHighWithoutMitigationCount: unresolvedHighWithoutMitigation.length,
    missingResponseCount: missingResponse.length,
  };
}

function criticalUnitsForSourceCheck(state = {}, gate = {}, units = []) {
  if (state?.outputType !== "matrix") return units;
  const criticalIds = Array.isArray(gate?.criticalAttributeIds)
    ? gate.criticalAttributeIds.map((id) => clean(id)).filter(Boolean)
    : [];
  if (!criticalIds.length) return units;
  const allowed = new Set(criticalIds);
  const filtered = units.filter((unit) => allowed.has(clean(unit?.attributeId)));
  return filtered.length ? filtered : units;
}

function citationCoverageMetrics(units = []) {
  const relevantSources = [];
  units.forEach((unit) => {
    const sources = Array.isArray(unit?.sources) ? unit.sources : [];
    sources.forEach((source) => {
      if (!sourceRequiresStrictCitationCheck(source)) return;
      relevantSources.push(source);
    });
  });

  const totals = {
    totalRelevant: relevantSources.length,
    verified: 0,
    fabricated: 0,
    unreachableInfrastructure: 0,
    unreachableStale: 0,
    unverifiable: 0,
    notFound: 0,
    unknown: 0,
    missingVerificationTier: 0,
    signalHigh: 0,
    signalMedium: 0,
    signalLow: 0,
    signalUnknown: 0,
    signalReasonGroundedUnavailable: 0,
  };

  relevantSources.forEach((source) => {
    const tier = normalizeVerificationTier(source?.verificationTier);
    if (tier === "verified") {
      totals.verified += 1;
      return;
    }
    if (tier === "fabricated") {
      totals.fabricated += 1;
      return;
    }
    if (tier === "unreachable_infrastructure") {
      totals.unreachableInfrastructure += 1;
      return;
    }
    if (tier === "unreachable_stale") {
      totals.unreachableStale += 1;
      return;
    }
    if (tier === "unverifiable") {
      totals.unverifiable += 1;
      return;
    }

    const signal = clean(source?.fabricationSignal).toLowerCase();
    const signalReason = clean(source?.fabricationSignalReason).toLowerCase();
    if (signal === "high") totals.signalHigh += 1;
    else if (signal === "medium") totals.signalMedium += 1;
    else if (signal === "low") totals.signalLow += 1;
    else if (signal === "unknown") totals.signalUnknown += 1;
    if (signalReason === "grounded_set_unavailable") totals.signalReasonGroundedUnavailable += 1;
    if (signal === "unknown") {
      totals.unknown += 1;
      return;
    }

    totals.missingVerificationTier += 1;
    totals.unverifiable += 1;
  });

  const denom = Math.max(1, totals.totalRelevant);
  const fabricationDenominator = Math.max(1, totals.totalRelevant - totals.unknown);
  // Keep unverifiable transport noise diagnostic-only; gate hard on stronger failure signals.
  const unresolvedNumerator = totals.fabricated + totals.unreachableStale + totals.notFound;
  const fabricationSignal = totals.signalUnknown > 0 && totals.signalUnknown >= Math.max(totals.signalHigh, totals.signalMedium, totals.signalLow)
    ? "unknown"
    : (totals.signalHigh > 0 ? "high" : (totals.signalMedium > 0 ? "medium" : "low"));
  const fabricationSignalReason = fabricationSignal === "unknown" && totals.signalReasonGroundedUnavailable > 0
    ? "grounded_set_unavailable"
    : "";
  return {
    ...totals,
    unresolvedNumerator,
    verifiedRatio: totals.totalRelevant ? (totals.verified / denom) : 1,
    unverifiableRatio: totals.totalRelevant ? (totals.unverifiable / denom) : 0,
    unresolvedRatio: totals.totalRelevant ? (unresolvedNumerator / denom) : 0,
    fabricationRatio: totals.totalRelevant ? (totals.fabricated / fabricationDenominator) : 0,
    unknownRatio: totals.totalRelevant ? (totals.unknown / denom) : 0,
    fabricationSignal,
    fabricationSignalReason,
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
    maxUnverifiedSourceRatio: 1,
    maxFabricatedSourceRatio: 1,
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
  const criticalUnits = criticalUnitsForSourceCheck(state, gate, units);
  const sourceCheckFailed = criticalUnits.some((unit) => {
    const sources = Array.isArray(unit?.sources) ? unit.sources : [];
    const eligibleSources = sources.filter((source) => normalizeVerificationTier(source?.verificationTier) !== "fabricated");
    const independentCount = eligibleSources.filter(isIndependentSource).length;
    return eligibleSources.length < gate.minSourcesPerCriticalUnit
      || independentCount < gate.minIndependentSourcesPerCriticalUnit;
  });

  const critic = unresolvedCriticCounts(state);
  const citationCoverage = citationCoverageMetrics(units);
  const citationCoverageFailed = citationCoverage.unresolvedRatio > Number(gate.maxUnverifiedSourceRatio || 1);
  const fabricationFailed = citationCoverage.fabricationRatio > Number(gate.maxFabricatedSourceRatio || 1);

  const checks = {
    coverage: coverageRatio >= gate.minCoverageRatio,
    confidence: lowConfidenceRatio <= gate.maxLowConfidenceRatio,
    sourceSufficiency: !sourceCheckFailed,
    citationCoverage: !citationCoverageFailed,
    fabrication: !fabricationFailed,
    criticResolution: critic.unresolvedCount <= gate.maxUnresolvedCriticFlags,
    highSeverityCoverage: critic.unresolvedHighWithoutMitigationCount === 0,
    criticDefendCompleteness: critic.missingResponseCount === 0,
  };

  const passed = Object.values(checks).every(Boolean);
  const reasonCodes = [
    ...(
      passed
        ? []
        : [
          REASON_CODES.DECISION_GATE_FAILED,
          ...(fabricationFailed ? [REASON_CODES.DECISION_GATE_FABRICATION_FLAGGED] : []),
        ]
    ),
    ...(citationCoverage.missingVerificationTier > 0 ? [REASON_CODES.SOURCE_MISSING_VERIFICATION_TIER] : []),
    ...(citationCoverage.unknownRatio > 0.5 ? [REASON_CODES.SOURCE_GROUNDING_UNAVAILABLE] : []),
  ];

  const deprecatedConfigUsed = [];
  if (Object.prototype.hasOwnProperty.call(gate, "minCitedSourceRatio")) {
    deprecatedConfigUsed.push("minCitedSourceRatio");
  }

  return {
    passed,
    checks,
    gate,
    coverage,
    critic,
    citationCoverage: {
      fabricationSignal: clean(citationCoverage?.fabricationSignal) || "low",
      fabricationSignalReason: clean(citationCoverage?.fabricationSignalReason) || "",
      fabricationRatio: toNumber(citationCoverage?.fabricationRatio, 0),
      unknownRatio: toNumber(citationCoverage?.unknownRatio, 0),
      unverifiableRatio: toNumber(citationCoverage?.unverifiableRatio, 0),
      verifiedRatio: toNumber(citationCoverage?.verifiedRatio, 0),
    },
    reasonCodes,
    summary: {
      coverageRatio,
      lowConfidenceRatio,
      criticalUnitsChecked: criticalUnits.length,
      citationCoverage,
    },
    diagnostics: {
      deprecatedConfigUsed,
    },
  };
}
