import {
  callActorJson,
  clean,
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

function selectScorecardUnits(state = {}, budget = 8) {
  const byId = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? state.assessment.scorecard.byId
    : {};
  const rows = Object.values(byId).map((unit) => ({
    key: unit.id,
    type: "dimension",
    pressure: computePressure(unit),
    unit,
  }));
  return rows
    .sort((a, b) => b.pressure - a.pressure)
    .slice(0, Math.max(0, Number(budget) || 0));
}

function groupMatrixCells(cells = []) {
  const byAttr = new Map();
  ensureArray(cells).forEach((cell) => {
    const attr = clean(cell?.attributeId);
    if (!byAttr.has(attr)) byAttr.set(attr, []);
    byAttr.get(attr).push(cell);
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
  const cells = ensureArray(state?.assessment?.matrix?.cells);
  const ranked = cells
    .map((cell) => ({
      key: `${cell.subjectId}::${cell.attributeId}`,
      type: "cell",
      pressure: computePressure(cell),
      unit: cell,
    }))
    .sort((a, b) => b.pressure - a.pressure);

  const selected = ranked.slice(0, Math.max(0, Number(budget) || 0));
  const groups = groupMatrixCells(selected.map((item) => item.unit));
  return { selected, groups };
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
  })).filter((cell) => cell.subjectId && cell.attributeId);
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const reasonCodes = [];

  if (state?.outputType === "matrix") {
    const adaptiveBudget = Number(runtime?.config?.limits?.matrixAdaptiveTargetedMax || 16);
    const { selected, groups } = selectMatrixUnits(state, adaptiveBudget);
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
    for (const group of groups) {
      const prompt = `Objective: ${clean(state?.request?.objective)}\nRecover missing evidence for these matrix cells.\nCells:\n${group.map((cell) => `- ${cell.subjectId}::${cell.attributeId}`).join("\n")}
Return JSON {"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":""}]}`;

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
        schemaHint: '{"cells":[{"subjectId":"","attributeId":"","value":"","sources":[]}]}',
      });
      patches.push(...normalizeMatrixPatch(result?.parsed));
    }

    return {
      stageStatus: "ok",
      reasonCodes,
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
      },
    };
  }

  const budget = Number(runtime?.config?.limits?.lowConfidenceBudgetUnits || 8);
  const selected = selectScorecardUnits(state, budget);
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

  const prompt = `Objective: ${clean(state?.request?.objective)}\nRecover evidence for these dimensions:\n${selected.map((item) => `- ${item.key}`).join("\n")}
Return JSON {"dimensions":[{"id":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":""}]}`;

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
    schemaHint: '{"dimensions":[{"id":"","brief":"","sources":[]}]}',
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
