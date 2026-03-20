const MAX_TEXT = 120000;

function trimText(value, max = MAX_TEXT) {
  if (value == null) return value;
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}... [trimmed ${text.length - max} chars]`;
}

function sanitizeEvent(event = {}) {
  const out = { ...event };
  if (out.phase) out.phase = trimText(out.phase, 120);
  if (out.attempt) out.attempt = trimText(out.attempt, 120);
  if (out.type) out.type = trimText(out.type, 120);
  if (out.error) out.error = trimText(out.error, 8000);
  if (out.parseNear) out.parseNear = trimText(out.parseNear, 8000);
  if (out.prompt) out.prompt = trimText(out.prompt, 50000);
  if (out.response) out.response = trimText(out.response, MAX_TEXT);
  if (out.responseExcerpt) out.responseExcerpt = trimText(out.responseExcerpt, 12000);
  return out;
}

function timestampTag(isoDate = new Date().toISOString()) {
  return isoDate.replace(/[:.]/g, "-");
}

export function createAnalysisDebugSession({ useCaseId, analysisMode, rawInput, dims }) {
  return {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    useCaseId: String(useCaseId || ""),
    analysisMode: String(analysisMode || "standard"),
    rawInput: trimText(rawInput || "", 5000),
    dimensions: (dims || []).map((d) => ({
      id: d.id,
      label: d.label,
      weight: d.weight,
      enabled: !!d.enabled,
    })),
    events: [],
  };
}

export function appendAnalysisDebugEvent(session, event) {
  if (!session || !Array.isArray(session.events)) return;
  const entry = sanitizeEvent({
    time: new Date().toISOString(),
    ...event,
  });
  session.events.push(entry);
}

export function downloadAnalysisDebugSession(session, { status, error, analysisMeta } = {}) {
  if (typeof window === "undefined" || !session) return;

  const finishedAt = new Date().toISOString();
  const payload = {
    ...session,
    finishedAt,
    status: status || "unknown",
    error: error ? {
      message: trimText(error.message || String(error), 12000),
      stack: trimText(error.stack || "", 30000),
    } : null,
    analysisMeta: analysisMeta || null,
  };

  const fileName = `analysis-debug-${session.useCaseId || "unknown"}-${timestampTag(finishedAt)}.json`;
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
