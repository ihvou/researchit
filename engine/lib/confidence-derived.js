import { isIndependentSource } from "./sources/source-type.js";

function clean(value) {
  return String(value || "").trim();
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeConfidence(value = "") {
  const lower = clean(value).toLowerCase();
  if (lower.startsWith("h")) return "high";
  if (lower.startsWith("m")) return "medium";
  if (lower.startsWith("l")) return "low";
  return "low";
}

function confidenceFromScore(score = 0) {
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function countByTier(sources = []) {
  let verified = 0;
  let fabricated = 0;
  let unreachableInfrastructure = 0;
  let unreachableStale = 0;
  let unverifiable = 0;
  let grounded = 0;
  let independent = 0;
  sources.forEach((source) => {
    if (source?.groundedByProvider === true) grounded += 1;
    if (isIndependentSource(source)) independent += 1;
    const tier = clean(source?.verificationTier).toLowerCase();
    if (tier === "verified") verified += 1;
    else if (tier === "fabricated") fabricated += 1;
    else if (tier === "unreachable_infrastructure") unreachableInfrastructure += 1;
    else if (tier === "unreachable_stale") unreachableStale += 1;
    else if (tier === "unverifiable") unverifiable += 1;
  });
  return {
    verified,
    fabricated,
    unreachableInfrastructure,
    unreachableStale,
    unverifiable,
    grounded,
    independent,
  };
}

export function deriveDeterministicConfidence(unit = {}, options = {}) {
  const selfReported = normalizeConfidence(unit?.confidence);
  const sources = ensureArray(unit?.sources);
  const counts = countByTier(sources);
  const checked = counts.verified + counts.fabricated + counts.unreachableInfrastructure + counts.unreachableStale + counts.unverifiable;
  const verifiedRatio = checked > 0 ? (counts.verified / checked) : 0;
  const hasContradiction = ensureArray(unit?.arguments?.supporting).length > 0
    && ensureArray(unit?.arguments?.limiting).length > 0;

  const thinSignals = sources.length < Number(options?.minSourceCountForDerived || 2)
    && counts.grounded === 0
    && counts.verified === 0;

  if (thinSignals && options?.allowModelFallback !== false) {
    return {
      confidence: selfReported,
      confidenceSelfReported: selfReported,
      confidenceSource: "model_fallback",
      confidenceReason: clean(unit?.confidenceReason) || "Signals too thin for deterministic confidence; using model fallback.",
      signals: {
        ...counts,
        checked,
        verifiedRatio,
        contradiction: hasContradiction,
      },
    };
  }

  let score = 0;
  if (counts.grounded >= 2) score += 2;
  else if (counts.grounded >= 1) score += 1;

  if (counts.independent >= 2) score += 2;
  else if (counts.independent >= 1) score += 1;

  if (checked >= 2 && verifiedRatio >= 0.6) score += 2;
  else if (checked >= 1 && verifiedRatio >= 0.3) score += 1;

  if (counts.fabricated > 0) score -= 3;
  if (counts.unreachableInfrastructure > 0) score -= 1;
  if (counts.unverifiable > counts.verified) score -= 1;
  if (hasContradiction) score -= 1;

  const derived = confidenceFromScore(score);
  return {
    confidence: derived,
    confidenceSelfReported: selfReported,
    confidenceSource: "derived",
    confidenceReason: `Derived from grounded=${counts.grounded}, independent=${counts.independent}, verifiedRatio=${verifiedRatio.toFixed(2)}, fabricated=${counts.fabricated}.`,
    signals: {
      ...counts,
      checked,
      verifiedRatio,
      contradiction: hasContradiction,
      score,
    },
  };
}

