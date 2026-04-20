import { normalizeReasonCodes } from "../../pipeline/contracts/reason-codes.js";

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function summarizeChunkTrace(chunkTrace = []) {
  const trace = ensureArray(chunkTrace);
  if (!trace.length) {
    return {
      chunksStarted: 0,
      chunksCompleted: 0,
      chunksFailed: 0,
      chunkRetriesTotal: 0,
      chunkSplitDepthMax: 0,
    };
  }
  const summary = {
    chunksStarted: 0,
    chunksCompleted: 0,
    chunksFailed: 0,
    chunkRetriesTotal: 0,
    chunkSplitDepthMax: 0,
  };
  trace.forEach((entry) => {
    const event = String(entry?.event || "").trim().toLowerCase();
    const depth = toNumber(entry?.depth, 0);
    if (depth > summary.chunkSplitDepthMax) summary.chunkSplitDepthMax = depth;
    if (event === "started") summary.chunksStarted += 1;
    if (event === "completed") summary.chunksCompleted += 1;
    if (event === "failed") summary.chunksFailed += 1;
    if (event === "retried") summary.chunkRetriesTotal += 1;
  });
  return summary;
}

export function createStageRecord(stageId, meta = {}) {
  return {
    stage: stageId,
    title: meta?.title || stageId,
    status: "running",
    startedAt: nowIso(),
    endedAt: "",
    reasonCodes: [],
    retries: 0,
    durationMs: 0,
    modelRoute: meta?.modelRoute || null,
    tokens: null,
    cost: null,
    diagnostics: {},
  };
}

export function completeStageRecord(record = {}, patch = {}) {
  const started = record?.startedAt ? Date.parse(record.startedAt) : Date.now();
  const endedAt = nowIso();
  const ended = Date.parse(endedAt);
  return {
    ...record,
    ...patch,
    status: patch?.status || record?.status || "ok",
    endedAt,
    durationMs: toNumber(ended - started, 0),
    reasonCodes: normalizeReasonCodes([
      ...(Array.isArray(record?.reasonCodes) ? record.reasonCodes : []),
      ...(Array.isArray(patch?.reasonCodes) ? patch.reasonCodes : []),
    ]),
  };
}

export function appendStageRecord(state = {}, record = {}) {
  if (!state?.diagnostics || typeof state.diagnostics !== "object") return state;
  const stages = Array.isArray(state.diagnostics.stages) ? state.diagnostics.stages : [];
  state.diagnostics.stages = [...stages, record];
  return state;
}

export function updateStageRecord(state = {}, record = {}) {
  if (!state?.diagnostics || typeof state.diagnostics !== "object") return state;
  const stages = Array.isArray(state.diagnostics.stages) ? state.diagnostics.stages : [];
  const idx = stages.findIndex((s) => s?.stage === record?.stage);
  if (idx >= 0) {
    state.diagnostics.stages = stages.map((s, i) => (i === idx ? record : s));
  } else {
    state.diagnostics.stages = [...stages, record];
  }
  return state;
}

export function appendIoRecord(state = {}, ioEntry = {}) {
  if (!state?.diagnostics || typeof state.diagnostics !== "object") return state;
  const io = Array.isArray(state.diagnostics.io) ? state.diagnostics.io : [];
  const entry = {
    time: nowIso(),
    ...ioEntry,
  };
  state.diagnostics.io = [...io, entry];
  return state;
}

export function appendProgressRecord(state = {}, progress = {}) {
  if (!state?.diagnostics || typeof state.diagnostics !== "object") return state;
  const list = Array.isArray(state.diagnostics.progress) ? state.diagnostics.progress : [];
  state.diagnostics.progress = [...list, { time: nowIso(), ...progress }];
  return state;
}

export function pushReasonCodes(state = {}, reasonCodes = []) {
  if (!state?.diagnostics || typeof state.diagnostics !== "object") return state;
  const merged = normalizeReasonCodes([
    ...(Array.isArray(state.diagnostics.reasonCodes) ? state.diagnostics.reasonCodes : []),
    ...(Array.isArray(reasonCodes) ? reasonCodes : []),
  ]);
  state.diagnostics.reasonCodes = merged;
  return state;
}

export function finalizeStageDiagnostics(diagnostics = {}) {
  const out = diagnostics && typeof diagnostics === "object"
    ? { ...diagnostics }
    : {};
  const trace = ensureArray(out?.chunkTrace);
  if (trace.length) {
    out.chunkTrace = trace.map((entry) => ({
      timestamp: nowIso(),
      ...entry,
    }));
    const traceSummary = summarizeChunkTrace(trace);
    Object.keys(traceSummary).forEach((key) => {
      if (out[key] == null) out[key] = traceSummary[key];
    });
  }
  if (out?.cacheDiagnostics && typeof out.cacheDiagnostics === "object") {
    out.cacheDiagnostics = {
      cacheKey: String(out.cacheDiagnostics?.cacheKey || ""),
      hash: String(out.cacheDiagnostics?.hash || ""),
      cacheHit: out.cacheDiagnostics?.cacheHit === true,
      cacheAgeMs: toNumber(out.cacheDiagnostics?.cacheAgeMs, 0),
      hashInputs: out.cacheDiagnostics?.hashInputs && typeof out.cacheDiagnostics.hashInputs === "object"
        ? out.cacheDiagnostics.hashInputs
        : {},
      missReason: String(out.cacheDiagnostics?.missReason || ""),
    };
  }
  return out;
}
