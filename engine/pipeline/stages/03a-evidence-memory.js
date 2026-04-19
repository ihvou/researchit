import {
  callActorJson,
  clean,
  combineTokenDiagnostics,
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
      missingEvidence: clean(unit?.missingEvidence),
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
        missingEvidence: clean(source?.missingEvidence),
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
  const initialChunks = chunkSubjects(subjects, chunkSize);

  const results = await Promise.all(initialChunks.map(async (root) => {
    const cells = [];
    const diagnostics = [];
    const queue = [root];
    while (queue.length) {
      const current = queue.shift();
      const prompt = `Objective: ${clean(state?.request?.objective)}\nBuild MEMORY-ONLY matrix evidence for the provided cells.
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Subjects:\n${current.map((subject) => `- ${subject.id}: ${subject.label}`).join("\n")}
Attributes:\n${attributes.map((attribute) => `- ${attribute.id}: ${attribute.label}${clean(attribute?.brief) ? ` - ${clean(attribute.brief)}` : ""}`).join("\n")}

Rules:
- Use only model memory and prior knowledge; do not fabricate sources.
- If credible evidence is unavailable, keep "sources" empty, set low confidence, and explain the gap in "missingEvidence".

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
    "risks": "",
    "missingEvidence": ""
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
          tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 24000,
          timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 120000,
          // Queue loop handles retry-via-splitting; inner retries would compound exponentially.
          maxRetries: 0,
          liveSearch: false,
          schemaHint: '{"cells":[{"subjectId":"","attributeId":"","value":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
        });
        cells.push(...normalizeMatrixCells(result?.parsed, current, attributes));
        diagnostics.push({
          chunkSubjects: current.map((subject) => subject.id),
          chunkSize: current.length,
          retries: result.retries,
          tokenDiagnostics: result.tokenDiagnostics,
          modelRoute: result.route,
        });
      } catch (err) {
        if (current.length <= 1) throw err;
        const splitAt = Math.max(1, Math.floor(current.length / 2));
        const left = current.slice(0, splitAt);
        const right = current.slice(splitAt);
        diagnostics.push({
          chunkSubjects: current.map((subject) => subject.id),
          chunkSize: current.length,
          splitInto: [left.map((subject) => subject.id), right.map((subject) => subject.id)],
          splitReason: clean(err?.reasonCode || err?.message || "chunk_failure"),
        });
        if (right.length) queue.unshift(right);
        if (left.length) queue.unshift(left);
      }
    }
    return { cells, diagnostics };
  }));

  return {
    cells: results.flatMap((r) => r.cells),
    diagnostics: results.flatMap((r) => r.diagnostics),
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
    const aggregatedTokens = combineTokenDiagnostics(
      matrix.diagnostics.map((entry) => entry?.tokenDiagnostics).filter(Boolean)
    );
    const totalRetries = matrix.diagnostics.reduce((sum, entry) => sum + Number(entry?.retries || 0), 0);
    const modelRoute = matrix.diagnostics.find((entry) => entry?.modelRoute)?.modelRoute || null;

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
        retries: totalRetries,
        tokenDiagnostics: aggregatedTokens,
        modelRoute,
      },
      modelRoute,
      tokens: aggregatedTokens,
      retries: totalRetries,
    };
  }

  const dimensions = ensureArray(state?.request?.scorecard?.dimensions);
  const prompt = `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Build MEMORY-ONLY evidence for each scorecard dimension.
Dimensions:
${dimensions.map((dim) => `- ${dim.id}: ${dim.label}${clean(dim?.brief) ? ` - ${clean(dim.brief)}` : ""}`).join("\n")}

Rules:
- Use only memory and prior knowledge.
- If evidence cannot be found confidently, keep "sources" empty and document what is missing in "missingEvidence".

Return JSON:
{
  "dimensions": [{
    "unitId": "",
    "brief": "",
    "full": "",
    "confidence": "high|medium|low",
    "confidenceReason": "",
    "sources": [{"name":"","url":"","quote":"","sourceType":""}],
    "arguments": {"supporting":[],"limiting":[]},
    "risks": "",
    "missingEvidence": ""
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
    schemaHint: '{"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
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
