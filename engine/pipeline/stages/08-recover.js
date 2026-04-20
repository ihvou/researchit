import {
  annotateSourcesWithGrounding,
  callActorJson,
  clean,
  combineTokenDiagnostics,
  ensureArray,
  fabricationSignalFromSources,
  normalizeArguments,
  normalizeConfidence,
  normalizeSources,
} from "./common.js";
import { REASON_CODES } from "../contracts/reason-codes.js";

export const STAGE_ID = "stage_08_recover";
export const STAGE_TITLE = "Targeted Recovery";
export const PROMPT_VERSION = "v2";

function nowIso() {
  return new Date().toISOString();
}

function computePressure(unit = {}, extra = {}) {
  let score = 0;
  if (extra?.hasContradiction) score += 5;
  if (clean(unit?.confidence).toLowerCase() === "low") score += 4;
  if (!ensureArray(unit?.sources).length) score += 4;
  if (ensureArray(unit?.sources).length <= 1) score += 2;
  if (extra?.staleHeavy) score += 2;
  return score;
}

function staleSourceCount(unit = {}) {
  return ensureArray(unit?.sources).filter((source) => (
    clean(source?.displayStatus).toLowerCase() === "excluded_stale"
  )).length;
}

function hasContradictionSignal(unit = {}) {
  const supporting = ensureArray(unit?.arguments?.supporting).length;
  const limiting = ensureArray(unit?.arguments?.limiting).length;
  return supporting > 0 && limiting > 0;
}

function buildPlanUnitMap(state = {}) {
  const map = new Map();
  ensureArray(state?.plan?.units).forEach((unit) => {
    const key = clean(unit?.unitId);
    if (!key) return;
    map.set(key, unit);
  });
  return map;
}

