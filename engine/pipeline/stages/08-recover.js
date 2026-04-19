import {
  callActorJson,
  clean,
  combineTokenDiagnostics,
  ensureArray,
  normalizeArguments,
  normalizeConfidence,
  normalizeSources,
} from "./common.js";
import { REASON_CODES } from "../contracts/reason-codes.js";

export const STAGE_ID = "stage_08_recover";
export const STAGE_TITLE = "Targeted Recovery";

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
  byAttr.forEach((items) => {
    for (let i = 0; i < items.length; i += 2) {
      groups.push(items.slice(i, i + 2));
    }
  });
  return groups;
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

function normalizeScorecardPatch(parsed = {}) {
  return ensureArray(parsed?.dimensions).map((unit) => ({
    id: clean(unit?.id || unit?.unitId),
    brief: clean(unit?.brief),
    full: clean(unit?.full),
    confidence: normalizeConfidence(unit?.confidence),
    confidenceReason: clean(unit?.confidenceReason),
    sources: normalizeSources(unit?.sources || []),
    arguments: normalizeArguments(unit?.arguments || {}, `recover-${clean(unit?.id || unit?.unitId)}`),
    risks: clean(unit?.risks),
    missingEvidence: clean(unit?.missingEvidence),
  })).filter((unit) => unit.id);
}

function normalizeMatrixPatch(parsed = {}) {
  return ensureArray(parsed?.cells).map((cell) => ({
    subjectId: clean(cell?.subjectId),
    attributeId: clean(cell?.attributeId),
    value: clean(cell?.value),
    full: clean(cell?.full),
    confidence: normalizeConfidence(cell?.confidence),
    confidenceReason: clean(cell?.confidenceReason),
    sources: normalizeSources(cell?.sources || []),
    arguments: normalizeArguments(cell?.arguments || {}, `recover-${clean(cell?.subjectId)}-${clean(cell?.attributeId)}`),
    risks: clean(cell?.risks),
    missingEvidence: clean(cell?.missingEvidence),
  })).filter((cell) => cell.subjectId && cell.attributeId);
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const reasonCodes = [];

  if (state?.outputType === "matrix") {
    const adaptiveBudget = Number(runtime?.config?.limits?.matrixAdaptiveTargetedMax || 16);
    const selection = selectMatrixUnits(state, adaptiveBudget);
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

    const patches = [];
    const matrixReasonCodes = [];
    const tokenDiagnosticsList = [];
    const modelRoutes = [];
    let totalRetries = 0;
    for (const group of groups) {
      const prompt = `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Recover missing evidence for these matrix cells.
Cells:
${group.map((item) => `- ${item.unit.subjectId}::${item.unit.attributeId} (${item.subjectLabel} x ${item.attributeLabel})
  attributeBrief: ${item.attributeBrief || "not provided"}
  existingEvidence: ${truncateText(item?.unit?.full || item?.unit?.value || "none", 800)}
  whySelected: pressure=${item.pressure}; confidence=${item.reasons.confidence}; sourceCount=${item.reasons.sourceCount}; contradictionFlag=${item.reasons.contradictionFlag}; staleSourceFlag=${item.reasons.staleSourceFlag}; gapHypothesis=${item.reasons.gapHypothesis || "not provided"}`).join("\n")}

Rules:
- Focus on what is weak for each listed cell.
- If reliable evidence is still unavailable, keep "sources" empty and describe the missing data in "missingEvidence".

Return JSON {"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;

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
        schemaHint: '{"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
      });
      matrixReasonCodes.push(...ensureArray(result?.reasonCodes));
      patches.push(...normalizeMatrixPatch(result?.parsed));
      tokenDiagnosticsList.push(result?.tokenDiagnostics || null);
      if (result?.route) modelRoutes.push(result.route);
      totalRetries += Number(result?.retries || 0);
    }
    const aggregatedTokens = combineTokenDiagnostics(tokenDiagnosticsList);
    const modelRoute = modelRoutes[0] || null;

    return {
      stageStatus: "ok",
      reasonCodes: [...reasonCodes, ...matrixReasonCodes],
      statePatch: {
        ui: { phase: STAGE_ID },
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
        requestedBudget: selection.requestedBudget,
        effectiveBudget: selection.effectiveBudget,
        attributeCoverageFloorReserved: selection.floorReserved,
        retries: totalRetries,
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

  const patch = normalizeScorecardPatch(result?.parsed);

  return {
    stageStatus: "ok",
    reasonCodes: [...reasonCodes, ...(result.reasonCodes || [])],
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
      retries: result.retries,
      modelRoute: result.route,
      tokenDiagnostics: result.tokenDiagnostics,
    },
    io: {
      prompt,
      response: result.text,
    },
    modelRoute: result.route,
    tokens: result.tokenDiagnostics,
    retries: result.retries,
  };
}
