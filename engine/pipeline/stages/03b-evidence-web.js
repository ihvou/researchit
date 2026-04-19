import {
  callActorJson,
  clean,
  combineTokenDiagnostics,
  ensureArray,
  normalizeArguments,
  normalizeConfidence,
  normalizeSources,
} from "./common.js";

export const STAGE_ID = "stage_03b_evidence_web";
export const STAGE_TITLE = "Evidence Web";

function mergeSourceLists(a = [], b = []) {
  const map = new Map();
  [...ensureArray(a), ...ensureArray(b)].forEach((source) => {
    const key = `${clean(source?.name)}|${clean(source?.url)}|${clean(source?.quote)}`;
    if (!key.replace(/\|/g, "")) return;
    if (!map.has(key)) map.set(key, source);
  });
  return [...map.values()];
}

function mergeScorecard(memory = [], web = []) {
  const webById = new Map(web.map((unit) => [clean(unit?.id), unit]));
  return memory.map((unit) => {
    const patch = webById.get(unit.id) || {};
    return {
      ...unit,
      brief: clean(patch?.brief || unit?.brief),
      full: clean(patch?.full || unit?.full),
      confidence: normalizeConfidence(patch?.confidence || unit?.confidence),
      confidenceReason: clean(patch?.confidenceReason || unit?.confidenceReason),
      sources: mergeSourceLists(unit?.sources, patch?.sources),
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
    return {
      ...cell,
      value: clean(patch?.value || cell?.value),
      full: clean(patch?.full || cell?.full),
      confidence: normalizeConfidence(patch?.confidence || cell?.confidence),
      confidenceReason: clean(patch?.confidenceReason || cell?.confidenceReason),
      sources: mergeSourceLists(cell?.sources, patch?.sources),
      arguments: {
        supporting: [...ensureArray(cell?.arguments?.supporting), ...ensureArray(patch?.arguments?.supporting)],
        limiting: [...ensureArray(cell?.arguments?.limiting), ...ensureArray(patch?.arguments?.limiting)],
      },
      risks: clean(patch?.risks || cell?.risks),
      missingEvidence: clean(patch?.missingEvidence || cell?.missingEvidence),
    };
  });
}

function normalizeScorecard(parsed = {}, dimensions = []) {
  const byId = new Map(ensureArray(parsed?.dimensions).map((item) => [clean(item?.id || item?.unitId), item]));
  return dimensions.map((dim) => {
    const unit = byId.get(dim.id) || {};
    return {
      id: dim.id,
      brief: clean(unit?.brief),
      full: clean(unit?.full),
      confidence: normalizeConfidence(unit?.confidence),
      confidenceReason: clean(unit?.confidenceReason),
      sources: normalizeSources(unit?.sources || []),
      arguments: normalizeArguments(unit?.arguments || {}, `${dim.id}-web`),
      risks: clean(unit?.risks),
      missingEvidence: clean(unit?.missingEvidence),
    };
  });
}

function normalizeMatrix(parsed = {}, subjects = [], attributes = []) {
  const byKey = new Map(ensureArray(parsed?.cells).map((item) => [`${clean(item?.subjectId)}::${clean(item?.attributeId)}`, item]));
  const cells = [];
  subjects.forEach((subject) => {
    attributes.forEach((attribute) => {
      const patch = byKey.get(`${subject.id}::${attribute.id}`) || {};
      cells.push({
        subjectId: subject.id,
        attributeId: attribute.id,
        value: clean(patch?.value),
        full: clean(patch?.full),
        confidence: normalizeConfidence(patch?.confidence),
        confidenceReason: clean(patch?.confidenceReason),
        sources: normalizeSources(patch?.sources || []),
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
          // Queue loop handles retry-via-splitting; inner retries would compound exponentially.
          maxRetries: 0,
          liveSearch: true,
          schemaHint: '{"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
        });
        cells.push(...normalizeMatrix(result?.parsed, current, attributes));
        reasonCodes.push(...ensureArray(result?.reasonCodes));
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
    return { cells, reasonCodes, diagnostics };
  }));

  return {
    cells: results.flatMap((r) => r.cells),
    reasonCodes: [...new Set(results.flatMap((r) => r.reasonCodes))],
    diagnostics: results.flatMap((r) => r.diagnostics),
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
- Use sources that can be cited with specific URLs when possible.
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

  const normalizedWeb = normalizeScorecard(result?.parsed, dimensions);
  const merged = mergeScorecard(ensureArray(memory?.scorecard?.dimensions), normalizedWeb);

  return {
    stageStatus: "ok",
    reasonCodes: result.reasonCodes,
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
