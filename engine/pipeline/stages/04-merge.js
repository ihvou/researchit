import { clean, ensureArray, uniqBy } from "./common.js";
import { REASON_CODES } from "../contracts/reason-codes.js";

export const STAGE_ID = "stage_04_merge";
export const STAGE_TITLE = "Evidence Merge";

function sourceCount(unit = {}) {
  return ensureArray(unit?.sources).length;
}

function confidenceRank(confidence = "") {
  const value = clean(confidence).toLowerCase();
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function mergeSources(a = [], b = []) {
  return uniqBy([...ensureArray(a), ...ensureArray(b)], (source) => `${clean(source?.name)}|${clean(source?.url)}|${clean(source?.quote)}`);
}

function overlapScore(a = "", b = "") {
  const toSet = (value) => new Set(clean(value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const left = toSet(a);
  const right = toSet(b);
  if (!left.size || !right.size) return 0;
  let intersect = 0;
  left.forEach((token) => { if (right.has(token)) intersect += 1; });
  const union = new Set([...left, ...right]).size;
  return union ? (intersect / union) : 0;
}

function agreementFromTexts(values = [], thresholds = {}) {
  const high = Number(thresholds?.high ?? 0.72);
  const low = Number(thresholds?.low ?? 0.38);
  const cleaned = values.map((value) => clean(value)).filter(Boolean);
  if (cleaned.length <= 1) return "single";

  let total = 0;
  let pairs = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    for (let j = i + 1; j < cleaned.length; j += 1) {
      total += overlapScore(cleaned[i], cleaned[j]);
      pairs += 1;
    }
  }
  const avg = pairs ? (total / pairs) : 0;
  if (avg >= high) return "agree";
  if (avg >= low) return "partial";
  return "contradict";
}

function mergeDeepAssistScorecard(providers = [], thresholds = {}) {
  const all = ensureArray(providers);
  const providerContributions = all.map((provider) => ({
    provider: provider?.providerId,
    success: true,
    durationMs: 0,
  }));

  const dimensionIds = new Set();
  all.forEach((provider) => {
    ensureArray(provider?.draft?.scorecard?.dimensions).forEach((unit) => dimensionIds.add(clean(unit?.id)));
  });

  const dimensions = [...dimensionIds].map((dimensionId) => {
    const candidates = all
      .map((provider) => ensureArray(provider?.draft?.scorecard?.dimensions).find((unit) => clean(unit?.id) === dimensionId))
      .filter(Boolean);
    const best = candidates
      .slice()
      .sort((a, b) => {
        const sourceDelta = sourceCount(b) - sourceCount(a);
        if (sourceDelta !== 0) return sourceDelta;
        return confidenceRank(b?.confidence) - confidenceRank(a?.confidence);
      })[0] || { id: dimensionId };

    return {
      ...best,
      id: dimensionId,
      sources: uniqBy(candidates.flatMap((unit) => ensureArray(unit?.sources)), (source) => `${clean(source?.name)}|${clean(source?.url)}|${clean(source?.quote)}`),
      providerAgreement: agreementFromTexts(candidates.map((unit) => unit?.full || unit?.brief), thresholds),
    };
  });

  return {
    scorecard: { dimensions },
    providerContributions,
  };
}

function mergeDeepAssistMatrix(providers = [], thresholds = {}) {
  const all = ensureArray(providers);
  const providerContributions = all.map((provider) => ({
    provider: provider?.providerId,
    success: true,
    durationMs: 0,
  }));

  const cellKeys = new Set();
  all.forEach((provider) => {
    ensureArray(provider?.draft?.matrix?.cells).forEach((cell) => cellKeys.add(`${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`));
  });

  const cells = [...cellKeys].map((key) => {
    const [subjectId, attributeId] = key.split("::");
    const candidates = all
      .map((provider) => ensureArray(provider?.draft?.matrix?.cells)
        .find((cell) => clean(cell?.subjectId) === subjectId && clean(cell?.attributeId) === attributeId))
      .filter(Boolean);

    const best = candidates
      .slice()
      .sort((a, b) => {
        const sourceDelta = sourceCount(b) - sourceCount(a);
        if (sourceDelta !== 0) return sourceDelta;
        return confidenceRank(b?.confidence) - confidenceRank(a?.confidence);
      })[0] || { subjectId, attributeId };

    return {
      ...best,
      subjectId,
      attributeId,
      sources: uniqBy(candidates.flatMap((unit) => ensureArray(unit?.sources)), (source) => `${clean(source?.name)}|${clean(source?.url)}|${clean(source?.quote)}`),
      providerAgreement: agreementFromTexts(candidates.map((unit) => unit?.value || unit?.full), thresholds),
    };
  });

  return {
    matrix: { cells },
    providerContributions,
  };
}

function mergeNativeScorecard(memory = {}, merged = {}) {
  const memoryRows = ensureArray(memory?.scorecard?.dimensions);
  const mergedRows = ensureArray(merged?.scorecard?.dimensions);
  const byId = new Map(mergedRows.map((unit) => [clean(unit?.id), unit]));

  return {
    scorecard: {
      dimensions: memoryRows.map((unit) => {
        const patch = byId.get(clean(unit?.id)) || {};
        return {
          ...unit,
          brief: clean(patch?.brief || unit?.brief),
          full: clean(patch?.full || unit?.full),
          confidence: clean(patch?.confidence || unit?.confidence),
          confidenceReason: clean(patch?.confidenceReason || unit?.confidenceReason),
          sources: mergeSources(unit?.sources, patch?.sources),
          arguments: {
            supporting: [...ensureArray(unit?.arguments?.supporting), ...ensureArray(patch?.arguments?.supporting)],
            limiting: [...ensureArray(unit?.arguments?.limiting), ...ensureArray(patch?.arguments?.limiting)],
          },
          risks: clean(patch?.risks || unit?.risks),
          missingEvidence: clean(patch?.missingEvidence || unit?.missingEvidence),
        };
      }),
    },
  };
}

function mergeNativeMatrix(memory = {}, merged = {}) {
  const memoryRows = ensureArray(memory?.matrix?.cells);
  const mergedRows = ensureArray(merged?.matrix?.cells);
  const byKey = new Map(mergedRows.map((cell) => [`${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`, cell]));

  return {
    matrix: {
      cells: memoryRows.map((cell) => {
        const patch = byKey.get(`${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`) || {};
        return {
          ...cell,
          value: clean(patch?.value || cell?.value),
          full: clean(patch?.full || cell?.full),
          confidence: clean(patch?.confidence || cell?.confidence),
          confidenceReason: clean(patch?.confidenceReason || cell?.confidenceReason),
          sources: mergeSources(cell?.sources, patch?.sources),
          arguments: {
            supporting: [...ensureArray(cell?.arguments?.supporting), ...ensureArray(patch?.arguments?.supporting)],
            limiting: [...ensureArray(cell?.arguments?.limiting), ...ensureArray(patch?.arguments?.limiting)],
          },
          risks: clean(patch?.risks || cell?.risks),
          missingEvidence: clean(patch?.missingEvidence || cell?.missingEvidence),
        };
      }),
    },
  };
}

function mergeStats(bundle = {}, baseline = {}) {
  const lowCount = (units = []) => ensureArray(units).filter((unit) => clean(unit?.confidence).toLowerCase() === "low").length;
  const sourcedCount = (units = []) => ensureArray(units).filter((unit) => ensureArray(unit?.sources).length > 0).length;

  const extractUnits = (item = {}) => {
    if (item?.scorecard?.dimensions) return ensureArray(item.scorecard.dimensions);
    if (item?.matrix?.cells) return ensureArray(item.matrix.cells);
    return [];
  };

  const currentUnits = extractUnits(bundle);
  const previousUnits = extractUnits(baseline);

  return {
    currentLow: lowCount(currentUnits),
    prevLow: lowCount(previousUnits),
    currentCovered: sourcedCount(currentUnits),
    prevCovered: sourcedCount(previousUnits),
  };
}

function shouldRejectReconcile(candidate = {}, baseline = {}, threshold = 1) {
  const stats = mergeStats(candidate, baseline);
  const confidenceLift = Math.max(0, stats.prevLow - stats.currentLow);
  const sourceLift = Math.max(0, stats.currentCovered - stats.prevCovered);
  const contradictionReduced = true;
  const lowReduced = stats.currentLow < stats.prevLow;

  const reject = confidenceLift < threshold && !lowReduced && sourceLift <= 0 && !contradictionReduced;
  return { reject, stats };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const thresholds = runtime?.config?.deepAssist?.agreementThresholds || { high: 0.72, low: 0.38 };
  let merged;
  let reasonCodes = [];

  if (clean(state?.mode).toLowerCase() === "deep-assist") {
    const providers = ensureArray(state?.evidenceDrafts?.deepAssist?.providers);
    merged = state?.outputType === "matrix"
      ? mergeDeepAssistMatrix(providers, thresholds)
      : mergeDeepAssistScorecard(providers, thresholds);
  } else {
    const memory = state?.evidenceDrafts?.memory || {};
    const webMerged = state?.evidenceDrafts?.merged || {};
    merged = state?.outputType === "matrix"
      ? mergeNativeMatrix(memory, webMerged)
      : mergeNativeScorecard(memory, webMerged);

    const baseline = state?.outputType === "matrix"
      ? { matrix: { cells: ensureArray(memory?.matrix?.cells) } }
      : { scorecard: { dimensions: ensureArray(memory?.scorecard?.dimensions) } };
    const reconcile = shouldRejectReconcile(merged, baseline, Number(runtime?.config?.limits?.reconcileMinLift || 1));
    if (reconcile.reject) {
      merged = baseline;
      reasonCodes.push(REASON_CODES.RECONCILE_REJECTED_NO_LIFT);
    }
  }

  return {
    stageStatus: reasonCodes.length ? "recovered" : "ok",
    reasonCodes,
    statePatch: {
      ui: { phase: STAGE_ID },
      evidence: merged,
    },
    diagnostics: {
      mode: state?.mode,
      outputType: state?.outputType,
      providerContributions: ensureArray(merged?.providerContributions),
    },
  };
}
