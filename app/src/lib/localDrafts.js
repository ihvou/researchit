const KEY = "researchit_local_drafts_v1";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

export function loadLocalDraftState() {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return null;
  const parsed = safeParse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const savedAt = Number(parsed.savedAt || 0);
  if (savedAt && Date.now() - savedAt > MAX_AGE_MS) {
    window.localStorage.removeItem(KEY);
    return null;
  }
  return parsed;
}

export function saveLocalDraftState(payload = {}) {
  if (typeof window === "undefined") return;
  const safePayload = {
    version: 1,
    savedAt: Date.now(),
    useCases: Array.isArray(payload?.useCases) ? payload.useCases : [],
    setupByConfig: payload?.setupByConfig || {},
    dimsByConfig: payload?.dimsByConfig || {},
    activeConfigId: payload?.activeConfigId || null,
    inputText: String(payload?.inputText || ""),
    evidenceMode: String(payload?.evidenceMode || "native"),
  };
  window.localStorage.setItem(KEY, JSON.stringify(safePayload));
}

export function clearLocalDraftState() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}
