import { normalizeReasonCodes } from "../../pipeline/contracts/reason-codes.js";

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