function truncateText(value, max = 800) {
  const text = clean(value).replace(/\s+/g, " ");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(120, max)).trimEnd()}...`;
}

function selectScorecardUnits(state = {}, budget = 8) {
  const dimensions = ensureArray(state?.request?.scorecard?.dimensions);
  const dimensionById = new Map(dimensions.map((dim) => [clean(dim?.id), dim]));
  const planByUnit = buildPlanUnitMap(state);
  const byId = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? state.assessment.scorecard.byId
    : {};
  const ranked = Object.values(byId).map((unit) => ({
    key: unit.id,
    type: "dimension",
    label: clean(dimensionById.get(clean(unit?.id))?.label || unit?.id),
    brief: clean(dimensionById.get(clean(unit?.id))?.brief),
    pressure: computePressure(unit, {
      hasContradiction: hasContradictionSignal(unit),
      staleHeavy: staleSourceCount(unit) > 0,
    }),
    reasons: {
      confidence: clean(unit?.confidence) || "low",
      sourceCount: ensureArray(unit?.sources).length,
      contradictionFlag: hasContradictionSignal(unit),
      staleSourceFlag: staleSourceCount(unit) > 0,
      gapHypothesis: clean(planByUnit.get(clean(unit?.id))?.gapHypothesis),
    },
    unit,
  }))
    .sort((a, b) => b.pressure - a.pressure);

  const selectedByKey = new Map();
  const floorSelected = [];
  ranked.forEach((item) => {
    const uncovered = clean(item?.unit?.confidence).toLowerCase() === "low"
      || ensureArray(item?.unit?.sources).length === 0;
    if (!uncovered || selectedByKey.has(item.key)) return;
    selectedByKey.set(item.key, item);
    floorSelected.push(item);
  });

  const requestedBudget = Math.max(0, Number(budget) || 0);
  const effectiveBudget = Math.max(requestedBudget, floorSelected.length);
  for (const item of ranked) {
    if (selectedByKey.size >= effectiveBudget) break;
    if (selectedByKey.has(item.key)) continue;
    selectedByKey.set(item.key, item);
  }

  return {
    selected: [...selectedByKey.values()],
    requestedBudget,
    effectiveBudget,
    floorReserved: floorSelected.length,
  };
}

function groupMatrixSelections(items = []) {
  const byAttr = new Map();
  ensureArray(items).forEach((item) => {
    const attr = clean(item?.unit?.attributeId);
    if (!byAttr.has(attr)) byAttr.set(attr, []);
    byAttr.get(attr).push(item);
  });

  const groups = [];
  let index = 0;
  byAttr.forEach((items) => {
    for (let i = 0; i < items.length; i += 2) {
      index += 1;
      groups.push({
        chunkId: `c${String(index).padStart(2, "0")}`,
        depth: 0,
        cells: items.slice(i, i + 2),
      });
    }
  });
  return groups;
}

function computeMatrixAdaptiveBudget(state = {}, runtime = {}) {
  const limits = runtime?.config?.limits || {};
  const cells = ensureArray(state?.assessment?.matrix?.cells);
  const totalCells = cells.length;
  if (!totalCells) {
    return {
      requestedBudget: 0,
      diagnostics: {
        totalCells: 0,
        lowConfidenceCells: 0,
        ratioTarget: 0,
        floorTarget: 0,
        configuredMax: 0,
        lowConfidenceDeficit: 0,
        criticalSourceDeficit: 0,
      },
    };
  }

  const ratioTarget = Math.max(0, Number(limits?.matrixAdaptiveTargetedRatio || 0.7));
  const floorTarget = Math.max(1, Number(limits?.matrixAdaptiveTargetedFloor || 12));
  const configuredMax = Math.max(1, Number(limits?.matrixAdaptiveTargetedMax || 36));
  const decisionGate = limits?.matrixDecisionGradeGate && typeof limits.matrixDecisionGradeGate === "object"
    ? limits.matrixDecisionGradeGate
    : {};

  const lowConfidenceCells = cells.filter((cell) => clean(cell?.confidence).toLowerCase() === "low").length;
  const maxLowRatio = Number(decisionGate?.maxLowConfidenceRatio);
  const maxAllowedLow = Number.isFinite(maxLowRatio)
    ? Math.max(0, Math.floor(totalCells * Math.max(0, maxLowRatio)))
    : 0;
  const lowConfidenceDeficit = Number.isFinite(maxLowRatio)
    ? Math.max(0, lowConfidenceCells - maxAllowedLow)
    : 0;

  const minSourcesPerCriticalCell = Math.max(
    1,
    Number(decisionGate?.minSourcesPerCriticalCell || decisionGate?.minSourcesPerCriticalUnit || 2)
  );
  const criticalAttributeIds = new Set(
    ensureArray(decisionGate?.criticalAttributeIds)
      .map((id) => clean(id))
      .filter(Boolean)
  );
  const criticalCells = criticalAttributeIds.size
    ? cells.filter((cell) => criticalAttributeIds.has(clean(cell?.attributeId)))
    : cells;
  const criticalSourceDeficit = criticalCells.filter((cell) => ensureArray(cell?.sources).length < minSourcesPerCriticalCell).length;

  const ratioBudget = Math.ceil(totalCells * ratioTarget);
  let requestedBudget = Math.max(floorTarget, ratioBudget, lowConfidenceDeficit, criticalSourceDeficit);
  if (state?.strictQuality) {
    requestedBudget = Math.max(requestedBudget, lowConfidenceCells, criticalSourceDeficit);
  }

  const cap = state?.strictQuality ? totalCells : configuredMax;
  requestedBudget = Math.max(1, Math.min(totalCells, Math.min(requestedBudget, cap)));

  return {
    requestedBudget,
    diagnostics: {
      totalCells,
      lowConfidenceCells,
      ratioTarget,
      floorTarget,
      configuredMax,
      strictQuality: !!state?.strictQuality,
      maxLowRatio: Number.isFinite(maxLowRatio) ? maxLowRatio : null,
      maxAllowedLow: Number.isFinite(maxLowRatio) ? maxAllowedLow : null,
      lowConfidenceDeficit,
      minSourcesPerCriticalCell,
      criticalSourceDeficit,
      criticalCellCount: criticalCells.length,
    },
  };
}

function selectMatrixUnits(state = {}, budget = 12) {
  const subjects = ensureArray(state?.request?.matrix?.subjects);
  const attributes = ensureArray(state?.request?.matrix?.attributes);
  const subjectById = new Map(subjects.map((subject) => [clean(subject?.id), subject]));
  const attributeById = new Map(attributes.map((attribute) => [clean(attribute?.id), attribute]));
  const planByUnit = buildPlanUnitMap(state);
  const cells = ensureArray(state?.assessment?.matrix?.cells);
  const ranked = cells
    .map((cell) => ({
      key: `${cell.subjectId}::${cell.attributeId}`,
      type: "cell",
      subjectLabel: clean(subjectById.get(clean(cell?.subjectId))?.label || cell?.subjectId),
      attributeLabel: clean(attributeById.get(clean(cell?.attributeId))?.label || cell?.attributeId),
      attributeBrief: clean(attributeById.get(clean(cell?.attributeId))?.brief),
      pressure: computePressure(cell, {
        hasContradiction: hasContradictionSignal(cell),
        staleHeavy: staleSourceCount(cell) > 0,
      }),
      reasons: {
        confidence: clean(cell?.confidence) || "low",
        sourceCount: ensureArray(cell?.sources).length,
        contradictionFlag: hasContradictionSignal(cell),
        staleSourceFlag: staleSourceCount(cell) > 0,
        gapHypothesis: clean(planByUnit.get(clean(cell?.attributeId))?.gapHypothesis),
      },
      unit: cell,
    }))
    .sort((a, b) => b.pressure - a.pressure);

  const byAttribute = new Map();
  ranked.forEach((item) => {
    const attr = clean(item?.unit?.attributeId);
    if (!attr) return;
    if (!byAttribute.has(attr)) byAttribute.set(attr, []);
    byAttribute.get(attr).push(item);
  });

  const selectedByKey = new Map();
  const floorSelected = [];
  byAttribute.forEach((items) => {
    const candidate = items.find((item) => (
      clean(item?.unit?.confidence).toLowerCase() === "low"
      || ensureArray(item?.unit?.sources).length === 0
    ));
    if (!candidate) return;
    selectedByKey.set(candidate.key, candidate);
    floorSelected.push(candidate);
  });

  const requestedBudget = Math.max(0, Number(budget) || 0);
  const effectiveBudget = Math.max(requestedBudget, floorSelected.length);
  for (const item of ranked) {
    if (selectedByKey.size >= effectiveBudget) break;
    if (selectedByKey.has(item.key)) continue;
    selectedByKey.set(item.key, item);
  }

  const selected = [...selectedByKey.values()];
  const groups = groupMatrixSelections(selected);
  return {
    selected,
    groups,
    requestedBudget,
    effectiveBudget,
    floorReserved: floorSelected.length,
  };
}

function normalizeScorecardPatch(parsed = {}, options = {}) {
  const groundedSources = ensureArray(options?.groundedSources || []);
  const confidenceStats = options?.confidenceStats || { coerced: 0 };
  const providerGroundedCount = groundedSources.length;
  const liveSearchUsed = options?.liveSearchUsed === true;
  return ensureArray(parsed?.dimensions).map((unit) => {
    const grounded = annotateSourcesWithGrounding(unit?.sources || [], groundedSources);
    return {
    id: clean(unit?.id || unit?.unitId),
    brief: clean(unit?.brief),
    full: clean(unit?.full),
    confidence: normalizeConfidence(unit?.confidence, confidenceStats),
    confidenceReason: clean(unit?.confidenceReason),
    sources: grounded.sources,
    fabricationSignal: fabricationSignalFromSources(grounded.sources, {
      liveSearchUsed,
      groundedSourceCount: providerGroundedCount,
    }),
    arguments: normalizeArguments(unit?.arguments || {}, `recover-${clean(unit?.id || unit?.unitId)}`),
    risks: clean(unit?.risks),
    missingEvidence: clean(unit?.missingEvidence),
  };
  }).filter((unit) => unit.id);
}

function normalizeMatrixPatch(parsed = {}, options = {}) {
  const groundedSources = ensureArray(options?.groundedSources || []);
  const confidenceStats = options?.confidenceStats || { coerced: 0 };
  const providerGroundedCount = groundedSources.length;
  const liveSearchUsed = options?.liveSearchUsed === true;
  return ensureArray(parsed?.cells).map((cell) => {
    const grounded = annotateSourcesWithGrounding(cell?.sources || [], groundedSources);
    return {
    subjectId: clean(cell?.subjectId),
    attributeId: clean(cell?.attributeId),
    value: clean(cell?.value),
    full: clean(cell?.full),
    confidence: normalizeConfidence(cell?.confidence, confidenceStats),
    confidenceReason: clean(cell?.confidenceReason),
    sources: grounded.sources,
    fabricationSignal: fabricationSignalFromSources(grounded.sources, {
      liveSearchUsed,
      groundedSourceCount: providerGroundedCount,
    }),
    arguments: normalizeArguments(cell?.arguments || {}, `recover-${clean(cell?.subjectId)}-${clean(cell?.attributeId)}`),
    risks: clean(cell?.risks),
    missingEvidence: clean(cell?.missingEvidence),
  };
  }).filter((cell) => cell.subjectId && cell.attributeId);
}

function computeGroundingCoverage(units = []) {
  let totalUrls = 0;
  let groundedUrls = 0;
  ensureArray(units).forEach((unit) => {
    ensureArray(unit?.sources).forEach((source) => {
      if (!clean(source?.url)) return;
      totalUrls += 1;
      if (source?.groundedByProvider === true) groundedUrls += 1;
    });
  });
  return {
    totalUrls,
    groundedUrls,
    groundedRatio: totalUrls > 0 ? groundedUrls / totalUrls : 1,
  };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const reasonCodes = [];

  if (state?.outputType === "matrix") {
    const subjects = ensureArray(state?.request?.matrix?.subjects);
    const attributes = ensureArray(state?.request?.matrix?.attributes);
    const budgetPlan = computeMatrixAdaptiveBudget(state, runtime);
    const selection = selectMatrixUnits(state, budgetPlan.requestedBudget);
    const { selected, groups } = selection;
    if (!selected.length) {
      reasonCodes.push(REASON_CODES.RECOVERY_BUDGET_STARVED);
      return {
        stageStatus: "recovered",
        reasonCodes,
        statePatch: {
          ui: { phase: STAGE_ID },
          recoveredPatch: { matrix: { cells: [] } },
        },
        diagnostics: { selected: 0, groups: 0 },
      };
    }

    const chunkTrace = [];
    const subjectIndex = new Map(subjects.map((subject, idx) => [clean(subject?.id), idx]));
    const attributeIndex = new Map(attributes.map((attribute, idx) => [clean(attribute?.id), idx]));
    const chunkManifest = groups.map((group) => ({
      chunkId: group.chunkId,
      parentId: null,
      depth: Number(group?.depth || 0),
      cells: ensureArray(group?.cells).map((item) => ({
        subjectId: clean(item?.unit?.subjectId),
        attributeId: clean(item?.unit?.attributeId),
        subjectIdx: Number.isFinite(subjectIndex.get(clean(item?.unit?.subjectId)))
          ? Number(subjectIndex.get(clean(item?.unit?.subjectId)))
          : null,
        attributeIdx: Number.isFinite(attributeIndex.get(clean(item?.unit?.attributeId)))
          ? Number(attributeIndex.get(clean(item?.unit?.attributeId)))
          : null,
      })),
    }));

    const groupResults = await Promise.all(groups.map(async (group) => {
      chunkTrace.push({
        chunkId: group.chunkId,
        event: "started",
        timestamp: nowIso(),
        depth: Number(group?.depth || 0),
        cellCount: ensureArray(group?.cells).length,
      });
      const prompt = `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Recover missing evidence for these matrix cells.
