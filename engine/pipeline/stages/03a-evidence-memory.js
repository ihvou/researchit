import {
  callActorJson,
  clean,
  ensureArray,
  normalizeArguments,
  normalizeConfidence,
  normalizeSources,
} from "./common.js";

export const STAGE_ID = "stage_03a_evidence_memory";
export const STAGE_TITLE = "Evidence Memory";

function normalizeScorecardEvidence(parsed = {}, dimensions = []) {
  const byId = new Map((ensureArray(parsed?.dimensions)).map((item) => [clean(item?.id || item?.unitId), item]));
  return dimensions.map((dim) => {
    const unit = byId.get(dim.id) || {};
    return {
      id: dim.id,
      brief: clean(unit?.brief || unit?.summary),
      full: clean(unit?.full || unit?.analysis),
      value: clean(unit?.value),
      confidence: normalizeConfidence(unit?.confidence),
      confidenceReason: clean(unit?.confidenceReason),
      sources: normalizeSources(unit?.sources || []),
      arguments: normalizeArguments(unit?.arguments || {}, `${dim.id}-mem`),
      risks: clean(unit?.risks),
    };
  });
}

function chunkSubjects(subjects = [], size = 4) {
  const safeSize = Math.max(1, Number(size) || 1);
  const list = [];
  for (let i = 0; i < subjects.length; i += safeSize) {
    list.push(subjects.slice(i, i + safeSize));
  }
  return list;
}

function normalizeMatrixCells(parsed = {}, subjects = [], attributes = []) {
  const rawCells = ensureArray(parsed?.cells);
  const byKey = new Map(rawCells.map((cell) => [
    `${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`,
    cell,
  ]));

  const cells = [];
  subjects.forEach((subject) => {
    attributes.forEach((attribute) => {
      const key = `${subject.id}::${attribute.id}`;
      const source = byKey.get(key) || {};
      cells.push({
        subjectId: subject.id,
        attributeId: attribute.id,
        value: clean(source?.value),
        full: clean(source?.full || source?.analysis),
        confidence: normalizeConfidence(source?.confidence),
        confidenceReason: clean(source?.confidenceReason),
        sources: normalizeSources(source?.sources || []),
        arguments: normalizeArguments(source?.arguments || {}, `${subject.id}-${attribute.id}-mem`),
        risks: clean(source?.risks),
      });
    });
  });

  return cells;
}

async function gatherMatrixChunk({
  state,
  runtime,
  subjects,
  attributes,
  chunkSize,
}) {
  const chunks = chunkSubjects(subjects, chunkSize);
  const cells = [];
  const diagnostics = [];

  for (const chunk of chunks) {
    let localChunkSize = chunk.length;
    let success = false;
    let lastError = null;
    let attempts = 0;

    while (!success) {
      attempts += 1;
      const activeChunk = chunk.slice(0, localChunkSize);
      const prompt = `Objective: ${clean(state?.request?.objective)}\nBuild MEMORY-ONLY matrix evidence for the provided cells.
Subjects:\n${activeChunk.map((subject) => `- ${subject.id}: ${subject.label}`).join("\n")}
Attributes:\n${attributes.map((attribute) => `- ${attribute.id}: ${attribute.label}`).join("\n")}

Return JSON:
{
  "cells": [{
    "subjectId": "",
    "attributeId": "",
    "value": "",
    "full": "",
    "confidence": "high|medium|low",
    "confidenceReason": "",
    "sources": [{"name":"","url":"","quote":"","sourceType":""}],
    "arguments": {"supporting":[],"limiting":[]},
    "risks": ""
  }]
}`;
      try {
        const result = await callActorJson({
          state,
          runtime,
          stageId: STAGE_ID,
          actor: "analyst",
          systemPrompt: runtime?.prompts?.analyst || "You produce memory-only matrix evidence.",
          userPrompt: prompt,
          tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 10000,
          timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 90000,
          maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 2,
          liveSearch: false,
          schemaHint: '{"cells":[{"subjectId":"","attributeId":"","value":"","confidence":"","sources":[]}]}',
        });
        const normalized = normalizeMatrixCells(result?.parsed, activeChunk, attributes);
        cells.push(...normalized);
        diagnostics.push({
          chunkSubjects: activeChunk.map((subject) => subject.id),
          chunkSize: localChunkSize,
          retries: result.retries,
          tokenDiagnostics: result.tokenDiagnostics,
          modelRoute: result.route,
        });
        success = true;
      } catch (err) {
        lastError = err;
        if (localChunkSize <= 1) break;
        localChunkSize = Math.max(1, Math.floor(localChunkSize / 2));
      }
    }

    if (!success) {
      throw lastError || new Error("Matrix memory evidence chunk failed.");
    }
  }

  return {
    cells,
    diagnostics,
  };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;

  if (state?.outputType === "matrix") {
    const subjects = ensureArray(state?.request?.matrix?.subjects);
    const attributes = ensureArray(state?.request?.matrix?.attributes);
    const startChunkSize = Math.max(1, Number(runtime?.config?.matrix?.chunkSizeStart) || 4);
    const matrix = await gatherMatrixChunk({
      state,
      runtime,
      subjects,
      attributes,
      chunkSize: startChunkSize,
    });

    return {
      stageStatus: "ok",
      reasonCodes: [],
      statePatch: {
        ui: { phase: STAGE_ID },
        evidenceDrafts: {
          memory: {
            matrix: {
              cells: matrix.cells,
            },
          },
        },
      },
      diagnostics: {
        mode: "matrix",
        cells: matrix.cells.length,
        chunks: matrix.diagnostics,
      },
    };
  }

  const dimensions = ensureArray(state?.request?.scorecard?.dimensions);
  const prompt = `Objective: ${clean(state?.request?.objective)}\nBuild MEMORY-ONLY evidence for each dimension.\nDimensions:\n${dimensions.map((dim) => `- ${dim.id}: ${dim.label}`).join("\n")}\n\nReturn JSON:\n{
  "dimensions": [{
    "id": "",
    "brief": "",
    "full": "",
    "confidence": "high|medium|low",
    "confidenceReason": "",
    "sources": [{"name":"","url":"","quote":"","sourceType":""}],
    "arguments": {"supporting":[],"limiting":[]},
    "risks": ""
  }]
}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: runtime?.prompts?.analyst || "You produce memory evidence by dimension.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 8000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 75000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 1,
    liveSearch: false,
    schemaHint: '{"dimensions":[{"id":"","brief":"","full":"","sources":[]}]}',
  });

  const normalized = normalizeScorecardEvidence(result?.parsed, dimensions);
  return {
    stageStatus: "ok",
    reasonCodes: result.reasonCodes,
    statePatch: {
      ui: { phase: STAGE_ID },
      evidenceDrafts: {
        memory: {
          scorecard: {
            dimensions: normalized,
          },
        },
      },
    },
    diagnostics: {
      mode: "scorecard",
      dimensions: normalized.length,
      retries: result.retries,
      tokenDiagnostics: result.tokenDiagnostics,
      modelRoute: result.route,
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
