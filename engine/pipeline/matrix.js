import { safeParseJSON } from "../lib/json.js";
import {
  createAnalysisDebugSession,
  appendAnalysisDebugEvent,
  finalizeAnalysisDebugSession,
} from "../lib/debug.js";

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
- Flag internal contradictions within each subject and across subjects.
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

const MATRIX_SUBJECT_DISCOVERY_PROMPT = `You are helping scope a matrix research run when subjects are missing or underspecified.

Rules:
- Produce a concrete decision question from the user prompt.
- Propose a shortlist of subjects that should be compared.
- Each suggested subject needs a practical reason and at least one supporting source.
- Keep output concise and decision-oriented.
- Return ONLY valid JSON using the exact schema.
`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value) {
  return String(value || "").trim();
}

function clip(value, max = 260) {
  const text = cleanText(value);
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
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

function confidenceRank(value) {
  const normalized = normalizeConfidence(value);
  if (normalized === "high") return 3;
  if (normalized === "medium") return 2;
  return 1;
}

function confidenceFromRank(rank, fallback = "medium") {
  if (rank >= 3) return "high";
  if (rank >= 2) return "medium";
  if (rank >= 1) return "low";
  return fallback;
}

function normalizeSourceList(sources = []) {
  if (!Array.isArray(sources)) return [];
  return sources
    .map((src) => ({
      name: cleanText(src?.name),
      quote: cleanText(src?.quote).slice(0, 180),
      url: cleanText(src?.url),
      sourceType: cleanText(src?.sourceType || "").toLowerCase(),
      verificationStatus: cleanText(src?.verificationStatus || ""),
      verificationNote: cleanText(src?.verificationNote || ""),
    }))
    .filter((src) => src.name || src.quote || src.url)
    .slice(0, 10);
}

function normalizeHttpUrl(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch (_) {
    return "";
  }
}

function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["'`]+/g, "")
    .replace(/[^a-z0-9\s:/._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quotedClaimFoundInPage(source = {}, snapshot = null) {
  const pageText = normalizeMatchText(`${snapshot?.title || ""} ${snapshot?.text || ""}`);
  if (!pageText) return false;

  const quote = normalizeMatchText(source.quote);
  if (quote.length >= 12) {
    if (pageText.includes(quote)) return true;
    const parts = quote.split(" ").filter(Boolean);
    if (parts.length >= 6) {
      const head = parts.slice(0, 6).join(" ");
      const tail = parts.slice(-6).join(" ");
      if (pageText.includes(head) && pageText.includes(tail)) return true;
    }
  }

  const name = normalizeMatchText(source.name);
  if (name.length >= 4 && pageText.includes(name)) return true;
  return false;
}

function normalizeSubjectCandidates(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => cleanText(item)).filter(Boolean);
  }
  return String(raw || "")
    .split(/[\n,;|]/g)
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function splitSubjectTokens(text = "") {
  return String(text || "")
    .replace(/\s+versus\s+/gi, ",")
    .replace(/\s+vs\.?\s+/gi, ",")
    .replace(/\s+and\s+/gi, ",")
    .split(/[\n,;|]/g)
    .map((item) => cleanText(item.replace(/^[-*\d.)\s]+/, "")))
    .filter(Boolean);
}

function extractSubjectsFromUnifiedPrompt(text = "") {
  const raw = cleanText(text);
  if (!raw) return [];

  const candidates = [];
  const addMany = (items = []) => {
    items.forEach((item) => {
      const value = cleanText(item)
        .replace(/^['"“”‘’]+|['"“”‘’]+$/g, "")
        .replace(/\s{2,}/g, " ");
      if (!value) return;
      if (value.length > 70) return;
      if (/^(should|compare|which|what|prioritize|evaluate|analyze|decision|question)$/i.test(value)) return;
      candidates.push(value);
    });
  };

  const subjectsLineMatches = raw.match(/subjects?\s*:\s*([^\n]+)/i);
  if (subjectsLineMatches?.[1]) {
    addMany(splitSubjectTokens(subjectsLineMatches[1]));
  }

  const compareMatches = raw.match(/compare\s+([^.?\n]+?)(?:\s+(?:for|to|across|against|regarding|about)\b|[.?\n]|$)/i);
  if (compareMatches?.[1]) {
    addMany(splitSubjectTokens(compareMatches[1]));
  }

  const betweenMatches = raw.match(/between\s+([^.?\n]+?)(?:\s+(?:for|to|across|against|regarding|about)\b|[.?\n]|$)/i);
  if (betweenMatches?.[1]) {
    addMany(splitSubjectTokens(betweenMatches[1]));
  }

  const listStyle = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]|^\d+[.)]/.test(line));
  if (listStyle.length) {
    addMany(listStyle.map((line) => line.replace(/^[-*\d.)\s]+/, "")));
  }

  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function extractDecisionQuestion(text = "") {
  const raw = cleanText(text);
  if (!raw) return "";
  const sentences = raw.split(/(?<=[.?!])\s+/).map((line) => cleanText(line)).filter(Boolean);
  const picked = sentences.find((line) => /\b(should|which|compare|prioritize|evaluate|choose|decision|best)\b/i.test(line))
    || sentences[0]
    || raw;
  return clip(picked, 220);
}

function normalizeSubjectList(rawSubjects, subjectsSpec = {}, options = {}) {
  const strict = options?.strict !== false;
  const values = normalizeSubjectCandidates(rawSubjects);
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
  if (strict && unique.length < minCount) {
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
  } else if (role === "subject_discovery") {
    next.subjectDiscoveryUsed = !!next.subjectDiscoveryUsed || !!stepMeta.liveSearchUsed;
    next.subjectDiscoveryWebSearchCalls = Number(next.subjectDiscoveryWebSearchCalls || 0) + calls;
    if (!next.subjectDiscoveryFallbackReason && stepMeta.liveSearchFallbackReason) {
      next.subjectDiscoveryFallbackReason = stepMeta.liveSearchFallbackReason;
    }
  }
  return next;
}

function mergeTargetedMeta(baseMeta = {}, stepMeta = {}) {
  const next = { ...baseMeta };
  if (!stepMeta || typeof stepMeta !== "object") return next;
  if (stepMeta.liveSearchUsed) next.lowConfidenceTargetedSearchUsed = true;
  next.lowConfidenceTargetedWebSearchCalls = Number(next.lowConfidenceTargetedWebSearchCalls || 0)
    + Number(stepMeta.webSearchCalls || 0);
  if (!next.lowConfidenceTargetedFallbackReason && stepMeta.liveSearchFallbackReason) {
    next.lowConfidenceTargetedFallbackReason = stepMeta.liveSearchFallbackReason;
  }
  return next;
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
      lowConfidenceInitialCount: 0,
      lowConfidenceUpgradedCount: 0,
      lowConfidenceValidatedLowCount: 0,
      lowConfidenceCycleFailures: 0,
      lowConfidenceTargetedSearchUsed: false,
      lowConfidenceTargetedWebSearchCalls: 0,
      lowConfidenceTargetedFallbackReason: null,
      subjectDiscoveryRequested: false,
      subjectDiscoveryUsed: false,
      subjectDiscoveryWebSearchCalls: 0,
      subjectDiscoveryFallbackReason: null,
      subjectDiscoverySuggestedCount: 0,
      sourceVerificationChecked: 0,
      sourceVerificationVerified: 0,
      sourceVerificationNotFound: 0,
      sourceVerificationFetchFailed: 0,
      sourceVerificationPenalizedCells: 0,
      sourceVerificationSkippedReason: null,
      matrixHybridStats: null,
      contestedCellsResolved: 0,
      contestedCellsConceded: 0,
      contestedCellsDefended: 0,
    },
  };
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
      analystDecision: "",
      analystNote: "",
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
          analystDecision: "",
          analystNote: "",
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