Cells:
${ensureArray(group?.cells).map((item) => `- ${item.unit.subjectId}::${item.unit.attributeId} (${item.subjectLabel} x ${item.attributeLabel})
  attributeBrief: ${item.attributeBrief || "not provided"}
  existingEvidence: ${truncateText(item?.unit?.full || item?.unit?.value || "none", 800)}
  whySelected: pressure=${item.pressure}; confidence=${item.reasons.confidence}; sourceCount=${item.reasons.sourceCount}; contradictionFlag=${item.reasons.contradictionFlag}; staleSourceFlag=${item.reasons.staleSourceFlag}; gapHypothesis=${item.reasons.gapHypothesis || "not provided"}`).join("\n")}

Rules:
- Focus on what is weak for each listed cell.
- Use high-quality, specific sources. Prefer independent evidence (government, research, analyst, or reputable news) over vendor claims.
- Return confidence as one of these strings only: high, medium, low. Do not return numbers.
- Example: {"confidence":"high"}
- For each non-empty source, include a valid canonical public https URL, a concise quote/snippet, and "sourceType".
- Never return temporary grounding redirect links (for example vertexaisearch.cloud.google.com/grounding-api-redirect/...).
- If you are not certain the canonical public URL is correct, omit the URL instead of guessing.
- sourceType must be one of: independent, research, news, analyst, government, registry, vendor, press_release, marketing.
- If reliable evidence is still unavailable, keep "sources" empty and describe the missing data in "missingEvidence".

