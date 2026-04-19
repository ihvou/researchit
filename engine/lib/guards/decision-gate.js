import { REASON_CODES } from "../../pipeline/contracts/reason-codes.js";
import { collectCoverageMetrics } from "./coverage-gate.js";

function clean(value) {
  return String(value || "").trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sourceTypeNormalized(value) {
  const type = clean(value).toLowerCase();
  if (!type) return "";
  if (["gov", "government", "public_registry", "regulator"].includes(type)) return "government";
  if (["research", "academic", "journal", "paper", "study"].includes(type)) return "research";
  if (["press", "press_release", "press-release"].includes(type)) return "press_release";
  if (["news", "media"].includes(type)) return "news";
  if (["analyst", "analysis"].includes(type)) return "analyst";
  if (["independent"].includes(type)) return "independent";
  if (["vendor", "company", "official"].includes(type)) return "vendor";
  if (["marketing", "sponsored"].includes(type)) return "marketing";
  if (["registry"].includes(type)) return "registry";
  return type;
}

function hostFromUrl(value) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function inferSourceType(source = {}) {
  const explicit = sourceTypeNormalized(source?.sourceType);
  if (explicit) return explicit;
  const host = hostFromUrl(source?.url);
  if (!host) return "";
  if (host.endsWith(".gov")) return "government";
  if (
    host.includes("ncbi.nlm.nih.gov")
    || host.includes("nature.com")
    || host.includes("thelancet.com")
    || host.includes("jamanetwork.com")
    || host.includes("bmj.com")
    || host.includes("nejm.org")
    || host.includes("sciencedirect.com")
    || host.includes("arxiv.org")
    || host.includes("doi.org")
  ) {
    return "research";
  }
  if (
    host.includes("reuters.com")
    || host.includes("bloomberg.com")
    || host.includes("ft.com")
    || host.includes("nytimes.com")
    || host.includes("wsj.com")
    || host.includes("statnews.com")
    || host.includes("beckershospitalreview.com")
  ) {
    return "news";
  }
  if (
    host.includes("gartner.com")
    || host.includes("forrester.com")
    || host.includes("klasresearch.com")
    || host.includes("cbinsights.com")
    || host.includes("pitchbook.com")
  ) {
    return "analyst";
  }
  if (
    host.includes("businesswire.com")
    || host.includes("prnewswire.com")
    || host.includes("globenewswire.com")
  ) {
    return "press_release";
  }
  return "";
}

function isIndependentSource(source = {}) {
  const type = inferSourceType(source);
  return type === "independent"
    || type === "research"
    || type === "news"
    || type === "analyst"
    || type === "government"
    || type === "registry";
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
  const criticalUnits = criticalUnitsForSourceCheck(state, gate, units);
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
      criticalUnitsChecked: criticalUnits.length,
    },
  };
}