function normalizeAnalystResponses(raw = {}, subjects = [], attributes = []) {
  const responsesRaw = Array.isArray(raw?.responses) ? raw.responses : [];
  const subjectsByLabel = new Map(subjects.map((s) => [s.label.toLowerCase(), s.id]));
  const attributesByLabel = new Map();
  attributes.forEach((attr) => {
    attributesByLabel.set(attr.id.toLowerCase(), attr.id);
    attributesByLabel.set(attr.label.toLowerCase(), attr.id);
  });

  const out = [];
  for (const entry of responsesRaw) {
    const subjectId = matchSubjectId(entry?.subjectId || entry?.subject || entry?.row, subjectsByLabel);
    const attributeId = matchAttributeId(entry?.attributeId || entry?.attribute || entry?.column, attributesByLabel);
    if (!subjectId || !attributeId) continue;

    const rawDecision = cleanText(entry?.decision || "").toLowerCase();
    const decision = rawDecision === "concede" ? "concede" : "defend";
    out.push({
      subjectId,
      attributeId,
      decision,
      value: cleanText(entry?.value || entry?.updatedValue || ""),
      confidence: normalizeConfidence(entry?.confidence),
      confidenceReason: cleanText(entry?.confidenceReason || ""),
      sources: normalizeSourceList(entry?.sources),
      analystNote: cleanText(entry?.analystNote || entry?.response || ""),
    });
  }
  return out;
}

function normalizeCriticFlags(raw = {}, subjects = [], attributes = []) {
  const flagsRaw = Array.isArray(raw?.flags) ? raw.flags : [];
  const subjectsByLabel = new Map(subjects.map((s) => [s.label.toLowerCase(), s.id]));
  const attributesByLabel = new Map();
  attributes.forEach((attr) => {
    attributesByLabel.set(attr.id.toLowerCase(), attr.id);
    attributesByLabel.set(attr.label.toLowerCase(), attr.id);
  });

  const out = [];
  for (const flag of flagsRaw) {
    const subjectId = matchSubjectId(flag?.subjectId || flag?.subject || flag?.row, subjectsByLabel);
    const attributeId = matchAttributeId(flag?.attributeId || flag?.attribute || flag?.column, attributesByLabel);
    if (!subjectId || !attributeId) continue;
    out.push({
      subjectId,
      attributeId,
      note: cleanText(flag?.note || flag?.issue || "Critic flagged this cell for weak support."),
      suggestedConfidence: normalizeConfidence(flag?.confidence || flag?.suggestedConfidence),
      suggestedValue: cleanText(flag?.suggestedValue || flag?.value || ""),
    });
  }
  return out;
}

function upsertCell(matrix = {}, nextCell = {}) {
  const cells = Array.isArray(matrix?.cells) ? [...matrix.cells] : [];
  const key = buildCellKey(nextCell.subjectId, nextCell.attributeId);
  const idx = cells.findIndex((cell) => buildCellKey(cell.subjectId, cell.attributeId) === key);
  if (idx >= 0) {
    cells[idx] = { ...cells[idx], ...nextCell };
  } else {
    cells.push({ ...nextCell });
  }
  return {
    ...matrix,
    cells,
  };
}

function summarizeCoverage(cells = []) {
  const totalCells = cells.length;
  const lowConfidenceCells = cells.filter((cell) => normalizeConfidence(cell.confidence) === "low").length;
  const contestedCells = cells.filter((cell) => cell.contested).length;
  return { totalCells, lowConfidenceCells, contestedCells };
}

function matrixHybridStats(subjects = [], attributes = [], baseline = {}, web = {}, reconciled = {}) {
  const pairs = [];
  subjects.forEach((subject) => {
    attributes.forEach((attribute) => {
      pairs.push(buildCellKey(subject.id, attribute.id));
    });
  });

  const byKey = (cells = []) => {
    const map = new Map();
    (cells || []).forEach((cell) => map.set(buildCellKey(cell.subjectId, cell.attributeId), cell));
    return map;
  };
  const baseMap = byKey(baseline.cells);
  const webMap = byKey(web.cells);
  const recMap = byKey(reconciled.cells);

  let changedFromBaseline = 0;
  let changedFromWeb = 0;
  pairs.forEach((key) => {
    const b = baseMap.get(key);
    const w = webMap.get(key);
    const r = recMap.get(key);
    if (!r) return;
    if (b && (cleanText(b.value) !== cleanText(r.value) || normalizeConfidence(b.confidence) !== normalizeConfidence(r.confidence))) {
      changedFromBaseline += 1;
    }
    if (w && (cleanText(w.value) !== cleanText(r.value) || normalizeConfidence(w.confidence) !== normalizeConfidence(r.confidence))) {
      changedFromWeb += 1;
    }
  });

  return { changedFromBaseline, changedFromWeb, totalCells: pairs.length };
}

async function fetchSourceWithCache(url, sourceFetchCache = new Map(), transport = null) {
  const normalizedUrl = normalizeHttpUrl(url);
  if (!normalizedUrl) {
    return { ok: false, error: "invalid_url", snapshot: null };
  }
  if (sourceFetchCache.has(normalizedUrl)) {
    return sourceFetchCache.get(normalizedUrl);
  }

  if (!transport?.fetchSource) {
    const unavailable = { ok: false, error: "fetch_source_unavailable", snapshot: null };
    sourceFetchCache.set(normalizedUrl, unavailable);
    return unavailable;
  }

  try {
    const snapshot = await transport.fetchSource(normalizedUrl);
    const result = { ok: true, error: "", snapshot };
    sourceFetchCache.set(normalizedUrl, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err?.message || "fetch_failed", snapshot: null };
    sourceFetchCache.set(normalizedUrl, result);
    return result;
  }
}

