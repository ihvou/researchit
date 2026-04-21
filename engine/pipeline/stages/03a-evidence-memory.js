import {
  callActorJson,
  clean,
  combineTokenDiagnostics,
  ensureArray,
  normalizeArguments,
  normalizeConfidence,
  normalizeSources,
} from "./common.js";
import { REASON_CODES, normalizeReasonCodes } from "../contracts/reason-codes.js";
import {
  createInitialMatrixCellChunks,
  makeChunkManifest,
  splitMatrixCellChunk,
  toChunkManifestEntry,
} from "../../lib/chunking/matrix-chunks.js";
import { runChunkPool } from "../../lib/runtime/chunk-pool.js";

export const STAGE_ID = "stage_03a_evidence_memory";
export const STAGE_TITLE = "Evidence Memory";
export const PROMPT_VERSION = "v2";

function nowIso() {
  return new Date().toISOString();
}

function normalizeMemorySources(items = []) {
  return normalizeSources(items).map((source) => ({
    ...source,
    groundedByProvider: false,
    groundedSetAvailable: false,
    groundingConfidence: "memory",
  }));
}

function computeGroundingPropagation(units = []) {
  const distribution = {};
  let totalSources = 0;
  let groundedByProviderTrue = 0;
  let groundedByProviderFalse = 0;
  ensureArray(units).forEach((unit) => {
    ensureArray(unit?.sources).forEach((source) => {
      totalSources += 1;
      if (source?.groundedByProvider === true) groundedByProviderTrue += 1;
      else groundedByProviderFalse += 1;
      const confidence = clean(source?.groundingConfidence || "unspecified").toLowerCase();
      distribution[confidence] = Number(distribution[confidence] || 0) + 1;
    });
  });
  return {
    stage: STAGE_ID,
    totalSources,
    groundedByProviderTrue,
    groundedByProviderFalse,
    groundingConfidenceDistribution: distribution,
  };
}

function normalizeScorecardEvidence(parsed = {}, dimensions = [], confidenceStats = { coerced: 0 }) {
  const byId = new Map((ensureArray(parsed?.dimensions)).map((item) => [clean(item?.id || item?.unitId), item]));
  return dimensions.map((dim) => {
    const unit = byId.get(dim.id) || {};
    return {
      id: dim.id,
      brief: clean(unit?.brief || unit?.summary),
      full: clean(unit?.full || unit?.analysis),
      value: clean(unit?.value),
      confidence: normalizeConfidence(unit?.confidence, confidenceStats),
      confidenceReason: clean(unit?.confidenceReason),
      sources: normalizeMemorySources(unit?.sources || []),
      arguments: normalizeArguments(unit?.arguments || {}, `${dim.id}-mem`),
      risks: clean(unit?.risks),
      missingEvidence: clean(unit?.missingEvidence),
    };
  });
}

function normalizeMatrixCellsForChunk(parsed = {}, chunk = {}, confidenceStats = { coerced: 0 }) {
  const rawCells = ensureArray(parsed?.cells);
  const byKey = new Map(rawCells.map((cell) => [
    `${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`,
    cell,
  ]));

  return ensureArray(chunk?.cells).map((target) => {
    const key = `${target.subjectId}::${target.attributeId}`;
    const source = byKey.get(key) || {};
    return {
      subjectId: target.subjectId,
      attributeId: target.attributeId,
      value: clean(source?.value),
      full: clean(source?.full || source?.analysis),
      confidence: normalizeConfidence(source?.confidence, confidenceStats),
      confidenceReason: clean(source?.confidenceReason),
      sources: normalizeMemorySources(source?.sources || []),
      arguments: normalizeArguments(source?.arguments || {}, `${target.subjectId}-${target.attributeId}-mem`),
      risks: clean(source?.risks),
      missingEvidence: clean(source?.missingEvidence),
    };
  });
}

