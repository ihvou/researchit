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
import { REASON_CODES, normalizeReasonCodes } from "../contracts/reason-codes.js";

export const STAGE_ID = "stage_03b_evidence_web";
export const STAGE_TITLE = "Evidence Web";

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

function computeFabricationSignalForMergedSources(sources = []) {
  const list = normalizeSources(sources);
  const groundedSetAvailable = list.some((source) => source?.groundedSetAvailable === true);
  const groundedCount = list.filter((source) => source?.groundedByProvider === true).length;
  return fabricationSignalFromSources(list, {
    liveSearchUsed: groundedSetAvailable,
    groundedSourceCount: groundedSetAvailable ? Math.max(1, groundedCount) : 0,
  });
}

function mergeScorecard(memory = [], web = []) {
  const webById = new Map(web.map((unit) => [clean(unit?.id), unit]));
  return memory.map((unit) => {
    const patch = webById.get(unit.id) || {};
    const mergedSources = mergeSourceLists(unit?.sources, patch?.sources);
    return {
      ...unit,
      brief: clean(patch?.brief || unit?.brief),
      full: clean(patch?.full || unit?.full),
      confidence: mergeConfidence(unit?.confidence, patch?.confidence),
      confidenceReason: mergeConfidenceReason(unit?.confidenceReason, patch?.confidenceReason),
      sources: mergedSources,
      fabricationSignal: clean(patch?.fabricationSignal || unit?.fabricationSignal)
        || computeFabricationSignalForMergedSources(mergedSources),
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
    return {
      ...cell,
      value: clean(patch?.value || cell?.value),
      full: clean(patch?.full || cell?.full),
      confidence: mergeConfidence(cell?.confidence, patch?.confidence),
      confidenceReason: mergeConfidenceReason(cell?.confidenceReason, patch?.confidenceReason),
      sources: mergedSources,
      fabricationSignal: clean(patch?.fabricationSignal || cell?.fabricationSignal)
        || computeFabricationSignalForMergedSources(mergedSources),
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

  return dimensions.map((dim) => {
    const unit = byId.get(dim.id) || {};
    const grounded = annotateSourcesWithGrounding(unit?.sources || [], groundedSources);
    return {
      id: dim.id,
      brief: clean(unit?.brief),
      full: clean(unit?.full),
      confidence: normalizeConfidence(unit?.confidence, confidenceStats),
      confidenceReason: clean(unit?.confidenceReason),
      sources: grounded.sources,
      fabricationSignal: fabricationSignalFromSources(grounded.sources, {
        liveSearchUsed,
        groundedSourceCount: providerGroundedCount,
      }),
      arguments: normalizeArguments(unit?.arguments || {}, `${dim.id}-web`),
      risks: clean(unit?.risks),
      missingEvidence: clean(unit?.missingEvidence),
    };
  });
}

function normalizeMatrix(parsed = {}, subjects = [], attributes = [], options = {}) {
  const byKey = new Map(ensureArray(parsed?.cells).map((item) => [`${clean(item?.subjectId)}::${clean(item?.attributeId)}`, item]));
  const groundedSources = ensureArray(options?.groundedSources);
  const confidenceStats = options?.confidenceStats || { coerced: 0 };
  const providerGroundedCount = groundedSources.length;
  const liveSearchUsed = options?.liveSearchUsed === true;

  const cells = [];
  subjects.forEach((subject) => {
    attributes.forEach((attribute) => {
      const patch = byKey.get(`${subject.id}::${attribute.id}`) || {};
      const grounded = annotateSourcesWithGrounding(patch?.sources || [], groundedSources);
      cells.push({
        subjectId: subject.id,
        attributeId: attribute.id,
        value: clean(patch?.value),
        full: clean(patch?.full),
        confidence: normalizeConfidence(patch?.confidence, confidenceStats),
        confidenceReason: clean(patch?.confidenceReason),
        sources: grounded.sources,
        fabricationSignal: fabricationSignalFromSources(grounded.sources, {
          liveSearchUsed,
          groundedSourceCount: providerGroundedCount,
        }),
        arguments: normalizeArguments(patch?.arguments || {}, `${subject.id}-${attribute.id}-web`),
        risks: clean(patch?.risks),
        missingEvidence: clean(patch?.missingEvidence),
      });
    });
  });
  return cells;
}

function chunkSubjects(subjects = [], size = 1) {
  const safeSize = Math.max(1, Number(size) || 1);
  const chunks = [];
  for (let idx = 0; idx < subjects.length; idx += safeSize) {
    chunks.push(subjects.slice(idx, idx + safeSize));
  }
  return chunks;
}

function matrixChunkSize(subjects = [], attributes = [], config = {}) {
  const subjectCount = Math.max(1, ensureArray(subjects).length);
  const attrCount = Math.max(1, ensureArray(attributes).length);
  const maxCells = Math.max(
    attrCount,
    Number(config?.limits?.matrixWebChunkMaxCells) || 16
  );
  const byCells = Math.max(1, Math.floor(maxCells / attrCount));
  return Math.max(1, Math.min(subjectCount, byCells));
}

function buildMatrixPrompt(state = {}, subjects = [], attributes = []) {
  return `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Collect WEB evidence for each matrix cell below and return structured JSON.
Subjects:
${subjects.map((subject) => `- ${subject.id}: ${subject.label}`).join("\n")}
Attributes:
${attributes.map((attribute) => `- ${attribute.id}: ${attribute.label}${clean(attribute?.brief) ? ` - ${clean(attribute.brief)}` : ""}`).join("\n")}

Rules:
- Cover every listed subject x attribute cell.
- Lead with specific known facts. Confidence should reflect evidence depth, not citation quantity.
- Return confidence as one of these strings only: high, medium, low. Do not return numbers.
- Example: {"confidence":"high"}
- If uncertain, lower confidence and state what is missing.
- Use high-quality, specific sources. Prefer independent evidence (government, research, analyst, reputable news) over vendor claims.
- For each non-empty source, include a valid public https URL, a concise quote/snippet, and "sourceType".
- Never return temporary grounding redirect links (for example vertexaisearch.cloud.google.com/grounding-api-redirect/...).
- If you are not certain the canonical public URL is correct, omit the URL instead of guessing.
- sourceType must be one of: independent, research, news, analyst, government, registry, vendor, press_release, marketing.
- If evidence is unavailable, keep "sources" empty, use low confidence, and explain what is missing in "missingEvidence".

Return JSON {"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;
}

async function gatherMatrixWeb({
  state,
  runtime,
  subjects,
  attributes,
}) {
  const initialSize = matrixChunkSize(subjects, attributes, runtime?.config || {});
  const rootChunks = chunkSubjects(subjects, initialSize);

  const results = await Promise.all(rootChunks.map(async (root) => {
    const cells = [];
    const reasonCodes = [];
    const diagnostics = [];
    const queue = [root];
    while (queue.length) {
      const current = queue.shift();
      const prompt = buildMatrixPrompt(state, current, attributes);
      try {
        const result = await callActorJson({
          state,
          runtime,
          stageId: STAGE_ID,
          actor: "analyst",
          systemPrompt: runtime?.prompts?.analyst || "You produce web-backed evidence.",
          userPrompt: prompt,
          tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 28000,
          timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 150000,
          // 1 retry enables parse-repair (injects "return strict JSON" notice on parse failure).
          // Queue splits on failure rather than retrying the same size, so this does not compound.
          maxRetries: 1,
          liveSearch: true,
          schemaHint: '{"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
        });
        const confidenceStats = { coerced: 0 };
        const normalizedChunk = normalizeMatrix(result?.parsed, current, attributes, {
          groundedSources: result?.meta?.groundedSources || [],
          liveSearchUsed: result?.tokenDiagnostics?.liveSearchUsed === true,
          confidenceStats,
        });
        const tokenDiagnostics = {
          ...(result?.tokenDiagnostics || {}),
          confidenceScaleCoerced: Number(confidenceStats.coerced || 0),
        };
        cells.push(...normalizedChunk);
        const chunkReasonCodes = [
          ...ensureArray(result?.reasonCodes),
          ...(confidenceStats.coerced > 0 ? [REASON_CODES.CONFIDENCE_SCALE_COERCED] : []),
        ];
        reasonCodes.push(...chunkReasonCodes);
        diagnostics.push({
          chunkSubjects: current.map((subject) => subject.id),
          chunkSize: current.length,
          retries: result.retries,
          tokenDiagnostics,
          modelRoute: result.route,
          citations: computeGroundingCoverage(normalizedChunk),
          groundedSourcesResolved: result?.meta?.groundedSourcesResolved || null,
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
    return { cells, reasonCodes, diagnostics };
  }));

  const allDiagnostics = results.flatMap((r) => r.diagnostics);
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

  return {
    cells: results.flatMap((r) => r.cells),
    reasonCodes: normalizeReasonCodes(results.flatMap((r) => r.reasonCodes)),
    diagnostics: allDiagnostics,
    citations: {
      ...citationAggregate,
      groundedRatio: citationAggregate.totalUrls > 0 ? citationAggregate.groundedUrls / citationAggregate.totalUrls : 1,
    },
    groundedSourcesResolved,
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
    const normalizedWeb = matrixWeb.cells;
    const merged = mergeMatrixCells(ensureArray(memory?.matrix?.cells), normalizedWeb);
    const aggregatedTokens = combineTokenDiagnostics(
      matrixWeb.diagnostics.map((entry) => entry?.tokenDiagnostics).filter(Boolean)
    );
    const totalRetries = matrixWeb.diagnostics.reduce((sum, entry) => sum + Number(entry?.retries || 0), 0);
    const modelRoute = matrixWeb.diagnostics.find((entry) => entry?.modelRoute)?.modelRoute || null;
    return {
      stageStatus: "ok",
      reasonCodes: matrixWeb.reasonCodes,
      statePatch: {
        ui: { phase: STAGE_ID },
        evidenceDrafts: {
          web: {
            matrix: {
              cells: normalizedWeb,
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
        citations: matrixWeb.citations,
        groundedSourcesResolved: matrixWeb.groundedSourcesResolved,
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
Collect WEB evidence and update each scorecard dimension.
Dimensions:
${dimensions.map((dim) => `- ${dim.id}: ${dim.label}${clean(dim?.brief) ? ` - ${clean(dim.brief)}` : ""}`).join("\n")}

Rules:
- Lead with specific known facts. Confidence should reflect evidence depth, not citation quantity.
- Return confidence as one of these strings only: high, medium, low. Do not return numbers.
- Example: {"confidence":"high"}
- If uncertain, lower confidence and state what is missing.
- Use sources that can be cited with specific canonical public URLs when possible.
- Prefer independent evidence (government, research, analyst, reputable news) over vendor claims.
- For each non-empty source, include a valid https URL, concise quote/snippet, and "sourceType".
- Never return temporary grounding redirect links (for example vertexaisearch.cloud.google.com/grounding-api-redirect/...).
- If you are not certain the canonical public URL is correct, omit the URL instead of guessing.
- sourceType must be one of: independent, research, news, analyst, government, registry, vendor, press_release, marketing.
- If reliable evidence is unavailable, keep "sources" empty and explain the gap in "missingEvidence".

Return JSON {"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: runtime?.prompts?.analyst || "You produce web-backed evidence by dimension.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 10000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 90000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 2,
    liveSearch: true,
    schemaHint: '{"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
  });

  const confidenceStats = { coerced: 0 };
  const normalizedWeb = normalizeScorecard(result?.parsed, dimensions, {
    groundedSources: result?.meta?.groundedSources || [],
    liveSearchUsed: result?.tokenDiagnostics?.liveSearchUsed === true,
    confidenceStats,
  });
  const tokenDiagnostics = {
    ...(result?.tokenDiagnostics || {}),
    confidenceScaleCoerced: Number(confidenceStats.coerced || 0),
  };
  const merged = mergeScorecard(ensureArray(memory?.scorecard?.dimensions), normalizedWeb);

  const reasonCodes = [
    ...ensureArray(result?.reasonCodes),
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