async function verifySourceListWithFetch(sources = [], sourceFetchCache, analysisMeta, transport = null) {
  const normalizedSources = normalizeSourceList(sources);
  if (!transport?.fetchSource) {
    if (!analysisMeta.sourceVerificationSkippedReason) {
      analysisMeta.sourceVerificationSkippedReason = "fetchSource transport is not available.";
    }
    return {
      sources: normalizedSources,
      counters: {
        checked: 0,
        verified: 0,
        notFound: 0,
        fetchFailed: 0,
      },
    };
  }

  const counters = {
    checked: 0,
    verified: 0,
    notFound: 0,
    fetchFailed: 0,
  };

  const out = [];
  for (const source of normalizedSources) {
    const normalizedUrl = normalizeHttpUrl(source.url);
    if (!normalizedUrl) {
      out.push(source);
      continue;
    }

    counters.checked += 1;
    const fetched = await fetchSourceWithCache(normalizedUrl, sourceFetchCache, transport);
    if (!fetched.ok) {
      counters.fetchFailed += 1;
      out.push({
        ...source,
        url: normalizedUrl,
        verificationStatus: "fetch_failed",
        verificationNote: `Source fetch failed: ${fetched.error}`,
      });
      continue;
    }

    const found = quotedClaimFoundInPage(source, fetched.snapshot);
    if (found) {
      counters.verified += 1;
      out.push({
        ...source,
        url: normalizedUrl,
        verificationStatus: "verified_in_page",
        verificationNote: "Quoted claim text appears in fetched source content.",
      });
    } else {
      counters.notFound += 1;
      out.push({
        ...source,
        url: normalizedUrl,
        verificationStatus: "not_found_in_page",
        verificationNote: "Quoted claim text was not found in fetched source content.",
      });
    }
  }

  analysisMeta.sourceVerificationChecked += counters.checked;
  analysisMeta.sourceVerificationVerified += counters.verified;
  analysisMeta.sourceVerificationNotFound += counters.notFound;
  analysisMeta.sourceVerificationFetchFailed += counters.fetchFailed;

  return { sources: out, counters };
}

function applyCellVerificationPenalty(cell, counters, analysisMeta) {
  const checked = Number(counters.checked || 0);
  if (!checked) return;

  const verified = Number(counters.verified || 0);
  if (verified / checked >= 0.5) return;

  const current = normalizeConfidence(cell.confidence);
  const downgraded = confidenceFromRank(confidenceRank(current) - 1, current);
  if (downgraded !== current) {
    cell.confidence = downgraded;
    analysisMeta.sourceVerificationPenalizedCells += 1;
  }
  const note = `Source verification check: ${verified}/${checked} cited URLs contained the quoted claim text.`;
  const previous = cleanText(cell.confidenceReason).replace(/\s*Source verification check:[^.]*\./gi, "").trim();
  cell.confidenceReason = [previous, note].filter(Boolean).join(" ");
}

async function verifyMatrixCellSources(matrix, analysisMeta, sourceFetchCache, options = {}) {
  const penalizeConfidence = options?.penalizeConfidence !== false;
  const transport = options?.transport || null;
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];

  for (const cell of cells) {
    const checked = await verifySourceListWithFetch(cell.sources, sourceFetchCache, analysisMeta, transport);
    cell.sources = checked.sources;
    if (penalizeConfidence) {
      applyCellVerificationPenalty(cell, checked.counters, analysisMeta);
    }
  }

  return matrix;
}

