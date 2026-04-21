import {
  annotateSourcesWithGrounding,
  callActorJson,
  clean,
  combineTokenDiagnostics,
  ensureArray,
  fabricationAssessmentFromSources,
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

export const STAGE_ID = "stage_03b_evidence_web";
export const STAGE_TITLE = "Evidence Web";
export const PROMPT_VERSION = "v2";

function nowIso() {
  return new Date().toISOString();
}

function confidenceRank(value = "") {
  const normalized = normalizeConfidence(value);
  if (normalized === "high") return 3;
  if (normalized === "medium") return 2;
  return 1;
}

function mergeConfidence(memoryConfidence, webConfidence) {
  const memory = normalizeConfidence(memoryConfidence);
  const web = normalizeConfidence(webConfidence);
  return confidenceRank(web) >= confidenceRank(memory) ? web : memory;
}

function mergeConfidenceReason(memoryReason = "", webReason = "") {
  const parts = [clean(memoryReason), clean(webReason)].filter(Boolean);
  if (!parts.length) return "";
  return [...new Set(parts)].join(" | ");
}

function mergeSourceLists(a = [], b = []) {
  const map = new Map();
  [...ensureArray(a), ...ensureArray(b)].forEach((source) => {
    const key = `${clean(source?.name)}|${clean(source?.url)}|${clean(source?.quote)}`;
    if (!key.replace(/\|/g, "")) return;
    if (!map.has(key)) map.set(key, source);
  });
  return [...map.values()];
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
    groundedRatio: totalUrls > 0 ? (groundedUrls / totalUrls) : 1,
  };
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

function computeFabricationSignalForMergedSources(sources = []) {
  const list = normalizeSources(sources);
  const groundedSetAvailable = list.some((source) => source?.groundedSetAvailable === true);
  const groundedCount = list.filter((source) => source?.groundedByProvider === true).length;
  const assessment = fabricationAssessmentFromSources(list, {
    liveSearchUsed: groundedSetAvailable,
    groundedSourceCount: groundedSetAvailable ? Math.max(1, groundedCount) : 0,
  });
  return assessment;
}

function mergeScorecard(memory = [], web = []) {
  const webById = new Map(web.map((unit) => [clean(unit?.id), unit]));
  return memory.map((unit) => {
    const patch = webById.get(unit.id) || {};
    const mergedSources = mergeSourceLists(unit?.sources, patch?.sources);
    const fabricationAssessment = computeFabricationSignalForMergedSources(mergedSources);
    return {
      ...unit,
      brief: clean(patch?.brief || unit?.brief),
      full: clean(patch?.full || unit?.full),
      confidence: mergeConfidence(unit?.confidence, patch?.confidence),
      confidenceReason: mergeConfidenceReason(unit?.confidenceReason, patch?.confidenceReason),
      sources: mergedSources,
      fabricationSignal: clean(patch?.fabricationSignal || unit?.fabricationSignal)
        || fabricationAssessment.signal,
      fabricationSignalReason: clean(patch?.fabricationSignalReason || unit?.fabricationSignalReason)
        || fabricationAssessment.reason,
      arguments: {
        supporting: [...ensureArray(unit?.arguments?.supporting), ...ensureArray(patch?.arguments?.supporting)],
        limiting: [...ensureArray(unit?.arguments?.limiting), ...ensureArray(patch?.arguments?.limiting)],
      },
      risks: clean(patch?.risks || unit?.risks),
      missingEvidence: clean(patch?.missingEvidence || unit?.missingEvidence),
    };
  });
}

function mergeMatrixCells(memory = [], web = []) {
  const webByKey = new Map(web.map((cell) => [`${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`, cell]));
  return memory.map((cell) => {
    const patch = webByKey.get(`${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`) || {};
    const mergedSources = mergeSourceLists(cell?.sources, patch?.sources);
    const fabricationAssessment = computeFabricationSignalForMergedSources(mergedSources);
    return {
      ...cell,
      value: clean(patch?.value || cell?.value),
      full: clean(patch?.full || cell?.full),
      confidence: mergeConfidence(cell?.confidence, patch?.confidence),
      confidenceReason: mergeConfidenceReason(cell?.confidenceReason, patch?.confidenceReason),
      sources: mergedSources,
      fabricationSignal: clean(patch?.fabricationSignal || cell?.fabricationSignal)
        || fabricationAssessment.signal,
      fabricationSignalReason: clean(patch?.fabricationSignalReason || cell?.fabricationSignalReason)
        || fabricationAssessment.reason,
      arguments: {
        supporting: [...ensureArray(cell?.arguments?.supporting), ...ensureArray(patch?.arguments?.supporting)],
        limiting: [...ensureArray(cell?.arguments?.limiting), ...ensureArray(patch?.arguments?.limiting)],
      },
      risks: clean(patch?.risks || cell?.risks),
      missingEvidence: clean(patch?.missingEvidence || cell?.missingEvidence),
    };
  });
}

function normalizeScorecard(parsed = {}, dimensions = [], options = {}) {
  const byId = new Map(ensureArray(parsed?.dimensions).map((item) => [clean(item?.id || item?.unitId), item]));
  const groundedSources = ensureArray(options?.groundedSources);
  const confidenceStats = options?.confidenceStats || { coerced: 0 };
  const providerGroundedCount = groundedSources.length;
  const liveSearchUsed = options?.liveSearchUsed === true;
  const callFailedGrounding = options?.callFailedGrounding === true;

  return dimensions.map((dim) => {
    const unit = byId.get(dim.id) || {};
    const grounded = annotateSourcesWithGrounding(unit?.sources || [], groundedSources);
    const fabricationAssessment = fabricationAssessmentFromSources(grounded.sources, {
      liveSearchUsed,
      groundedSourceCount: providerGroundedCount,
      callFailedGrounding,
    });
    const sourcesWithSignal = grounded.sources.map((source) => ({
      ...source,
      groundingConfidence: source?.groundedByProvider === true ? "provider" : "model-emitted",
      fabricationSignal: fabricationAssessment.signal,
      fabricationSignalReason: fabricationAssessment.reason || undefined,
    }));
    return {
      id: dim.id,
      brief: clean(unit?.brief),
      full: clean(unit?.full),
      confidence: normalizeConfidence(unit?.confidence, confidenceStats),
      confidenceReason: clean(unit?.confidenceReason),
      sources: sourcesWithSignal,
      fabricationSignal: fabricationAssessment.signal,
      fabricationSignalReason: fabricationAssessment.reason,
      arguments: normalizeArguments(unit?.arguments || {}, `${dim.id}-web`),
      risks: clean(unit?.risks),
      missingEvidence: clean(unit?.missingEvidence),
    };
  });
}

function normalizeMatrixChunk(parsed = {}, chunk = {}, options = {}) {
  const byKey = new Map(ensureArray(parsed?.cells).map((item) => [`${clean(item?.subjectId)}::${clean(item?.attributeId)}`, item]));
  const groundedSources = ensureArray(options?.groundedSources);
  const confidenceStats = options?.confidenceStats || { coerced: 0 };
  const providerGroundedCount = groundedSources.length;
  const liveSearchUsed = options?.liveSearchUsed === true;
  const callFailedGrounding = options?.callFailedGrounding === true;

  return ensureArray(chunk?.cells).map((cell) => {
    const patch = byKey.get(`${cell.subjectId}::${cell.attributeId}`) || {};
    const grounded = annotateSourcesWithGrounding(patch?.sources || [], groundedSources);
    const fabricationAssessment = fabricationAssessmentFromSources(grounded.sources, {
      liveSearchUsed,
      groundedSourceCount: providerGroundedCount,
      callFailedGrounding,
    });
    const sourcesWithSignal = grounded.sources.map((source) => ({
      ...source,
      groundingConfidence: source?.groundedByProvider === true ? "provider" : "model-emitted",
      fabricationSignal: fabricationAssessment.signal,
      fabricationSignalReason: fabricationAssessment.reason || undefined,
    }));
    return {
      subjectId: cell.subjectId,
      attributeId: cell.attributeId,
      value: clean(patch?.value),
      full: clean(patch?.full),
      confidence: normalizeConfidence(patch?.confidence, confidenceStats),
      confidenceReason: clean(patch?.confidenceReason),
      sources: sourcesWithSignal,
      fabricationSignal: fabricationAssessment.signal,
      fabricationSignalReason: fabricationAssessment.reason,
      arguments: normalizeArguments(patch?.arguments || {}, `${cell.subjectId}-${cell.attributeId}-web`),
      risks: clean(patch?.risks),
      missingEvidence: clean(patch?.missingEvidence),
    };
  });
}

function normalizeUrlKey(value = "") {
  const raw = clean(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const path = clean(parsed.pathname).replace(/\/+$/, "") || "/";
    return `${clean(parsed.hostname).toLowerCase()}${path}${clean(parsed.search)}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

function buildMatrixContextBlock(chunk = {}, subjectsById = new Map(), attributesById = new Map()) {
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
      const cellKey = `${cell.subjectId}::${cell.attributeId}`;
      return `- cellKey=${cellKey}; subjectId=${cell.subjectId}; attributeId=${cell.attributeId} (${clean(subject?.label) || cell.subjectId} x ${clean(attribute?.label) || cell.attributeId})${brief ? ` | brief: ${brief}` : ""}`;
    })
    .join("\n");

  return {
    uniqueSubjectLines,
    uniqueAttributeLines,
    cellLines,
  };
}

function buildMatrixRetrievePrompt(state = {}, chunk = {}, subjectsById = new Map(), attributesById = new Map()) {
  const {
    uniqueSubjectLines,
    uniqueAttributeLines,
    cellLines,
  } = buildMatrixContextBlock(chunk, subjectsById, attributesById);

  return `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Stage 03b retrieve pass. Propose targeted web-search queries per listed cell.
Subjects in this chunk:
${uniqueSubjectLines || "- none"}
Attributes in this chunk:
${uniqueAttributeLines || "- none"}
Cells to cover:
${cellLines || "- none"}

Rules:
- Return queries only; do not return evidence, scores, or sources.
- You must call google_search while generating this output.
- Provide 1-2 precise queries per cellKey.

Return JSON {"queries":[{"cellKey":"","query":"","rationale":""}]}`;
}

function buildMatrixReadPrompt(state = {}, chunk = {}, subjectsById = new Map(), attributesById = new Map(), corpus = []) {
  const {
    uniqueSubjectLines,
    uniqueAttributeLines,
    cellLines,
  } = buildMatrixContextBlock(chunk, subjectsById, attributesById);
  const corpusLines = ensureArray(corpus).map((entry) => (
    `- corpusId=${entry.corpusId}; url=${entry.url}; title=${entry.title}${clean(entry?.query) ? `; query=${clean(entry.query)}` : ""}`
  )).join("\n");

  return `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Stage 03b read pass. Build matrix evidence using ONLY the retrieved corpus.
Subjects in this chunk:
${uniqueSubjectLines || "- none"}
Attributes in this chunk:
${uniqueAttributeLines || "- none"}
Cells to cover:
${cellLines || "- none"}
Retrieved corpus:
${corpusLines || "- none"}

Rules:
- Cover every listed cell exactly once.
- Use only retrieved corpus entries for citations.
- Every source item MUST include corpusId that exists in Retrieved corpus.
- If no corpus entry supports the claim, keep sources empty and explain in missingEvidence.
- Return confidence as one of these strings only: high, medium, low. Do not return numbers.
- sourceType must be one of: independent, research, news, analyst, government, registry, vendor, press_release, marketing.

Return JSON {"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[{"corpusId":"","name":"","quote":"","sourceType":""}],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;
}

function buildRetrievedCorpus(groundedSources = [], chunkId = "") {
  const dedup = new Map();
  ensureArray(groundedSources).forEach((source, idx) => {
    const url = clean(source?.url);
    if (!url) return;
    const key = normalizeUrlKey(url);
    if (!key) return;
    if (dedup.has(key)) return;
    const corpusId = `${clean(chunkId) || "chunk"}-src-${String(dedup.size + 1).padStart(2, "0")}`;
    dedup.set(key, {
      corpusId,
      url,
      canonicalUrl: url,
      title: clean(source?.title || source?.name || `Retrieved source ${idx + 1}`) || `Retrieved source ${idx + 1}`,
      query: clean(source?.query),
      rank: dedup.size + 1,
      retrievedAt: new Date().toISOString(),
    });
  });
  const entries = [...dedup.values()];
  const byId = new Map(entries.map((entry) => [entry.corpusId, entry]));
  return {
    entries,
    byId,
  };
}

function normalizeMatrixReadChunk(parsed = {}, chunk = {}, corpusById = new Map(), confidenceStats = { coerced: 0 }, diagnostics = {}) {
  const byKey = new Map(ensureArray(parsed?.cells).map((item) => [`${clean(item?.subjectId)}::${clean(item?.attributeId)}`, item]));
  const corpusByUrlKey = new Map(
    [...(corpusById?.values ? corpusById.values() : [])]
      .map((entry) => [normalizeUrlKey(entry?.url), entry])
      .filter(([key]) => !!key)
  );
  return ensureArray(chunk?.cells).map((cell) => {
    const patch = byKey.get(`${cell.subjectId}::${cell.attributeId}`) || {};
    const rawSources = ensureArray(patch?.sources);
    const sources = [];
    rawSources.forEach((source) => {
      const corpusId = clean(source?.corpusId);
      let corpus = corpusById.get(corpusId);
      if (!corpus) {
        corpus = corpusByUrlKey.get(normalizeUrlKey(source?.url));
      }
      if (!corpus) {
        diagnostics.sourceAbsentFromCorpus = Number(diagnostics.sourceAbsentFromCorpus || 0) + 1;
        return;
      }
      sources.push({
        name: clean(source?.name || corpus?.title) || "Retrieved source",
        url: clean(corpus?.url),
        quote: clean(source?.quote),
        sourceType: clean(source?.sourceType).toLowerCase() || "independent",
        corpusId: clean(corpus?.corpusId || corpusId),
        groundedByProvider: true,
        groundedSetAvailable: true,
        groundingConfidence: "provider",
      });
    });
    const fabricationAssessment = computeFabricationSignalForMergedSources(sources);
    const sourcesWithSignal = sources.map((source) => ({
      ...source,
      fabricationSignal: fabricationAssessment.signal,
      fabricationSignalReason: fabricationAssessment.reason || undefined,
    }));

    return {
      subjectId: cell.subjectId,
      attributeId: cell.attributeId,
      value: clean(patch?.value),
      full: clean(patch?.full),
      confidence: normalizeConfidence(patch?.confidence, confidenceStats),
      confidenceReason: clean(patch?.confidenceReason),
      sources: sourcesWithSignal,
      fabricationSignal: fabricationAssessment.signal,
      fabricationSignalReason: fabricationAssessment.reason,
      arguments: normalizeArguments(patch?.arguments || {}, `${cell.subjectId}-${cell.attributeId}-web`),
      risks: clean(patch?.risks),
      missingEvidence: clean(patch?.missingEvidence),
    };
  });
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

async function gatherMatrixWeb({
  state,
  runtime,
  subjects,
  attributes,
}) {
  const limits = runtime?.config?.limits || {};
  const cellsPerChunk = Math.max(1, Number(limits?.matrixWebCellsPerChunk || limits?.matrixCellsPerChunk || 12));
  const { chunks: rootChunks, allCells } = createInitialMatrixCellChunks({
    subjects,
    attributes,
    cellsPerChunk,
  });
  const subjectsById = new Map(subjects.map((subject) => [clean(subject?.id), subject]));
  const attributesById = new Map(attributes.map((attribute) => [clean(attribute?.id), attribute]));

  const queue = [...rootChunks];
  const manifestMap = new Map(rootChunks.map((chunk) => [chunk.chunkId, toChunkManifestEntry(chunk)]));
  const cellsByKey = new Map();
  const reasonCodes = [];
  const diagnostics = [];
  const chunkTrace = [];
  const envConcurrency = Number(globalThis?.process?.env?.RESEARCHIT_STAGE_03B_CHUNK_CONCURRENCY || 0);
  const chunkConcurrency = Math.max(
    1,
    Number(runtime?.budgets?.[STAGE_ID]?.chunkConcurrency || envConcurrency || 3)
  );
  const pool = await runChunkPool({
    initialChunks: queue,
    concurrency: chunkConcurrency,
    processChunk: async (current) => {
      const retrievePrompt = buildMatrixRetrievePrompt(state, current, subjectsById, attributesById);
      chunkTrace.push({
        chunkId: current.chunkId,
        event: "started",
        timestamp: nowIso(),
        depth: Number(current?.depth || 0),
        cellCount: ensureArray(current?.cells).length,
      });
      try {
        const retrieveResult = await callActorJson({
          state,
          runtime,
          stageId: STAGE_ID,
          actor: "analyst",
          systemPrompt: runtime?.prompts?.analyst || "You produce retrieval query plans.",
          userPrompt: retrievePrompt,
          tokenBudget: Math.max(3000, Math.floor((runtime?.budgets?.[STAGE_ID]?.tokenBudget || 28000) * 0.35)),
          timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 150000,
          maxRetries: 1,
          liveSearch: true,
          callContext: {
            chunkId: `${current.chunkId}-retrieve`,
            promptVersion: PROMPT_VERSION,
          },
          schemaHint: '{"queries":[{"cellKey":"","query":"","rationale":""}]}',
        });

        if (retrieveResult?.meta?.noSearchPerformed === true && current?.searchRetryAttempted !== true) {
          reasonCodes.push(REASON_CODES.STAGE_03B_NO_SEARCH_PERFORMED);
          chunkTrace.push({
            chunkId: current.chunkId,
            event: "retried",
            timestamp: nowIso(),
            retryIndex: 1,
            reason: "no_search_performed",
            depth: Number(current?.depth || 0),
          });
          diagnostics.push({
            chunkId: current.chunkId,
            parentId: current.parentId || null,
            depth: Number(current?.depth || 0),
            cellCount: ensureArray(current?.cells).length,
            retries: Number(retrieveResult?.retries || 0),
            tokenDiagnostics: {
              ...(retrieveResult?.tokenDiagnostics || {}),
              noSearchPerformed: true,
            },
            retrieveModelRoute: retrieveResult.route,
            modelRoute: retrieveResult.route,
            citations: computeGroundingCoverage([]),
            groundedSourcesResolved: retrieveResult?.meta?.groundedSourcesResolved || null,
            noSearchPerformed: true,
          });
          return {
            children: [{ ...current, searchRetryAttempted: true }],
            enqueueFront: true,
          };
        }
        if (retrieveResult?.meta?.noSearchPerformed === true && current?.searchRetryAttempted === true) {
          const noSearchErr = new Error("No google_search calls were performed for this chunk.");
          noSearchErr.reasonCode = REASON_CODES.STAGE_03B_NO_SEARCH_PERFORMED;
          throw noSearchErr;
        }

        const retrievedCorpus = buildRetrievedCorpus(retrieveResult?.meta?.groundedSources || [], current.chunkId);
        const readPrompt = buildMatrixReadPrompt(state, current, subjectsById, attributesById, retrievedCorpus.entries);
        const readResult = await callActorJson({
          state,
          runtime,
          stageId: STAGE_ID,
          actor: "analyst",
          systemPrompt: runtime?.prompts?.analyst || "You produce web-backed evidence from a fixed corpus.",
          userPrompt: readPrompt,
          tokenBudget: Math.max(6000, Math.floor((runtime?.budgets?.[STAGE_ID]?.tokenBudget || 28000) * 0.75)),
          timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 150000,
          maxRetries: 1,
          liveSearch: false,
          callContext: {
            chunkId: `${current.chunkId}-read`,
            promptVersion: PROMPT_VERSION,
          },
          schemaHint: '{"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[{"corpusId":"","name":"","quote":"","sourceType":""}],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
        });

        const confidenceStats = { coerced: 0 };
        const corpusDiagnostics = { sourceAbsentFromCorpus: 0 };
        const normalizedChunk = normalizeMatrixReadChunk(
          readResult?.parsed,
          current,
          retrievedCorpus.byId,
          confidenceStats,
          corpusDiagnostics
        );
        normalizedChunk.forEach((cell) => {
          cellsByKey.set(`${cell.subjectId}::${cell.attributeId}`, cell);
        });

        const tokenDiagnostics = combineTokenDiagnostics([
          retrieveResult?.tokenDiagnostics,
          readResult?.tokenDiagnostics,
        ]) || {};
        tokenDiagnostics.confidenceScaleCoerced = Number(confidenceStats.coerced || 0);
        const chunkReasonCodes = [
          ...ensureArray(retrieveResult?.reasonCodes),
          ...ensureArray(readResult?.reasonCodes),
          ...(confidenceStats.coerced > 0 ? [REASON_CODES.CONFIDENCE_SCALE_COERCED] : []),
          ...(Number(corpusDiagnostics?.sourceAbsentFromCorpus || 0) > 0 ? [REASON_CODES.SOURCE_ABSENT_FROM_CORPUS] : []),
        ];
        reasonCodes.push(...chunkReasonCodes);

        const retryCount = Number(retrieveResult?.retries || 0) + Number(readResult?.retries || 0);
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
          outputSize: normalizedChunk.length,
          outputTokens: Number(tokenDiagnostics?.outputTokens || readResult?.tokenDiagnostics?.outputTokens || 0),
          finishReason: clean(tokenDiagnostics?.finishReason) || "unknown",
        });
        diagnostics.push({
          chunkId: current.chunkId,
          parentId: current.parentId || null,
          depth: Number(current?.depth || 0),
          cellCount: ensureArray(current?.cells).length,
          retries: retryCount,
          tokenDiagnostics,
          retrieveTokenDiagnostics: retrieveResult?.tokenDiagnostics || null,
          readTokenDiagnostics: readResult?.tokenDiagnostics || null,
          retrieveModelRoute: retrieveResult.route,
          readModelRoute: readResult.route,
          modelRoute: readResult.route || retrieveResult.route,
          citations: computeGroundingCoverage(normalizedChunk),
          groundedSourcesResolved: retrieveResult?.meta?.groundedSourcesResolved || null,
          retrievedCorpusCount: retrievedCorpus.entries.length,
          sourceAbsentFromCorpus: Number(corpusDiagnostics?.sourceAbsentFromCorpus || 0),
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
      confidenceReason: "No web evidence returned for this cell.",
      sources: [],
      fabricationSignal: "high",
      arguments: { supporting: [], limiting: [] },
      risks: "",
      missingEvidence: "No web evidence returned.",
    }
  ));
  const allDiagnostics = diagnostics;
  const citationAggregate = allDiagnostics.reduce((acc, item) => {
    const stats = item?.citations || {};
    acc.totalUrls += Number(stats?.totalUrls || 0);
    acc.groundedUrls += Number(stats?.groundedUrls || 0);
    return acc;
  }, { totalUrls: 0, groundedUrls: 0 });
  const groundedSourcesResolved = allDiagnostics.reduce((acc, item) => {
    const stats = item?.groundedSourcesResolved || {};
    acc.total += Number(stats?.total || 0);
    acc.resolved += Number(stats?.resolved || 0);
    acc.unresolved += Number(stats?.unresolved || 0);
    return acc;
  }, { total: 0, resolved: 0, unresolved: 0 });
  const retrievedCorpusCount = allDiagnostics.reduce((sum, item) => sum + Number(item?.retrievedCorpusCount || 0), 0);
  const sourceAbsentFromCorpus = allDiagnostics.reduce((sum, item) => sum + Number(item?.sourceAbsentFromCorpus || 0), 0);
  const retrieveWebSearchCalls = allDiagnostics.reduce((sum, item) => (
    sum + Number(item?.retrieveTokenDiagnostics?.webSearchCalls || 0)
  ), 0);
  const readWebSearchCalls = allDiagnostics.reduce((sum, item) => (
    sum + Number(item?.readTokenDiagnostics?.webSearchCalls || 0)
  ), 0);
  const tokenDiagnostics = combineTokenDiagnostics(
    allDiagnostics.map((entry) => entry?.tokenDiagnostics).filter(Boolean)
  );
  const modelRoute = allDiagnostics.find((entry) => entry?.modelRoute)?.modelRoute || null;
  allDiagnostics.sort((a, b) => String(a?.chunkId || "").localeCompare(String(b?.chunkId || "")));
  chunkTrace.sort((a, b) => {
    const chunkCmp = String(a?.chunkId || "").localeCompare(String(b?.chunkId || ""));
    if (chunkCmp !== 0) return chunkCmp;
    return String(a?.event || "").localeCompare(String(b?.event || ""));
  });

  return {
    cells: completedCells,
    reasonCodes: normalizeReasonCodes(reasonCodes),
    diagnostics: allDiagnostics,
    chunkTrace,
    chunkManifest: makeChunkManifest([...manifestMap.values()]),
    citations: {
      ...citationAggregate,
      groundedRatio: citationAggregate.totalUrls > 0 ? citationAggregate.groundedUrls / citationAggregate.totalUrls : 1,
    },
    groundedSourcesResolved,
    retrievedCorpusCount,
    sourceAbsentFromCorpus,
    retrieveWebSearchCalls,
    readWebSearchCalls,
    groundingPropagation: computeGroundingPropagation(completedCells),
    tokenDiagnostics,
    modelRoute,
    chunkConcurrency,
    peakWorkerCount: Number(pool?.peakWorkerCount || 0),
  };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const memory = state?.evidenceDrafts?.memory || {};

  if (state?.outputType === "matrix") {
    const subjects = ensureArray(state?.request?.matrix?.subjects);
    const attributes = ensureArray(state?.request?.matrix?.attributes);
    const matrixWeb = await gatherMatrixWeb({
      state,
      runtime,
      subjects,
      attributes,
    });
    const merged = mergeMatrixCells(ensureArray(memory?.matrix?.cells), matrixWeb.cells);
    const chunkSummary = summarizeChunkEvents(matrixWeb.chunkTrace);
    return {
      stageStatus: "ok",
      reasonCodes: matrixWeb.reasonCodes,
      statePatch: {
        ui: { phase: STAGE_ID },
        chunkManifest: {
          ...(state?.chunkManifest || {}),
          [STAGE_ID]: matrixWeb.chunkManifest,
        },
        evidenceDrafts: {
          web: {
            matrix: {
              cells: matrixWeb.cells,
            },
          },
          merged: {
            matrix: {
              cells: merged,
            },
          },
        },
      },
      diagnostics: {
        mode: "matrix",
        cells: merged.length,
        chunks: matrixWeb.diagnostics,
        chunkTrace: matrixWeb.chunkTrace,
        chunkManifest: matrixWeb.chunkManifest,
        chunkTruncationRate: Number(matrixWeb?.tokenDiagnostics?.outputTruncatedRate || 0),
        citations: matrixWeb.citations,
        groundedSourcesResolved: matrixWeb.groundedSourcesResolved,
        retrievedCorpusCount: Number(matrixWeb?.retrievedCorpusCount || 0),
        sourceAbsentFromCorpus: Number(matrixWeb?.sourceAbsentFromCorpus || 0),
        retrieveCalls: Number(matrixWeb?.diagnostics?.length || 0),
        readCalls: Number(matrixWeb?.diagnostics?.length || 0),
        retrieveWebSearchCalls: Number(matrixWeb?.retrieveWebSearchCalls || 0),
        readWebSearchCalls: Number(matrixWeb?.readWebSearchCalls || 0),
        groundingPropagation: matrixWeb.groundingPropagation,
        chunkConcurrency: Number(matrixWeb?.chunkConcurrency || 1),
        peakWorkerCount: Number(matrixWeb?.peakWorkerCount || 1),
        retries: Number(matrixWeb?.tokenDiagnostics?.retries || 0),
        tokenDiagnostics: matrixWeb.tokenDiagnostics,
        modelRoute: matrixWeb.modelRoute,
        ...chunkSummary,
      },
      modelRoute: matrixWeb.modelRoute,
      tokens: matrixWeb.tokenDiagnostics,
      retries: Number(matrixWeb?.tokenDiagnostics?.retries || 0),
    };
  }

  const dimensions = ensureArray(state?.request?.scorecard?.dimensions);
  const prompt = `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Collect WEB evidence and update each scorecard dimension.
Dimensions:
${dimensions.map((dim) => `- ${dim.id}: ${dim.label}${clean(dim?.brief) ? ` - ${clean(dim.brief)}` : ""}`).join("\n")}

Rules:
- Lead with specific known facts. Confidence should reflect evidence depth, not citation quantity.
- Return confidence as one of these strings only: high, medium, low. Do not return numbers.
- If uncertain, lower confidence and state what is missing.
- Use sources that can be cited with specific canonical public URLs when possible.
- Prefer independent evidence (government, research, analyst, reputable news) over vendor claims.
- For each non-empty source, include a valid https URL, concise quote/snippet, and "sourceType".
- Never return temporary grounding redirect links (for example vertexaisearch.cloud.google.com/grounding-api-redirect/...).
- If you are not certain the canonical public URL is correct, omit the URL instead of guessing.
- sourceType must be one of: independent, research, news, analyst, government, registry, vendor, press_release, marketing.
- If reliable evidence is unavailable, keep "sources" empty and explain the gap in "missingEvidence".

Return JSON {"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;

  const callScorecardWeb = async (extraRequirement = "") => callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: runtime?.prompts?.analyst || "You produce web-backed evidence by dimension.",
    userPrompt: extraRequirement ? `${prompt}\n\n${extraRequirement}` : prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 10000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 90000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 2,
    liveSearch: true,
    callContext: {
      chunkId: extraRequirement ? "scorecard-retry" : "scorecard",
      promptVersion: PROMPT_VERSION,
    },
    schemaHint: '{"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
  });

  const firstResult = await callScorecardWeb();
  let result = firstResult;
  const tokenDiagnosticsList = [firstResult?.tokenDiagnostics];
  let combinedRetries = Number(firstResult?.retries || 0);
  const stageReasonCodes = [...ensureArray(firstResult?.reasonCodes)];
  if (firstResult?.meta?.noSearchPerformed === true) {
    const retryResult = await callScorecardWeb("Mandatory requirement: call google_search for each dimension before returning sources.");
    combinedRetries += Number(retryResult?.retries || 0);
    stageReasonCodes.push(...ensureArray(retryResult?.reasonCodes));
    tokenDiagnosticsList.push(retryResult?.tokenDiagnostics);
    if (retryResult?.meta?.noSearchPerformed === true) {
      const noSearchErr = new Error("No google_search calls were performed for the scorecard web evidence pass.");
      noSearchErr.reasonCode = REASON_CODES.STAGE_03B_NO_SEARCH_PERFORMED;
      throw noSearchErr;
    }
    result = retryResult;
  }

  const confidenceStats = { coerced: 0 };
  const normalizedWeb = normalizeScorecard(result?.parsed, dimensions, {
    groundedSources: result?.meta?.groundedSources || [],
    liveSearchUsed: result?.tokenDiagnostics?.liveSearchUsed === true,
    callFailedGrounding: result?.meta?.callFailedGrounding === true,
    confidenceStats,
  });
  const tokenDiagnostics = {
    ...(combineTokenDiagnostics(tokenDiagnosticsList) || result?.tokenDiagnostics || {}),
    confidenceScaleCoerced: Number(confidenceStats.coerced || 0),
  };
  const merged = mergeScorecard(ensureArray(memory?.scorecard?.dimensions), normalizedWeb);

  const reasonCodes = [
    ...stageReasonCodes,
    ...(confidenceStats.coerced > 0 ? [REASON_CODES.CONFIDENCE_SCALE_COERCED] : []),
  ];

  return {
    stageStatus: "ok",
    reasonCodes: normalizeReasonCodes(reasonCodes),
    statePatch: {
      ui: { phase: STAGE_ID },
      evidenceDrafts: {
        web: {
          scorecard: {
            dimensions: normalizedWeb,
          },
        },
        merged: {
          scorecard: {
            dimensions: merged,
          },
        },
      },
    },
    diagnostics: {
      mode: "scorecard",
      dimensions: merged.length,
      citations: computeGroundingCoverage(normalizedWeb),
      groundingPropagation: computeGroundingPropagation(normalizedWeb),
      groundedSourcesResolved: result?.meta?.groundedSourcesResolved || null,
      retries: combinedRetries,
      modelRoute: result.route,
      tokenDiagnostics,
    },
    io: {
      prompt,
      response: result.text,
    },
    modelRoute: result.route,
    tokens: tokenDiagnostics,
    retries: combinedRetries,
  };
}
