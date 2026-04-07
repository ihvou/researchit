import { safeParseJSON } from "../lib/json.js";
import { SYS_ANALYST, SYS_CRITIC } from "../prompts/defaults.js";

const MATRIX_ANALYST_PROMPT = `You are a senior research analyst producing an evidence-first comparison matrix.

Rules:
- Compare each subject across every attribute.
- Use concise, factual language.
- Prefer independent evidence; avoid marketing copy.
- Every cell must include confidence and a short reason.
- If evidence is weak, say so explicitly and keep confidence low.
- Return ONLY valid JSON using the exact schema.
`;

const MATRIX_CRITIC_PROMPT = `You are a skeptical research critic auditing a comparison matrix.

Rules:
- Flag overconfident or weakly supported cells.
- Flag internal contradictions within each subject.
- Keep feedback surgical and concrete.
- Return ONLY valid JSON using the exact schema.
`;

const MATRIX_DISCOVERY_PROMPT = `You are suggesting additive completeness checks for a finished comparison matrix.

Rules:
- Suggest missed subjects and missed attributes only.
- Keep suggestions practical and specific.
- Do not re-run analysis; this is an additive recommendation block.
- Return ONLY valid JSON using the exact schema.
`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value) {
  return String(value || "").trim();
}

function toId(value, fallback = "item") {
  const normalized = cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeConfidence(value) {
  const raw = cleanText(value).toLowerCase();
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  if (raw.startsWith("h")) return "high";
  if (raw.startsWith("m")) return "medium";
  return "low";
}

function normalizeSourceList(sources = []) {
  if (!Array.isArray(sources)) return [];
  return sources
    .map((src) => ({
      name: cleanText(src?.name),
      quote: cleanText(src?.quote).slice(0, 180),
      url: cleanText(src?.url),
      sourceType: cleanText(src?.sourceType || "").toLowerCase(),
    }))
    .filter((src) => src.name || src.quote || src.url)
    .slice(0, 8);
}

function normalizeSubjectList(rawSubjects, subjectsSpec = {}) {
  const values = Array.isArray(rawSubjects)
    ? rawSubjects
    : cleanText(rawSubjects)
      .split(/[,\n]/g)
      .map((item) => cleanText(item))
      .filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  const minCount = Math.max(2, Number(subjectsSpec?.minCount) || 2);
  const maxCount = Math.max(minCount, Number(subjectsSpec?.maxCount) || 8);
  if (unique.length < minCount) {
    throw new Error(`Matrix mode requires at least ${minCount} subjects.`);
  }
  const bounded = unique.slice(0, maxCount);
  return bounded.map((label, idx) => ({
    id: toId(label, `subject-${idx + 1}`),
    label,
  }));
}

function normalizeAttributeList(attributes = []) {
  if (!Array.isArray(attributes) || !attributes.length) {
    throw new Error("Matrix mode requires config.attributes.");
  }
  return attributes.map((attr, idx) => ({
    id: toId(attr?.id || attr?.label, `attribute-${idx + 1}`),
    label: cleanText(attr?.label || attr?.id || `Attribute ${idx + 1}`),
    brief: cleanText(attr?.brief || attr?.description),
    derived: !!attr?.derived,
  }));
}

function normalizeLayoutHint(layout) {
  const normalized = cleanText(layout);
  if (normalized === "subjects-as-rows" || normalized === "subjects-as-columns") return normalized;
  return "auto";
}

function buildCellKey(subjectId, attributeId) {
  return `${subjectId}::${attributeId}`;
}

function matchSubjectId(raw, subjectsByLabel) {
  const key = cleanText(raw).toLowerCase();
  return subjectsByLabel.get(key) || "";
}

function matchAttributeId(raw, attributesByLabel) {
  const key = cleanText(raw).toLowerCase();
  return attributesByLabel.get(key) || "";
}

function roleOptions(config, role) {
  const model = config?.models?.[role] || {};
  const options = {};
  if (cleanText(model.provider)) options.provider = cleanText(model.provider);
  if (cleanText(model.model)) options.model = cleanText(model.model);
  if (cleanText(model.webSearchModel)) options.webSearchModel = cleanText(model.webSearchModel);
  if (cleanText(model.baseUrl)) options.baseUrl = cleanText(model.baseUrl);
  return options;
}

function extractJson(text, fallback = {}) {
  try {
    return safeParseJSON(text);
  } catch (_) {
    return fallback;
  }
}

function createInitialState(input) {
  const id = cleanText(input?.id);
  const desc = cleanText(input?.description);
  if (!id || !desc) {
    throw new Error("runAnalysis requires input.id and input.description.");
  }
  return {
    id,
    rawInput: desc,
    status: "analyzing",
    phase: "matrix_plan",
    attributes: null,
    dimScores: null,
    critique: null,
    finalScores: null,
    debate: [],
    followUps: {},
    errorMsg: null,
    discover: null,
    origin: input?.origin || null,
    outputMode: "matrix",
    matrix: null,
    analysisMeta: {
      analysisMode: "matrix",
      liveSearchRequested: true,
      liveSearchUsed: false,
      webSearchCalls: 0,
      liveSearchFallbackReason: null,
      criticLiveSearchRequested: true,
      criticLiveSearchUsed: false,
      criticWebSearchCalls: 0,
      criticLiveSearchFallbackReason: null,
      discoveryLiveSearchRequested: false,
      discoveryLiveSearchUsed: false,
      discoveryWebSearchCalls: 0,
      discoveryLiveSearchFallbackReason: null,
      generatedDiscoverCandidatesCount: 0,
      discoverCandidatesCount: 0,
      rejectedDiscoverCandidatesCount: 0,
    },
  };
}

function mergeMeta(baseMeta = {}, stepMeta = {}, role = "analyst") {
  const next = { ...baseMeta };
  if (!stepMeta || typeof stepMeta !== "object") return next;
  const calls = Number(stepMeta.webSearchCalls) || 0;
  if (role === "analyst") {
    next.liveSearchUsed = !!next.liveSearchUsed || !!stepMeta.liveSearchUsed;
    next.webSearchCalls = Number(next.webSearchCalls || 0) + calls;
    if (!next.liveSearchFallbackReason && stepMeta.liveSearchFallbackReason) {
      next.liveSearchFallbackReason = stepMeta.liveSearchFallbackReason;
    }
  } else if (role === "critic") {
    next.criticLiveSearchUsed = !!next.criticLiveSearchUsed || !!stepMeta.liveSearchUsed;
    next.criticWebSearchCalls = Number(next.criticWebSearchCalls || 0) + calls;
    if (!next.criticLiveSearchFallbackReason && stepMeta.liveSearchFallbackReason) {
      next.criticLiveSearchFallbackReason = stepMeta.liveSearchFallbackReason;
    }
  } else if (role === "discover") {
    next.discoveryLiveSearchUsed = !!next.discoveryLiveSearchUsed || !!stepMeta.liveSearchUsed;
    next.discoveryWebSearchCalls = Number(next.discoveryWebSearchCalls || 0) + calls;
    if (!next.discoveryLiveSearchFallbackReason && stepMeta.liveSearchFallbackReason) {
      next.discoveryLiveSearchFallbackReason = stepMeta.liveSearchFallbackReason;
    }
  }
  return next;
}

function normalizeAnalystMatrix(raw = {}, subjects = [], attributes = []) {
  const cellsRaw = Array.isArray(raw?.cells) ? raw.cells : [];
  const subjectSummariesRaw = Array.isArray(raw?.subjectSummaries) ? raw.subjectSummaries : [];

  const subjectsByLabel = new Map(subjects.map((s) => [s.label.toLowerCase(), s.id]));
  const attributesByLabel = new Map();
  attributes.forEach((attr) => {
    attributesByLabel.set(attr.id.toLowerCase(), attr.id);
    attributesByLabel.set(attr.label.toLowerCase(), attr.id);
  });

  const cellMap = new Map();
  for (const cell of cellsRaw) {
    const subjectId = matchSubjectId(cell?.subjectId || cell?.subject || cell?.row, subjectsByLabel);
    const attributeId = matchAttributeId(cell?.attributeId || cell?.attribute || cell?.column, attributesByLabel);
    if (!subjectId || !attributeId) continue;
    const key = buildCellKey(subjectId, attributeId);
    cellMap.set(key, {
      subjectId,
      attributeId,
      value: cleanText(cell?.value || cell?.summary || "No reliable evidence found."),
      confidence: normalizeConfidence(cell?.confidence),
      confidenceReason: cleanText(cell?.confidenceReason || ""),
      sources: normalizeSourceList(cell?.sources),
      contested: false,
      criticNote: "",
    });
  }

  const cells = [];
  for (const subject of subjects) {
    for (const attribute of attributes) {
      const key = buildCellKey(subject.id, attribute.id);
      const existing = cellMap.get(key);
      if (existing) {
        cells.push(existing);
      } else {
        cells.push({
          subjectId: subject.id,
          attributeId: attribute.id,
          value: "No reliable evidence found for this cell.",
          confidence: "low",
          confidenceReason: "Insufficient evidence returned.",
          sources: [],
          contested: false,
          criticNote: "",
        });
      }
    }
  }

  const summaryMap = new Map();
  subjectSummariesRaw.forEach((entry) => {
    const subjectId = matchSubjectId(entry?.subjectId || entry?.subject || entry?.label, subjectsByLabel);
    if (!subjectId) return;
    summaryMap.set(subjectId, cleanText(entry?.summary || entry?.value));
  });
  const subjectSummaries = subjects.map((subject) => ({
    subjectId: subject.id,
    summary: summaryMap.get(subject.id) || "",
  }));

  return {
    cells,
    subjectSummaries,
    crossMatrixSummary: cleanText(raw?.crossMatrixSummary || raw?.summary || ""),
  };
}

function applyCriticFlags(matrix, critic = {}, subjects = [], attributes = []) {
  const subjectMap = new Map(subjects.map((s) => [s.label.toLowerCase(), s.id]));
  const attributeMap = new Map();
  attributes.forEach((attr) => {
    attributeMap.set(attr.id.toLowerCase(), attr.id);
    attributeMap.set(attr.label.toLowerCase(), attr.id);
  });
  const flags = Array.isArray(critic?.flags) ? critic.flags : [];
  const flagMap = new Map();
  flags.forEach((flag) => {
    const subjectId = matchSubjectId(flag?.subjectId || flag?.subject || flag?.row, subjectMap);
    const attributeId = matchAttributeId(flag?.attributeId || flag?.attribute || flag?.column, attributeMap);
    if (!subjectId || !attributeId) return;
    flagMap.set(buildCellKey(subjectId, attributeId), flag);
  });

  return matrix.cells.map((cell) => {
    const flag = flagMap.get(buildCellKey(cell.subjectId, cell.attributeId));
    if (!flag) return cell;
    return {
      ...cell,
      contested: true,
      criticNote: cleanText(flag?.note || flag?.issue || "Critic flagged this cell for weak support."),
      confidence: normalizeConfidence(flag?.confidence || cell.confidence),
      confidenceReason: cleanText(flag?.confidenceReason || cell.confidenceReason),
    };
  });
}

function summarizeCoverage(cells = []) {
  const totalCells = cells.length;
  const lowConfidenceCells = cells.filter((cell) => cell.confidence === "low").length;
  const contestedCells = cells.filter((cell) => cell.contested).length;
  return { totalCells, lowConfidenceCells, contestedCells };
}

export async function runMatrixAnalysis(input, config, callbacks = {}) {
  const transport = callbacks?.transport;
  if (!transport?.callAnalyst || !transport?.callCritic) {
    throw new Error("runAnalysis requires callbacks.transport with callAnalyst and callCritic.");
  }

  const onProgress = typeof callbacks?.onProgress === "function" ? callbacks.onProgress : () => {};
  let state = input?.initialState ? clone(input.initialState) : createInitialState(input);
  const update = (phase, patch) => {
    state = { ...state, phase, ...patch };
    onProgress(phase, clone(state));
  };

  const subjects = normalizeSubjectList(input?.options?.matrixSubjects, config?.subjects || {});
  const attributes = normalizeAttributeList(config?.attributes || []);
  const layout = normalizeLayoutHint(config?.matrixLayout);
  const relatedDiscovery = config?.relatedDiscovery !== false;

  update("matrix_plan", {
    outputMode: "matrix",
    matrix: {
      layout,
      subjects,
      attributes,
      cells: [],
      subjectSummaries: [],
      crossMatrixSummary: "",
      coverage: { totalCells: subjects.length * attributes.length, lowConfidenceCells: 0, contestedCells: 0 },
      discovery: null,
    },
  });

  const limits = config?.limits?.tokenLimits || {};
  const analystTokens = Number(limits.phase1Evidence) || 10000;
  const criticTokens = Number(limits.critic) || 6000;
  const discoveryTokens = Number(limits.phase3Response) || 3200;
  const analystPrompt = cleanText(config?.prompts?.matrixAnalyst) || MATRIX_ANALYST_PROMPT;
  const criticPrompt = cleanText(config?.prompts?.matrixCritic) || MATRIX_CRITIC_PROMPT;

  try {
    const analystUserPrompt = `Research question:
${state.rawInput}

Subjects:
${subjects.map((subject, idx) => `${idx + 1}. ${subject.label}`).join("\n")}

Attributes:
${attributes.map((attr) => `- ${attr.id}: ${attr.label}${attr.brief ? ` — ${attr.brief}` : ""}`).join("\n")}

Return JSON only:
{
  "cells": [
    {
      "subjectId": "<subject id from list>",
      "attributeId": "<attribute id from list>",
      "value": "<2-4 sentence evidence-based finding>",
      "confidence": "<high|medium|low>",
      "confidenceReason": "<short reason>",
      "sources": [{"name":"...","quote":"<max 20 words>","url":"...","sourceType":"<vendor|press|independent>"}]
    }
  ],
  "subjectSummaries": [
    {"subjectId":"<subject id>","summary":"<1-2 sentence editorial summary>"}
  ],
  "crossMatrixSummary": "<key cross-matrix patterns and surprises>"
}`;

    update("matrix_evidence", {});
    const analystRes = await transport.callAnalyst(
      [{ role: "user", content: analystUserPrompt }],
      analystPrompt,
      analystTokens,
      {
        ...roleOptions(config, "analyst"),
        liveSearch: true,
        includeMeta: true,
      }
    );
    const analystParsed = extractJson(analystRes?.text || analystRes, {});
    const analystMatrix = normalizeAnalystMatrix(analystParsed, subjects, attributes);
    const analystMeta = mergeMeta(state.analysisMeta, analystRes?.meta, "analyst");

    update("matrix_critic", {
      matrix: {
        ...state.matrix,
        ...analystMatrix,
        coverage: summarizeCoverage(analystMatrix.cells),
      },
      analysisMeta: analystMeta,
    });

    const criticUserPrompt = `Research question:
${state.rawInput}

Current matrix draft:
${JSON.stringify({
      subjects,
      attributes,
      cells: analystMatrix.cells,
      subjectSummaries: analystMatrix.subjectSummaries,
      crossMatrixSummary: analystMatrix.crossMatrixSummary,
    }, null, 2)}

Audit the matrix and return JSON only:
{
  "flags": [
    {
      "subjectId": "<subject id>",
      "attributeId": "<attribute id>",
      "note": "<why this cell is weak/contested/contradictory>",
      "confidence": "<high|medium|low>"
    }
  ]
}`;

    const criticRes = await transport.callCritic(
      [{ role: "user", content: criticUserPrompt }],
      criticPrompt,
      criticTokens,
      {
        ...roleOptions(config, "critic"),
        liveSearch: true,
        includeMeta: true,
      }
    );
    const criticParsed = extractJson(criticRes?.text || criticRes, {});
    const mergedCells = applyCriticFlags(analystMatrix, criticParsed, subjects, attributes);
    const criticMeta = mergeMeta(analystMeta, criticRes?.meta, "critic");

    update("matrix_summary", {
      matrix: {
        ...state.matrix,
        ...analystMatrix,
        cells: mergedCells,
        coverage: summarizeCoverage(mergedCells),
      },
      analysisMeta: criticMeta,
    });

    if (relatedDiscovery) {
      const discoveryPrompt = `Research question:
${state.rawInput}

Subjects analyzed:
${subjects.map((s) => `- ${s.label}`).join("\n")}

Attributes analyzed:
${attributes.map((a) => `- ${a.label}`).join("\n")}

Return JSON only:
{
  "suggestedSubjects": [{"label":"<subject>","reason":"<why it's relevant>"}],
  "suggestedAttributes": [{"label":"<attribute>","reason":"<why it's relevant>"}],
  "notes": "<optional short note>"
}`;

      update("matrix_discover", {});
      const discoverRes = await transport.callAnalyst(
        [{ role: "user", content: discoveryPrompt }],
        MATRIX_DISCOVERY_PROMPT,
        discoveryTokens,
        {
          ...roleOptions(config, "analyst"),
          liveSearch: true,
          includeMeta: true,
        }
      );
      const discoverParsed = extractJson(discoverRes?.text || discoverRes, {});
      const suggestedSubjects = Array.isArray(discoverParsed?.suggestedSubjects)
        ? discoverParsed.suggestedSubjects
          .map((entry) => ({ label: cleanText(entry?.label), reason: cleanText(entry?.reason) }))
          .filter((entry) => entry.label)
          .slice(0, 6)
        : [];
      const suggestedAttributes = Array.isArray(discoverParsed?.suggestedAttributes)
        ? discoverParsed.suggestedAttributes
          .map((entry) => ({ label: cleanText(entry?.label), reason: cleanText(entry?.reason) }))
          .filter((entry) => entry.label)
          .slice(0, 6)
        : [];
      const discoverMeta = mergeMeta(state.analysisMeta, discoverRes?.meta, "discover");

      update("complete", {
        status: "complete",
        matrix: {
          ...state.matrix,
          discovery: {
            suggestedSubjects,
            suggestedAttributes,
            notes: cleanText(discoverParsed?.notes || ""),
          },
        },
        discover: {
          mode: "matrix",
          suggestedSubjects,
          suggestedAttributes,
          notes: cleanText(discoverParsed?.notes || ""),
        },
        analysisMeta: discoverMeta,
      });
    } else {
      update("complete", {
        status: "complete",
      });
    }
  } catch (err) {
    update("error", {
      status: "error",
      errorMsg: err?.message || "Matrix analysis failed.",
    });
    throw err;
  }

  return clone(state);
}