function buildMatrixEvidencePrompt({
  rawInput,
  decisionQuestion,
  subjects,
  attributes,
  passLabel,
  liveSearch,
}) {
  const liveSearchBlock = liveSearch
    ? "Use live web search to ground evidence in current external sources and include real URLs when possible."
    : "Live web search is disabled for this pass. Use only internal model memory and explicitly mark uncertainty.";

  return `Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Pass:
${passLabel}

${liveSearchBlock}

Subjects:
${subjects.map((subject, idx) => `${idx + 1}. ${subject.label}`).join("\n")}

Attributes:
${attributes.map((attr) => `- ${attr.id}: ${attr.label}${attr.brief ? ` - ${attr.brief}` : ""}`).join("\n")}

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
}

function buildMatrixReconcilePrompt({ rawInput, decisionQuestion, subjects, attributes, baseline, web }) {
  return `Merge two matrix drafts for the same research question.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Subjects:
${subjects.map((subject, idx) => `${idx + 1}. ${subject.label}`).join("\n")}

Attributes:
${attributes.map((attr) => `- ${attr.id}: ${attr.label}`).join("\n")}

Draft A (memory-only baseline):
${JSON.stringify(baseline, null, 2)}

Draft B (web-assisted):
${JSON.stringify(web, null, 2)}

Rules:
- Reconcile each cell using the stronger evidence-backed variant.
- If one draft has clearly higher confidence with better sources, prefer it.
- If both are weak, keep conservative wording and low confidence.
- Keep output complete for all subject x attribute pairs.

Return JSON only with the same schema as analyst pass.`;
}

function buildLowConfidenceQueryPrompt({ rawInput, decisionQuestion, subject, attribute, cell }) {
  return `Generate targeted search queries for one low-confidence matrix cell.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Cell under review:
- Subject: ${subject.label}
- Attribute: ${attribute.label}
- Current confidence: ${normalizeConfidence(cell?.confidence)}
- Current reason: ${clip(cell?.confidenceReason, 180)}
- Current value: ${clip(cell?.value, 220)}

Task:
- Produce 3 to 4 specific search queries to close evidence gaps for this exact cell.
- Focus on verifiable facts and current market evidence.

Return JSON only:
{
  "gap": "<single sentence gap>",
  "queries": ["<q1>", "<q2>", "<q3>", "<q4 optional>"]
}`;
}

function buildLowConfidenceSearchPrompt({ rawInput, decisionQuestion, subject, attribute, queryPlan, cell }) {
  return `Run focused live web research for one low-confidence matrix cell.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Cell:
- Subject: ${subject.label}
- Attribute: ${attribute.label}
- Current value: ${clip(cell?.value, 220)}
- Gap: ${queryPlan?.gap || "Evidence is sparse."}

Queries:
${(queryPlan?.queries || []).map((query, idx) => `${idx + 1}. ${query}`).join("\n")}

Rules:
- Return only concrete findings with sources.
- Mark whether each query produced useful evidence.

Return JSON only:
{
  "findings": [
    {
      "query": "<exact query>",
      "fact": "<single concrete fact>",
      "source": {"name":"...","quote":"<max 20 words>","url":"...","sourceType":"<vendor|press|independent>"}
    }
  ],
  "queryCoverage": [
    {"query":"<exact query>","useful":<true|false>,"note":"<short note>"}
  ]
}`;
}

function buildLowConfidenceRescorePrompt({ rawInput, decisionQuestion, subject, attribute, cell, queryPlan, harvest }) {
  return `Re-evaluate one matrix cell using targeted findings.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Cell:
- Subject: ${subject.label}
- Attribute: ${attribute.label}

Current cell state:
${JSON.stringify(cell, null, 2)}

Targeted query plan:
${JSON.stringify(queryPlan || {}, null, 2)}

Targeted search findings:
${JSON.stringify(harvest || {}, null, 2)}

Rules:
- Keep updates evidence-based and conservative.
- Raise confidence only if uncertainty materially decreases.

Return JSON only:
{
  "value": "<updated finding>",
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "sources": [{"name":"...","quote":"<max 20 words>","url":"...","sourceType":"<vendor|press|independent>"}]
}`;
}

function buildMatrixCriticPrompt({ rawInput, decisionQuestion, subjects, attributes, matrix }) {
  return `Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Subjects:
${subjects.map((subject) => `- ${subject.label}`).join("\n")}

Attributes:
${attributes.map((attr) => `- ${attr.label}`).join("\n")}

Current matrix draft:
${JSON.stringify(matrix, null, 2)}

Audit this matrix and return JSON only:
{
  "flags": [
    {
      "subjectId": "<subject id>",
      "attributeId": "<attribute id>",
      "note": "<why this cell is weak/contested/contradictory>",
      "confidence": "<high|medium|low>",
      "suggestedValue": "<optional revised wording>"
    }
  ]
}`;
}

function buildMatrixAnalystResponsePrompt({ rawInput, decisionQuestion, subjects, attributes, cells, flags }) {
  const subjectLabel = new Map(subjects.map((s) => [s.id, s.label]));
  const attrLabel = new Map(attributes.map((a) => [a.id, a.label]));

  const contested = flags.map((flag) => {
    const key = buildCellKey(flag.subjectId, flag.attributeId);
    const cell = cells.find((item) => buildCellKey(item.subjectId, item.attributeId) === key) || {};
    return {
      subjectId: flag.subjectId,
      attributeId: flag.attributeId,
      subject: subjectLabel.get(flag.subjectId) || flag.subjectId,
      attribute: attrLabel.get(flag.attributeId) || flag.attributeId,
      currentValue: cell.value || "",
      currentConfidence: cell.confidence || "low",
      currentReason: cell.confidenceReason || "",
      currentSources: cell.sources || [],
      criticNote: flag.note || "",
      criticSuggestedValue: flag.suggestedValue || "",
      criticSuggestedConfidence: flag.suggestedConfidence || "",
    };
  });

  return `Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Contested matrix cells:
${JSON.stringify(contested, null, 2)}

Task:
- For each contested cell choose decision "defend" or "concede".
- defend: keep core cell conclusion, add stronger evidence or reasoning.
- concede: revise value/confidence based on critic challenge.
- Keep updates concise and source-backed.

Return JSON only:
{
  "responses": [
    {
      "subjectId": "<subject id>",
      "attributeId": "<attribute id>",
      "decision": "<defend|concede>",
      "value": "<updated or defended wording>",
      "confidence": "<high|medium|low>",
      "confidenceReason": "<1 sentence>",
      "analystNote": "<why this decision was made>",
      "sources": [{"name":"...","quote":"<max 20 words>","url":"...","sourceType":"<vendor|press|independent>"}]
    }
  ]
}`;
}

function buildMatrixDiscoveryPrompt({ rawInput, decisionQuestion, subjects, attributes }) {
  return `Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Subjects analyzed:
${subjects.map((s) => `- ${s.label}`).join("\n")}

Attributes analyzed:
${attributes.map((a) => `- ${a.label}`).join("\n")}

Return JSON only:
{
  "suggestedSubjects": [{"label":"<subject>","reason":"<why relevant>"}],
  "suggestedAttributes": [{"label":"<attribute>","reason":"<why relevant>"}],
  "notes": "<optional short note>"
}`;
}

function buildSubjectDiscoveryPrompt({ rawInput, decisionQuestion, subjectsSpec }) {
  const minCount = Math.max(2, Number(subjectsSpec?.minCount) || 2);
  const maxCount = Math.max(minCount, Number(subjectsSpec?.maxCount) || 8);
  const examples = Array.isArray(subjectsSpec?.examples) ? subjectsSpec.examples : [];
  const exampleBlock = examples.length
    ? `Examples:\n${examples.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}`
    : "";

  return `Research brief:
${rawInput}

Initial decision question:
${decisionQuestion || rawInput}

The user did not provide enough concrete subjects for matrix comparison.
Generate an evidence-backed shortlist.

Target range: ${minCount}-${maxCount} subjects.
${exampleBlock}

Return JSON only:
{
  "decisionQuestion": "<refined decision question>",
  "searchQueries": ["<q1>", "<q2>", "<q3>"],
  "suggestedSubjects": [
    {
      "label": "<subject>",
      "reason": "<why this subject should be included>",
      "sources": [{"name":"...","quote":"<max 20 words>","url":"...","sourceType":"<vendor|press|independent>"}]
    }
  ],
  "notes": "<optional short note for user confirmation>"
}`;
}

function normalizeSubjectDiscoveryResult(raw = {}, subjectsSpec = {}) {
  const suggestedSubjects = Array.isArray(raw?.suggestedSubjects)
    ? raw.suggestedSubjects
      .map((entry) => ({
        label: cleanText(entry?.label),
        reason: cleanText(entry?.reason),
        sources: normalizeSourceList(entry?.sources),
      }))
      .filter((entry) => entry.label)
      .slice(0, Math.max(2, Number(subjectsSpec?.maxCount) || 8))
    : [];

  const searchQueries = Array.isArray(raw?.searchQueries)
    ? raw.searchQueries.map((query) => cleanText(query)).filter(Boolean).slice(0, 6)
    : [];

  const labels = suggestedSubjects.map((entry) => entry.label);
  const normalizedSubjects = normalizeSubjectList(labels, subjectsSpec, { strict: false });

  return {
    decisionQuestion: cleanText(raw?.decisionQuestion),
    suggestedSubjects,
    normalizedSubjects,
    searchQueries,
    notes: cleanText(raw?.notes),
  };
}

function mergeSubjectEntries(primary = [], secondary = [], subjectsSpec = {}) {
  const minCount = Math.max(2, Number(subjectsSpec?.minCount) || 2);
  const maxCount = Math.max(minCount, Number(subjectsSpec?.maxCount) || 8);
  const seen = new Set();
  const out = [];

  const consume = (items = []) => {
    items.forEach((entry) => {
      const label = cleanText(entry?.label || entry);
      if (!label) return;
      const key = label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id: toId(label, `subject-${out.length + 1}`), label });
    });
  };

  consume(primary);
  consume(secondary);
  return out.slice(0, maxCount);
}

export async function resolveMatrixResearchInput(input, config, callbacks = {}, options = {}) {
  const desc = cleanText(input?.description || input?.rawInput);
  if (!desc) throw new Error("Matrix input description is required.");

  const subjectsSpec = config?.subjects || {};
  const minCount = Math.max(2, Number(subjectsSpec?.minCount) || 2);
  const explicitSubjects = normalizeSubjectList(input?.options?.matrixSubjects, subjectsSpec, { strict: false });
  const extractedLabels = extractSubjectsFromUnifiedPrompt(desc);
  const extractedSubjects = normalizeSubjectList(extractedLabels, subjectsSpec, { strict: false });
  const mergedLocal = mergeSubjectEntries(explicitSubjects, extractedSubjects, subjectsSpec);
  const decisionQuestion = extractDecisionQuestion(desc);

  if (mergedLocal.length >= minCount) {
    return {
      subjects: mergedLocal,
      decisionQuestion,
      extractedSubjects,
      localSubjects: mergedLocal,
      discovery: null,
      usedSubjectDiscovery: false,
      requiresConfirmation: false,
      discoveryMeta: null,
    };
  }

  const transport = callbacks?.transport;
  if (!transport?.callAnalyst) {
    throw new Error(`Please provide at least ${minCount} subjects or enable analyst transport for subject discovery.`);
  }

  const prompt = buildSubjectDiscoveryPrompt({ rawInput: desc, decisionQuestion, subjectsSpec });
  const modelCfg = config?.models?.analyst || {};
  const modelOptions = {
    liveSearch: true,
    includeMeta: true,
  };
  if (cleanText(modelCfg.provider)) modelOptions.provider = cleanText(modelCfg.provider);
  if (cleanText(modelCfg.model)) modelOptions.model = cleanText(modelCfg.model);
  if (cleanText(modelCfg.webSearchModel)) modelOptions.webSearchModel = cleanText(modelCfg.webSearchModel);
  if (cleanText(modelCfg.baseUrl)) modelOptions.baseUrl = cleanText(modelCfg.baseUrl);

  const response = await transport.callAnalyst(
    [{ role: "user", content: prompt }],
    cleanText(config?.prompts?.analyst) || MATRIX_SUBJECT_DISCOVERY_PROMPT,
    2200,
    modelOptions
  );

  const parsed = extractJson(response?.text || response, {});
  const discovery = normalizeSubjectDiscoveryResult(parsed, subjectsSpec);
  const discoveredSubjects = discovery.normalizedSubjects;
  if (discoveredSubjects.length < minCount) {
    throw new Error(`Subject discovery returned fewer than ${minCount} viable subjects. Please provide subjects explicitly.`);
  }

  const finalSubjects = mergeSubjectEntries(mergedLocal, discoveredSubjects, subjectsSpec);
  if (finalSubjects.length < minCount) {
    throw new Error(`Please confirm at least ${minCount} subjects before running matrix analysis.`);
  }

  const requireConfirmation = options?.requireConfirmation === true;
  return {
    subjects: finalSubjects,
    decisionQuestion: discovery.decisionQuestion || decisionQuestion,
    extractedSubjects,
    localSubjects: mergedLocal,
    discovery,
    usedSubjectDiscovery: true,
    requiresConfirmation: requireConfirmation,
    discoveryMeta: response?.meta || null,
  };
}

function applyCriticFlags(cells, criticFlags = []) {
  const flagMap = new Map();
  (criticFlags || []).forEach((flag) => {
    flagMap.set(buildCellKey(flag.subjectId, flag.attributeId), flag);
  });

  return (cells || []).map((cell) => {
    const flag = flagMap.get(buildCellKey(cell.subjectId, cell.attributeId));
    if (!flag) return { ...cell, contested: false, criticNote: cleanText(cell.criticNote) };
    return {
      ...cell,
      contested: true,
      criticNote: cleanText(flag.note || "Critic flagged this cell for weak support."),
      confidence: normalizeConfidence(flag.suggestedConfidence || cell.confidence),
      confidenceReason: cleanText(cell.confidenceReason || ""),
    };
  });
}

function normalizeQueryPlan(raw = {}, fallback = {}) {
  const queries = Array.isArray(raw?.queries)
    ? raw.queries.map((query) => cleanText(query)).filter(Boolean).slice(0, 4)
    : [];
  const fallbackQueries = Array.isArray(fallback?.queries)
    ? fallback.queries.map((query) => cleanText(query)).filter(Boolean).slice(0, 4)
    : [];
  const merged = [...new Set([...queries, ...fallbackQueries])].slice(0, 4);
  return {
    gap: cleanText(raw?.gap || fallback?.gap || "Evidence is still sparse for this cell."),
    queries: merged,
  };
}

function normalizeSearchHarvest(raw = {}, queryPlan = {}) {
  const findings = Array.isArray(raw?.findings)
    ? raw.findings
      .map((entry) => ({
        query: cleanText(entry?.query),
        fact: cleanText(entry?.fact),
        source: entry?.source && typeof entry.source === "object"
          ? {
              name: cleanText(entry.source.name),
              quote: cleanText(entry.source.quote).slice(0, 180),
              url: cleanText(entry.source.url),
              sourceType: cleanText(entry.source.sourceType).toLowerCase(),
            }
          : null,
      }))
      .filter((entry) => entry.fact && (entry.source?.name || entry.source?.url || entry.source?.quote))
      .slice(0, 10)
    : [];

  const queryCoverage = Array.isArray(raw?.queryCoverage)
    ? raw.queryCoverage
      .map((entry) => ({
        query: cleanText(entry?.query),
        useful: !!entry?.useful,
        note: cleanText(entry?.note).slice(0, 180),
      }))
      .filter((entry) => entry.query)
      .slice(0, 8)
    : [];

  if (!queryCoverage.length) {
    return {
      findings,
      queryCoverage: (queryPlan?.queries || []).map((query) => ({
        query,
        useful: findings.some((entry) => entry.query === query),
        note: findings.some((entry) => entry.query === query)
          ? "At least one useful finding returned."
          : "No useful finding captured.",
      })),
    };
  }

  return { findings, queryCoverage };
}

function mergeSources(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    normalizeSourceList(list).forEach((source) => {
      const key = `${source.name}|${source.quote}|${source.url}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(source);
    });
  }
  return out.slice(0, 12);
}

