import { finalizeAnalysisDebugSession, timestampTag } from "@researchit/engine";

const MAX_COMPLETED_SESSIONS = 50;
const completedSessions = [];

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

export function storeCompletedAnalysisDebugSession(session, meta = {}) {
  if (!session) return null;
  const payload = session?.finishedAt ? session : finalizeAnalysisDebugSession(session, meta);
  completedSessions.unshift(payload);
  if (completedSessions.length > MAX_COMPLETED_SESSIONS) {
    completedSessions.length = MAX_COMPLETED_SESSIONS;
  }
  return payload;
}

export function downloadAnalysisDebugSession(session, meta = {}) {
  const payload = session?.finishedAt ? session : finalizeAnalysisDebugSession(session, meta);
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