function buildMatrixChunkPrompt(state = {}, chunk = {}, subjectsById = new Map(), attributesById = new Map()) {
  const cells = ensureArray(chunk?.cells);
  const uniqueSubjectLines = [...new Set(
    cells
      .map((cell) => cell?.subjectId)
      .filter(Boolean)
      .map((subjectId) => {
        const subject = subjectsById.get(subjectId) || {};
        return `- ${subjectId}: ${clean(subject?.label) || subjectId}`;
      })
  )].join("\n");
  const uniqueAttributeLines = [...new Set(
    cells
      .map((cell) => cell?.attributeId)
      .filter(Boolean)
      .map((attributeId) => {
        const attribute = attributesById.get(attributeId) || {};
        const brief = clean(attribute?.brief);
        return `- ${attributeId}: ${clean(attribute?.label) || attributeId}${brief ? ` - ${brief}` : ""}`;
      })
  )].join("\n");
  const cellLines = cells
    .map((cell) => {
      const subject = subjectsById.get(cell.subjectId) || {};
      const attribute = attributesById.get(cell.attributeId) || {};
      const brief = clean(attribute?.brief);
      return `- subjectId=${cell.subjectId}; attributeId=${cell.attributeId} (${clean(subject?.label) || cell.subjectId} x ${clean(attribute?.label) || cell.attributeId})${brief ? ` | brief: ${brief}` : ""}`;
    })
    .join("\n");

  return `Objective: ${clean(state?.request?.objective)}
Build MEMORY-ONLY matrix evidence for the provided cells.
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Subjects in this chunk:
${uniqueSubjectLines || "- none"}
Attributes in this chunk:
${uniqueAttributeLines || "- none"}
Cells to cover:
${cellLines || "- none"}

Rules:
- Cover every listed cell exactly once.
- Use only model memory and prior knowledge; do not fabricate sources.
- Lead with specific known facts. Confidence should reflect evidence depth, not citation quantity.
- Return confidence as one of these strings only: high, medium, low. Do not return numbers.
- If uncertain, lower confidence and explain what is missing.
- If you are not certain a public URL is correct, omit the URL instead of guessing.
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
}

function summarizeChunkEvents(trace = []) {
  const events = ensureArray(trace);
  const started = events.filter((entry) => entry?.event === "started").length;
  const completed = events.filter((entry) => entry?.event === "completed").length;
  const failed = events.filter((entry) => entry?.event === "failed").length;
  const retries = events.filter((entry) => entry?.event === "retried").length;
  const splitDepthMax = events.reduce((maxDepth, entry) => {
    const depth = Number(entry?.depth || 0);
    return depth > maxDepth ? depth : maxDepth;
  }, 0);
  return {
    chunksStarted: started,
    chunksCompleted: completed,
    chunksFailed: failed,
    chunkRetriesTotal: retries,
    chunkSplitDepthMax: splitDepthMax,
  };
}

async function gatherMatrixChunk({
  state,
  runtime,
  subjects,
  attributes,
}) {
  const limits = runtime?.config?.limits || {};
  const cellsPerChunk = Math.max(1, Number(limits?.matrixCellsPerChunk || 12));
  const { chunks: rootChunks, allCells } = createInitialMatrixCellChunks({
    subjects,
    attributes,
    cellsPerChunk,
  });
  const subjectsById = new Map(subjects.map((subject) => [clean(subject?.id), subject]));
  const attributesById = new Map(attributes.map((attribute) => [clean(attribute?.id), attribute]));

  const manifestMap = new Map(rootChunks.map((chunk) => [chunk.chunkId, toChunkManifestEntry(chunk)]));
  const cellsByKey = new Map();
  const reasonCodes = [];
  const diagnostics = [];
  const chunkTrace = [];
  const envConcurrency = Number(globalThis?.process?.env?.RESEARCHIT_STAGE_03A_CHUNK_CONCURRENCY || 0);
  const chunkConcurrency = Math.max(
    1,
    Number(runtime?.budgets?.[STAGE_ID]?.chunkConcurrency || envConcurrency || 4)
  );

  const pool = await runChunkPool({
    initialChunks: rootChunks,
    concurrency: chunkConcurrency,
    processChunk: async (current) => {
      const prompt = buildMatrixChunkPrompt(state, current, subjectsById, attributesById);
      chunkTrace.push({
        chunkId: current.chunkId,
        event: "started",
        timestamp: nowIso(),
        depth: Number(current?.depth || 0),
        cellCount: ensureArray(current?.cells).length,
      });
      try {
        const result = await callActorJson({
          state,
          runtime,
          stageId: STAGE_ID,
          actor: "analyst",
          systemPrompt: runtime?.prompts?.analyst || "You produce memory-only matrix evidence.",
          userPrompt: prompt,
          tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 24000,
          timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 180000,
          maxRetries: 1,
          liveSearch: false,
          callContext: {
            chunkId: current.chunkId,
            promptVersion: PROMPT_VERSION,
          },
          schemaHint: '{"cells":[{"subjectId":"","attributeId":"","value":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
        });

        const confidenceStats = { coerced: 0 };
        const normalizedCells = normalizeMatrixCellsForChunk(result?.parsed, current, confidenceStats);
        normalizedCells.forEach((cell) => {
          cellsByKey.set(`${cell.subjectId}::${cell.attributeId}`, cell);
        });

        const tokenDiagnostics = {
          ...(result?.tokenDiagnostics || {}),
          confidenceScaleCoerced: Number(confidenceStats.coerced || 0),
        };
        const chunkReasonCodes = [
          ...ensureArray(result?.reasonCodes),
          ...(confidenceStats.coerced > 0 ? [REASON_CODES.CONFIDENCE_SCALE_COERCED] : []),
        ];
        reasonCodes.push(...chunkReasonCodes);

        const retryCount = Number(result?.retries || 0);
        for (let retryIndex = 1; retryIndex <= retryCount; retryIndex += 1) {
          chunkTrace.push({
            chunkId: current.chunkId,
            event: "retried",
            timestamp: nowIso(),
            retryIndex,
            reason: "call_retry",
            depth: Number(current?.depth || 0),
          });
        }

        chunkTrace.push({
          chunkId: current.chunkId,
          event: "completed",
          timestamp: nowIso(),
          depth: Number(current?.depth || 0),
          outputSize: normalizedCells.length,
          outputTokens: Number(tokenDiagnostics?.outputTokens || 0),
          finishReason: clean(tokenDiagnostics?.finishReason) || "unknown",
        });

        diagnostics.push({
          chunkId: current.chunkId,
          parentId: current.parentId || null,
          depth: Number(current?.depth || 0),
          cellCount: ensureArray(current?.cells).length,
          retries: retryCount,
          tokenDiagnostics,
          modelRoute: result.route,
        });
        return {};
      } catch (err) {
        chunkTrace.push({
          chunkId: current.chunkId,
          event: "failed",
          timestamp: nowIso(),
          depth: Number(current?.depth || 0),
          error: clean(err?.message || "chunk_failure"),
          abortReason: err?.abortReason || null,
          finishReason: clean(err?.finishReason) || "unknown",
        });
        if (ensureArray(current?.cells).length <= 1) {
          err.chunkId = clean(current?.chunkId) || null;
          err.chunkDepth = Number(current?.depth || 0);
          err.chunkSplitDepthMax = Math.max(Number(err?.chunkSplitDepthMax || 0), Number(current?.depth || 0));
          err.chunkSplitExhausted = Number(current?.depth || 0) > 0;
          throw err;
        }
        const children = splitMatrixCellChunk(current);
        if (!children.length) throw err;
        children.forEach((child) => {
          manifestMap.set(child.chunkId, toChunkManifestEntry(child));
        });
        chunkTrace.push({
          chunkId: current.chunkId,
          event: "split",
          timestamp: nowIso(),
          depth: Number(current?.depth || 0),
          parentId: current.chunkId,
          childIds: children.map((child) => child.chunkId),
          reason: clean(err?.reasonCode || err?.message || "chunk_failure"),
        });
        diagnostics.push({
          chunkId: current.chunkId,
          parentId: current.parentId || null,
          depth: Number(current?.depth || 0),
          cellCount: ensureArray(current?.cells).length,
          splitInto: children.map((child) => child.chunkId),
          splitReason: clean(err?.reasonCode || err?.message || "chunk_failure"),
          error: clean(err?.message || "chunk_failure"),
          abortReason: err?.abortReason || null,
        });
        return {
          children,
          enqueueFront: true,
        };
      }
    },
  });

  const completedCells = allCells.map((cell) => (
    cellsByKey.get(cell.key) || {
      subjectId: cell.subjectId,
      attributeId: cell.attributeId,
      value: "",
      full: "",
      confidence: "low",
      confidenceReason: "No evidence returned for this cell.",
      sources: [],
      arguments: { supporting: [], limiting: [] },
      risks: "",
      missingEvidence: "No evidence returned.",
    }
  ));
  const aggregatedTokens = combineTokenDiagnostics(
    diagnostics.map((entry) => entry?.tokenDiagnostics).filter(Boolean)
  );
  const modelRoute = diagnostics.find((entry) => entry?.modelRoute)?.modelRoute || null;
  diagnostics.sort((a, b) => String(a?.chunkId || "").localeCompare(String(b?.chunkId || "")));
  chunkTrace.sort((a, b) => {
    const chunkCmp = String(a?.chunkId || "").localeCompare(String(b?.chunkId || ""));
    if (chunkCmp !== 0) return chunkCmp;
    return String(a?.event || "").localeCompare(String(b?.event || ""));
  });

  return {
    cells: completedCells,
    reasonCodes: normalizeReasonCodes(reasonCodes),
    diagnostics,
    chunkTrace,
    chunkManifest: makeChunkManifest([...manifestMap.values()]),
    tokenDiagnostics: aggregatedTokens,
    modelRoute,
    chunkConcurrency,
    peakWorkerCount: Number(pool?.peakWorkerCount || 0),
  };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;

  if (state?.outputType === "matrix") {
    const subjects = ensureArray(state?.request?.matrix?.subjects);
    const attributes = ensureArray(state?.request?.matrix?.attributes);
    const matrix = await gatherMatrixChunk({
      state,
      runtime,
      subjects,
      attributes,
    });
    const chunkSummary = summarizeChunkEvents(matrix.chunkTrace);
    return {
      stageStatus: "ok",
      reasonCodes: matrix.reasonCodes,
      statePatch: {
        ui: { phase: STAGE_ID },
        chunkManifest: {
          ...(state?.chunkManifest || {}),
          [STAGE_ID]: matrix.chunkManifest,
        },
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
        chunkTrace: matrix.chunkTrace,
        chunkManifest: matrix.chunkManifest,
        chunkTruncationRate: Number(matrix?.tokenDiagnostics?.outputTruncatedRate || 0),
        chunkConcurrency: Number(matrix?.chunkConcurrency || 1),
        peakWorkerCount: Number(matrix?.peakWorkerCount || 1),
        groundingPropagation: computeGroundingPropagation(matrix.cells),
        ...chunkSummary,
        retries: Number(matrix?.tokenDiagnostics?.retries || 0),
        tokenDiagnostics: matrix.tokenDiagnostics,
        modelRoute: matrix.modelRoute,
      },
      modelRoute: matrix.modelRoute,
      tokens: matrix.tokenDiagnostics,
      retries: Number(matrix?.tokenDiagnostics?.retries || 0),
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
- Lead with specific known facts. Confidence should reflect evidence depth, not citation quantity.
- Return confidence as one of these strings only: high, medium, low. Do not return numbers.
- Example: {"confidence":"high"}
- If uncertain, lower confidence and explain what is missing.
- If you are not certain a public URL is correct, omit the URL instead of guessing.
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
    callContext: {
      chunkId: "scorecard",
      promptVersion: PROMPT_VERSION,
    },
    schemaHint: '{"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
  });

  const confidenceStats = { coerced: 0 };
  const normalized = normalizeScorecardEvidence(result?.parsed, dimensions, confidenceStats);
  const reasonCodes = [
    ...ensureArray(result?.reasonCodes),
    ...(confidenceStats.coerced > 0 ? [REASON_CODES.CONFIDENCE_SCALE_COERCED] : []),
  ];
  const tokenDiagnostics = {
    ...(result?.tokenDiagnostics || {}),
    confidenceScaleCoerced: Number(confidenceStats.coerced || 0),
  };
  return {
    stageStatus: "ok",
    reasonCodes: normalizeReasonCodes(reasonCodes),
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
      groundingPropagation: computeGroundingPropagation(normalized),
      retries: result.retries,
      tokenDiagnostics,
      modelRoute: result.route,
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