function normalizeMatrixDiscovery(raw = {}) {
  const suggestedSubjects = Array.isArray(raw?.suggestedSubjects)
    ? raw.suggestedSubjects
      .map((entry) => ({ label: cleanText(entry?.label), reason: cleanText(entry?.reason) }))
      .filter((entry) => entry.label)
      .slice(0, 8)
    : [];

  const suggestedAttributes = Array.isArray(raw?.suggestedAttributes)
    ? raw.suggestedAttributes
      .map((entry) => ({ label: cleanText(entry?.label), reason: cleanText(entry?.reason) }))
      .filter((entry) => entry.label)
      .slice(0, 8)
    : [];

  return {
    suggestedSubjects,
    suggestedAttributes,
    notes: cleanText(raw?.notes || ""),
  };
}

export async function runMatrixAnalysis(input, config, callbacks = {}) {
  const transport = callbacks?.transport;
  if (!transport?.callAnalyst || !transport?.callCritic) {
    throw new Error("runAnalysis requires callbacks.transport with callAnalyst and callCritic.");
  }

  const onProgress = typeof callbacks?.onProgress === "function" ? callbacks.onProgress : () => {};
  const onDebugSession = typeof callbacks?.onDebugSession === "function" ? callbacks.onDebugSession : null;
  let state = input?.initialState ? clone(input.initialState) : createInitialState(input);
  const sourceFetchCache = new Map();
  const debugSession = createAnalysisDebugSession({
    useCaseId: state.id,
    analysisMode: "matrix",
    rawInput: state.rawInput,
    dims: normalizeAttributeList(config?.attributes || []),
  });
  appendAnalysisDebugEvent(debugSession, {
    type: "analysis_start",
    phase: state.phase || "matrix_plan",
  });
  let runStatus = "error";
  let runError = null;

  const update = (phase, patch) => {
    state = { ...state, phase, ...patch };
    appendAnalysisDebugEvent(debugSession, {
      type: "phase_update",
      phase,
      status: String(state?.status || "analyzing"),
    });
    onProgress(phase, clone(state));
  };

  const limits = config?.limits?.tokenLimits || {};
  const analystTokens = Number(limits.phase1Evidence) || 10000;
  const criticTokens = Number(limits.critic) || 6000;
  const responseTokens = Number(limits.phase3Response) || 4200;
  const discoveryTokens = Number(limits.phase3Response) || 3200;

  const analystPrompt = cleanText(config?.prompts?.matrixAnalyst) || MATRIX_ANALYST_PROMPT;
  const criticPrompt = cleanText(config?.prompts?.matrixCritic) || MATRIX_CRITIC_PROMPT;

  try {
    const resolvedInput = await resolveMatrixResearchInput(input, config, { transport }, { requireConfirmation: false });

    state.analysisMeta.subjectDiscoveryRequested = true;
    state.analysisMeta.subjectDiscoverySuggestedCount = resolvedInput?.discovery?.normalizedSubjects?.length || 0;
    state.analysisMeta = mergeMeta(state.analysisMeta, resolvedInput?.discoveryMeta, "subject_discovery");

    const subjects = resolvedInput.subjects;
    const attributes = normalizeAttributeList(config?.attributes || []);
    const layout = normalizeLayoutHint(config?.matrixLayout);
    const decisionQuestion = resolvedInput?.decisionQuestion || extractDecisionQuestion(state.rawInput) || state.rawInput;
    const relatedDiscovery = config?.relatedDiscovery !== false;

    update("matrix_plan", {
      outputMode: "matrix",
      matrix: {
        layout,
        decisionQuestion,
        subjects,
        attributes,
        cells: [],
        subjectSummaries: [],
        crossMatrixSummary: "",
        coverage: { totalCells: subjects.length * attributes.length, lowConfidenceCells: 0, contestedCells: 0 },
        discovery: null,
        subjectResolution: {
          usedSubjectDiscovery: !!resolvedInput.usedSubjectDiscovery,
          extractedSubjects: resolvedInput.extractedSubjects || [],
          localSubjects: resolvedInput.localSubjects || [],
          notes: resolvedInput?.discovery?.notes || "",
        },
      },
    });

    update("matrix_baseline", {});
    const baselinePrompt = buildMatrixEvidencePrompt({
      rawInput: state.rawInput,
      decisionQuestion,
      subjects,
      attributes,
      passLabel: "baseline memory-only pass",
      liveSearch: false,
    });
    const baselineRes = await transport.callAnalyst(
      [{ role: "user", content: baselinePrompt }],
      analystPrompt,
      analystTokens,
      {
        ...roleOptions(config, "analyst"),
        liveSearch: false,
        includeMeta: true,
      }
    );
    const baselineParsed = extractJson(baselineRes?.text || baselineRes, {});
    const baselineMatrix = normalizeAnalystMatrix(baselineParsed, subjects, attributes);
    state.analysisMeta = mergeMeta(state.analysisMeta, baselineRes?.meta, "analyst");
    await verifyMatrixCellSources(baselineMatrix, state.analysisMeta, sourceFetchCache, {
      penalizeConfidence: true,
      transport,
    });

    update("matrix_web", {
      matrix: {
        ...state.matrix,
        ...baselineMatrix,
        coverage: summarizeCoverage(baselineMatrix.cells),
      },
      analysisMeta: state.analysisMeta,
    });

    const webPrompt = buildMatrixEvidencePrompt({
      rawInput: state.rawInput,
      decisionQuestion,
      subjects,
      attributes,
      passLabel: "web-assisted pass",
      liveSearch: true,
    });
    const webRes = await transport.callAnalyst(
      [{ role: "user", content: webPrompt }],
      analystPrompt,
      analystTokens,
      {
        ...roleOptions(config, "analyst"),
        liveSearch: true,
        includeMeta: true,
      }
    );
    const webParsed = extractJson(webRes?.text || webRes, {});
    const webMatrix = normalizeAnalystMatrix(webParsed, subjects, attributes);
    state.analysisMeta = mergeMeta(state.analysisMeta, webRes?.meta, "analyst");
    await verifyMatrixCellSources(webMatrix, state.analysisMeta, sourceFetchCache, {
      penalizeConfidence: true,
      transport,
    });

    update("matrix_reconcile", {
      matrix: {
        ...state.matrix,
        ...webMatrix,
        coverage: summarizeCoverage(webMatrix.cells),
      },
      analysisMeta: state.analysisMeta,
    });

    const reconcilePrompt = buildMatrixReconcilePrompt({
      rawInput: state.rawInput,
      decisionQuestion,
      subjects,
      attributes,
      baseline: baselineMatrix,
      web: webMatrix,
    });
    const reconcileRes = await transport.callAnalyst(
      [{ role: "user", content: reconcilePrompt }],
      analystPrompt,
      analystTokens,
      {
        ...roleOptions(config, "analyst"),
        liveSearch: false,
        includeMeta: true,
      }
    );
    const reconcileParsed = extractJson(reconcileRes?.text || reconcileRes, {});
    let reconciledMatrix = normalizeAnalystMatrix(reconcileParsed, subjects, attributes);
    state.analysisMeta = mergeMeta(state.analysisMeta, reconcileRes?.meta, "analyst");
    await verifyMatrixCellSources(reconciledMatrix, state.analysisMeta, sourceFetchCache, {
      penalizeConfidence: true,
      transport,
    });

    state.analysisMeta.matrixHybridStats = matrixHybridStats(subjects, attributes, baselineMatrix, webMatrix, reconciledMatrix);

    update("matrix_targeted", {
      matrix: {
        ...state.matrix,
        ...reconciledMatrix,
        coverage: summarizeCoverage(reconciledMatrix.cells),
      },
      analysisMeta: state.analysisMeta,
    });

    const lowCells = reconciledMatrix.cells
      .filter((cell) => normalizeConfidence(cell.confidence) === "low")
      .slice(0, 8);

    state.analysisMeta.lowConfidenceInitialCount = lowCells.length;
    state.analysisMeta.lowConfidenceUpgradedCount = 0;
    state.analysisMeta.lowConfidenceValidatedLowCount = 0;
    state.analysisMeta.lowConfidenceCycleFailures = 0;
    state.analysisMeta.lowConfidenceTargetedSearchUsed = false;
    state.analysisMeta.lowConfidenceTargetedWebSearchCalls = 0;
    state.analysisMeta.lowConfidenceTargetedFallbackReason = null;

    for (const cell of lowCells) {
      const subject = subjects.find((item) => item.id === cell.subjectId);
      const attribute = attributes.find((item) => item.id === cell.attributeId);
      if (!subject || !attribute) continue;

      const fallbackPlan = {
        gap: `Evidence is weak for ${subject.label} x ${attribute.label}.`,
        queries: [
          `${subject.label} ${attribute.label} case study metrics`,
          `${subject.label} ${attribute.label} benchmark evidence`,
          `${subject.label} ${attribute.label} customer outcome`,
        ],
      };

      let queryPlan = fallbackPlan;
      try {
        const queryPrompt = buildLowConfidenceQueryPrompt({
          rawInput: state.rawInput,
          decisionQuestion,
          subject,
          attribute,
          cell,
        });
        const queryRes = await transport.callAnalyst(
          [{ role: "user", content: queryPrompt }],
          analystPrompt,
          1400,
          {
            ...roleOptions(config, "analyst"),
            liveSearch: false,
            includeMeta: true,
          }
        );
        state.analysisMeta = mergeTargetedMeta(state.analysisMeta, queryRes?.meta);
        queryPlan = normalizeQueryPlan(extractJson(queryRes?.text || queryRes, {}), fallbackPlan);
      } catch (_) {
        queryPlan = fallbackPlan;
      }

      let harvest = {
        findings: [],
        queryCoverage: queryPlan.queries.map((query) => ({ query, useful: false, note: "No useful findings captured." })),
      };
      try {
        const searchPrompt = buildLowConfidenceSearchPrompt({
          rawInput: state.rawInput,
          decisionQuestion,
          subject,
          attribute,
          queryPlan,
          cell,
        });
        const searchRes = await transport.callAnalyst(
          [{ role: "user", content: searchPrompt }],
          analystPrompt,
          2600,
          {
            ...roleOptions(config, "analyst"),
            liveSearch: true,
            includeMeta: true,
          }
        );
        state.analysisMeta = mergeTargetedMeta(state.analysisMeta, searchRes?.meta);
        harvest = normalizeSearchHarvest(extractJson(searchRes?.text || searchRes, {}), queryPlan);
      } catch (_) {
        harvest = {
          findings: [],
          queryCoverage: queryPlan.queries.map((query) => ({ query, useful: false, note: "No useful findings captured." })),
        };
      }

      try {
        const rescorePrompt = buildLowConfidenceRescorePrompt({
          rawInput: state.rawInput,
          decisionQuestion,
          subject,
          attribute,
          cell,
          queryPlan,
          harvest,
        });
        const rescoreRes = await transport.callAnalyst(
          [{ role: "user", content: rescorePrompt }],
          analystPrompt,
          2400,
          {
            ...roleOptions(config, "analyst"),
            liveSearch: false,
            includeMeta: true,
          }
        );
        state.analysisMeta = mergeTargetedMeta(state.analysisMeta, rescoreRes?.meta);

        const parsed = extractJson(rescoreRes?.text || rescoreRes, {});
        const nextConfidence = normalizeConfidence(parsed?.confidence || cell.confidence);
        const upgraded = confidenceRank(nextConfidence) > confidenceRank(cell.confidence);

        const updatedCell = {
          ...cell,
          value: cleanText(parsed?.value || cell.value),
          confidence: nextConfidence,
          confidenceReason: cleanText(parsed?.confidenceReason || cell.confidenceReason),
          sources: mergeSources(cell.sources, parsed?.sources, (harvest.findings || []).map((entry) => entry.source)),
        };

        reconciledMatrix = upsertCell(reconciledMatrix, updatedCell);
        if (upgraded) {
          state.analysisMeta.lowConfidenceUpgradedCount += 1;
        } else if (nextConfidence === "low") {
          state.analysisMeta.lowConfidenceValidatedLowCount += 1;
        }
      } catch (_) {
        state.analysisMeta.lowConfidenceCycleFailures += 1;
      }
    }

    await verifyMatrixCellSources(reconciledMatrix, state.analysisMeta, sourceFetchCache, {
      penalizeConfidence: true,
      transport,
    });

    update("matrix_critic", {
      matrix: {
        ...state.matrix,
        ...reconciledMatrix,
        coverage: summarizeCoverage(reconciledMatrix.cells),
      },
      analysisMeta: state.analysisMeta,
    });

    const criticPromptText = buildMatrixCriticPrompt({
      rawInput: state.rawInput,
      decisionQuestion,
      subjects,
      attributes,
      matrix: reconciledMatrix,
    });

    const criticRes = await transport.callCritic(
      [{ role: "user", content: criticPromptText }],
      criticPrompt,
      criticTokens,
      {
        ...roleOptions(config, "critic"),
        liveSearch: true,
        includeMeta: true,
      }
    );
    state.analysisMeta = mergeMeta(state.analysisMeta, criticRes?.meta, "critic");
    const criticFlags = normalizeCriticFlags(extractJson(criticRes?.text || criticRes, {}), subjects, attributes);
    const critiquedCells = applyCriticFlags(reconciledMatrix.cells, criticFlags);

    update("matrix_response", {
      matrix: {
        ...state.matrix,
        ...reconciledMatrix,
        cells: critiquedCells,
        coverage: summarizeCoverage(critiquedCells),
      },
      analysisMeta: state.analysisMeta,
    });

    let responseAppliedCells = critiquedCells;
    if (criticFlags.length) {
      const responsePrompt = buildMatrixAnalystResponsePrompt({
        rawInput: state.rawInput,
        decisionQuestion,
        subjects,
        attributes,
        cells: critiquedCells,
        flags: criticFlags,
      });

      const responseRes = await transport.callAnalyst(
        [{ role: "user", content: responsePrompt }],
        cleanText(config?.prompts?.analystResponse) || MATRIX_ANALYST_PROMPT,
        responseTokens,
        {
          ...roleOptions(config, "analyst"),
          liveSearch: true,
          includeMeta: true,
        }
      );
      state.analysisMeta = mergeMeta(state.analysisMeta, responseRes?.meta, "analyst");
      const responses = normalizeAnalystResponses(extractJson(responseRes?.text || responseRes, {}), subjects, attributes);

      const responseMap = new Map();
      responses.forEach((entry) => {
        responseMap.set(buildCellKey(entry.subjectId, entry.attributeId), entry);
      });

      responseAppliedCells = critiquedCells.map((cell) => {
        const key = buildCellKey(cell.subjectId, cell.attributeId);
        const response = responseMap.get(key);
        if (!response) return cell;

        const previousSources = normalizeSourceList(cell.sources);
        const nextSources = mergeSources(previousSources, response.sources);
        const previousNamed = new Set(previousSources.map((src) => cleanText(src.name).toLowerCase()).filter(Boolean));
        const newNamedCount = nextSources
          .map((src) => cleanText(src.name).toLowerCase())
          .filter((name) => name && !previousNamed.has(name)).length;

        const decision = response.decision === "concede" ? "concede" : "defend";
        if (decision === "concede") {
          state.analysisMeta.contestedCellsConceded += 1;
        } else {
          state.analysisMeta.contestedCellsDefended += 1;
        }
        state.analysisMeta.contestedCellsResolved += 1;

        const nextConfidenceRaw = normalizeConfidence(response.confidence || cell.confidence);
        const guardedConfidence = decision === "defend" && newNamedCount < 1
          ? confidenceFromRank(Math.min(confidenceRank(cell.confidence), confidenceRank(nextConfidenceRaw)), cell.confidence)
          : nextConfidenceRaw;

        return {
          ...cell,
          value: decision === "concede"
            ? cleanText(response.value || cell.value)
            : cleanText(response.value || cell.value),
          confidence: guardedConfidence,
          confidenceReason: cleanText(response.confidenceReason || cell.confidenceReason),
          sources: nextSources,
          contested: false,
          analystDecision: decision,
          analystNote: cleanText(response.analystNote || ""),
        };
      });
    }

    const resolvedMatrix = {
      ...reconciledMatrix,
      cells: responseAppliedCells,
      coverage: summarizeCoverage(responseAppliedCells),
    };
    await verifyMatrixCellSources(resolvedMatrix, state.analysisMeta, sourceFetchCache, {
      penalizeConfidence: true,
      transport,
    });

    update("matrix_summary", {
      matrix: {
        ...state.matrix,
        ...resolvedMatrix,
        coverage: summarizeCoverage(resolvedMatrix.cells),
      },
      analysisMeta: state.analysisMeta,
    });

    if (relatedDiscovery) {
      update("matrix_discover", {});
      const discoveryPromptText = buildMatrixDiscoveryPrompt({
        rawInput: state.rawInput,
        decisionQuestion,
        subjects,
        attributes,
      });
      const discoverRes = await transport.callAnalyst(
        [{ role: "user", content: discoveryPromptText }],
        MATRIX_DISCOVERY_PROMPT,
        discoveryTokens,
        {
          ...roleOptions(config, "analyst"),
          liveSearch: true,
          includeMeta: true,
        }
      );
      state.analysisMeta = mergeMeta(state.analysisMeta, discoverRes?.meta, "discover");
      const discovery = normalizeMatrixDiscovery(extractJson(discoverRes?.text || discoverRes, {}));

      state.analysisMeta.generatedDiscoverCandidatesCount = Number(discovery.suggestedSubjects.length + discovery.suggestedAttributes.length);
      state.analysisMeta.discoverCandidatesCount = Number(discovery.suggestedSubjects.length + discovery.suggestedAttributes.length);
      state.analysisMeta.rejectedDiscoverCandidatesCount = 0;

      update("complete", {
        status: "complete",
        matrix: {
          ...state.matrix,
          ...resolvedMatrix,
          discovery,
          coverage: summarizeCoverage(resolvedMatrix.cells),
        },
        discover: {
          mode: "matrix",
          suggestedSubjects: discovery.suggestedSubjects,
          suggestedAttributes: discovery.suggestedAttributes,
          notes: discovery.notes,
        },
        analysisMeta: state.analysisMeta,
      });
    } else {
      update("complete", {
        status: "complete",
        matrix: {
          ...state.matrix,
          ...resolvedMatrix,
          coverage: summarizeCoverage(resolvedMatrix.cells),
        },
        analysisMeta: state.analysisMeta,
      });
    }
    runStatus = "complete";
  } catch (err) {
    runError = err;
    update("error", {
      status: "error",
      errorMsg: err?.message || "Matrix analysis failed.",
    });
    throw err;
  } finally {
    appendAnalysisDebugEvent(debugSession, {
      type: "analysis_end",
      phase: "matrix",
      status: runStatus,
      error: runError ? String(runError?.message || runError) : "",
    });
    const completedDebugSession = finalizeAnalysisDebugSession(debugSession, {
      status: runStatus,
      error: runError,
      analysisMeta: state?.analysisMeta || null,
    });
    if (onDebugSession) {
      onDebugSession(completedDebugSession, {
        downloadRequested: !!input?.options?.downloadDebugLog,
      });
    }
  }

  return clone(state);
}