Return JSON {"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;

      try {
        const result = await callActorJson({
          state,
          runtime,
          stageId: STAGE_ID,
          actor: "analyst",
          systemPrompt: runtime?.prompts?.analyst || "You recover targeted evidence.",
          userPrompt: prompt,
          tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 16000,
          timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 90000,
          maxRetries: 1,
          liveSearch: true,
          schemaHint: '{"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
        });
        const confidenceStats = { coerced: 0 };
        const patches = normalizeMatrixPatch(result?.parsed, {
          groundedSources: result?.meta?.groundedSources || [],
          liveSearchUsed: result?.tokenDiagnostics?.liveSearchUsed === true,
          confidenceStats,
        });
        const tokenDiagnostics = {
          ...(result?.tokenDiagnostics || {}),
          confidenceScaleCoerced: Number(confidenceStats.coerced || 0),
        };
        const reasonCodes = [
          ...ensureArray(result?.reasonCodes),
          ...(confidenceStats.coerced > 0 ? [REASON_CODES.CONFIDENCE_SCALE_COERCED] : []),
        ];
        const retryCount = Number(result?.retries || 0);
        for (let retryIndex = 1; retryIndex <= retryCount; retryIndex += 1) {
          chunkTrace.push({
            chunkId: group.chunkId,
            event: "retried",
            timestamp: nowIso(),
            retryIndex,
            reason: "call_retry",
            depth: Number(group?.depth || 0),
          });
        }
        chunkTrace.push({
          chunkId: group.chunkId,
          event: "completed",
          timestamp: nowIso(),
          depth: Number(group?.depth || 0),
          outputSize: patches.length,
          outputTokens: Number(tokenDiagnostics?.outputTokens || 0),
          finishReason: clean(tokenDiagnostics?.finishReason) || "unknown",
        });
        return {
          chunkId: group.chunkId,
          depth: Number(group?.depth || 0),
          cellCount: ensureArray(group?.cells).length,
          patches,
          reasonCodes,
          tokenDiagnostics,
          citations: computeGroundingCoverage(patches),
          route: result?.route || null,
          retries: retryCount,
          groundedSourcesResolved: result?.meta?.groundedSourcesResolved || null,
        };
      } catch (err) {
        chunkTrace.push({
          chunkId: group.chunkId,
          event: "failed",
          timestamp: nowIso(),
          depth: Number(group?.depth || 0),
          error: clean(err?.message || "chunk_failure"),
          abortReason: err?.abortReason || null,
          finishReason: clean(err?.finishReason) || "unknown",
        });
        throw err;
      }
    }));

    const patches = groupResults.flatMap((r) => r.patches);
    const matrixReasonCodes = groupResults.flatMap((r) => r.reasonCodes);
    const tokenDiagnosticsList = groupResults.map((r) => r.tokenDiagnostics);
    const modelRoutes = groupResults.map((r) => r.route).filter(Boolean);
    const totalRetries = groupResults.reduce((sum, r) => sum + r.retries, 0);
    const aggregatedTokens = combineTokenDiagnostics(tokenDiagnosticsList);
    const citations = groupResults.reduce((acc, row) => {
      const stats = row?.citations || {};
      acc.totalUrls += Number(stats?.totalUrls || 0);
      acc.groundedUrls += Number(stats?.groundedUrls || 0);
      return acc;
    }, { totalUrls: 0, groundedUrls: 0 });
    citations.groundedRatio = citations.totalUrls > 0 ? (citations.groundedUrls / citations.totalUrls) : 1;
    const groundedSourcesResolved = groupResults.reduce((acc, row) => {
      const stats = row?.groundedSourcesResolved || {};
      acc.total += Number(stats?.total || 0);
      acc.resolved += Number(stats?.resolved || 0);
      acc.unresolved += Number(stats?.unresolved || 0);
      return acc;
    }, { total: 0, resolved: 0, unresolved: 0 });
    const modelRoute = modelRoutes[0] || null;

    return {
      stageStatus: "ok",
      reasonCodes: [...reasonCodes, ...matrixReasonCodes],
      statePatch: {
        ui: { phase: STAGE_ID },
        chunkManifest: {
          ...(state?.chunkManifest || {}),
          [STAGE_ID]: chunkManifest,
        },
        recoveredPatch: {
          matrix: {
            cells: patches,
          },
        },
      },
      diagnostics: {
        selectedUnits: selected.length,
        groupedCalls: groups.length,
        patchedCells: patches.length,
        chunkTrace,
        chunkManifest,
        requestedBudget: selection.requestedBudget,
        effectiveBudget: selection.effectiveBudget,
        attributeCoverageFloorReserved: selection.floorReserved,
        adaptiveBudget: budgetPlan.diagnostics,
        citations,
        groundedSourcesResolved,
        retries: totalRetries,
        chunkRetriesTotal: chunkTrace.filter((entry) => entry?.event === "retried").length,
        chunkSplitDepthMax: chunkTrace.reduce((maxDepth, entry) => {
          const depth = Number(entry?.depth || 0);
          return depth > maxDepth ? depth : maxDepth;
        }, 0),
        chunksStarted: chunkTrace.filter((entry) => entry?.event === "started").length,
        chunksCompleted: chunkTrace.filter((entry) => entry?.event === "completed").length,
        chunksFailed: chunkTrace.filter((entry) => entry?.event === "failed").length,
        chunkTruncationRate: Number(aggregatedTokens?.outputTruncatedRate || 0),
        tokenDiagnostics: aggregatedTokens,
        modelRoute,
      },
      modelRoute,
      tokens: aggregatedTokens,
      retries: totalRetries,
    };
  }

  const budget = Number(runtime?.config?.limits?.lowConfidenceBudgetUnits || 8);
  const selection = selectScorecardUnits(state, budget);
  const selected = selection.selected;
  if (!selected.length) {
    reasonCodes.push(REASON_CODES.RECOVERY_BUDGET_STARVED);
    return {
      stageStatus: "recovered",
      reasonCodes,
      statePatch: {
        ui: { phase: STAGE_ID },
        recoveredPatch: { scorecard: { dimensions: [] } },
      },
      diagnostics: { selected: 0 },
    };
  }

  const prompt = `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Recover evidence for these scorecard dimensions.
Targets:
${selected.map((item) => `- ${item.key}: ${item.label}
  brief: ${item.brief || "not provided"}
  existingEvidence: ${truncateText(item?.unit?.full || item?.unit?.brief || "none", 800)}
  whySelected: pressure=${item.pressure}; confidence=${item.reasons.confidence}; sourceCount=${item.reasons.sourceCount}; contradictionFlag=${item.reasons.contradictionFlag}; staleSourceFlag=${item.reasons.staleSourceFlag}; gapHypothesis=${item.reasons.gapHypothesis || "not provided"}`).join("\n")}

Rules:
- Focus on closing the specific weakness for each target.
- Use high-quality sources whenever possible; prefer independent evidence (government, research, analyst, reputable news).
- Return confidence as one of these strings only: high, medium, low. Do not return numbers.
- Example: {"confidence":"high"}
- For each non-empty source, include a valid canonical public https URL, concise quote/snippet, and "sourceType".
- Never return temporary grounding redirect links (for example vertexaisearch.cloud.google.com/grounding-api-redirect/...).
- If you are not certain the canonical public URL is correct, omit the URL instead of guessing.
- sourceType must be one of: independent, research, news, analyst, government, registry, vendor, press_release, marketing.
- If reliable evidence is still unavailable, keep "sources" empty and state what remains missing in "missingEvidence".

Return JSON {"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: runtime?.prompts?.analyst || "You recover targeted evidence.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 8000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 90000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 2,
    liveSearch: true,
    schemaHint: '{"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
  });

  const confidenceStats = { coerced: 0 };
  const patch = normalizeScorecardPatch(result?.parsed, {
    groundedSources: result?.meta?.groundedSources || [],
    liveSearchUsed: result?.tokenDiagnostics?.liveSearchUsed === true,
    confidenceStats,
  });
  const scorecardReasonCodes = [
    ...reasonCodes,
    ...ensureArray(result?.reasonCodes),
    ...(confidenceStats.coerced > 0 ? [REASON_CODES.CONFIDENCE_SCALE_COERCED] : []),
  ];
  const tokenDiagnostics = {
    ...(result?.tokenDiagnostics || {}),
    confidenceScaleCoerced: Number(confidenceStats.coerced || 0),
  };

  return {
    stageStatus: "ok",
    reasonCodes: normalizeReasonCodes(scorecardReasonCodes),
    statePatch: {
      ui: { phase: STAGE_ID },
      recoveredPatch: {
        scorecard: {
          dimensions: patch,
        },
      },
    },
    diagnostics: {
      selectedUnits: selected.length,
      patchedDimensions: patch.length,
      requestedBudget: selection.requestedBudget,
      effectiveBudget: selection.effectiveBudget,
      coverageFloorReserved: selection.floorReserved,
      citations: computeGroundingCoverage(patch),
      groundedSourcesResolved: result?.meta?.groundedSourcesResolved || null,
      retries: result.retries,
      modelRoute: result.route,
      tokenDiagnostics,
    },
    io: {
      prompt,
      response: result.text,
    },
    modelRoute: result.route,
    tokens: tokenDiagnostics,
    retries: result.retries,
  };
}
