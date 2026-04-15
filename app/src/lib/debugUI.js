import { finalizeAnalysisDebugSession, timestampTag } from "@researchit/engine";

const MAX_COMPLETED_SESSIONS = 1;
const completedSessions = [];
let activeRunCapture = null;

const MAX_TEXT = 5000000;
const MAX_ARRAY_ITEMS = 1200;
const MAX_OBJECT_KEYS = 1200;

function trimText(value, max = MAX_TEXT) {
  if (value == null) return value;
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}... [trimmed ${text.length - max} chars]`;
}

function sanitizeValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return trimText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 8) return "[depth-limit]";

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[trimmed ${value.length - MAX_ARRAY_ITEMS} array items]`);
    }
    return items;
  }

  if (typeof value === "object") {
    const out = {};
    const keys = Object.keys(value);
    keys.slice(0, MAX_OBJECT_KEYS).forEach((key) => {
      out[key] = sanitizeValue(value[key], depth + 1);
    });
    if (keys.length > MAX_OBJECT_KEYS) {
      out.__trimmed_keys__ = keys.length - MAX_OBJECT_KEYS;
    }
    return out;
  }

  return String(value);
}

function downloadJsonFile(fileName, payload) {
  if (typeof window === "undefined") return;
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function startRunDebugCapture({ useCaseId = "", analysisMode = "", rawInput = "" } = {}) {
  activeRunCapture = {
    schemaVersion: 1,
    useCaseId: String(useCaseId || "").trim(),
    analysisMode: String(analysisMode || "").trim(),
    rawInput: trimText(rawInput || "", 5000),
    startedAt: new Date().toISOString(),
    events: [],
  };
  return activeRunCapture;
}

export function appendRunDebugNetworkEvent(event = {}) {
  if (!activeRunCapture || !Array.isArray(activeRunCapture.events)) return null;
  const entry = sanitizeValue({
    time: new Date().toISOString(),
    ...event,
  });
  activeRunCapture.events.push(entry);
  if (activeRunCapture.events.length > 3000) {
    activeRunCapture.events = activeRunCapture.events.slice(-3000);
  }
  return entry;
}

export function stopRunDebugCapture(useCaseId = "") {
  if (!activeRunCapture) return null;
  if (useCaseId && String(useCaseId || "").trim() && activeRunCapture.useCaseId !== String(useCaseId || "").trim()) {
    return null;
  }
  const capture = {
    ...activeRunCapture,
    finishedAt: new Date().toISOString(),
    eventCount: activeRunCapture.events.length,
  };
  activeRunCapture = null;
  return capture;
}

export function storeCompletedAnalysisDebugSession(session, meta = {}) {
  if (!session) return null;
  const payload = session?.finishedAt ? session : finalizeAnalysisDebugSession(session, meta);
  const networkCapture = meta?.networkCapture || null;
  const mergedPayload = networkCapture
    ? {
      ...payload,
      networkTrace: sanitizeValue(networkCapture),
    }
    : payload;
  completedSessions.unshift(mergedPayload);
  if (completedSessions.length > MAX_COMPLETED_SESSIONS) {
    completedSessions.length = MAX_COMPLETED_SESSIONS;
  }
  return mergedPayload;
}

export function downloadAnalysisDebugSession(session, meta = {}) {
  const finalized = session?.finishedAt ? session : finalizeAnalysisDebugSession(session, meta);
  const payload = meta?.networkCapture
    ? { ...finalized, networkTrace: sanitizeValue(meta.networkCapture) }
    : finalized;
  const fileName = `analysis-debug-${session?.useCaseId || "unknown"}-${timestampTag(payload.finishedAt)}.json`;
  downloadJsonFile(fileName, payload);
}

export function downloadDebugLogsBundle() {
  if (typeof window === "undefined") return false;
  if (!completedSessions.length) {
    window.alert("No debug logs captured yet in this browser session.");
    return false;
  }

  const exportedAt = new Date().toISOString();
  const payload = {
    schemaVersion: 1,
    exportedAt,
    sessionCount: completedSessions.length,
    sessions: completedSessions,
  };
  const fileName = `analysis-debug-bundle-${timestampTag(exportedAt)}.json`;
  downloadJsonFile(fileName, payload);
  return true;
}
