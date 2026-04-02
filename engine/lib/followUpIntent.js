export const FOLLOW_UP_INTENTS = {
  CHALLENGE: "challenge",
  QUESTION: "question",
  REFRAME: "reframe",
  ADD_EVIDENCE: "add_evidence",
  NOTE: "note",
  RE_SEARCH: "re_search",
};

export const ALL_FOLLOW_UP_INTENTS = new Set(Object.values(FOLLOW_UP_INTENTS));

export function normalizeFollowUpIntent(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === FOLLOW_UP_INTENTS.CHALLENGE) return FOLLOW_UP_INTENTS.CHALLENGE;
  if (raw === FOLLOW_UP_INTENTS.QUESTION) return FOLLOW_UP_INTENTS.QUESTION;
  if (raw === FOLLOW_UP_INTENTS.REFRAME) return FOLLOW_UP_INTENTS.REFRAME;
  if (raw === FOLLOW_UP_INTENTS.ADD_EVIDENCE) return FOLLOW_UP_INTENTS.ADD_EVIDENCE;
  if (raw === FOLLOW_UP_INTENTS.NOTE) return FOLLOW_UP_INTENTS.NOTE;
  if (raw === FOLLOW_UP_INTENTS.RE_SEARCH || raw === "research" || raw === "re-search") return FOLLOW_UP_INTENTS.RE_SEARCH;
  return "";
}

export function intentDisplayLabel(intent) {
  const n = normalizeFollowUpIntent(intent);
  if (n === FOLLOW_UP_INTENTS.CHALLENGE) return "Challenge";
  if (n === FOLLOW_UP_INTENTS.QUESTION) return "Question";
  if (n === FOLLOW_UP_INTENTS.REFRAME) return "Reframe";
  if (n === FOLLOW_UP_INTENTS.ADD_EVIDENCE) return "Add Evidence";
  if (n === FOLLOW_UP_INTENTS.NOTE) return "Note / Comment";
  if (n === FOLLOW_UP_INTENTS.RE_SEARCH) return "Re-search";
  return "Message";
}

export function pmIntentLabel(intent) {
  const n = normalizeFollowUpIntent(intent);
  if (n === FOLLOW_UP_INTENTS.CHALLENGE) return "Your Challenge";
  if (n === FOLLOW_UP_INTENTS.QUESTION) return "Your Question";
  if (n === FOLLOW_UP_INTENTS.REFRAME) return "Your Reframe Request";
  if (n === FOLLOW_UP_INTENTS.ADD_EVIDENCE) return "Evidence Added";
  if (n === FOLLOW_UP_INTENTS.NOTE) return "Your Note";
  if (n === FOLLOW_UP_INTENTS.RE_SEARCH) return "Your Re-search Request";
  return "Your Message";
}

export function intentAllowsScoreProposal(intent) {
  const n = normalizeFollowUpIntent(intent);
  return n === FOLLOW_UP_INTENTS.CHALLENGE
    || n === FOLLOW_UP_INTENTS.ADD_EVIDENCE
    || n === FOLLOW_UP_INTENTS.RE_SEARCH;
}

export function intentNeedsAnalystResponse(intent) {
  return normalizeFollowUpIntent(intent) !== FOLLOW_UP_INTENTS.NOTE;
}

export function extractUrls(text) {
  if (!text) return [];
  const matches = String(text).match(/https?:\/\/[^\s<>"')]+/gi) || [];
  const uniq = [];
  const seen = new Set();
  for (const raw of matches) {
    const url = raw.replace(/[),.;!?]+$/g, "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    uniq.push(url);
  }
  return uniq;
}

export function fallbackIntentFromText(input) {
  const text = String(input || "").trim();
  const lower = text.toLowerCase();

  if (!text) return FOLLOW_UP_INTENTS.CHALLENGE;
  if (extractUrls(text).length > 0) return FOLLOW_UP_INTENTS.ADD_EVIDENCE;
  if (/\b(note|fyi|for review|internal comment|just a comment)\b/.test(lower)) return FOLLOW_UP_INTENTS.NOTE;
  if (/\b(research again|search again|re-search|fresh search|latest sources|check latest)\b/.test(lower)) return FOLLOW_UP_INTENTS.RE_SEARCH;
  if (/\b(rewrite|rephrase|simplify|make it shorter|for cfo|for ceo|non-technical|plain language)\b/.test(lower)) return FOLLOW_UP_INTENTS.REFRAME;
  if (/\?$/.test(text) || /^(why|how|what|when|where|can you explain|explain)/.test(lower)) return FOLLOW_UP_INTENTS.QUESTION;
  return FOLLOW_UP_INTENTS.CHALLENGE;
}

