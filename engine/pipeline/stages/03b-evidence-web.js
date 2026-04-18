import {
  callActorJson,
  clean,
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
      });
    });
  });
  return cells;
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const memory = state?.evidenceDrafts?.memory || {};

  if (state?.outputType === "matrix") {
    const subjects = ensureArray(state?.request?.matrix?.subjects);
    const attributes = ensureArray(state?.request?.matrix?.attributes);
    const prompt = `Objective: ${clean(state?.request?.objective)}\nCollect WEB evidence for each matrix cell below and return structured JSON.\nSubjects:\n${subjects.map((subject) => `- ${subject.id}: ${subject.label}`).join("\n")}\nAttributes:\n${attributes.map((attribute) => `- ${attribute.id}: ${attribute.label}`).join("\n")}
Return JSON {"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":""}]}`;

    const result = await callActorJson({
      state,
      runtime,
      stageId: STAGE_ID,
      actor: "analyst",
      systemPrompt: runtime?.prompts?.analyst || "You produce web-backed evidence.",
      userPrompt: prompt,
      tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 12000,
      timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 120000,
      maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 2,
      liveSearch: true,
      schemaHint: '{"cells":[{"subjectId":"","attributeId":"","value":"","sources":[]}]}',
    });

    const normalizedWeb = normalizeMatrix(result?.parsed, subjects, attributes);
    const merged = mergeMatrixCells(ensureArray(memory?.matrix?.cells), normalizedWeb);
    return {
      stageStatus: "ok",
      reasonCodes: result.reasonCodes,
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

  const dimensions = ensureArray(state?.request?.scorecard?.dimensions);
  const prompt = `Objective: ${clean(state?.request?.objective)}\nCollect WEB evidence and update each dimension.\nDimensions:\n${dimensions.map((dim) => `- ${dim.id}: ${dim.label}`).join("\n")}
Return JSON {"dimensions":[{"id":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":""}]}`;

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
    schemaHint: '{"dimensions":[{"id":"","brief":"","full":"","sources":[]}]}',
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
