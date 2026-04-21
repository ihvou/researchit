import { clean, ensureArray, normalizeConfidence } from "./common.js";
import { deriveDeterministicConfidence } from "../../lib/confidence-derived.js";

export const STAGE_ID = "stage_09_rescore";
export const STAGE_TITLE = "Re-Score";

function mergeSources(a = [], b = []) {
  const map = new Map();
  [...ensureArray(a), ...ensureArray(b)].forEach((source) => {
    const key = `${clean(source?.name)}|${clean(source?.url)}|${clean(source?.quote)}`;
    if (!key.replace(/\|/g, "")) return;
    if (!map.has(key)) map.set(key, source);
  });
  return [...map.values()];
}

function rescoreScorecard(state = {}) {
  const byId = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? { ...state.assessment.scorecard.byId }
    : {};
  const patchRows = ensureArray(state?.recoveredPatch?.scorecard?.dimensions);
  const byPatch = new Map(patchRows.map((row) => [clean(row?.id), row]));

  Object.keys(byId).forEach((id) => {
    const current = byId[id];
    const patch = byPatch.get(id);
    if (!patch) return;
    const mergedSources = mergeSources(current?.sources, patch?.sources);
    const selfReported = normalizeConfidence(patch?.confidence || current?.confidence);
    const derivedConfidence = deriveDeterministicConfidence({
      confidence: selfReported,
      confidenceReason: clean(patch?.confidenceReason || current?.confidenceReason),
      sources: mergedSources,
      arguments: {
        supporting: [...ensureArray(current?.arguments?.supporting), ...ensureArray(patch?.arguments?.supporting)],
        limiting: [...ensureArray(current?.arguments?.limiting), ...ensureArray(patch?.arguments?.limiting)],
      },
    }, {
      allowModelFallback: true,
      minSourceCountForDerived: 2,
    });
    const confidence = normalizeConfidence(derivedConfidence.confidence);
    const score = Number.isFinite(Number(current?.score)) ? Number(current.score) : 3;
    const adjustedScore = confidence === "high"
      ? Math.min(5, score + (mergedSources.length >= 3 ? 1 : 0))
      : (confidence === "low" ? Math.max(1, score - 1) : score);

    byId[id] = {
      ...current,
      brief: clean(patch?.brief || current?.brief),
      full: clean(patch?.full || current?.full),
      confidence,
      confidenceSelfReported: derivedConfidence.confidenceSelfReported,
      confidenceSource: clean(derivedConfidence.confidenceSource || current?.confidenceSource || "model"),
      confidenceReason: clean(derivedConfidence.confidenceReason) || clean(patch?.confidenceReason || current?.confidenceReason),
      sources: mergedSources,
      arguments: {
        supporting: [...ensureArray(current?.arguments?.supporting), ...ensureArray(patch?.arguments?.supporting)],
        limiting: [...ensureArray(current?.arguments?.limiting), ...ensureArray(patch?.arguments?.limiting)],
      },
      risks: clean(patch?.risks || current?.risks),
      score: adjustedScore,
      missingEvidence: clean(patch?.missingEvidence || current?.missingEvidence) || (confidence === "low" ? "More evidence needed." : ""),
    };
  });

  return {
    scorecard: { byId },
  };
}

function rescoreMatrix(state = {}) {
  const cells = ensureArray(state?.assessment?.matrix?.cells).map((cell) => ({ ...cell }));
  const patchRows = ensureArray(state?.recoveredPatch?.matrix?.cells);
  const byPatch = new Map(patchRows.map((cell) => [`${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`, cell]));

  const merged = cells.map((cell) => {
    const patch = byPatch.get(`${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`);
    if (!patch) return cell;
    const mergedSources = mergeSources(cell?.sources, patch?.sources);
    const selfReported = normalizeConfidence(patch?.confidence || cell?.confidence);
    const derivedConfidence = deriveDeterministicConfidence({
      confidence: selfReported,
      confidenceReason: clean(patch?.confidenceReason || cell?.confidenceReason),
      sources: mergedSources,
      arguments: {
        supporting: [...ensureArray(cell?.arguments?.supporting), ...ensureArray(patch?.arguments?.supporting)],
        limiting: [...ensureArray(cell?.arguments?.limiting), ...ensureArray(patch?.arguments?.limiting)],
      },
    }, {
      allowModelFallback: true,
      minSourceCountForDerived: 2,
    });
    return {
      ...cell,
      value: clean(patch?.value || cell?.value),
      full: clean(patch?.full || cell?.full),
      confidence: normalizeConfidence(derivedConfidence.confidence),
      confidenceSelfReported: derivedConfidence.confidenceSelfReported,
      confidenceSource: clean(derivedConfidence.confidenceSource || cell?.confidenceSource || "model"),
      confidenceReason: clean(derivedConfidence.confidenceReason) || clean(patch?.confidenceReason || cell?.confidenceReason),
      sources: mergedSources,
      arguments: {
        supporting: [...ensureArray(cell?.arguments?.supporting), ...ensureArray(patch?.arguments?.supporting)],
        limiting: [...ensureArray(cell?.arguments?.limiting), ...ensureArray(patch?.arguments?.limiting)],
      },
      risks: clean(patch?.risks || cell?.risks),
      missingEvidence: clean(patch?.missingEvidence || cell?.missingEvidence),
    };
  });

  return {
    matrix: {
      cells: merged,
    },
  };
}

export async function runStage(context = {}) {
  const { state } = context;
  const assessment = state?.outputType === "matrix"
    ? rescoreMatrix(state)
    : rescoreScorecard(state);

  return {
    stageStatus: "ok",
    reasonCodes: [],
    statePatch: {
      ui: { phase: STAGE_ID },
      assessment,
    },
    diagnostics: {
      outputType: state?.outputType,
      patchedUnits: state?.outputType === "matrix"
        ? ensureArray(state?.recoveredPatch?.matrix?.cells).length
        : ensureArray(state?.recoveredPatch?.scorecard?.dimensions).length,
    },
  };
}
