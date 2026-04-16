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

const MATRIX_RED_TEAM_PROMPT = `You are an adversarial Red Team for a completed comparison matrix.

Rules:
- Stress-test conclusions by constructing strongest credible counter-cases.
- Prioritize structural threats, hidden downside, and disconfirming evidence.
- Flag where confidence appears higher than evidence quality.
- Do not rewrite scores; add risk context only.
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

const DEFAULT_DEEP_ASSIST_PROVIDERS = ["chatgpt", "claude", "gemini"];

function normalizeEvidenceMode(value) {
  return cleanText(value).toLowerCase() === "deep-assist" ? "deep-assist" : "native";
}

function normalizeResearchSetupContext(raw = {}) {
  const setup = raw && typeof raw === "object" ? raw : {};
  return {
    decisionContext: cleanText(setup.decisionContext),
    userRoleContext: cleanText(setup.userRoleContext),
  };
}

function buildResearchSetupContextBlock(setup = {}) {
  const context = normalizeResearchSetupContext(setup);
  return [
    context.decisionContext ? `Decision context: ${context.decisionContext}` : "Decision context: not provided.",
    context.userRoleContext ? `User role/context: ${context.userRoleContext}` : "User role/context: not provided.",
  ].join("\n");
}

function normalizeDeepAssistOptions(raw = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const providers = Array.isArray(input.providers)
    ? input.providers.map((value) => cleanText(value).toLowerCase()).filter(Boolean)
    : [];
  const selected = providers.length ? [...new Set(providers)] : DEFAULT_DEEP_ASSIST_PROVIDERS;
  return {
    providers: selected,
    minProviders: Math.max(1, Math.min(selected.length, Number(input.minProviders) || 2)),
    maxWaitMs: Math.max(20000, Number(input.maxWaitMs) || 300000),
    maxRetries: Math.max(0, Math.min(3, Number(input.maxRetries) || 1)),
  };
}

function normalizeStrictQuality(value) {
  const raw = cleanText(value).toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function failIfStrictQuality(strictQuality, message, code = "STRICT_QUALITY_ABORT") {
  if (!strictQuality) return;
  const err = new Error(cleanText(message) || "Strict quality mode aborted the run.");
  err.code = code;
  err.retryable = false;
  throw err;
}

function deepAssistProviderLabel(providerId) {
  const key = cleanText(providerId).toLowerCase();
  if (key === "chatgpt") return "ChatGPT";
  if (key === "claude") return "Claude";
  if (key === "gemini") return "Gemini";
  return key || "Provider";
}

function ensureDegradedMeta(analysisMeta = {}) {
  if (!analysisMeta || typeof analysisMeta !== "object") return;
  if (!analysisMeta.qualityGrade) analysisMeta.qualityGrade = "standard";
  if (!Array.isArray(analysisMeta.degradedReasons)) analysisMeta.degradedReasons = [];
}

function markDegraded(analysisMeta = {}, reasonCode = "quality_guard", detail = "") {
  ensureDegradedMeta(analysisMeta);
  analysisMeta.qualityGrade = "degraded";
  const entry = { code: cleanText(reasonCode) || "quality_guard", detail: cleanText(detail) };
  const exists = analysisMeta.degradedReasons.some((item) => item?.code === entry.code && item?.detail === entry.detail);
  if (!exists) analysisMeta.degradedReasons.push(entry);
}

function withStepTimeout(stepLabel, timeoutMs, work) {
  const limit = Number(timeoutMs);
  if (!Number.isFinite(limit) || limit <= 0) {
    return Promise.resolve().then(work);
  }
  let timer = null;
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${stepLabel} timed out after ${Math.round(limit)}ms`);
        err.code = "STEP_TIMEOUT";
        err.retryable = false;
        reject(err);
      }, limit);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function classifyDeepAssistGuardrailFailure(err) {
  const message = cleanText(err?.message || err);
  const lower = message.toLowerCase();
  if (
    err?.code === "TIMEOUT"
    || err?.code === "STEP_TIMEOUT"
    || lower.includes("timed out")
    || lower.includes("timeout")
  ) {
    return {
      code: "deep_assist_step_timeout",
      detail: message || "Deep Assist provider step timed out.",
    };
  }
  if (
    Number(err?.attempts || 0) > 1
    || /\(attempt\s+\d+\/\d+\)/i.test(message)
    || lower.includes("rate limit")
    || lower.includes("retry")
  ) {
    return {
      code: "deep_assist_retry_exhausted",
      detail: message || "Deep Assist provider retries were exhausted.",
    };
  }
  if (
    lower.includes("json parse")
    || lower.includes("valid json")
    || lower.includes("unexpected token")
    || lower.includes("unexpected non-whitespace")
  ) {
    return {
      code: "deep_assist_parse_failed",
      detail: message || "Deep Assist provider response parse failed.",
    };
  }
  return {
    code: "deep_assist_provider_failed",
    detail: message || "Deep Assist provider step failed.",
  };
}

function trackSafetyGuardrail(analysisMeta, failure, providerId = "") {
  if (!analysisMeta || typeof analysisMeta !== "object") return;
  const normalizedFailure = failure && typeof failure === "object" ? failure : {};
  const code = cleanText(normalizedFailure.code) || "deep_assist_provider_failed";
  const detail = cleanText(normalizedFailure.detail);
  const provider = cleanText(providerId);
  const guardrails = analysisMeta.safetyGuardrails && typeof analysisMeta.safetyGuardrails === "object"
    ? analysisMeta.safetyGuardrails
    : {
      triggered: false,
      totalEvents: 0,
      timeoutEvents: 0,
      retryExhaustedEvents: 0,
      parseFailureEvents: 0,
      providerFailureEvents: 0,
      events: [],
    };
  guardrails.triggered = true;
  guardrails.totalEvents += 1;
  if (code === "deep_assist_step_timeout") guardrails.timeoutEvents += 1;
  else if (code === "deep_assist_retry_exhausted") guardrails.retryExhaustedEvents += 1;
  else if (code === "deep_assist_parse_failed") guardrails.parseFailureEvents += 1;
  else guardrails.providerFailureEvents += 1;
  guardrails.events = Array.isArray(guardrails.events) ? guardrails.events : [];
  const nextEvent = { code, providerId: provider, detail };
  const duplicate = guardrails.events.some((event) => (
    event?.code === nextEvent.code
    && event?.providerId === nextEvent.providerId
    && event?.detail === nextEvent.detail
  ));
  if (!duplicate) {
    guardrails.events.push(nextEvent);
    if (guardrails.events.length > 30) guardrails.events = guardrails.events.slice(-30);
  }
  analysisMeta.safetyGuardrails = guardrails;
}

function setCompletionState(analysisMeta = {}, runStatus = "failed", failureCode = "analysis_failed", failureDetail = "") {
  ensureDegradedMeta(analysisMeta);
  if (runStatus !== "complete") {
    if (failureCode) {
      markDegraded(
        analysisMeta,
        failureCode,
        cleanText(failureDetail) || "Analysis did not reach a completed terminal state."
      );
    }
    analysisMeta.completionState = "failed";
  } else if (analysisMeta.qualityGrade === "degraded" || (analysisMeta.degradedReasons || []).length) {
    analysisMeta.completionState = "complete_with_gaps";
  } else {
    analysisMeta.completionState = "complete";
  }
  analysisMeta.terminalReasonCodes = [...new Set(
    (Array.isArray(analysisMeta.degradedReasons) ? analysisMeta.degradedReasons : [])
      .map((item) => cleanText(item?.code))
      .filter(Boolean)
  )];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeStringList(values, maxItems = 6, maxLen = 180) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => cleanText(item))
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLen));
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
      displayStatus: cleanText(src?.displayStatus || "").toLowerCase(),
    }))
    .filter((src) => src.name || src.quote || src.url)
    .slice(0, 10)
    .map((src) => ({ ...src }));
}

function extractEvidenceYearsFromSource(source = {}) {
  const text = `${source?.quote || ""} ${source?.name || ""} ${source?.url || ""}`;
  const matches = String(text).match(/\b(20\d{2})\b/g);
  if (!matches || !matches.length) return [];
  return matches
    .map((value) => Number(value))
    .filter((year) => Number.isFinite(year) && year >= 2000 && year <= 2099);
}

function sourceHasOnlyStaleYears(source = {}, staleCutoff = (new Date().getFullYear() - 2)) {
  const years = extractEvidenceYearsFromSource(source);
  if (!years.length) return false;
  return years.every((year) => year < staleCutoff);
}

function isVendorPrimaryAttribute(attributeId = "", attributeLabel = "") {
  const text = `${cleanText(attributeId)} ${cleanText(attributeLabel)}`.toLowerCase();
  if (!text) return false;
  return (
    /\b(icp|persona|buyer|segment|positioning|pricing|price|tier|package|company|channel|acquisition|gtm|decision[-\s]?trigger|workflow)\b/.test(text)
    || text.includes("core-position")
    || text.includes("target-icp")
  );
}

function deriveSourceDisplayStatus(source = {}, options = {}) {
  const verificationStatus = cleanText(source?.verificationStatus);
  const sourceType = cleanText(source?.sourceType).toLowerCase();
  const staleEvidenceRatio = Number(options?.staleEvidenceRatio);
  const attributeId = cleanText(options?.attributeId);
  const attributeLabel = cleanText(options?.attributeLabel);
  const allowVendorAsPrimary = !!options?.allowVendorAsPrimary || isVendorPrimaryAttribute(attributeId, attributeLabel);
  const staleCutoff = Number.isFinite(Number(options?.staleCutoff))
    ? Number(options.staleCutoff)
    : (new Date().getFullYear() - 2);

  if (verificationStatus === "verified_in_page") return "cited";
  if (
    Number.isFinite(staleEvidenceRatio)
    && staleEvidenceRatio >= 0.6
    && sourceHasOnlyStaleYears(source, staleCutoff)
  ) {
    return "excluded_stale";
  }
  if (sourceType === "vendor" && verificationStatus !== "verified_in_page") {
    if (allowVendorAsPrimary) {
      if (verificationStatus === "name_only_in_page") return "corroborating";
      return "unverified";
    }
    return "excluded_marketing";
  }
  if (verificationStatus === "name_only_in_page" && sourceType !== "vendor") {
    return "corroborating";
  }
  if (
    verificationStatus === "not_found_in_page"
    || verificationStatus === "fetch_failed"
    || verificationStatus === "invalid_url"
  ) {
    return "unverified";
  }
  if (sourceType === "independent" || sourceType === "press") return "corroborating";
  return "unverified";
}

function annotateSourceListDisplayStatus(sources = [], options = {}) {
  return normalizeSourceList(sources).map((source) => ({
    ...source,
    displayStatus: deriveSourceDisplayStatus(source, options),
  }));
}

function emptySourceUniverseSummary() {
  return {
    cited: 0,
    corroborating: 0,
    unverified: 0,
    excludedMarketing: 0,
    excludedStale: 0,
    total: 0,
  };
}

function buildMatrixSourceUniverse(matrix = {}) {
  const totals = emptySourceUniverseSummary();
  const seen = new Set();
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const attributeLabelById = new Map(
    (Array.isArray(matrix?.attributes) ? matrix.attributes : [])
      .map((attr) => [cleanText(attr?.id), cleanText(attr?.label)])
      .filter((entry) => entry[0])
  );
  cells.forEach((cell) => {
    const staleEvidenceRatio = Number(cell?.staleEvidenceRatio);
    const sources = annotateSourceListDisplayStatus(cell?.sources, {
      staleEvidenceRatio: Number.isFinite(staleEvidenceRatio) ? staleEvidenceRatio : null,
      attributeId: cleanText(cell?.attributeId),
      attributeLabel: attributeLabelById.get(cleanText(cell?.attributeId)) || "",
    });
    sources.forEach((source) => {
      const key = `${cleanText(source?.name)}|${cleanText(source?.quote)}|${cleanText(source?.url)}`;
      if (!key || seen.has(key)) return;
      seen.add(key);
      const status = cleanText(source?.displayStatus).toLowerCase() || "unverified";
      if (status === "cited") totals.cited += 1;
      else if (status === "corroborating") totals.corroborating += 1;
      else if (status === "excluded_marketing") totals.excludedMarketing += 1;
      else if (status === "excluded_stale") totals.excludedStale += 1;
      else totals.unverified += 1;
      totals.total += 1;
    });
  });
  return totals;
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

function tokenizeMatchText(value = "") {
  return normalizeMatchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function fuzzyQuoteCoverage(quote = "", pageText = "") {
  const quoteTokens = tokenizeMatchText(quote);
  if (quoteTokens.length < 5) return 0;
  const pageTokenSet = new Set(tokenizeMatchText(pageText));
  if (!pageTokenSet.size) return 0;
  let hits = 0;
  quoteTokens.forEach((token) => {
    if (pageTokenSet.has(token)) hits += 1;
  });
  return hits / quoteTokens.length;
}

function quotedClaimFoundInPage(source = {}, snapshot = null) {
  const pageText = normalizeMatchText(`${snapshot?.title || ""} ${snapshot?.text || ""}`);
  if (!pageText) return { verified: false, matchType: "none", quoteCoverage: 0 };

  const quote = normalizeMatchText(source.quote);
  const name = normalizeMatchText(source.name);
  let matchType = "none";
  let quoteCoverage = 0;
  if (quote.length >= 12) {
    if (pageText.includes(quote)) return { verified: true, matchType: "exact_quote", quoteCoverage: 1 };
    const parts = quote.split(" ").filter(Boolean);
    if (parts.length >= 6) {
      const head = parts.slice(0, 6).join(" ");
      const tail = parts.slice(-6).join(" ");
      if (pageText.includes(head) && pageText.includes(tail)) return { verified: true, matchType: "span_quote", quoteCoverage: 0.8 };
    }
    quoteCoverage = fuzzyQuoteCoverage(quote, pageText);
    if (quoteCoverage >= 0.72) return { verified: true, matchType: "fuzzy_quote", quoteCoverage };
    if (quoteCoverage > 0) matchType = "partial_quote";
  }

  if (name.length >= 4 && pageText.includes(name)) {
    return { verified: false, matchType: matchType === "partial_quote" ? "partial_quote_name" : "name_only", quoteCoverage };
  }
  return { verified: false, matchType, quoteCoverage };
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

function normalizeSubjectMatchKey(value = "") {
  return cleanText(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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

function extractRequiredSubjectsFromUnifiedPrompt(text = "") {
  const raw = cleanText(text);
  if (!raw) return [];

  const candidates = [];
  const addMany = (items = []) => {
    items.forEach((item) => {
      const value = cleanText(item)
        .replace(/^['"“”‘’]+|['"“”‘’]+$/g, "")
        .replace(/\s{2,}/g, " ");
      if (!value || value.length > 90) return;
      candidates.push(value);
    });
  };

  const directLabelPatterns = [
    /especially\s*:\s*([^.!\n]+)/gi,
    /(?:vendors?|competitors?|subjects?)\s+to\s+cover\s*:?\s*([^.!\n]+)/gi,
    /focus\s+on\s+(?:vendors?|competitors?|subjects?)\s*:\s*([^.!\n]+)/gi,
    /include\s+(?:at\s+least\s+)?(?:vendors?|competitors?|subjects?)\s*:?\s*([^.!\n]+)/gi,
  ];

  for (const pattern of directLabelPatterns) {
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      addMany(splitSubjectTokens(match[1]));
    }
  }

  const sectionMatch = raw.match(/(?:vendors?|competitors?|subjects?)\s+to\s+cover\s*\n([\s\S]{0,600})/i);
  if (sectionMatch?.[1]) {
    const sectionLines = sectionMatch[1]
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line && /^[-*]|^\d+[.)]/.test(line))
      .map((line) => line.replace(/^[-*\d.)\s]+/, ""));
    addMany(sectionLines);
  }

  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = normalizeSubjectMatchKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
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

function deriveMatrixTitleFromInput(rawInput = "", subjects = []) {
  const normalizedInput = cleanText(rawInput)
    .replace(/^(product concept|research brief|context)\s*:\s*/i, "")
    .trim();
  const decisionLike = extractDecisionQuestion(normalizedInput);
  const sourceText = cleanText(decisionLike || normalizedInput);
  const words = sourceText.split(/\s+/).filter(Boolean);
  let title = words.slice(0, 14).join(" ").replace(/[,:;.\-]+$/g, "");

  if (!title) {
    const labels = (Array.isArray(subjects) ? subjects : [])
      .map((subject) => cleanText(subject?.label || subject))
      .filter(Boolean)
      .slice(0, 2);
    if (labels.length >= 2) {
      title = `Matrix research: ${labels[0]} vs ${labels[1]}`;
    } else if (labels.length === 1) {
      title = `Matrix research: ${labels[0]}`;
    }
  }

  return clip(title || "Matrix research", 100);
}

function buildMatrixAttributes({
  rawInput = "",
  decisionQuestion = "",
  researchSetup = {},
  subjects = [],
} = {}) {
  const normalizedInput = cleanText(rawInput);
  const resolvedDecision = cleanText(researchSetup?.decisionContext) || cleanText(decisionQuestion) || extractDecisionQuestion(normalizedInput);
  const derivedTitle = deriveMatrixTitleFromInput(normalizedInput, subjects);
  const subjectLabels = (Array.isArray(subjects) ? subjects : [])
    .map((subject) => cleanText(subject?.label || subject))
    .filter(Boolean)
    .slice(0, 12);
  const scopeParts = [];
  const roleContext = cleanText(researchSetup?.userRoleContext);
  if (subjectLabels.length) scopeParts.push(`Subjects: ${subjectLabels.join(", ")}`);
  if (roleContext) scopeParts.push(`Role/context: ${roleContext}`);
  return {
    title: derivedTitle,
    expandedDescription: resolvedDecision
      ? `Decision focus: ${resolvedDecision}`
      : "",
    vertical: "",
    buyerPersona: roleContext,
    aiSolutionType: "",
    typicalTimeline: "",
    deliveryModel: "",
    inputFrame: {
      providedInput: normalizedInput,
      framingFields: {
        researchObject: normalizedInput || "unspecified",
        decisionQuestion: resolvedDecision || "unspecified",
        scopeContext: scopeParts.join(" | ") || "unspecified",
      },
      assumptionsUsed: [],
      confidenceLimits: "",
    },
  };
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
  const maxOverrideRaw = Number(options?.maxCountOverride);
  const maxCount = options?.preserveAll
    ? Math.max(minCount, unique.length)
    : Math.max(
      minCount,
      Number.isFinite(maxOverrideRaw) && maxOverrideRaw >= minCount
        ? Math.round(maxOverrideRaw)
        : (Number(subjectsSpec?.maxCount) || 8)
    );
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

function tokenSet(text = "") {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  );
}

function tokenOverlapScore(a = "", b = "") {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  setA.forEach((token) => {
    if (setB.has(token)) intersection += 1;
  });
  const union = new Set([...setA, ...setB]).size || 1;
  return intersection / union;
}

function fuzzyLookupId(raw, labelMap = new Map()) {
  const source = cleanText(raw).toLowerCase();
  if (!source || !labelMap?.size) return "";
  let best = { id: "", score: 0 };
  for (const [label, id] of labelMap.entries()) {
    const score = tokenOverlapScore(source, label);
    if (score > best.score) {
      best = { id, score };
    }
  }
  return best.score >= 0.45 ? best.id : "";
}

function parsePositiveIndex(raw) {
  const text = cleanText(raw).toLowerCase();
  if (!text) return null;
  const match = text.match(/^#?\s*(\d{1,4})$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function matchSubjectId(raw, subjectsByLabel, subjectsByIndex = new Map(), diagnostics = null) {
  const key = cleanText(raw).toLowerCase();
  if (!key) return "";
  const direct = subjectsByLabel.get(key);
  if (direct) return direct;
  const index = parsePositiveIndex(raw);
  if (Number.isFinite(index) && subjectsByIndex?.has?.(index)) {
    if (diagnostics && typeof diagnostics === "object") diagnostics.numericSubjectIdCoercions += 1;
    return subjectsByIndex.get(index);
  }
  return fuzzyLookupId(key, subjectsByLabel) || "";
}

function matchAttributeId(raw, attributesByLabel, attributesByIndex = new Map(), diagnostics = null) {
  const key = cleanText(raw).toLowerCase();
  if (!key) return "";
  const direct = attributesByLabel.get(key);
  if (direct) return direct;
  const index = parsePositiveIndex(raw);
  if (Number.isFinite(index) && attributesByIndex?.has?.(index)) {
    if (diagnostics && typeof diagnostics === "object") diagnostics.numericAttributeIdCoercions += 1;
    return attributesByIndex.get(index);
  }
  return fuzzyLookupId(key, attributesByLabel) || "";
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

function roleOptionsWithFallback(config, primaryRole, fallbackRole) {
  const primary = roleOptions(config, primaryRole);
  const fallback = roleOptions(config, fallbackRole);
  return {
    provider: primary.provider || fallback.provider,
    model: primary.model || fallback.model,
    webSearchModel: primary.webSearchModel || fallback.webSearchModel,
    baseUrl: primary.baseUrl || fallback.baseUrl,
  };
}

function modelSignatureFromOptions(options = {}) {
  const provider = cleanText(options?.provider) || "default";
  const model = cleanText(options?.model) || "default";
  return `${provider}:${model}`;
}

function capabilityOptions(config, capability, fallbackRole = "analyst") {
  const capCfg = config?.models?.[capability] || {};
  const hasCapabilityConfig = !!(
    cleanText(capCfg.provider)
    || cleanText(capCfg.model)
    || cleanText(capCfg.webSearchModel)
    || cleanText(capCfg.baseUrl)
  );
  if (!hasCapabilityConfig && cleanText(capability).toLowerCase() === "retrieval") {
    return {};
  }
  const base = roleOptions(config, fallbackRole);
  if (!base.provider && cleanText(capCfg.provider)) base.provider = cleanText(capCfg.provider);
  if (!base.model && cleanText(capCfg.model)) base.model = cleanText(capCfg.model);
  if (!base.webSearchModel && cleanText(capCfg.webSearchModel)) base.webSearchModel = cleanText(capCfg.webSearchModel);
  if (!base.baseUrl && cleanText(capCfg.baseUrl)) base.baseUrl = cleanText(capCfg.baseUrl);
  return base;
}

function extractJson(text, fallback = {}, context = {}) {
  try {
    return safeParseJSON(text);
  } catch (err) {
    const rawText = typeof text === "string" ? text : String(text || "");
    const debugSession = context?.debugSession || null;
    if (debugSession) {
      appendAnalysisDebugEvent(debugSession, {
        type: "json_parse_failure",
        phase: cleanText(context?.phase) || "matrix_unknown",
        attempt: cleanText(context?.attempt),
        error: err?.message || "Failed to parse JSON response.",
        responseLength: rawText.length,
        responseExcerpt: rawText.slice(0, 12000),
        response: rawText,
        prompt: cleanText(context?.prompt),
        extra: context?.extra || null,
      });
    }
    if (context?.allowFallback) return fallback;
    const parseErr = new Error(`JSON parse failed (${cleanText(context?.phase) || "matrix"}): ${err?.message || "Invalid JSON response."}`);
    parseErr.code = "JSON_PARSE_FAILED";
    parseErr.retryable = false;
    throw parseErr;
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
  const evidenceMode = normalizeEvidenceMode(input?.options?.evidenceMode);
  const deepAssist = normalizeDeepAssistOptions(input?.options?.deepAssist || {});
  const researchSetup = normalizeResearchSetupContext(input?.options?.researchSetup || {});
  const initialDecisionQuestion = cleanText(researchSetup.decisionContext) || extractDecisionQuestion(desc) || desc;
  return {
    id,
    rawInput: desc,
    status: "analyzing",
    phase: "matrix_plan",
    attributes: buildMatrixAttributes({
      rawInput: desc,
      decisionQuestion: initialDecisionQuestion,
      researchSetup,
      subjects: normalizeSubjectCandidates(input?.options?.matrixSubjects || []),
    }),
    dimScores: null,
    critique: null,
    finalScores: null,
    debate: [],
    followUps: {},
    errorMsg: null,
    discover: null,
    origin: input?.origin || null,
    researchSetup,
    outputMode: "matrix",
    matrix: null,
    analysisMeta: {
      analysisMode: evidenceMode === "deep-assist" ? "matrix-deep-assist" : "matrix",
      evidenceMode,
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
      discoveryFailureReason: null,
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
      lowConfidenceRoundRobinApplied: false,
      lowConfidenceBudgetCells: 0,
      lowConfidenceBudgetUsed: 0,
      lowConfidenceDroppedByBudget: 0,
      lowConfidenceBudgetStrategy: "adaptive",
      targetedRetrievalNiche: "",
      targetedRetrievalAliases: [],
      targetedCellDiagnostics: [],
      counterfactualQueriesGenerated: 0,
      counterfactualFindingsUsed: 0,
      deepAssistRecoveryTriggered: false,
      deepAssistRecoveryCandidates: 0,
      deepAssistRecoveryBudgetCells: 0,
      deepAssistRecoveryDroppedByBudget: 0,
      deepAssistRecoveryUpgraded: 0,
      deepAssistRecoveryValidatedLow: 0,
      deepAssistRecoveryFailed: false,
      deepAssistRecoveryDiagnostics: [],
      subjectDiscoveryRequested: false,
      subjectDiscoveryUsed: false,
      subjectDiscoveryWebSearchCalls: 0,
      subjectDiscoveryFallbackReason: null,
      subjectDiscoverySuggestedCount: 0,
      requiredSubjectsRequested: 0,
      requiredSubjectsMissing: 0,
      sourceVerificationChecked: 0,
      sourceVerificationVerified: 0,
      sourceVerificationNotFound: 0,
      sourceVerificationFetchFailed: 0,
      sourceVerificationInvalidUrl: 0,
      sourceVerificationPartialMatch: 0,
      sourceVerificationNameOnly: 0,
      sourceVerificationPenalizedCells: 0,
      sourceVerificationSkippedReason: null,
      matrixHybridStats: null,
      matrixReconcileHealth: null,
      matrixReconcileRetryTriggered: false,
      matrixReconcileRetryAttempts: 0,
      matrixReconcileRetryUsed: false,
      matrixReconcileRetryReason: "",
      matrixReconcileRetryDiagnostics: null,
      contestedCellsResolved: 0,
      contestedCellsConceded: 0,
      contestedCellsDefended: 0,
      criticCellsAudited: 0,
      criticFlagsRaised: 0,
      criticFlagRate: 0,
      criticFlagRateLowConfidenceRate: 0,
      criticFlagRateAlert: "",
      matrixCoverageSLAPassed: false,
      matrixCoverageSLAFailureReason: "",
      matrixCoverageSLA: null,
      decisionGradePassed: false,
      decisionGradeFailureReason: "",
      decisionGradeGate: null,
      qualityGrade: "standard",
      degradedReasons: [],
      safetyGuardrails: {
        triggered: false,
        totalEvents: 0,
        timeoutEvents: 0,
        retryExhaustedEvents: 0,
        parseFailureEvents: 0,
        providerFailureEvents: 0,
        events: [],
      },
      completionState: "running",
      terminalReasonCodes: [],
      deepAssistProvidersRequested: evidenceMode === "deep-assist" ? deepAssist.providers.length : 0,
      deepAssistProvidersSucceeded: 0,
      deepAssistProvidersFailed: 0,
      deepAssistProviderRuns: [],
      sourceDiversityConfidenceCaps: 0,
      staleEvidenceObservedCells: 0,
      staleEvidenceRatioSum: 0,
      staleEvidenceConfidenceCaps: 0,
      verificationConfidenceCaps: 0,
      urlCoverageConfidenceCaps: 0,
      zeroSourceConfidenceCaps: 0,
      highConfidenceCorroborationCaps: 0,
      sourceUniverse: emptySourceUniverseSummary(),
      matrixChunking: {},
      matrixNormalization: {},
      matrixEarlyCoverageGate: null,
      redTeamCallMade: false,
      redTeamHighSeverityCount: 0,
      synthesizerCallMade: false,
      synthesizerModel: "",
      providerContributions: {},
      decisionContext: researchSetup.decisionContext,
      userRoleContext: researchSetup.userRoleContext,
    },
  };
}

function normalizeMatrixCellArguments(raw = {}) {
  const normalizeGroup = (items = [], prefix = "arg") => {
    if (!Array.isArray(items)) return [];
    return items
      .map((entry, idx) => ({
        id: cleanText(entry?.id || `${prefix}-${idx + 1}`) || `${prefix}-${idx + 1}`,
        claim: cleanText(entry?.claim),
        detail: cleanText(entry?.detail),
        sources: normalizeSourceList(entry?.sources),
      }))
      .filter((entry) => entry.claim || entry.detail)
      .slice(0, 6);
  };
  return {
    supporting: normalizeGroup(raw?.supporting, "sup"),
    limiting: normalizeGroup(raw?.limiting, "lim"),
  };
}

function normalizeAnalystMatrix(raw = {}, subjects = [], attributes = []) {
  const cellsRaw = Array.isArray(raw?.cells) ? raw.cells : [];
  const subjectSummariesRaw = Array.isArray(raw?.subjectSummaries) ? raw.subjectSummaries : [];

  const subjectsByLabel = new Map(subjects.map((s) => [s.label.toLowerCase(), s.id]));
  const subjectsByIndex = new Map(subjects.map((s, idx) => [idx + 1, s.id]));
  const attributesByLabel = new Map();
  const attributesByIndex = new Map(attributes.map((attr, idx) => [idx + 1, attr.id]));
  attributes.forEach((attr) => {
    attributesByLabel.set(attr.id.toLowerCase(), attr.id);
    attributesByLabel.set(attr.label.toLowerCase(), attr.id);
  });
  const diagnostics = {
    expectedCells: subjects.length * attributes.length,
    rawCells: cellsRaw.length,
    mappedCells: 0,
    placeholderCellsAdded: 0,
    missingCellKeys: [],
    droppedUnknownSubject: 0,
    droppedUnknownAttribute: 0,
    duplicateCellOverwrites: 0,
    numericSubjectIdCoercions: 0,
    numericAttributeIdCoercions: 0,
  };

  const cellMap = new Map();
  for (const cell of cellsRaw) {
    const subjectId = matchSubjectId(
      cell?.subjectId || cell?.subject || cell?.row,
      subjectsByLabel,
      subjectsByIndex,
      diagnostics
    );
    const attributeId = matchAttributeId(
      cell?.attributeId || cell?.attribute || cell?.column,
      attributesByLabel,
      attributesByIndex,
      diagnostics
    );
    if (!subjectId) diagnostics.droppedUnknownSubject += 1;
    if (!attributeId) diagnostics.droppedUnknownAttribute += 1;
    if (!subjectId || !attributeId) continue;
    const key = buildCellKey(subjectId, attributeId);
    if (cellMap.has(key)) diagnostics.duplicateCellOverwrites += 1;
    cellMap.set(key, {
      subjectId,
      attributeId,
      value: cleanText(cell?.value || cell?.summary || "No reliable evidence found."),
      full: cleanText(cell?.full || cell?.detail || cell?.value || cell?.summary || ""),
      risks: cleanText(cell?.risks || ""),
      arguments: normalizeMatrixCellArguments(cell?.arguments || {}),
      confidence: normalizeConfidence(cell?.confidence),
      confidenceReason: cleanText(cell?.confidenceReason || ""),
      sources: normalizeSourceList(cell?.sources),
      contested: false,
      criticNote: "",
      analystDecision: "",
      analystNote: "",
      providerAgreement: cleanText(cell?.providerAgreement).toLowerCase(),
      providerSignals: Array.isArray(cell?.providerSignals)
        ? cell.providerSignals
          .map((entry) => ({
            provider: cleanText(entry?.provider || entry?.providerId),
            providerLabel: cleanText(entry?.providerLabel || entry?.provider),
            confidence: normalizeConfidence(entry?.confidence),
            confidenceReason: cleanText(entry?.confidenceReason),
            sourceCount: Number(entry?.sourceCount) || 0,
            brief: cleanText(entry?.brief),
          }))
          .filter((entry) => entry.provider || entry.providerLabel)
        : [],
    });
  }
  diagnostics.mappedCells = cellMap.size;

  const cells = [];
  for (const subject of subjects) {
    for (const attribute of attributes) {
      const key = buildCellKey(subject.id, attribute.id);
      const existing = cellMap.get(key);
      if (existing) {
        cells.push(existing);
      } else {
        diagnostics.missingCellKeys.push(key);
        cells.push({
          subjectId: subject.id,
          attributeId: attribute.id,
          value: "No reliable evidence found for this cell.",
          full: "",
          risks: "",
          arguments: { supporting: [], limiting: [] },
          confidence: "low",
          confidenceReason: "Insufficient evidence returned.",
          sources: [],
          contested: false,
          criticNote: "",
          analystDecision: "",
          analystNote: "",
          providerAgreement: "none",
          providerSignals: [],
        });
        diagnostics.placeholderCellsAdded += 1;
      }
    }
  }

  const summaryMap = new Map();
  subjectSummariesRaw.forEach((entry) => {
    const subjectId = matchSubjectId(
      entry?.subjectId || entry?.subject || entry?.label,
      subjectsByLabel,
      subjectsByIndex,
      diagnostics
    );
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
    executiveSummary: raw?.executiveSummary && typeof raw.executiveSummary === "object"
      ? {
          decisionAnswer: cleanText(raw.executiveSummary.decisionAnswer),
          closestThreats: cleanText(raw.executiveSummary.closestThreats),
          whitespace: cleanText(raw.executiveSummary.whitespace),
          strategicClassification: cleanText(raw.executiveSummary.strategicClassification),
          keyRisks: cleanText(raw.executiveSummary.keyRisks),
          decisionImplications: cleanText(raw.executiveSummary.decisionImplications),
          uncertaintyNotes: cleanText(raw.executiveSummary.uncertaintyNotes),
          providerAgreementHighlights: cleanText(raw.executiveSummary.providerAgreementHighlights),
        }
      : null,
    normalization: diagnostics,
  };
}

function normalizeAnalystResponses(raw = {}, subjects = [], attributes = []) {
  const responsesRaw = Array.isArray(raw?.responses) ? raw.responses : [];
  const subjectsByLabel = new Map(subjects.map((s) => [s.label.toLowerCase(), s.id]));
  const subjectsByIndex = new Map(subjects.map((s, idx) => [idx + 1, s.id]));
  const attributesByLabel = new Map();
  const attributesByIndex = new Map(attributes.map((attr, idx) => [idx + 1, attr.id]));
  attributes.forEach((attr) => {
    attributesByLabel.set(attr.id.toLowerCase(), attr.id);
    attributesByLabel.set(attr.label.toLowerCase(), attr.id);
  });

  const out = [];
  for (const entry of responsesRaw) {
    const subjectId = matchSubjectId(entry?.subjectId || entry?.subject || entry?.row, subjectsByLabel, subjectsByIndex);
    const attributeId = matchAttributeId(entry?.attributeId || entry?.attribute || entry?.column, attributesByLabel, attributesByIndex);
    if (!subjectId || !attributeId) continue;

    const rawDecision = cleanText(entry?.decision || "").toLowerCase();
    const decision = rawDecision === "concede" ? "concede" : "defend";
    out.push({
      subjectId,
      attributeId,
      decision,
      value: cleanText(entry?.value || entry?.updatedValue || ""),
      full: cleanText(entry?.full || entry?.detail || ""),
      risks: cleanText(entry?.risks || ""),
      arguments: normalizeMatrixCellArguments(entry?.arguments || {}),
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
  const subjectsByIndex = new Map(subjects.map((s, idx) => [idx + 1, s.id]));
  const attributesByLabel = new Map();
  const attributesByIndex = new Map(attributes.map((attr, idx) => [idx + 1, attr.id]));
  attributes.forEach((attr) => {
    attributesByLabel.set(attr.id.toLowerCase(), attr.id);
    attributesByLabel.set(attr.label.toLowerCase(), attr.id);
  });

  const out = [];
  for (const flag of flagsRaw) {
    const subjectId = matchSubjectId(flag?.subjectId || flag?.subject || flag?.row, subjectsByLabel, subjectsByIndex);
    const attributeId = matchAttributeId(flag?.attributeId || flag?.attribute || flag?.column, attributesByLabel, attributesByIndex);
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

function resolveMatrixCoverageSla(config = {}) {
  const raw = config?.limits?.matrixCoverageSLA || {};
  const minSourcesPerCell = Math.max(1, Number(raw?.minSourcesPerCell) || 2);
  const minSubjectEvidenceCoverage = Math.min(1, Math.max(0, Number(raw?.minSubjectEvidenceCoverage) || 0.5));
  const maxUnresolvedCellsRatio = Math.min(1, Math.max(0, Number(raw?.maxUnresolvedCellsRatio) || 0.35));
  const maxUnresolvedCellsRaw = Number(raw?.maxUnresolvedCells);
  const maxUnresolvedCells = Number.isFinite(maxUnresolvedCellsRaw) && maxUnresolvedCellsRaw >= 0
    ? Math.floor(maxUnresolvedCellsRaw)
    : null;
  return {
    minSourcesPerCell,
    minSubjectEvidenceCoverage,
    maxUnresolvedCellsRatio,
    maxUnresolvedCells,
  };
}

function resolveCriticFlagMonitoring(config = {}) {
  const raw = config?.limits?.criticFlagMonitoring || {};
  return {
    minAuditedCells: Math.max(1, Number(raw?.minAuditedCells) || 8),
    minFlagRate: Math.min(1, Math.max(0, Number(raw?.minFlagRate) || 0.1)),
    highLowConfidenceRate: Math.min(1, Math.max(0, Number(raw?.highLowConfidenceRate) || 0.3)),
  };
}

function hasExplicitFailureReason(cell = {}) {
  const text = `${cleanText(cell?.value)} ${cleanText(cell?.confidenceReason)}`.toLowerCase();
  if (!text) return false;
  return /no reliable evidence|no evidence|insufficient evidence|insufficient public evidence|could not find|unable to find|not found|retrieval failed|data unavailable|public data unavailable/.test(text);
}

function evaluateMatrixCoverageSla(matrix = {}, subjects = [], attributes = [], config = {}) {
  const sla = resolveMatrixCoverageSla(config);
  const subjectList = Array.isArray(subjects) ? subjects : [];
  const attributeList = Array.isArray(attributes) ? attributes : [];
  const cellMap = new Map();
  (Array.isArray(matrix?.cells) ? matrix.cells : []).forEach((cell) => {
    cellMap.set(buildCellKey(cell.subjectId, cell.attributeId), cell);
  });

  const totalCells = subjectList.length * attributeList.length;
  const subjectDiagnostics = [];
  const failingSubjects = [];
  let unresolvedCells = 0;
  let explicitFailureCells = 0;
  let evidenceSatisfiedCells = 0;

  for (const subject of subjectList) {
    let subjectEvidenceCells = 0;
    let subjectUnresolvedCells = 0;
    for (const attribute of attributeList) {
      const key = buildCellKey(subject.id, attribute.id);
      const cell = cellMap.get(key);
      if (!cell) {
        unresolvedCells += 1;
        subjectUnresolvedCells += 1;
        continue;
      }
      const sourceCount = normalizeSourceList(cell.sources).length;
      if (sourceCount >= sla.minSourcesPerCell) {
        subjectEvidenceCells += 1;
        evidenceSatisfiedCells += 1;
        continue;
      }
      if (hasExplicitFailureReason(cell)) {
        explicitFailureCells += 1;
        continue;
      }
      unresolvedCells += 1;
      subjectUnresolvedCells += 1;
    }

    const subjectTotal = attributeList.length || 1;
    const evidenceCoverage = subjectEvidenceCells / subjectTotal;
    const subjectDiag = {
      subjectId: subject.id,
      subjectLabel: subject.label,
      totalCells: attributeList.length,
      evidenceCells: subjectEvidenceCells,
      unresolvedCells: subjectUnresolvedCells,
      evidenceCoverage,
      pass: evidenceCoverage >= sla.minSubjectEvidenceCoverage,
    };
    subjectDiagnostics.push(subjectDiag);
    if (!subjectDiag.pass) failingSubjects.push(subjectDiag);
  }

  const unresolvedByRatio = Math.ceil(totalCells * sla.maxUnresolvedCellsRatio);
  const maxUnresolvedCellsAllowed = sla.maxUnresolvedCells == null
    ? unresolvedByRatio
    : Math.min(sla.maxUnresolvedCells, unresolvedByRatio);
  const unresolvedRatio = totalCells ? unresolvedCells / totalCells : 0;
  const globalPass = unresolvedCells <= maxUnresolvedCellsAllowed;
  const pass = globalPass && failingSubjects.length === 0;

  let failureReason = "";
  if (!pass) {
    const bits = [];
    if (!globalPass) {
      bits.push(`Unresolved cells ${unresolvedCells}/${totalCells} exceed max ${maxUnresolvedCellsAllowed}.`);
    }
    if (failingSubjects.length) {
      const subjectText = failingSubjects
        .map((item) => `${item.subjectLabel} ${Math.round(item.evidenceCoverage * 100)}%`)
        .join(", ");
      bits.push(`Subject evidence coverage below ${Math.round(sla.minSubjectEvidenceCoverage * 100)}%: ${subjectText}.`);
    }
    failureReason = bits.join(" ");
  }

  return {
    pass,
    failureReason,
    diagnostics: {
      enabled: true,
      config: { ...sla },
      totalCells,
      evidenceSatisfiedCells,
      explicitFailureCells,
      unresolvedCells,
      unresolvedRatio,
      maxUnresolvedCellsAllowed,
      failingSubjectsCount: failingSubjects.length,
      failingSubjects,
      subjects: subjectDiagnostics,
    },
  };
}

function evaluateMatrixEarlyCatastrophicCoverage(matrix = {}, subjects = [], attributes = [], config = {}) {
  const slaResult = evaluateMatrixCoverageSla(matrix, subjects, attributes, config);
  const diagnostics = slaResult?.diagnostics && typeof slaResult.diagnostics === "object"
    ? slaResult.diagnostics
    : {};
  const subjectDiagnostics = Array.isArray(diagnostics?.subjects) ? diagnostics.subjects : [];
  const thresholdRaw = Number(config?.limits?.matrixCatastrophicCoverageThreshold);
  const threshold = Number.isFinite(thresholdRaw)
    ? Math.min(0.9, Math.max(0.05, thresholdRaw))
    : 0.3;
  const unresolvedRatio = Number(diagnostics?.unresolvedRatio || 0);
  const evidenceSatisfiedCells = Number(diagnostics?.evidenceSatisfiedCells || 0);
  const allSubjectsBelowThreshold = subjectDiagnostics.length > 0
    && subjectDiagnostics.every((entry) => Number(entry?.evidenceCoverage || 0) < threshold);
  const shouldAbort = evidenceSatisfiedCells === 0
    || allSubjectsBelowThreshold
    || unresolvedRatio >= 0.85;

  let reason = "";
  if (shouldAbort) {
    if (evidenceSatisfiedCells === 0) {
      reason = "Coverage collapsed: no cells met minimum evidence requirements after targeted recovery.";
    } else if (allSubjectsBelowThreshold) {
      reason = `Coverage collapsed: every subject remained below ${(threshold * 100).toFixed(0)}% evidence coverage after targeted recovery.`;
    } else {
      reason = `Coverage collapsed: unresolved cell ratio ${(unresolvedRatio * 100).toFixed(0)}% is catastrophically high.`;
    }
  }

  return {
    shouldAbort,
    reason,
    diagnostics: {
      threshold,
      coverageSla: diagnostics,
    },
  };
}

function enforceMatrixChunkCompleteness(matrix = {}, phase = "", analysisMeta = {}, debugSession = null) {
  const normalization = matrix?.normalization && typeof matrix.normalization === "object"
    ? matrix.normalization
    : {};
  const placeholderCellsAdded = Number(normalization?.placeholderCellsAdded || 0);
  const expectedCells = Number(normalization?.expectedCells || 0);
  const mappedCells = Number(normalization?.mappedCells || 0);
  const droppedUnknownSubject = Number(normalization?.droppedUnknownSubject || 0);
  const droppedUnknownAttribute = Number(normalization?.droppedUnknownAttribute || 0);
  const hardFailure = placeholderCellsAdded > 0 || (expectedCells > 0 && mappedCells < expectedCells);
  if (!hardFailure) return;

  const reason = [
    `matrix completeness guard failed at ${cleanText(phase) || "unknown_phase"}.`,
    placeholderCellsAdded > 0 ? `missing cells synthesized: ${placeholderCellsAdded}` : "",
    expectedCells > 0 && mappedCells < expectedCells ? `mapped cells ${mappedCells}/${expectedCells}` : "",
    droppedUnknownSubject > 0 ? `dropped unknown subject mappings: ${droppedUnknownSubject}` : "",
    droppedUnknownAttribute > 0 ? `dropped unknown attribute mappings: ${droppedUnknownAttribute}` : "",
  ].filter(Boolean).join(" ");
  markDegraded(analysisMeta, "matrix_completeness_guard_failed", reason);
  if (analysisMeta && typeof analysisMeta === "object") {
    analysisMeta.matrixNormalization = {
      ...(analysisMeta.matrixNormalization || {}),
      [cleanText(phase) || "unknown_phase"]: normalization,
    };
  }
  appendAnalysisDebugEvent(debugSession, {
    type: "matrix_completeness_guard_failed",
    phase,
    note: reason,
    diagnostics: normalization,
  });
  const err = new Error(reason);
  err.code = "MATRIX_COMPLETENESS_GUARD_FAILED";
  err.retryable = false;
  throw err;
}

function resolveMatrixDecisionGradeGate(config = {}) {
  const raw = config?.limits?.matrixDecisionGradeGate || {};
  const criticalFromConfig = Array.isArray(raw?.criticalAttributeIds)
    ? raw.criticalAttributeIds.map((item) => cleanText(item)).filter(Boolean)
    : [];
  return {
    enabled: raw?.enabled !== false,
    minSourcesPerCoverageCell: Math.max(1, Number(raw?.minSourcesPerCoverageCell) || 2),
    minSubjectEvidenceCoverage: Math.min(1, Math.max(0, Number(raw?.minSubjectEvidenceCoverage) || 0.75)),
    maxLowConfidenceRatio: Math.min(1, Math.max(0, Number(raw?.maxLowConfidenceRatio) || 0.15)),
    minSourcesPerCriticalCell: Math.max(1, Number(raw?.minSourcesPerCriticalCell) || 2),
    minIndependentSourcesPerCriticalCell: Math.max(1, Number(raw?.minIndependentSourcesPerCriticalCell) || 1),
    maxUnverifiedSourceRatio: Math.min(1, Math.max(0, Number(raw?.maxUnverifiedSourceRatio) || 0.05)),
    minCitedSourceRatio: Math.min(1, Math.max(0, Number(raw?.minCitedSourceRatio) || 0.7)),
    requireResolvedCriticFlags: raw?.requireResolvedCriticFlags !== false,
    maxRedTeamHighSeverity: Number.isFinite(Number(raw?.maxRedTeamHighSeverity))
      ? Math.max(0, Number(raw.maxRedTeamHighSeverity))
      : 8,
    criticalAttributeIds: criticalFromConfig.length
      ? criticalFromConfig
      : ["pricing-model", "pmf-signal", "moat-assessment"],
  };
}

function evaluateMatrixDecisionGrade({
  matrix = {},
  subjects = [],
  attributes = [],
  analysisMeta = {},
  requiredSubjects = [],
  config = {},
} = {}) {
  const gate = resolveMatrixDecisionGradeGate(config);
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const coverage = matrix?.coverage && Number.isFinite(Number(matrix?.coverage?.totalCells))
    ? matrix.coverage
    : summarizeCoverage(cells);
  const subjectList = Array.isArray(subjects) ? subjects : [];
  const attributeList = Array.isArray(attributes) ? attributes : [];

  if (!gate.enabled) {
    return {
      pass: true,
      failureReason: "",
      diagnostics: {
        enabled: false,
        pass: true,
        checks: [],
        metrics: {},
      },
    };
  }

  const cellMap = new Map();
  cells.forEach((cell) => {
    cellMap.set(buildCellKey(cell?.subjectId, cell?.attributeId), cell);
  });
  const reasons = [];

  const lowConfidenceCells = Number(coverage?.lowConfidenceCells || 0);
  const totalCells = Number(coverage?.totalCells || cells.length || 0);
  const lowConfidenceRatio = totalCells ? (lowConfidenceCells / totalCells) : 0;
  if (lowConfidenceRatio > gate.maxLowConfidenceRatio) {
    reasons.push({
      code: "decision_grade_low_confidence_ratio_failed",
      detail: `Low-confidence cells ${lowConfidenceCells}/${totalCells} exceed ${(gate.maxLowConfidenceRatio * 100).toFixed(0)}% threshold.`,
    });
  }

  const requiredNormalized = (Array.isArray(requiredSubjects) ? requiredSubjects : [])
    .map((entry) => cleanText(entry?.label || entry))
    .filter(Boolean);
  const subjectKeySet = new Set(subjectList.map((entry) => normalizeSubjectMatchKey(entry?.label || entry)));
  const missingRequiredSubjects = requiredNormalized.filter((label) => !subjectKeySet.has(normalizeSubjectMatchKey(label)));
  if (missingRequiredSubjects.length) {
    reasons.push({
      code: "decision_grade_required_subjects_missing",
      detail: `Required subjects missing from final matrix: ${missingRequiredSubjects.join(", ")}.`,
    });
  }

  const subjectCoverage = subjectList.map((subject) => {
    let evidenceCells = 0;
    attributeList.forEach((attribute) => {
      const cell = cellMap.get(buildCellKey(subject.id, attribute.id));
      const sourceCount = normalizeSourceList(cell?.sources).length;
      if (sourceCount >= gate.minSourcesPerCoverageCell && !hasExplicitFailureReason(cell)) {
        evidenceCells += 1;
      }
    });
    const total = attributeList.length || 1;
    const coverageValue = evidenceCells / total;
    return {
      subjectId: subject.id,
      subjectLabel: subject.label,
      evidenceCells,
      totalCells: attributeList.length,
      coverage: coverageValue,
      pass: coverageValue >= gate.minSubjectEvidenceCoverage,
    };
  });
  const failingCoverageSubjects = subjectCoverage.filter((entry) => !entry.pass);
  if (failingCoverageSubjects.length) {
    reasons.push({
      code: "decision_grade_subject_coverage_failed",
      detail: `Subject evidence coverage below ${(gate.minSubjectEvidenceCoverage * 100).toFixed(0)}%: ${failingCoverageSubjects.map((entry) => `${entry.subjectLabel} ${(entry.coverage * 100).toFixed(0)}%`).join(", ")}.`,
    });
  }

  const criticalAttributeIds = attributeList
    .filter((attribute) => gate.criticalAttributeIds.includes(attribute.id))
    .map((attribute) => attribute.id);
  const attributeLabelById = new Map(attributeList.map((attribute) => [attribute.id, cleanText(attribute.label)]));
  const criticalCellFailures = [];
  if (criticalAttributeIds.length) {
    subjectList.forEach((subject) => {
      criticalAttributeIds.forEach((attributeId) => {
        const cell = cellMap.get(buildCellKey(subject.id, attributeId));
        const sources = normalizeSourceList(cell?.sources);
        const citedSources = sources.filter((source) => (
          deriveSourceDisplayStatus(source, {
            staleEvidenceRatio: Number(cell?.staleEvidenceRatio),
            attributeId,
            attributeLabel: attributeLabelById.get(attributeId) || "",
          }) === "cited"
        ));
        const independentCited = citedSources.filter((source) => (
          cleanText(source?.sourceType).toLowerCase() === "independent"
          || cleanText(source?.sourceType).toLowerCase() === "press"
        ));
        if (sources.length < gate.minSourcesPerCriticalCell || independentCited.length < gate.minIndependentSourcesPerCriticalCell) {
          criticalCellFailures.push({
            subjectId: subject.id,
            subjectLabel: subject.label,
            attributeId,
            sourceCount: sources.length,
            independentCited: independentCited.length,
          });
        }
      });
    });
  }
  if (criticalCellFailures.length) {
    reasons.push({
      code: "decision_grade_critical_cells_failed",
      detail: `Critical attributes require >=${gate.minSourcesPerCriticalCell} sources and >=${gate.minIndependentSourcesPerCriticalCell} independent cited source(s); failures: ${criticalCellFailures.slice(0, 8).map((entry) => `${entry.subjectLabel}::${entry.attributeId} (${entry.sourceCount} sources, ${entry.independentCited} independent)`).join(", ")}${criticalCellFailures.length > 8 ? ` (+${criticalCellFailures.length - 8} more)` : ""}.`,
    });
  }

  const sourceUniverse = analysisMeta?.sourceUniverse && typeof analysisMeta.sourceUniverse === "object"
    ? analysisMeta.sourceUniverse
    : buildMatrixSourceUniverse(matrix);
  const sourceTotal = Number(sourceUniverse?.total || 0);
  const citedRatio = sourceTotal ? (Number(sourceUniverse?.cited || 0) / sourceTotal) : 0;
  const unverifiedRatio = sourceTotal ? (Number(sourceUniverse?.unverified || 0) / sourceTotal) : 1;
  if (sourceTotal && citedRatio < gate.minCitedSourceRatio) {
    reasons.push({
      code: "decision_grade_cited_ratio_failed",
      detail: `Cited source ratio ${(citedRatio * 100).toFixed(1)}% is below ${(gate.minCitedSourceRatio * 100).toFixed(0)}% threshold.`,
    });
  }
  if (sourceTotal && unverifiedRatio > gate.maxUnverifiedSourceRatio) {
    reasons.push({
      code: "decision_grade_unverified_ratio_failed",
      detail: `Unverified source ratio ${(unverifiedRatio * 100).toFixed(1)}% exceeds ${(gate.maxUnverifiedSourceRatio * 100).toFixed(0)}% threshold.`,
    });
  }

  const contestedCells = Number(coverage?.contestedCells || 0);
  const flagsRaised = Number(analysisMeta?.criticFlagsRaised || 0);
  const resolvedFlags = Number(analysisMeta?.contestedCellsResolved || 0);
  const unresolvedFlags = Math.max(0, flagsRaised - resolvedFlags);
  if (gate.requireResolvedCriticFlags && (contestedCells > 0 || unresolvedFlags > 0)) {
    reasons.push({
      code: "decision_grade_unresolved_critic_flags",
      detail: `Critic unresolved flags remain: contested cells ${contestedCells}, unresolved ${unresolvedFlags}.`,
    });
  }

  const redTeamHighSeverityCount = Number(analysisMeta?.redTeamHighSeverityCount || 0);
  if (redTeamHighSeverityCount > gate.maxRedTeamHighSeverity) {
    reasons.push({
      code: "decision_grade_red_team_high_severity",
      detail: `Red Team high-severity findings (${redTeamHighSeverityCount}) exceed allowed maximum (${gate.maxRedTeamHighSeverity}).`,
    });
  }

  const pass = reasons.length === 0;
  return {
    pass,
    failureReason: reasons.map((entry) => entry.detail).join(" "),
    diagnostics: {
      enabled: true,
      pass,
      checks: reasons,
      metrics: {
        totalCells,
        lowConfidenceCells,
        lowConfidenceRatio,
        requiredSubjects: requiredNormalized,
        missingRequiredSubjects,
        subjectCoverage,
        criticalAttributeIds,
        criticalCellFailures,
        sourceUniverse,
        citedRatio,
        unverifiedRatio,
        contestedCells,
        criticFlagsRaised: flagsRaised,
        contestedCellsResolved: resolvedFlags,
        unresolvedFlags,
        redTeamHighSeverityCount,
      },
      config: gate,
    },
  };
}

function computeCriticFlagMonitoring({ matrix = {}, criticFlags = [], config = {} } = {}) {
  const thresholds = resolveCriticFlagMonitoring(config);
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const totalAuditedCells = cells.length;
  const lowConfidenceCells = cells.filter((cell) => normalizeConfidence(cell.confidence) === "low").length;
  const lowConfidenceRate = totalAuditedCells ? (lowConfidenceCells / totalAuditedCells) : 0;
  const flagsRaised = Array.isArray(criticFlags) ? criticFlags.length : 0;
  const flagRate = totalAuditedCells ? (flagsRaised / totalAuditedCells) : 0;
  const alert = totalAuditedCells >= thresholds.minAuditedCells
    && lowConfidenceRate >= thresholds.highLowConfidenceRate
    && flagRate < thresholds.minFlagRate;
  const alertMessage = alert
    ? `Critic flag rate ${Math.round(flagRate * 100)}% is below threshold ${Math.round(thresholds.minFlagRate * 100)}% with high low-confidence share ${Math.round(lowConfidenceRate * 100)}%.`
    : "";

  return {
    totalAuditedCells,
    flagsRaised,
    flagRate,
    lowConfidenceRate,
    thresholds,
    alert,
    alertMessage,
  };
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

function evaluateMatrixReconcileHealth(subjects = [], attributes = [], baseline = {}, web = {}, reconciled = {}) {
  const stats = matrixHybridStats(subjects, attributes, baseline, web, reconciled);
  const coverage = summarizeCoverage(Array.isArray(reconciled?.cells) ? reconciled.cells : []);
  const lowConfidenceRatio = stats.totalCells ? (coverage.lowConfidenceCells / stats.totalCells) : 0;
  const strongDisagreementThreshold = Math.max(3, Math.ceil(stats.totalCells * 0.2));
  const highUncertaintyThreshold = Math.max(3, Math.ceil(stats.totalCells * 0.3));

  const suspicious = (
    stats.changedFromWeb === 0
      && stats.changedFromBaseline <= 1
      && coverage.lowConfidenceCells >= highUncertaintyThreshold
  ) || (
    stats.changedFromWeb <= 1
      && stats.changedFromBaseline <= 1
      && coverage.lowConfidenceCells >= highUncertaintyThreshold
      && stats.totalCells >= strongDisagreementThreshold
  );

  const notes = [];
  if (stats.changedFromWeb === 0) {
    notes.push("Reconcile matched web draft exactly despite unresolved low-confidence cells.");
  }
  if (stats.changedFromBaseline <= 1) {
    notes.push("Reconcile remained near-baseline while matrix uncertainty stayed high.");
  }
  if (coverage.lowConfidenceCells >= highUncertaintyThreshold) {
    notes.push(`Low-confidence cells remain high: ${coverage.lowConfidenceCells}/${stats.totalCells}.`);
  }

  return {
    ...stats,
    lowConfidenceCells: coverage.lowConfidenceCells,
    lowConfidenceRatio,
    suspicious,
    notes,
  };
}

function scoreMatrixReconcileCandidate(diag = {}) {
  const changedBlend = Math.max(Number(diag.changedFromWeb || 0), Number(diag.changedFromBaseline || 0));
  const uncertaintyPenalty = Number(diag.lowConfidenceRatio || 0) * 2.5;
  const suspiciousPenalty = diag.suspicious ? 2 : 0;
  return changedBlend - uncertaintyPenalty - suspiciousPenalty;
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
      sources: annotateSourceListDisplayStatus(normalizedSources),
      counters: {
        checked: 0,
        verified: 0,
        notFound: 0,
        fetchFailed: 0,
        invalidUrl: 0,
        partial: 0,
        nameOnly: 0,
      },
    };
  }

  const counters = {
    checked: 0,
    verified: 0,
    notFound: 0,
    fetchFailed: 0,
    invalidUrl: 0,
    partial: 0,
    nameOnly: 0,
  };

  const out = [];
  for (const source of normalizedSources) {
    const existingStatus = cleanText(source?.verificationStatus).toLowerCase();
    if (
      existingStatus === "verified_in_page"
      || existingStatus === "not_found_in_page"
      || existingStatus === "fetch_failed"
      || existingStatus === "invalid_url"
      || existingStatus === "name_only_in_page"
    ) {
      out.push({ ...source });
      continue;
    }

    const normalizedUrl = normalizeHttpUrl(source.url);
    if (!normalizedUrl) {
      counters.invalidUrl += 1;
      out.push({
        ...source,
        verificationStatus: "invalid_url",
        verificationNote: "Source URL is missing or invalid; evidence cannot be quote-verified.",
      });
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

    const match = quotedClaimFoundInPage(source, fetched.snapshot);
    if (match.verified) {
      counters.verified += 1;
      out.push({
        ...source,
        url: normalizedUrl,
        verificationStatus: "verified_in_page",
        verificationNote: `Quoted claim matched in fetched page (${match.matchType}).`,
      });
    } else {
      if (match.matchType === "name_only" || match.matchType === "partial_quote_name") {
        counters.nameOnly += 1;
      } else if (String(match.matchType || "").startsWith("partial_quote")) {
        counters.partial += 1;
      }
      counters.notFound += 1;
      out.push({
        ...source,
        url: normalizedUrl,
        verificationStatus: match.matchType === "name_only" ? "name_only_in_page" : "not_found_in_page",
        verificationNote: match.matchType === "name_only"
          ? "Source name appears in fetched page, but quoted claim text was not verified."
          : "Quoted claim text was not found in fetched source content.",
      });
    }
  }

  analysisMeta.sourceVerificationChecked += counters.checked;
  analysisMeta.sourceVerificationVerified += counters.verified;
  analysisMeta.sourceVerificationNotFound += counters.notFound;
  analysisMeta.sourceVerificationFetchFailed += counters.fetchFailed;
  analysisMeta.sourceVerificationInvalidUrl = Number(analysisMeta.sourceVerificationInvalidUrl || 0) + counters.invalidUrl;
  analysisMeta.sourceVerificationPartialMatch = Number(analysisMeta.sourceVerificationPartialMatch || 0) + counters.partial;
  analysisMeta.sourceVerificationNameOnly = Number(analysisMeta.sourceVerificationNameOnly || 0) + counters.nameOnly;

  return { sources: annotateSourceListDisplayStatus(out), counters };
}

function applyCellVerificationPenalty(cell, counters, analysisMeta) {
  const checked = Number(counters.checked || 0);
  if (!checked) return;

  const verified = Number(counters.verified || 0);
  if (verified / checked >= 0.5) return;

  const current = normalizeConfidence(cell.confidence);
  const downgraded = confidenceRank(current) > confidenceRank("medium") ? "medium" : current;
  if (downgraded !== current) {
    cell.confidence = downgraded;
    analysisMeta.sourceVerificationPenalizedCells += 1;
  }
  const note = `Source verification check: ${verified}/${checked} cited URLs contained the quoted claim text.`;
  const previous = cleanText(cell.confidenceReason).replace(/\s*Source verification check:[^.]*\./gi, "").trim();
  cell.confidenceReason = [previous, note].filter(Boolean).join(" ");
}

function extractEvidenceYearFromSource(source = {}) {
  const years = extractEvidenceYearsFromSource(source);
  if (!years.length) return null;
  return Math.max(...years);
}

function applyCellQualityCaps(cell = {}, analysisMeta = {}) {
  const sources = normalizeSourceList(cell.sources);
  const sourceCount = sources.length;
  const withUrl = sources.filter((source) => normalizeHttpUrl(source.url)).length;
  const independent = sources.filter((source) => source.sourceType === "independent").length;
  let confidence = normalizeConfidence(cell.confidence);

  if (sourceCount > 0 && independent < 1 && confidenceRank(confidence) > confidenceRank("medium")) {
    confidence = "medium";
    analysisMeta.sourceDiversityConfidenceCaps = Number(analysisMeta.sourceDiversityConfidenceCaps || 0) + 1;
    const note = "Confidence capped: no independent corroborating source was cited.";
    cell.confidenceReason = [cleanText(cell.confidenceReason), note].filter(Boolean).join(" ");
  }

  const years = sources
    .map((source) => extractEvidenceYearFromSource(source))
    .filter((year) => Number.isFinite(year));
  const currentYear = new Date().getFullYear();
  const staleCutoff = currentYear - 2;
  const staleCount = years.filter((year) => year < staleCutoff).length;
  const staleRatio = years.length ? staleCount / years.length : 0;
  cell.staleEvidenceRatio = staleRatio;
  analysisMeta.staleEvidenceObservedCells = Number(analysisMeta.staleEvidenceObservedCells || 0) + 1;
  analysisMeta.staleEvidenceRatioSum = Number(analysisMeta.staleEvidenceRatioSum || 0) + staleRatio;

  if (staleRatio >= 0.6 && confidenceRank(confidence) > confidenceRank("low")) {
    const previous = confidence;
    confidence = confidenceRank(confidence) > confidenceRank("medium") ? "medium" : confidence;
    if (confidence !== previous) {
      analysisMeta.staleEvidenceConfidenceCaps = Number(analysisMeta.staleEvidenceConfidenceCaps || 0) + 1;
      const note = `Confidence reduced: evidence appears mostly stale (pre-${staleCutoff + 1}).`;
      cell.confidenceReason = [cleanText(cell.confidenceReason), note].filter(Boolean).join(" ");
    }
  }

  if (!sourceCount && confidenceRank(confidence) > confidenceRank("low")) {
    confidence = "low";
    analysisMeta.zeroSourceConfidenceCaps = Number(analysisMeta.zeroSourceConfidenceCaps || 0) + 1;
    const note = "Confidence reduced: no cited sources were returned for this cell.";
    cell.confidenceReason = [cleanText(cell.confidenceReason), note].filter(Boolean).join(" ");
  }

  if (sourceCount > 0 && confidenceRank(confidence) > confidenceRank("medium")) {
    const verifiedInPage = sources.filter((source) => source.verificationStatus === "verified_in_page").length;
    const verificationRatio = sourceCount ? (verifiedInPage / sourceCount) : 0;
    if (verificationRatio < 0.3) {
      confidence = "medium";
      analysisMeta.verificationConfidenceCaps = Number(analysisMeta.verificationConfidenceCaps || 0) + 1;
      const note = "Confidence capped: quote verification coverage is limited.";
      cell.confidenceReason = [cleanText(cell.confidenceReason), note].filter(Boolean).join(" ");
    }
  }

  if (sourceCount > 0 && confidenceRank(confidence) > confidenceRank("medium")) {
    const urlCoverage = sourceCount ? (withUrl / sourceCount) : 0;
    if (urlCoverage < 0.6) {
      confidence = "medium";
      analysisMeta.urlCoverageConfidenceCaps = Number(analysisMeta.urlCoverageConfidenceCaps || 0) + 1;
      const note = "Confidence capped: too few cited sources include verifiable URLs.";
      cell.confidenceReason = [cleanText(cell.confidenceReason), note].filter(Boolean).join(" ");
    }
  }

  if (sourceCount > 0 && confidenceRank(confidence) > confidenceRank("medium")) {
    const citedSources = sources.filter((source) => (
      deriveSourceDisplayStatus(source, {
        staleEvidenceRatio: staleRatio,
        attributeId: cleanText(cell?.attributeId),
        attributeLabel: cleanText(cell?.attributeLabel || ""),
      }) === "cited"
    ));
    const independentCited = citedSources.filter((source) => {
      const sourceType = cleanText(source?.sourceType).toLowerCase();
      return sourceType === "independent" || sourceType === "press";
    }).length;
    if (citedSources.length < 2 || independentCited < 1) {
      confidence = "medium";
      analysisMeta.highConfidenceCorroborationCaps = Number(analysisMeta.highConfidenceCorroborationCaps || 0) + 1;
      const note = "Confidence capped: high confidence requires at least two cited sources including one independent corroborating source.";
      cell.confidenceReason = [cleanText(cell.confidenceReason), note].filter(Boolean).join(" ");
    }
  }

  cell.sourceMix = {
    total: sourceCount,
    withUrl,
    independent,
    vendor: sources.filter((source) => source.sourceType === "vendor").length,
    press: sources.filter((source) => source.sourceType === "press").length,
  };
  cell.sources = annotateSourceListDisplayStatus(sources, {
    staleEvidenceRatio: staleRatio,
    attributeId: cleanText(cell?.attributeId),
    attributeLabel: cleanText(cell?.attributeLabel || ""),
  });
  cell.confidence = confidence;
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
      applyCellQualityCaps(cell, analysisMeta);
    } else {
      cell.sources = annotateSourceListDisplayStatus(cell.sources, {
        staleEvidenceRatio: Number.isFinite(Number(cell?.staleEvidenceRatio))
          ? Number(cell.staleEvidenceRatio)
          : null,
        attributeId: cleanText(cell?.attributeId),
        attributeLabel: cleanText(cell?.attributeLabel || ""),
      });
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
  researchSetup = {},
}) {
  const liveSearchBlock = liveSearch
    ? "Use live web search to ground evidence in current external sources and include real URLs when possible."
    : "Live web search is disabled for this pass. Use only internal model memory and explicitly mark uncertainty.";
  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

Pass:
${passLabel}

${liveSearchBlock}

Subjects:
${subjects.map((subject, idx) => `${idx + 1}. ${subject.id}: ${subject.label}`).join("\n")}

Attributes:
${attributes.map((attr) => `- ${attr.id}: ${attr.label}${attr.brief ? ` - ${attr.brief}` : ""}`).join("\n")}

Hard ID rule:
- Use exact subjectId and attributeId identifiers shown above.
- Never output positional row/column numbers as IDs.

Return JSON only:
{
  "cells": [
    {
      "subjectId": "<subject id from list>",
      "attributeId": "<attribute id from list>",
      "value": "<2-4 sentence evidence-based finding>",
      "full": "<1-2 short paragraphs with concrete detail>",
      "risks": "<1-2 sentences on key caveats or failure modes>",
      "arguments": {
        "supporting": [{"id":"sup-1","claim":"<short claim>","detail":"<short detail>","sources":[{"name":"...","quote":"...","url":"..."}]}],
        "limiting": [{"id":"lim-1","claim":"<short claim>","detail":"<short detail>","sources":[{"name":"...","quote":"...","url":"..."}]}]
      },
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

function buildMatrixReconcilePrompt({
  rawInput,
  decisionQuestion,
  subjects,
  attributes,
  baseline,
  web,
  qualityGuard = null,
  researchSetup = {},
}) {
  const guard = qualityGuard && typeof qualityGuard === "object" ? qualityGuard : null;
  const guardNotes = Array.isArray(guard?.notes)
    ? guard.notes.map((note) => cleanText(note)).filter(Boolean)
    : [];
  const focusCells = Array.isArray(guard?.focusCells)
    ? guard.focusCells
      .map((item) => `${cleanText(item?.subjectId)}::${cleanText(item?.attributeId)}`)
      .filter((item) => item && item !== "::")
    : [];
  const qualityGuardBlock = guard
    ? `\nReconcile quality guard:
- Previous reconcile looked implausibly unchanged.
- Prioritize these unresolved cells first: ${focusCells.length ? focusCells.join(", ") : "none specified"}.
- Guard notes:
${guardNotes.length ? guardNotes.map((note) => `  - ${note}`).join("\n") : "  - Previous merge underused available draft disagreement signals."}\n`
    : "";
  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Merge two matrix drafts for the same research question.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

Subjects:
${subjects.map((subject, idx) => `${idx + 1}. ${subject.id}: ${subject.label}`).join("\n")}

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
- Avoid blindly copying one draft when many cells still have low confidence.
${qualityGuardBlock}

Return JSON only with the same schema as analyst pass.`;
}

function splitIntoChunks(items = [], chunkSize = 1) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Number(chunkSize) || 1);
  const out = [];
  for (let idx = 0; idx < list.length; idx += size) {
    out.push(list.slice(idx, idx + size));
  }
  return out.length ? out : [[]];
}

function resolveMatrixChunkSize(subjects = [], attributes = [], limits = {}, { liveSearch = false } = {}) {
  const subjectCount = Math.max(1, Array.isArray(subjects) ? subjects.length : 0);
  const attributeCount = Math.max(1, Array.isArray(attributes) ? attributes.length : 0);
  const rawMaxCells = Number(
    liveSearch
      ? (limits?.matrixWebChunkMaxCells ?? limits?.matrixChunkMaxCells)
      : limits?.matrixChunkMaxCells
  );
  const maxCells = Number.isFinite(rawMaxCells)
    ? Math.max(attributeCount, Math.round(rawMaxCells))
    : Math.max(attributeCount, liveSearch ? 16 : 32);
  const byCells = Math.max(1, Math.floor(maxCells / attributeCount));
  return Math.min(subjectCount, byCells);
}

function sliceMatrixBySubjects(matrix = {}, subjectIds = new Set()) {
  const allowed = subjectIds instanceof Set ? subjectIds : new Set(subjectIds || []);
  return {
    ...matrix,
    cells: (Array.isArray(matrix?.cells) ? matrix.cells : []).filter((cell) => allowed.has(cell?.subjectId)),
    subjectSummaries: (Array.isArray(matrix?.subjectSummaries) ? matrix.subjectSummaries : [])
      .filter((entry) => allowed.has(entry?.subjectId)),
  };
}

function combineMatrixChunkPayloads(chunks = []) {
  const cellMap = new Map();
  const summaryMap = new Map();
  const summaries = [];
  (Array.isArray(chunks) ? chunks : []).forEach((entry) => {
    const payload = entry?.payload && typeof entry.payload === "object" ? entry.payload : {};
    const cells = Array.isArray(payload?.cells) ? payload.cells : [];
    const subjectSummaries = Array.isArray(payload?.subjectSummaries) ? payload.subjectSummaries : [];
    cells.forEach((cell) => {
      const key = `${cleanText(cell?.subjectId || cell?.subject || cell?.row)}::${cleanText(cell?.attributeId || cell?.attribute || cell?.column)}`;
      if (!key || key === "::") return;
      cellMap.set(key, cell);
    });
    subjectSummaries.forEach((summary) => {
      const key = cleanText(summary?.subjectId || summary?.subject || summary?.label).toLowerCase();
      if (!key) return;
      summaryMap.set(key, summary);
    });
    if (cleanText(payload?.crossMatrixSummary || payload?.summary)) {
      summaries.push(cleanText(payload?.crossMatrixSummary || payload?.summary));
    }
  });

  return {
    cells: [...cellMap.values()],
    subjectSummaries: [...summaryMap.values()],
    crossMatrixSummary: summaries.join(" ").trim(),
  };
}

function buildMatrixCompletenessRepairPrompt({
  rawInput,
  decisionQuestion,
  subjects = [],
  attributes = [],
  passLabel = "",
  liveSearch = false,
  researchSetup = {},
  missingCellKeys = [],
}) {
  const liveSearchBlock = liveSearch
    ? "- Use live web evidence and provide sources for each populated claim."
    : "- Use memory-only reasoning; do not fabricate sources.";
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  const missingCells = (Array.isArray(missingCellKeys) ? missingCellKeys : [])
    .filter(Boolean)
    .map((key) => `- ${key}`);

  return `Repair missing matrix cells for an in-progress pass.

Pass label:
${passLabel}

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

Subjects to repair:
${subjects.map((subject, idx) => `${idx + 1}. ${subject.id}: ${subject.label}`).join("\n")}

Attributes:
${attributes.map((attr) => `- ${attr.id}: ${attr.label}${attr.brief ? ` - ${attr.brief}` : ""}`).join("\n")}

Missing cell keys:
${missingCells.length ? missingCells.join("\n") : "- none listed"}

Rules:
- Return a complete cell object for every subject x attribute pair in this prompt.
- Use exact subjectId/attributeId IDs.
${liveSearchBlock}
- If evidence is insufficient, keep confidence low and state exactly why.

Return JSON only:
{
  "cells": [
    {
      "subjectId":"<subject id>",
      "attributeId":"<attribute id>",
      "value":"<short value>",
      "full":"<full explanation>",
      "risks":"<key risks>",
      "confidence":"<high|medium|low>",
      "confidenceReason":"<why>",
      "sources":[{"name":"<source title>", "url":"<https://...>", "snippet":"<optional snippet>"}]
    }
  ],
  "subjectSummaries":[{"subjectId":"<subject id>","summary":"<optional summary>"}],
  "crossMatrixSummary":"<optional summary>"
}`;
}

function parseMatrixCellKey(key = "") {
  const value = cleanText(key);
  if (!value || !value.includes("::")) return null;
  const [subjectId, attributeId] = value.split("::");
  if (!cleanText(subjectId) || !cleanText(attributeId)) return null;
  return {
    subjectId: cleanText(subjectId),
    attributeId: cleanText(attributeId),
  };
}

function resolveMissingSubjectsFromKeys(missingKeys = [], subjects = []) {
  const missingSubjectIds = new Set(
    (Array.isArray(missingKeys) ? missingKeys : [])
      .map((key) => parseMatrixCellKey(key))
      .filter(Boolean)
      .map((entry) => entry.subjectId)
  );
  return subjects.filter((subject) => missingSubjectIds.has(subject.id));
}

function mergeMatrixRepairChunk(baseMatrix = {}, repairedChunk = {}, missingKeys = new Set()) {
  const replacedKeys = new Set();
  const repairedMap = new Map(
    (Array.isArray(repairedChunk?.cells) ? repairedChunk.cells : [])
      .map((cell) => [buildCellKey(cell.subjectId, cell.attributeId), cell])
  );

  const nextCells = (Array.isArray(baseMatrix?.cells) ? baseMatrix.cells : []).map((cell) => {
    const key = buildCellKey(cell.subjectId, cell.attributeId);
    if (!missingKeys.has(key)) return cell;
    const candidate = repairedMap.get(key);
    if (!candidate) return cell;
    const candidateHasEvidence = normalizeSourceList(candidate.sources).length > 0
      || cleanText(candidate?.value) !== "No reliable evidence found for this cell."
      || cleanText(candidate?.full)
      || normalizeConfidence(candidate?.confidence) !== "low";
    if (!candidateHasEvidence) return cell;
    replacedKeys.add(key);
    return {
      ...cell,
      ...candidate,
    };
  });

  const summaryBySubject = new Map(
    (Array.isArray(baseMatrix?.subjectSummaries) ? baseMatrix.subjectSummaries : [])
      .map((entry) => [cleanText(entry?.subjectId), cleanText(entry?.summary)])
      .filter(([subjectId]) => !!subjectId)
  );
  (Array.isArray(repairedChunk?.subjectSummaries) ? repairedChunk.subjectSummaries : []).forEach((entry) => {
    const subjectId = cleanText(entry?.subjectId);
    const summary = cleanText(entry?.summary);
    if (!subjectId || !summary) return;
    summaryBySubject.set(subjectId, summary);
  });

  return {
    matrix: {
      ...baseMatrix,
      cells: nextCells,
      subjectSummaries: [...summaryBySubject.entries()].map(([subjectId, summary]) => ({ subjectId, summary })),
    },
    replacedKeys,
  };
}

function refreshMatrixNormalizationAfterRepair(matrix = {}, subjects = [], attributes = [], missingKeys = []) {
  const expectedCells = Math.max(0, subjects.length * attributes.length);
  const missingSet = new Set((Array.isArray(missingKeys) ? missingKeys : []).filter(Boolean));
  return {
    ...(matrix?.normalization || {}),
    expectedCells,
    mappedCells: Math.max(0, expectedCells - missingSet.size),
    placeholderCellsAdded: missingSet.size,
    missingCellKeys: [...missingSet],
  };
}

async function runChunkedAnalystMatrixPass({
  transport,
  analystPrompt,
  requestOptions = {},
  rawInput = "",
  decisionQuestion = "",
  subjects = [],
  attributes = [],
  passLabel = "",
  phase = "",
  liveSearch = false,
  tokenLimit = 8000,
  limits = {},
  debugSession = null,
  analysisMeta = {},
  researchSetup = {},
  buildPromptForChunk = null,
}) {
  const chunkSize = resolveMatrixChunkSize(subjects, attributes, limits, { liveSearch });
  const chunks = splitIntoChunks(subjects, chunkSize);
  const chunkPayloads = [];
  const parseRetryAttemptsRaw = Number(limits?.matrixChunkParseRetryAttempts);
  const parseRetryAttempts = Number.isFinite(parseRetryAttemptsRaw)
    ? Math.max(0, Math.min(2, Math.round(parseRetryAttemptsRaw)))
    : 1;
  const parseSplitMaxDepthRaw = Number(limits?.matrixChunkParseRetrySplitDepth);
  const parseSplitMaxDepth = Number.isFinite(parseSplitMaxDepthRaw)
    ? Math.max(0, Math.min(4, Math.round(parseSplitMaxDepthRaw)))
    : 3;

  const isJsonParseFailure = (err) => (
    cleanText(err?.code) === "JSON_PARSE_FAILED"
    || /JSON parse failed/i.test(cleanText(err?.message))
  );

  const strictJsonReminder = `

CRITICAL JSON REQUIREMENTS:
- Return one valid JSON object only.
- No prose outside JSON.
- Ensure all properties use ":" with valid values.
- Do not truncate or leave dangling keys.
`;

  const runChunkSubjects = async (chunkSubjects, chunkTag = "chunk", depth = 0) => {
    let lastParseError = null;

    for (let attempt = 0; attempt <= parseRetryAttempts; attempt += 1) {
      const forceStrict = attempt > 0;
      let prompt = typeof buildPromptForChunk === "function"
        ? buildPromptForChunk(chunkSubjects, chunkTag)
        : buildMatrixEvidencePrompt({
          rawInput,
          decisionQuestion,
          subjects: chunkSubjects,
          attributes,
          passLabel: `${passLabel} (${chunkTag})`,
          liveSearch,
          researchSetup,
        });
      if (forceStrict) prompt = `${prompt}${strictJsonReminder}`;

      const res = await transport.callAnalyst(
        [{ role: "user", content: prompt }],
        analystPrompt,
        tokenLimit,
        {
          ...(requestOptions || {}),
          liveSearch,
          includeMeta: true,
        }
      );
      if (analysisMeta && typeof analysisMeta === "object") {
        Object.assign(analysisMeta, mergeMeta(analysisMeta, res?.meta, "analyst"));
      }

      try {
        const parsed = extractJson(res?.text || res, {}, {
          phase,
          attempt: `${chunkTag}::try_${attempt + 1}`,
          prompt,
          debugSession,
        });
        return [{ subjectIds: chunkSubjects.map((item) => item.id), payload: parsed }];
      } catch (err) {
        if (!isJsonParseFailure(err)) throw err;
        lastParseError = err;
        appendAnalysisDebugEvent(debugSession, {
          type: "matrix_chunk_parse_retry",
          phase,
          attempt: `${chunkTag}::try_${attempt + 1}`,
          note: cleanText(err?.message || "matrix_chunk_parse_retry"),
          diagnostics: {
            subjectCount: chunkSubjects.length,
            depth,
            strictAttempt: forceStrict,
          },
        });
      }
    }

    if (chunkSubjects.length > 1 && depth < parseSplitMaxDepth) {
      const mid = Math.ceil(chunkSubjects.length / 2);
      const left = chunkSubjects.slice(0, mid);
      const right = chunkSubjects.slice(mid);
      appendAnalysisDebugEvent(debugSession, {
        type: "matrix_chunk_parse_split_retry",
        phase,
        attempt: chunkTag,
        note: `Parse retries exhausted; splitting chunk ${chunkSubjects.length} into ${left.length}+${right.length}.`,
        diagnostics: {
          depth,
          parseRetryAttempts,
        },
      });
      const leftPayloads = await runChunkSubjects(left, `${chunkTag}.a`, depth + 1);
      const rightPayloads = await runChunkSubjects(right, `${chunkTag}.b`, depth + 1);
      return [...leftPayloads, ...rightPayloads];
    }

    throw lastParseError || new Error(`Chunk parse failed for ${chunkTag}.`);
  };

  let chunkSequence = 0;
  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunkSubjects = chunks[idx];
    const chunkTag = `chunk_${idx + 1}/${chunks.length}`;
    const payloadEntries = await runChunkSubjects(chunkSubjects, chunkTag, 0);
    payloadEntries.forEach((entry) => {
      chunkPayloads.push({
        chunkIndex: chunkSequence,
        subjectIds: Array.isArray(entry?.subjectIds) ? entry.subjectIds : [],
        payload: entry?.payload && typeof entry.payload === "object" ? entry.payload : {},
      });
      chunkSequence += 1;
    });
  }

  const combinedPayload = combineMatrixChunkPayloads(chunkPayloads);
  let matrix = normalizeAnalystMatrix(combinedPayload, subjects, attributes);

  const maxRepairRoundsRaw = Number(limits?.matrixCompletenessRepairRounds);
  const maxRepairRounds = Number.isFinite(maxRepairRoundsRaw)
    ? Math.max(0, Math.min(3, Math.round(maxRepairRoundsRaw)))
    : 1;
  const repairSubjectChunkSizeRaw = Number(limits?.matrixCompletenessRepairSubjectChunkSize);
  const repairSubjectChunkSize = Number.isFinite(repairSubjectChunkSizeRaw)
    ? Math.max(1, Math.min(subjects.length || 1, Math.round(repairSubjectChunkSizeRaw)))
    : Math.min(2, subjects.length || 1);

  let repairRoundsUsed = 0;
  let repairedCellCount = 0;
  if (maxRepairRounds > 0) {
    for (let round = 1; round <= maxRepairRounds; round += 1) {
      const missingKeysRound = Array.isArray(matrix?.normalization?.missingCellKeys)
        ? matrix.normalization.missingCellKeys.filter(Boolean)
        : [];
      if (!missingKeysRound.length) break;

      const missingSubjects = resolveMissingSubjectsFromKeys(missingKeysRound, subjects);
      if (!missingSubjects.length) break;

      const repairChunks = splitIntoChunks(missingSubjects, repairSubjectChunkSize);
      const recoveredInRound = new Set();
      const missingSet = new Set(missingKeysRound);

      for (let idx = 0; idx < repairChunks.length; idx += 1) {
        const repairSubjects = repairChunks[idx];
        const repairSubjectIds = new Set(repairSubjects.map((subject) => subject.id));
        const repairKeys = missingKeysRound.filter((key) => {
          const parsedKey = parseMatrixCellKey(key);
          return parsedKey && repairSubjectIds.has(parsedKey.subjectId);
        });
        if (!repairKeys.length) continue;

        const prompt = buildMatrixCompletenessRepairPrompt({
          rawInput,
          decisionQuestion,
          subjects: repairSubjects,
          attributes,
          passLabel: `${passLabel} completeness repair round ${round}`,
          liveSearch,
          researchSetup,
          missingCellKeys: repairKeys,
        });
        try {
          const res = await transport.callAnalyst(
            [{ role: "user", content: prompt }],
            analystPrompt,
            tokenLimit,
            {
              ...(requestOptions || {}),
              liveSearch,
              includeMeta: true,
            }
          );
          if (analysisMeta && typeof analysisMeta === "object") {
            Object.assign(analysisMeta, mergeMeta(analysisMeta, res?.meta, "analyst"));
          }
          const parsed = extractJson(res?.text || res, {}, {
            phase: `${phase}_completeness_repair`,
            attempt: `round_${round}_chunk_${idx + 1}/${repairChunks.length}`,
            prompt,
            debugSession,
          });
          const repairedChunk = normalizeAnalystMatrix(parsed, repairSubjects, attributes);
          const merged = mergeMatrixRepairChunk(matrix, repairedChunk, missingSet);
          matrix = merged.matrix;
          merged.replacedKeys.forEach((key) => recoveredInRound.add(key));
        } catch (repairErr) {
          appendAnalysisDebugEvent(debugSession, {
            type: "matrix_completeness_repair_failed",
            phase: `${phase}_completeness_repair`,
            attempt: `round_${round}_chunk_${idx + 1}/${repairChunks.length}`,
            error: cleanText(repairErr?.message || "matrix_completeness_repair_failed"),
          });
        }
      }

      const remainingMissing = missingKeysRound.filter((key) => !recoveredInRound.has(key));
      matrix.normalization = refreshMatrixNormalizationAfterRepair(matrix, subjects, attributes, remainingMissing);
      repairedCellCount += recoveredInRound.size;
      repairRoundsUsed = round;
      appendAnalysisDebugEvent(debugSession, {
        type: "matrix_completeness_repair_round",
        phase,
        attempt: `round_${round}`,
        diagnostics: {
          missingBefore: missingKeysRound.length,
          repaired: recoveredInRound.size,
          missingAfter: remainingMissing.length,
        },
      });

      if (!remainingMissing.length || recoveredInRound.size === 0) break;
    }
  }

  matrix.chunking = {
    enabled: chunks.length > 1,
    chunkCount: chunks.length,
    chunkSize,
    expectedCells: subjects.length * attributes.length,
    rawCells: Number(matrix?.normalization?.rawCells || 0),
    mappedCells: Number(matrix?.normalization?.mappedCells || 0),
    placeholderCellsAdded: Number(matrix?.normalization?.placeholderCellsAdded || 0),
    repairRoundsUsed,
    repairedCellCount,
  };
  return matrix;
}

function buildLowConfidenceQueryPrompt({
  rawInput,
  decisionQuestion,
  subject,
  attribute,
  cell,
  researchSetup = {},
  counterfactualLimit = 2,
}) {
  const normalizedCounterfactualLimit = Math.max(1, Math.min(4, Number(counterfactualLimit) || 2));
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  return `Generate targeted search queries for one low-confidence matrix cell.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

Cell under review:
- Subject: ${subject.label}
- Attribute: ${attribute.label}
- Current confidence: ${normalizeConfidence(cell?.confidence)}
- Current reason: ${clip(cell?.confidenceReason, 180)}
- Current value: ${clip(cell?.value, 220)}

Task:
- Produce 3 to 4 specific search queries to close evidence gaps for this exact cell.
- Produce ${normalizedCounterfactualLimit} to ${Math.min(normalizedCounterfactualLimit + 1, 4)} counterfactual/disconfirming queries to challenge this cell.
- Focus on verifiable facts and current market evidence.

Return JSON only:
{
  "gap": "<single sentence gap>",
  "queries": ["<q1>", "<q2>", "<q3>", "<q4 optional>"],
  "counterfactualQueries": ["<counterfactual q1>", "<counterfactual q2>"]
}`;
}

function buildLowConfidenceSearchPrompt({ rawInput, decisionQuestion, subject, attribute, queryPlan, cell, researchSetup = {} }) {
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  return `Run focused live web research for one low-confidence matrix cell.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

Cell:
- Subject: ${subject.label}
- Attribute: ${attribute.label}
- Current value: ${clip(cell?.value, 220)}
- Gap: ${queryPlan?.gap || "Evidence is sparse."}

Queries:
${(queryPlan?.queries || []).map((query, idx) => `${idx + 1}. ${query}`).join("\n")}

Counterfactual queries:
${(queryPlan?.counterfactualQueries || []).length
  ? (queryPlan.counterfactualQueries || []).map((query, idx) => `${idx + 1}. ${query}`).join("\n")
  : "- none"}

Rules:
- Return only concrete findings with sources.
- Mark whether each query produced useful evidence.
- Label each finding as "supporting" or "counterfactual" based on query intent.

Return JSON only:
{
  "findings": [
    {
      "query": "<exact query>",
      "evidenceType": "<supporting|counterfactual>",
      "fact": "<single concrete fact>",
      "source": {"name":"...","quote":"<max 20 words>","url":"...","sourceType":"<vendor|press|independent>"}
    }
  ],
  "queryCoverage": [
    {"query":"<exact query>","useful":<true|false>,"note":"<short note>"}
  ]
}`;
}

function buildLowConfidenceRescorePrompt({ rawInput, decisionQuestion, subject, attribute, cell, queryPlan, harvest, researchSetup = {} }) {
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  return `Re-evaluate one matrix cell using targeted findings.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

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
- Explicitly weigh supporting vs counterfactual findings; counterfactual findings should influence limiting arguments.

Return JSON only:
{
  "value": "<updated finding>",
  "full": "<updated deep detail>",
  "risks": "<updated caveats>",
  "arguments": {
    "supporting": [{"id":"sup-1","claim":"<short claim>","detail":"<short detail>","sources":[{"name":"...","quote":"...","url":"..."}]}],
    "limiting": [{"id":"lim-1","claim":"<short claim>","detail":"<short detail>","sources":[{"name":"...","quote":"...","url":"..."}]}]
  },
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "sources": [{"name":"...","quote":"<max 20 words>","url":"...","sourceType":"<vendor|press|independent>"}]
}`;
}

function buildMatrixQueryStrategistPrompt({ rawInput, decisionQuestion, subjects, attributes, candidateCells = [], researchSetup = {} }) {
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  return `You are a retrieval strategist for a matrix research workflow.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

Subjects:
${subjects.map((subject) => `- ${subject.id}: ${subject.label}`).join("\n")}

Attributes:
${attributes.map((attribute) => `- ${attribute.id}: ${attribute.label}${attribute.brief ? ` (${attribute.brief})` : ""}`).join("\n")}

Low-confidence candidate cells:
${candidateCells.map((cell) => `- ${cell.subjectId} x ${cell.attributeId} (${normalizeConfidence(cell.confidence)})`).join("\n") || "- none"}

Task:
- Infer niche/domain and alias/rebrand/acquisition hints that improve retrieval recall.
- Provide supporting query seeds, counterfactual query seeds, and source targets for the low-confidence cells.
- Keep outputs concise and factual.

Return JSON only:
{
  "niche": "<short niche label>",
  "aliases": ["<alias or rebrand hint>"],
  "cellHints": [
    {
      "subjectId": "<subject id>",
      "attributeId": "<attribute id>",
      "querySeeds": ["<query seed>"],
      "counterfactualQueries": ["<disconfirming query seed>"],
      "sourceTargets": ["<source target>"]
    }
  ]
}`;
}

function normalizeMatrixStrategistHints(payload = {}, subjects = [], attributes = []) {
  const validSubjects = new Set(subjects.map((subject) => subject.id));
  const validAttributes = new Set(attributes.map((attribute) => attribute.id));
  const out = {};
  const rawHints = Array.isArray(payload?.cellHints) ? payload.cellHints : [];
  rawHints.forEach((entry) => {
    const subjectId = cleanText(entry?.subjectId);
    const attributeId = cleanText(entry?.attributeId);
    if (!validSubjects.has(subjectId) || !validAttributes.has(attributeId)) return;
    const key = buildCellKey(subjectId, attributeId);
    out[key] = {
      querySeeds: normalizeStringList(entry?.querySeeds, 4, 170),
      counterfactualQueries: normalizeStringList(entry?.counterfactualQueries, 4, 170),
      sourceTargets: normalizeStringList(entry?.sourceTargets, 4, 170),
    };
  });
  return {
    niche: cleanText(payload?.niche),
    aliases: normalizeStringList(payload?.aliases, 8, 120),
    cellHints: out,
  };
}

function matrixCellPressure(cell = {}) {
  const confidence = normalizeConfidence(cell.confidence);
  const sourceCount = normalizeSourceList(cell.sources).length;
  let score = 0;
  if (confidence === "low") score += 4;
  else if (confidence === "medium") score += 2;
  if (sourceCount === 0) score += 3;
  else if (sourceCount < 2) score += 2;
  else if (sourceCount < 4) score += 1;
  if (cleanText(cell?.confidenceReason).toLowerCase().includes("uncertain")) score += 1;
  return score;
}

function matrixAttributePlaybook(attribute = {}, subjectLabel = "") {
  const id = cleanText(attribute?.id).toLowerCase();
  const label = cleanText(attribute?.label || attribute?.id);
  const subject = cleanText(subjectLabel || "subject");

  if (id === "pricing-model") {
    return {
      gap: `Need verified pricing structure and commercial packaging evidence for ${subject}.`,
      querySeeds: [
        `${subject} pricing model annual contract PMPM per-facility`,
        `${subject} RFP pricing implementation fee contract term`,
        `${subject} procurement pricing benchmark hospital`,
      ],
      counterfactualQueries: [
        `${subject} no public pricing disclosed`,
        `${subject} hidden implementation costs complaints`,
      ],
      sourceTargets: ["RFP/procurement records", "buyer reviews", "contract summaries"],
    };
  }

  if (id === "pmf-signal") {
    return {
      gap: `Need hard PMF evidence for ${subject}: named deployments, outcomes, or independent validation.`,
      querySeeds: [
        `${subject} named hospital customer case study readmission outcomes`,
        `${subject} KLAS rating peer-reviewed validation`,
        `${subject} deployment outcomes readmission reduction`,
      ],
      counterfactualQueries: [
        `${subject} churn complaints failed implementation`,
        `${subject} no clinical validation evidence`,
      ],
      sourceTargets: ["named customer evidence", "independent analyst reports", "peer-reviewed studies"],
    };
  }

  if (id === "moat-assessment") {
    return {
      gap: `Need defensibility evidence for ${subject}: lock-in, switching cost, distribution control, and data advantage.`,
      querySeeds: [
        `${subject} switching costs integration depth EHR embedment`,
        `${subject} exclusive partnerships network effects data moat`,
        `${subject} contract renewal expansion evidence`,
      ],
      counterfactualQueries: [
        `${subject} easily replaceable alternatives`,
        `${subject} weak differentiation commoditized`,
      ],
      sourceTargets: ["integration docs", "customer migration case studies", "distribution partnership evidence"],
    };
  }

  if (id === "key-weaknesses") {
    return {
      gap: `Need evidence-backed failure modes for ${subject}, not inferred weaknesses.`,
      querySeeds: [
        `${subject} user complaints implementation issues`,
        `${subject} limitations review hospital deployment`,
        `${subject} failures workflow adoption problems`,
      ],
      counterfactualQueries: [
        `${subject} strengths that counter stated weakness`,
        `${subject} successful outcomes despite known limitations`,
      ],
      sourceTargets: ["G2/Capterra/KLAS feedback", "implementation retrospectives", "customer interviews"],
    };
  }

  return {
    gap: `Evidence remains weak for ${subject} x ${label}.`,
    querySeeds: [
      `${subject} ${label} evidence`,
      `${subject} ${label} customer outcome`,
    ],
    counterfactualQueries: [
      `${subject} ${label} criticism`,
      `${subject} alternatives outperforming ${label}`,
    ],
    sourceTargets: ["independent sources", "customer evidence"],
  };
}

function selectMatrixTargetedCells(cells = [], limits = {}, derivedAttributeIds = new Set()) {
  const candidates = cells
    .map((cell) => ({ ...cell, _pressure: matrixCellPressure(cell) }))
    .filter((cell) => {
      if (derivedAttributeIds?.has?.(cell.attributeId)) return false;
      const confidence = normalizeConfidence(cell.confidence);
      const sourceCount = normalizeSourceList(cell.sources).length;
      if (confidence === "low") return true;
      if (confidence === "medium" && sourceCount < 2) return true;
      return false;
    });
  const sortedCandidates = [...candidates]
    .sort((a, b) => b._pressure - a._pressure || normalizeSourceList(a.sources).length - normalizeSourceList(b.sources).length);

  const maxBudget = Number(limits?.matrixTargetedBudgetCells);
  let budgetCells = 0;
  let strategy = "adaptive";
  if (Number.isFinite(maxBudget)) {
    budgetCells = Math.max(1, Math.min(sortedCandidates.length || 1, Math.round(maxBudget)));
    strategy = "fixed";
  } else {
    const adaptiveRatioRaw = Number(limits?.matrixAdaptiveTargetedRatio);
    const adaptiveRatio = Number.isFinite(adaptiveRatioRaw)
      ? Math.min(1, Math.max(0.2, adaptiveRatioRaw))
      : 0.7;
    const adaptiveFloorRaw = Number(limits?.matrixAdaptiveTargetedFloor);
    const adaptiveFloor = Number.isFinite(adaptiveFloorRaw)
      ? Math.max(1, Math.round(adaptiveFloorRaw))
      : 12;
    const adaptiveCapRaw = Number(limits?.matrixAdaptiveTargetedMax);
    const adaptiveCapBase = Number.isFinite(adaptiveCapRaw)
      ? Math.max(1, Math.round(adaptiveCapRaw))
      : 36;
    const adaptiveCap = Math.max(adaptiveCapBase, Math.ceil(sortedCandidates.length * 0.8));
    const adaptiveByRatio = Math.ceil(sortedCandidates.length * adaptiveRatio);
    const adaptiveTarget = Math.min(
      sortedCandidates.length,
      Math.max(Math.min(adaptiveFloor, sortedCandidates.length), Math.min(adaptiveCap, adaptiveByRatio))
    );
    budgetCells = adaptiveTarget;
  }

  const selected = [];
  const selectedKeys = new Set();
  const pushSelected = (cell) => {
    if (!cell) return false;
    const key = buildCellKey(cell.subjectId, cell.attributeId);
    if (!key || selectedKeys.has(key) || selected.length >= budgetCells) return false;
    selected.push(cell);
    selectedKeys.add(key);
    return true;
  };

  const byAttribute = new Map();
  sortedCandidates.forEach((cell) => {
    const key = cleanText(cell.attributeId) || "__none__";
    if (!byAttribute.has(key)) byAttribute.set(key, []);
    byAttribute.get(key).push(cell);
  });
  const attributeKeys = [...byAttribute.keys()];

  attributeKeys.forEach((attrId) => {
    const zeroEvidenceCell = (byAttribute.get(attrId) || []).find((cell) => (
      normalizeSourceList(cell.sources).length === 0 || hasExplicitFailureReason(cell)
    ));
    pushSelected(zeroEvidenceCell);
  });

  attributeKeys.forEach((attrId) => {
    if (selected.length >= budgetCells) return;
    const alreadyCovered = selected.some((cell) => cleanText(cell.attributeId) === attrId);
    if (alreadyCovered) return;
    const topCandidate = (byAttribute.get(attrId) || [])[0];
    pushSelected(topCandidate);
  });

  const remaining = sortedCandidates.filter((cell) => !selectedKeys.has(buildCellKey(cell.subjectId, cell.attributeId)));
  const buckets = new Map();
  remaining.forEach((cell) => {
    const key = cleanText(cell.subjectId) || "__none__";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(cell);
  });
  const bucketKeys = [...buckets.keys()];
  let cursor = 0;
  while (selected.length < budgetCells && bucketKeys.length) {
    let picked = false;
    for (let i = 0; i < bucketKeys.length; i += 1) {
      const key = bucketKeys[(cursor + i) % bucketKeys.length];
      const queue = buckets.get(key) || [];
      const next = queue.shift();
      if (!next) continue;
      if (pushSelected(next)) {
        cursor = (cursor + i + 1) % bucketKeys.length;
        picked = true;
        break;
      }
    }
    if (!picked) break;
  }

  return {
    selected,
    allCount: sortedCandidates.length,
    budgetCells,
    droppedByBudget: Math.max(0, sortedCandidates.length - selected.length),
    strategy,
  };
}

function selectDeepAssistRecoveryCells(cells = [], limits = {}, derivedAttributeIds = new Set(), analysisMeta = {}) {
  const candidates = (Array.isArray(cells) ? cells : [])
    .filter((cell) => !derivedAttributeIds?.has?.(cell.attributeId))
    .map((cell) => {
      const confidence = normalizeConfidence(cell?.confidence);
      const sourceCount = normalizeSourceList(cell?.sources).length;
      const providerAgreement = cleanText(cell?.providerAgreement).toLowerCase();
      const reasons = [];
      let pressure = matrixCellPressure(cell);
      if (providerAgreement === "contradict") {
        reasons.push("provider_contradict");
        pressure += 5;
      }
      if (confidence === "low") {
        reasons.push("confidence_low");
        pressure += 4;
      }
      if (sourceCount < 2) {
        reasons.push("source_sparse");
        pressure += sourceCount === 0 ? 3 : 2;
      }
      if (
        Number(analysisMeta?.deepAssistProvidersFailed || 0) > 0
        && confidence !== "high"
        && !reasons.includes("provider_failure_signal")
      ) {
        reasons.push("provider_failure_signal");
        pressure += 1;
      }
      return {
        ...cell,
        _pressure: pressure,
        _reasons: reasons,
      };
    })
    .filter((cell) => Array.isArray(cell._reasons) && cell._reasons.length > 0)
    .sort((a, b) => b._pressure - a._pressure || normalizeSourceList(a.sources).length - normalizeSourceList(b.sources).length);

  const budgetRaw = Number(limits?.deepAssistRecoveryBudgetCells ?? limits?.matrixTargetedBudgetCells);
  let budgetCells = 0;
  if (Number.isFinite(budgetRaw)) {
    budgetCells = Math.max(1, Math.min(candidates.length || 1, Math.round(budgetRaw)));
  } else {
    const ratioRaw = Number(limits?.deepAssistRecoveryRatio ?? limits?.matrixAdaptiveTargetedRatio);
    const ratio = Number.isFinite(ratioRaw) ? Math.min(1, Math.max(0.2, ratioRaw)) : 0.6;
    const floorRaw = Number(limits?.deepAssistRecoveryFloor ?? limits?.matrixAdaptiveTargetedFloor);
    const floor = Number.isFinite(floorRaw) ? Math.max(1, Math.round(floorRaw)) : 8;
    const capRaw = Number(limits?.deepAssistRecoveryMax ?? limits?.matrixAdaptiveTargetedMax);
    const capBase = Number.isFinite(capRaw) ? Math.max(1, Math.round(capRaw)) : 36;
    const cap = Math.max(capBase, Math.ceil(candidates.length * 0.8));
    budgetCells = Math.min(
      candidates.length,
      Math.max(Math.min(floor, candidates.length), Math.min(cap, Math.ceil(candidates.length * ratio)))
    );
  }

  const selected = [];
  const selectedKeys = new Set();
  const pushSelected = (cell) => {
    if (!cell) return false;
    const key = buildCellKey(cell.subjectId, cell.attributeId);
    if (!key || selectedKeys.has(key) || selected.length >= budgetCells) return false;
    selected.push(cell);
    selectedKeys.add(key);
    return true;
  };

  const byAttribute = new Map();
  candidates.forEach((cell) => {
    const key = cleanText(cell.attributeId) || "__none__";
    if (!byAttribute.has(key)) byAttribute.set(key, []);
    byAttribute.get(key).push(cell);
  });
  [...byAttribute.keys()].forEach((attrId) => {
    const first = (byAttribute.get(attrId) || [])[0];
    pushSelected(first);
  });
  candidates.forEach((cell) => {
    pushSelected(cell);
  });
  return {
    selected,
    allCount: candidates.length,
    budgetCells,
    droppedByBudget: Math.max(0, candidates.length - selected.length),
    diagnostics: candidates.map((cell) => ({
      cellKey: buildCellKey(cell.subjectId, cell.attributeId),
      subjectId: cell.subjectId,
      attributeId: cell.attributeId,
      pressure: Number(cell._pressure || 0),
      reasons: cell._reasons || [],
      sourceCount: normalizeSourceList(cell.sources).length,
      confidence: normalizeConfidence(cell.confidence),
      providerAgreement: cleanText(cell.providerAgreement).toLowerCase(),
    })),
  };
}

function buildMatrixCriticPrompt({ rawInput, decisionQuestion, subjects, attributes, matrix, researchSetup = {} }) {
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  return `Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

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

function buildMatrixAnalystResponsePrompt({ rawInput, decisionQuestion, subjects, attributes, cells, flags, researchSetup = {} }) {
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

  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

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
      "full": "<updated deep detail>",
      "risks": "<updated caveats>",
      "arguments": {
        "supporting": [{"id":"sup-1","claim":"<short claim>","detail":"<short detail>","sources":[{"name":"...","quote":"...","url":"..."}]}],
        "limiting": [{"id":"lim-1","claim":"<short claim>","detail":"<short detail>","sources":[{"name":"...","quote":"...","url":"..."}]}]
      },
      "confidence": "<high|medium|low>",
      "confidenceReason": "<1 sentence>",
      "analystNote": "<why this decision was made>",
      "sources": [{"name":"...","quote":"<max 20 words>","url":"...","sourceType":"<vendor|press|independent>"}]
    }
  ]
}`;
}

function buildMatrixDerivedAttributesPrompt({
  rawInput,
  decisionQuestion,
  subjects,
  baseAttributes,
  derivedAttributes,
  matrix,
  researchSetup = {},
}) {
  const compactCells = Array.isArray(matrix?.cells)
    ? matrix.cells
      .filter((cell) => baseAttributes.some((attribute) => attribute.id === cell.attributeId))
      .map((cell) => ({
        subjectId: cleanText(cell.subjectId),
        attributeId: cleanText(cell.attributeId),
        value: clip(cell.value, 220),
        confidence: normalizeConfidence(cell.confidence),
        confidenceReason: clip(cell.confidenceReason, 160),
        sources: normalizeSourceList(cell.sources).slice(0, 4),
      }))
    : [];

  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Generate derived matrix attributes only after evidence and critic phases.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

Subjects:
${subjects.map((subject) => `- ${subject.id}: ${subject.label}`).join("\n")}

Base attributes already analyzed:
${baseAttributes.map((attribute) => `- ${attribute.id}: ${attribute.label}`).join("\n")}

Derived attributes to compute:
${derivedAttributes.map((attribute) => `- ${attribute.id}: ${attribute.label}${attribute.brief ? ` (${attribute.brief})` : ""}`).join("\n")}

Available base evidence snapshot:
${JSON.stringify(compactCells, null, 2)}

Rules:
- Use only existing base evidence plus explicit uncertainty.
- Do not invent sources.
- Keep derived findings concise and decision-oriented.

Return JSON only:
{
  "cells": [
    {
      "subjectId": "<subject id>",
      "attributeId": "<derived attribute id>",
      "value": "<2-4 sentence derived finding>",
      "full": "<1-2 short paragraphs>",
      "risks": "<1-2 sentence caveats>",
      "arguments": {
        "supporting": [{"id":"sup-1","claim":"<short claim>","detail":"<short detail>","sources":[{"name":"...","quote":"...","url":"..."}]}],
        "limiting": [{"id":"lim-1","claim":"<short claim>","detail":"<short detail>","sources":[{"name":"...","quote":"...","url":"..."}]}]
      },
      "confidence": "<high|medium|low>",
      "confidenceReason": "<short reason>",
      "sources": [{"name":"...","quote":"<max 20 words>","url":"...","sourceType":"<vendor|press|independent>"}]
    }
  ]
}`;
}

function normalizeDerivedCells(payload = {}, subjects = [], derivedAttributes = []) {
  const subjectMap = new Set(subjects.map((subject) => subject.id));
  const attrMap = new Set(derivedAttributes.map((attribute) => attribute.id));
  const rows = Array.isArray(payload?.cells) ? payload.cells : [];
  return rows
    .map((entry) => {
      const subjectId = cleanText(entry?.subjectId);
      const attributeId = cleanText(entry?.attributeId);
      if (!subjectMap.has(subjectId) || !attrMap.has(attributeId)) return null;
      return {
        subjectId,
        attributeId,
        value: cleanText(entry?.value),
        full: cleanText(entry?.full || entry?.value),
        risks: cleanText(entry?.risks),
        arguments: normalizeMatrixCellArguments(entry?.arguments || {}),
        confidence: normalizeConfidence(entry?.confidence),
        confidenceReason: cleanText(entry?.confidenceReason),
        sources: normalizeSourceList(entry?.sources),
      };
    })
    .filter(Boolean);
}

function buildMatrixDiscoveryPrompt({ rawInput, decisionQuestion, subjects, attributes, researchSetup = {} }) {
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  return `Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

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

function resolveDeepAssistProviderRequestOptions(config = {}, providerId = "", role = "analyst", deepAssistOptions = {}) {
  const key = cleanText(providerId).toLowerCase();
  const roleCfg = config?.models?.[role] || {};
  const providerCfgRoot = config?.deepAssist?.providers?.[key] || {};
  const providerCfg = providerCfgRoot?.[role] && typeof providerCfgRoot?.[role] === "object"
    ? providerCfgRoot[role]
    : providerCfgRoot;

  return {
    provider: cleanText(providerCfg?.provider || roleCfg?.provider || "openai"),
    model: cleanText(providerCfg?.model || roleCfg?.model),
    webSearchModel: cleanText(providerCfg?.webSearchModel || providerCfg?.model || roleCfg?.webSearchModel || roleCfg?.model),
    baseUrl: cleanText(providerCfg?.baseUrl || roleCfg?.baseUrl),
    timeoutMs: Math.max(20000, Number(deepAssistOptions?.maxWaitMs) || 300000),
    retry: {
      maxRetries: Math.max(0, Math.min(3, Number(deepAssistOptions?.maxRetries) || 1)),
    },
  };
}

function matrixProviderAgreement(entries = []) {
  if (!entries.length) return "none";
  if (entries.length === 1) return "single";
  const confidences = entries.map((entry) => normalizeConfidence(entry?.confidence));
  const ranks = confidences.map((value) => confidenceRank(value));
  const confSpread = Math.max(...ranks) - Math.min(...ranks);
  const values = entries.map((entry) => cleanText(entry?.value)).filter(Boolean);
  let overlapScore = 1;
  if (values.length >= 2) {
    let maxPair = 0;
    let minPair = 1;
    for (let i = 0; i < values.length; i += 1) {
      for (let j = i + 1; j < values.length; j += 1) {
        const score = tokenOverlapScore(values[i], values[j]);
        maxPair = Math.max(maxPair, score);
        minPair = Math.min(minPair, score);
      }
    }
    overlapScore = values.length > 1 ? ((maxPair + minPair) / 2) : 1;
  }

  if (confSpread <= 1 && overlapScore >= 0.42) return "agree";
  if (overlapScore >= 0.22) return "partial";
  return "contradict";
}

function pickBestMatrixProviderCell(entries = []) {
  if (!entries.length) return null;
  let best = entries[0];
  let bestRank = confidenceRank(best?.confidence);
  let bestSources = normalizeSourceList(best?.sources).length;
  for (let i = 1; i < entries.length; i += 1) {
    const candidate = entries[i];
    const rank = confidenceRank(candidate?.confidence);
    const sourceCount = normalizeSourceList(candidate?.sources).length;
    if (rank > bestRank || (rank === bestRank && sourceCount > bestSources)) {
      best = candidate;
      bestRank = rank;
      bestSources = sourceCount;
    }
  }
  return best;
}

function mergeDeepAssistMatrix(baseMatrix = {}, providerMatrices = []) {
  const merged = {
    ...baseMatrix,
    cells: Array.isArray(baseMatrix?.cells) ? [...baseMatrix.cells] : [],
  };

  merged.cells = merged.cells.map((cell) => {
    const entries = providerMatrices
      .filter((run) => run.status === "ok")
      .map((run) => {
        const found = (run.matrix?.cells || []).find((item) => (
          buildCellKey(item.subjectId, item.attributeId) === buildCellKey(cell.subjectId, cell.attributeId)
        ));
        if (!found) return null;
        return {
          providerId: run.providerId,
          providerLabel: run.label,
          ...found,
        };
      })
      .filter(Boolean);

    if (!entries.length) return cell;
    const agreement = matrixProviderAgreement(entries);
    const best = pickBestMatrixProviderCell(entries) || entries[0];
    const mergedSources = mergeSources(cell.sources, ...entries.map((entry) => entry.sources));
    let confidence = normalizeConfidence(best.confidence || cell.confidence);
    if (agreement === "contradict" && confidenceRank(confidence) > confidenceRank("medium")) {
      confidence = "medium";
    }

    return {
      ...cell,
      value: cleanText(best.value || cell.value),
      full: cleanText(best.full || best.value || cell.full || cell.value),
      risks: cleanText(best.risks || cell.risks),
      arguments: normalizeMatrixCellArguments(best.arguments || cell.arguments || {}),
      confidence,
      confidenceReason: [
        cleanText(best.confidenceReason || cell.confidenceReason),
        agreement === "agree" ? "Deep Assist providers aligned on this cell." : "",
        agreement === "partial" ? "Deep Assist providers partially aligned; confidence kept conservative." : "",
        agreement === "contradict" ? "Deep Assist providers contradicted each other; confidence capped pending targeted validation." : "",
      ].filter(Boolean).join(" ").trim(),
      sources: mergedSources,
      providerAgreement: agreement,
      providerSignals: entries.map((entry) => ({
        provider: entry.providerId,
        providerLabel: entry.providerLabel,
        confidence: normalizeConfidence(entry.confidence),
        confidenceReason: cleanText(entry.confidenceReason),
        sourceCount: normalizeSourceList(entry.sources).length,
        brief: cleanText(entry.value),
      })),
    };
  });

  return merged;
}

async function runMatrixDeepAssistEnrichment({
  state,
  config,
  transport,
  debugSession,
  analysisMeta,
  strictQuality = true,
  rawInput,
  decisionQuestion,
  subjects,
  attributes,
  baseMatrix,
  analystPrompt,
  tokenLimits,
  researchSetup = {},
}) {
  const deepAssist = normalizeDeepAssistOptions(state?.options?.deepAssist || {});
  const stepTimeoutMs = Math.max(40000, Number(deepAssist?.maxWaitMs || 300000) + 15000);
  const deepAssistEvidenceTokens = Number(tokenLimits?.phase1EvidenceWeb) || Number(tokenLimits?.phase1Evidence) || 10000;
  const providerRuns = await Promise.all(
    deepAssist.providers.map(async (providerId) => {
      const label = deepAssistProviderLabel(providerId);
      const startedAt = Date.now();
      try {
        const prompt = buildMatrixEvidencePrompt({
          rawInput,
          decisionQuestion,
          subjects,
          attributes,
          passLabel: `${label} deep assist matrix pass`,
          liveSearch: true,
          researchSetup,
        });
        const response = await withStepTimeout(
          `${label} deep assist matrix provider step`,
          stepTimeoutMs,
          () => transport.callAnalyst(
            [{ role: "user", content: prompt }],
            analystPrompt,
            deepAssistEvidenceTokens,
            {
              ...resolveDeepAssistProviderRequestOptions(config, providerId, "analyst", deepAssist),
              liveSearch: true,
              includeMeta: true,
            }
          )
        );
        const responseMeta = response?.meta && typeof response.meta === "object" ? response.meta : null;
        const parsed = extractJson(response?.text || response, {}, {
          phase: "matrix_deep_assist",
          attempt: providerId,
          prompt,
          debugSession,
        });
        const matrix = normalizeAnalystMatrix(parsed, subjects, attributes);
        const missingCells = Number(matrix?.normalization?.placeholderCellsAdded || 0);
        if (missingCells > 0) {
          throw new Error(`${label} deep assist output missed ${missingCells} matrix cells after normalization.`);
        }
        const durationMs = Math.max(0, Date.now() - startedAt);
        const webSearchCalls = Number(responseMeta?.webSearchCalls || 0);
        appendAnalysisDebugEvent(debugSession, {
          type: "deep_assist_provider_complete",
          phase: "matrix_deep_assist",
          attempt: providerId,
          durationMs,
          webSearchCalls,
        });
        return {
          providerId,
          label,
          status: "ok",
          durationMs,
          webSearchCalls,
          matrix,
          meta: responseMeta,
        };
      } catch (err) {
        const failure = classifyDeepAssistGuardrailFailure(err);
        trackSafetyGuardrail(analysisMeta, failure, providerId);
        appendAnalysisDebugEvent(debugSession, {
          type: "deep_assist_provider_failed",
          phase: "matrix_deep_assist",
          attempt: providerId,
          reasonCode: failure.code,
          error: err?.message || String(err),
        });
        return {
          providerId,
          label,
          status: "failed",
          durationMs: Math.max(0, Date.now() - startedAt),
          webSearchCalls: 0,
          error: err?.message || String(err),
          failureCode: failure.code,
          matrix: null,
          meta: null,
        };
      }
    })
  );

  providerRuns.forEach((run) => {
    if (!run?.meta) return;
    Object.assign(analysisMeta, mergeMeta(analysisMeta, run.meta, "analyst"));
  });

  analysisMeta.deepAssistProviderRuns = providerRuns.map((run) => ({
    providerId: run.providerId,
    label: run.label,
    status: run.status,
    durationMs: run.durationMs,
    webSearchCalls: run.webSearchCalls,
    error: run.error || "",
  }));
  analysisMeta.deepAssistProvidersRequested = deepAssist.providers.length;
  analysisMeta.deepAssistProvidersSucceeded = providerRuns.filter((run) => run.status === "ok").length;
  analysisMeta.deepAssistProvidersFailed = providerRuns.filter((run) => run.status !== "ok").length;
  analysisMeta.providerContributions = analysisMeta.providerContributions || {};
  analysisMeta.providerContributions.deepAssist = providerRuns.map((run) => ({
    providerId: run.providerId,
    label: run.label,
    status: run.status,
    webSearchCalls: run.webSearchCalls,
  }));

  const failedRuns = providerRuns.filter((run) => run.status !== "ok");
  if (failedRuns.length > 0) {
    markDegraded(
      analysisMeta,
      "deep_assist_provider_partial_failure",
      `${failedRuns.length}/${providerRuns.length} Deep Assist provider passes failed.`
    );
    const failureCounts = failedRuns.reduce((acc, run) => {
      const key = cleanText(run.failureCode) || "deep_assist_provider_failed";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    Object.entries(failureCounts).forEach(([code, count]) => {
      if (!count) return;
      markDegraded(
        analysisMeta,
        code,
        `${count} Deep Assist provider failure(s) matched ${code}.`
      );
    });
    failIfStrictQuality(
      strictQuality,
      `Matrix Deep Assist provider failures detected (${failedRuns.length}/${providerRuns.length}). Aborting run.`,
      "STRICT_MATRIX_DEEP_ASSIST_PROVIDER_PARTIAL_FAILURE"
    );
    const err = new Error(`Matrix Deep Assist provider failures detected (${failedRuns.length}/${providerRuns.length}).`);
    err.code = "MATRIX_DEEP_ASSIST_PROVIDER_PARTIAL_FAILURE";
    err.retryable = false;
    throw err;
  }

  const successful = providerRuns.filter((run) => run.status === "ok" && run.matrix);
  if (!successful.length) {
    markDegraded(
      analysisMeta,
      "deep_assist_no_provider_success",
      "All Deep Assist providers failed in matrix enrichment."
    );
    failIfStrictQuality(
      strictQuality,
      "Matrix Deep Assist failed: no provider succeeded.",
      "STRICT_MATRIX_DEEP_ASSIST_NO_PROVIDER_SUCCESS"
    );
    const err = new Error("Matrix Deep Assist failed: no provider succeeded.");
    err.code = "MATRIX_DEEP_ASSIST_NO_PROVIDER_SUCCESS";
    err.retryable = false;
    throw err;
  }
  if (successful.length < deepAssist.minProviders) {
    markDegraded(
      analysisMeta,
      "deep_assist_min_provider_not_met",
      `Matrix deep assist succeeded with ${successful.length}/${deepAssist.minProviders} required providers.`
    );
    failIfStrictQuality(
      strictQuality,
      `Matrix Deep Assist minimum providers not met (${successful.length}/${deepAssist.minProviders}).`,
      "STRICT_MATRIX_DEEP_ASSIST_MIN_PROVIDER_NOT_MET"
    );
    const err = new Error(`Matrix Deep Assist minimum providers not met (${successful.length}/${deepAssist.minProviders}).`);
    err.code = "MATRIX_DEEP_ASSIST_MIN_PROVIDER_NOT_MET";
    err.retryable = false;
    throw err;
  }

  const merged = mergeDeepAssistMatrix(baseMatrix, providerRuns);
  return merged;
}

function buildMatrixConsistencyPrompt({ decisionQuestion, subjects, attributes, matrix }) {
  return `You are auditing cross-subject consistency for a completed research matrix.

Decision question:
${decisionQuestion}

Subjects:
${subjects.map((subject) => `- ${subject.label}`).join("\n")}

Attributes:
${attributes.map((attribute) => `- ${attribute.label}`).join("\n")}

Matrix:
${JSON.stringify(matrix, null, 2)}

Task:
- Compare subjects within each attribute and detect contradictions.
- Flag cells that appear internally inconsistent with stronger evidence elsewhere in the same attribute.
- Suggest confidence downgrades where contradiction risk exists.

Return JSON only:
{
  "flags": [
    {
      "subjectId":"<subject id>",
      "attributeId":"<attribute id>",
      "note":"<contradiction explanation>",
      "suggestedConfidence":"<high|medium|low>"
    }
  ],
  "summary":"<short contradiction summary>"
}`;
}

function normalizeConsistencyFlags(raw = {}, subjects = [], attributes = []) {
  const subjectMap = new Map(subjects.map((subject) => [subject.id, subject]));
  const attributeMap = new Map(attributes.map((attribute) => [attribute.id, attribute]));
  const flags = Array.isArray(raw?.flags) ? raw.flags : [];
  return flags
    .map((entry) => ({
      subjectId: cleanText(entry?.subjectId),
      attributeId: cleanText(entry?.attributeId),
      note: cleanText(entry?.note),
      suggestedConfidence: normalizeConfidence(entry?.suggestedConfidence || entry?.confidence),
    }))
    .filter((entry) => subjectMap.has(entry.subjectId) && attributeMap.has(entry.attributeId));
}

function applyConsistencyFlags(cells = [], flags = []) {
  const byKey = new Map(flags.map((flag) => [buildCellKey(flag.subjectId, flag.attributeId), flag]));
  return (cells || []).map((cell) => {
    const flag = byKey.get(buildCellKey(cell.subjectId, cell.attributeId));
    if (!flag) return cell;
    const suggested = normalizeConfidence(flag.suggestedConfidence || cell.confidence);
    const downgraded = confidenceFromRank(
      Math.min(confidenceRank(cell.confidence), confidenceRank(suggested)),
      cell.confidence
    );
    return {
      ...cell,
      confidence: downgraded,
      confidenceReason: [cleanText(cell.confidenceReason), `Consistency audit: ${cleanText(flag.note)}`]
        .filter(Boolean)
        .join(" ")
        .trim(),
      analystNote: [cleanText(cell.analystNote), `Consistency: ${cleanText(flag.note)}`]
        .filter(Boolean)
        .join(" ")
        .trim(),
    };
  });
}

function buildMatrixExecutiveSynthesisPrompt({ rawInput, decisionQuestion, matrix, researchSetup = {} }) {
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  return `You are writing an executive synthesis for a completed evidence-first comparison matrix.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

Matrix:
${JSON.stringify(matrix, null, 2)}

Return JSON only:
{
  "decisionAnswer":"<direct answer to the decision question>",
  "closestThreats":"<closest threats and why>",
  "whitespace":"<main whitespace/opportunity>",
  "strategicClassification":"<classification of this concept>",
  "keyRisks":"<top viability risks>",
  "decisionImplications":"<what to do next>",
  "uncertaintyNotes":"<major evidence gaps/uncertainties>",
  "providerAgreementHighlights":"<where providers agreed/disagreed if available>"
}`;
}

function buildMatrixSynthesizerPrompt({ rawInput, decisionQuestion, matrix, analysisMeta = {}, researchSetup = {} }) {
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const compactCells = cells.map((cell) => ({
    subjectId: cell.subjectId,
    attributeId: cell.attributeId,
    confidence: normalizeConfidence(cell.confidence),
    confidenceReason: cleanText(cell.confidenceReason),
    value: cleanText(cell.value),
    risks: cleanText(cell.risks),
    providerAgreement: cleanText(cell.providerAgreement),
    limiting: Array.isArray(cell?.arguments?.limiting)
      ? cell.arguments.limiting.map((entry) => cleanText(entry?.claim || entry?.detail)).filter(Boolean).slice(0, 2)
      : [],
  }));

  return `You are an independent synthesizer for a completed strategic comparison matrix.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

Structured matrix signals (no raw source prose):
${JSON.stringify({
    coverage: matrix?.coverage || null,
    providerSignals: analysisMeta?.providerContributions || {},
    redTeam: matrix?.redTeam || {},
    crossMatrixSummary: cleanText(matrix?.crossMatrixSummary),
    cells: compactCells,
  }, null, 2)}

Task:
- Produce neutral decision synthesis from structured signals only.
- Do not repeat analyst wording.
- Include strongest dissent and key uncertainty.

Return JSON only:
{
  "decisionAnswer":"<direct answer to the decision question>",
  "closestThreats":"<closest threats and why>",
  "whitespace":"<main whitespace/opportunity>",
  "strategicClassification":"<classification of this concept>",
  "keyRisks":"<top viability risks>",
  "decisionImplications":"<what to do next>",
  "uncertaintyNotes":"<major evidence gaps/uncertainties>",
  "providerAgreementHighlights":"<where providers agreed/disagreed if available>"
}`;
}

function buildMatrixRedTeamPrompt({ rawInput, decisionQuestion, matrix, maxCells = 24, researchSetup = {} }) {
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const providerAgreementPriority = (cell) => {
    const agreement = cleanText(cell?.providerAgreement).toLowerCase();
    if (agreement === "contradict") return 0;
    if (agreement === "mixed") return 1;
    if (agreement === "support") return 2;
    if (agreement === "none") return 3;
    return 4;
  };
  const stableCellKey = (cell) => [
    cleanText(cell?.subjectId).toLowerCase(),
    cleanText(cell?.attributeId).toLowerCase(),
    cleanText(cell?.value).toLowerCase(),
  ].join("::");
  const prioritized = [...cells]
    .sort((a, b) => {
      const confidenceDelta = confidenceRank(normalizeConfidence(a?.confidence)) - confidenceRank(normalizeConfidence(b?.confidence));
      if (confidenceDelta !== 0) return confidenceDelta;
      const agreementDelta = providerAgreementPriority(a) - providerAgreementPriority(b);
      if (agreementDelta !== 0) return agreementDelta;
      return stableCellKey(a).localeCompare(stableCellKey(b));
    })
    .slice(0, Math.max(1, maxCells))
    .map((cell) => ({
      subjectId: cell.subjectId,
      attributeId: cell.attributeId,
      value: cleanText(cell.value),
      confidence: normalizeConfidence(cell.confidence),
      risks: cleanText(cell.risks),
      providerAgreement: cleanText(cell.providerAgreement),
    }));

  return `You are the Red Team for a completed comparison matrix.

Research brief:
${rawInput}

Decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

Structured matrix state (bounded set):
${JSON.stringify({
    executiveSummary: matrix?.executiveSummary || null,
    crossMatrixSummary: cleanText(matrix?.crossMatrixSummary),
    cells: prioritized,
  }, null, 2)}

Task:
- Construct strongest credible counter-cases.
- Identify assumptions that could be catastrophically wrong.
- Focus on structural threats and missed risks.
- Do NOT change confidence or cell values; add risk context only.

Return JSON only:
{
  "redTeamVerdict": "<1-2 sentence overall counter-case>",
  "cells": [
    {
      "subjectId":"<subject id>",
      "attributeId":"<attribute id>",
      "threat":"<strongest counter-argument>",
      "missedRisk":"<risk not explicit in current cell>",
      "severityIfWrong":"<high|medium|low>"
    }
  ]
}`;
}

function applyMatrixRedTeam(matrix = {}, raw = {}, subjects = [], attributes = []) {
  const subjectSet = new Set((Array.isArray(subjects) ? subjects : []).map((item) => item.id));
  const attributeSet = new Set((Array.isArray(attributes) ? attributes : []).map((item) => item.id));
  const entries = Array.isArray(raw?.cells) ? raw.cells : [];
  const redTeamByKey = new Map();
  let highSeverityCount = 0;

  entries.forEach((entry) => {
    const subjectId = cleanText(entry?.subjectId);
    const attributeId = cleanText(entry?.attributeId);
    if (!subjectSet.has(subjectId) || !attributeSet.has(attributeId)) return;
    const threat = cleanText(entry?.threat);
    const missedRisk = cleanText(entry?.missedRisk);
    if (!threat && !missedRisk) return;
    const severityRaw = cleanText(entry?.severityIfWrong).toLowerCase();
    const severityIfWrong = severityRaw === "high" || severityRaw === "medium" || severityRaw === "low"
      ? severityRaw
      : "medium";
    if (severityIfWrong === "high") highSeverityCount += 1;
    redTeamByKey.set(buildCellKey(subjectId, attributeId), {
      threat,
      missedRisk,
      severityIfWrong,
    });
  });

  const output = {
    ...(matrix || {}),
    redTeam: {
      redTeamVerdict: cleanText(raw?.redTeamVerdict),
      cells: Object.fromEntries([...redTeamByKey.entries()]),
    },
    cells: (Array.isArray(matrix?.cells) ? matrix.cells : []).map((cell) => {
      const key = buildCellKey(cell.subjectId, cell.attributeId);
      const red = redTeamByKey.get(key);
      if (!red) return cell;
      const addition = [cleanText(red?.threat), cleanText(red?.missedRisk)].filter(Boolean).join(" ");
      const nextRisks = [cleanText(cell?.risks), `Red Team (${red.severityIfWrong}): ${addition}`]
        .filter(Boolean)
        .join(" ")
        .trim();
      return {
        ...cell,
        redTeam: red,
        risks: nextRisks,
      };
    }),
  };

  return { matrix: output, highSeverityCount };
}

function buildSubjectDiscoveryPrompt({ rawInput, decisionQuestion, subjectsSpec, researchSetup = {} }) {
  const minCount = Math.max(2, Number(subjectsSpec?.minCount) || 2);
  const maxCount = Math.max(minCount, Number(subjectsSpec?.maxCount) || 8);
  const examples = Array.isArray(subjectsSpec?.examples) ? subjectsSpec.examples : [];
  const exampleBlock = examples.length
    ? `Examples:\n${examples.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}`
    : "";

  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Research brief:
${rawInput}

Initial decision question:
${decisionQuestion || rawInput}

Run context:
${setupContext}

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

function mergeSubjectEntries(primary = [], secondary = [], subjectsSpec = {}, options = {}) {
  const minCount = Math.max(2, Number(subjectsSpec?.minCount) || 2);
  const maxOverrideRaw = Number(options?.maxCountOverride);
  const maxCount = Math.max(
    minCount,
    Number.isFinite(maxOverrideRaw) && maxOverrideRaw >= minCount
      ? Math.round(maxOverrideRaw)
      : (Number(subjectsSpec?.maxCount) || 8)
  );
  const seen = new Set();
  const out = [];

  const consume = (items = []) => {
    items.forEach((entry) => {
      const label = cleanText(entry?.label || entry);
      if (!label) return;
      const key = normalizeSubjectMatchKey(label);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id: toId(label, `subject-${out.length + 1}`), label });
    });
  };

  consume(Array.isArray(options?.required) ? options.required : []);
  consume(primary);
  consume(secondary);
  return out.slice(0, maxCount);
}

function labelsLikelyDuplicate(a = "", b = "") {
  const labelA = cleanText(a).toLowerCase();
  const labelB = cleanText(b).toLowerCase();
  if (!labelA || !labelB) return false;
  if (normalizeSubjectMatchKey(labelA) === normalizeSubjectMatchKey(labelB)) return true;
  const overlap = tokenOverlapScore(labelA, labelB);
  if (overlap >= 0.72) return true;
  if (labelA.includes(labelB) || labelB.includes(labelA)) return true;
  return false;
}

function dedupeSubjectEntries(entries = []) {
  const out = [];
  const mergedAliases = [];
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const label = cleanText(entry?.label || entry);
    if (!label) return;
    const existingIdx = out.findIndex((candidate) => labelsLikelyDuplicate(candidate.label, label));
    if (existingIdx < 0) {
      out.push({
        id: cleanText(entry?.id) || toId(label, `subject-${out.length + 1}`),
        label,
      });
      return;
    }

    const existing = out[existingIdx];
    const existingTokenCount = tokenSet(existing.label).size;
    const incomingTokenCount = tokenSet(label).size;
    const shouldReplaceLabel = incomingTokenCount > existingTokenCount;
    if (shouldReplaceLabel) {
      out[existingIdx] = {
        ...existing,
        label,
      };
    }
    mergedAliases.push({
      from: label,
      into: out[existingIdx].label,
    });
  });
  return { subjects: out, mergedAliases };
}

function containsMatchingSubjectLabel(label = "", entries = []) {
  const needle = cleanText(label);
  if (!needle) return false;
  return (Array.isArray(entries) ? entries : []).some((entry) => {
    const candidate = cleanText(entry?.label || entry);
    if (!candidate) return false;
    return labelsLikelyDuplicate(needle, candidate);
  });
}

export async function resolveMatrixResearchInput(input, config, callbacks = {}, options = {}) {
  const desc = cleanText(input?.description || input?.rawInput);
  if (!desc) throw new Error("Matrix input description is required.");
  const researchSetup = normalizeResearchSetupContext(input?.options?.researchSetup || {});

  const subjectsSpec = config?.subjects || {};
  const minCount = Math.max(2, Number(subjectsSpec?.minCount) || 2);
  const specMaxCount = Math.max(minCount, Number(subjectsSpec?.maxCount) || 8);
  const explicitSubjects = normalizeSubjectList(input?.options?.matrixSubjects, subjectsSpec, { strict: false });
  const requiredFromPrompt = normalizeSubjectList(
    extractRequiredSubjectsFromUnifiedPrompt(desc),
    subjectsSpec,
    { strict: false, preserveAll: true }
  );
  const requiredMerged = mergeSubjectEntries(
    explicitSubjects,
    requiredFromPrompt,
    subjectsSpec,
    {
      required: [...explicitSubjects, ...requiredFromPrompt],
      maxCountOverride: Math.max(specMaxCount, explicitSubjects.length, requiredFromPrompt.length),
    }
  );
  const requiredCanonicalized = dedupeSubjectEntries(requiredMerged);
  const requiredSubjects = requiredCanonicalized.subjects;
  const runMaxCount = Math.max(specMaxCount, requiredSubjects.length);
  const extractedLabels = extractSubjectsFromUnifiedPrompt(desc);
  const extractedSubjects = normalizeSubjectList(
    extractedLabels,
    subjectsSpec,
    { strict: false, maxCountOverride: runMaxCount }
  );
  const mergedLocalRaw = mergeSubjectEntries(explicitSubjects, extractedSubjects, subjectsSpec, {
    required: requiredSubjects,
    maxCountOverride: runMaxCount,
  });
  const mergedLocalCanonicalized = dedupeSubjectEntries(mergedLocalRaw);
  const mergedLocal = mergedLocalCanonicalized.subjects;
  const decisionQuestion = extractDecisionQuestion(desc);

  const findMissingRequired = (items = []) => {
    return requiredSubjects
      .map((entry) => cleanText(entry?.label))
      .filter(Boolean)
      .filter((label) => !containsMatchingSubjectLabel(label, items));
  };
  const ensureRequiredPresent = (items = []) => {
    const missing = findMissingRequired(items);
    if (missing.length) {
      throw new Error(`Required subjects missing from matrix plan: ${missing.join(", ")}.`);
    }
    return missing;
  };

  if (mergedLocal.length >= minCount) {
    ensureRequiredPresent(mergedLocal);
    return {
      subjects: mergedLocal,
      decisionQuestion,
      extractedSubjects,
      localSubjects: mergedLocal,
      requiredSubjects,
      missingRequiredSubjects: [],
      discovery: null,
      usedSubjectDiscovery: false,
      requiresConfirmation: false,
      discoveryMeta: null,
      subjectCanonicalization: {
        mergedAliases: mergedLocalCanonicalized.mergedAliases,
      },
    };
  }

  const transport = callbacks?.transport;
  if (!transport?.callAnalyst) {
    throw new Error(`Please provide at least ${minCount} subjects or enable analyst transport for subject discovery.`);
  }

  const prompt = buildSubjectDiscoveryPrompt({ rawInput: desc, decisionQuestion, subjectsSpec, researchSetup });
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

  const parsed = extractJson(response?.text || response, {}, {
    phase: "matrix_subject_discovery",
    attempt: "initial",
    prompt,
    debugSession: options?.debugSession || null,
  });
  const discovery = normalizeSubjectDiscoveryResult(parsed, subjectsSpec);
  const discoveredSubjects = discovery.normalizedSubjects;
  if (discoveredSubjects.length < minCount) {
    throw new Error(`Subject discovery returned fewer than ${minCount} viable subjects. Please provide subjects explicitly.`);
  }

  const finalSubjectsRaw = mergeSubjectEntries(mergedLocal, discoveredSubjects, subjectsSpec, {
    required: requiredSubjects,
    maxCountOverride: runMaxCount,
  });
  const finalCanonicalized = dedupeSubjectEntries(finalSubjectsRaw);
  const finalSubjects = finalCanonicalized.subjects;
  if (finalSubjects.length < minCount) {
    throw new Error(`Please confirm at least ${minCount} subjects before running matrix analysis.`);
  }
  const missingRequiredSubjects = findMissingRequired(finalSubjects);
  ensureRequiredPresent(finalSubjects);

  const requireConfirmation = options?.requireConfirmation === true;
  return {
    subjects: finalSubjects,
    decisionQuestion: discovery.decisionQuestion || decisionQuestion,
    extractedSubjects,
    localSubjects: mergedLocal,
    requiredSubjects,
    missingRequiredSubjects,
    discovery,
    usedSubjectDiscovery: true,
    requiresConfirmation: requireConfirmation,
    discoveryMeta: response?.meta || null,
    subjectCanonicalization: {
      mergedAliases: [...(mergedLocalCanonicalized.mergedAliases || []), ...(finalCanonicalized.mergedAliases || [])],
    },
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
  const counterfactualQueriesRaw = Array.isArray(raw?.counterfactualQueries)
    ? raw.counterfactualQueries.map((query) => cleanText(query)).filter(Boolean).slice(0, 4)
    : [];
  const fallbackCounterfactual = Array.isArray(fallback?.counterfactualQueries)
    ? fallback.counterfactualQueries.map((query) => cleanText(query)).filter(Boolean).slice(0, 4)
    : [];
  const fallbackQueries = Array.isArray(fallback?.queries)
    ? fallback.queries.map((query) => cleanText(query)).filter(Boolean).slice(0, 4)
    : [];
  const merged = [...new Set([...queries, ...fallbackQueries])].slice(0, 4);
  const mergedCounterfactual = [...new Set([...counterfactualQueriesRaw, ...fallbackCounterfactual])]
    .filter((query) => !merged.includes(query))
    .slice(0, 2);
  return {
    gap: cleanText(raw?.gap || fallback?.gap || "Evidence is still sparse for this cell."),
    queries: merged,
    counterfactualQueries: mergedCounterfactual,
  };
}

function normalizeSearchHarvest(raw = {}, queryPlan = {}) {
  const counterfactualSet = new Set(
    normalizeStringList(queryPlan?.counterfactualQueries, 8, 170).map((query) => query.toLowerCase())
  );
  const findings = Array.isArray(raw?.findings)
    ? raw.findings
      .map((entry) => ({
        query: cleanText(entry?.query),
        evidenceType: cleanText(entry?.evidenceType).toLowerCase() === "counterfactual"
          || counterfactualSet.has(cleanText(entry?.query).toLowerCase())
          ? "counterfactual"
          : "supporting",
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
    const fallbackQueries = [
      ...normalizeStringList(queryPlan?.queries, 8, 170),
      ...normalizeStringList(queryPlan?.counterfactualQueries, 8, 170),
    ];
    return {
      findings,
      queryCoverage: fallbackQueries.map((query) => ({
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

function mergeHarvestFindingsIntoMatrixArguments(baseArguments = {}, harvest = {}) {
  const normalized = normalizeMatrixCellArguments(baseArguments || {});
  const supporting = Array.isArray(normalized?.supporting) ? [...normalized.supporting] : [];
  const limiting = Array.isArray(normalized?.limiting) ? [...normalized.limiting] : [];
  const seen = new Set(
    [...supporting, ...limiting]
      .map((entry) => cleanText(entry?.claim).toLowerCase())
      .filter(Boolean)
  );

  (Array.isArray(harvest?.findings) ? harvest.findings : []).forEach((entry, idx) => {
    const fact = cleanText(entry?.fact);
    if (!fact) return;
    const key = fact.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const target = cleanText(entry?.evidenceType).toLowerCase() === "counterfactual"
      ? limiting
      : supporting;
    const idPrefix = target === limiting ? "lim-harvest" : "sup-harvest";
    target.push({
      id: `${idPrefix}-${idx + 1}`,
      claim: clip(fact, 90),
      detail: cleanText(entry?.query)
        ? `Targeted query: ${clip(entry.query, 120)}`
        : "Captured during targeted low-confidence recovery.",
      sources: normalizeSourceList([entry?.source]),
      group: target === limiting ? "limiting" : "supporting",
      status: "active",
      discardedBy: "",
      discardReason: "",
      discardedAt: "",
    });
  });

  return {
    supporting: supporting.slice(0, 6),
    limiting: limiting.slice(0, 6),
  };
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
  const evidenceMode = normalizeEvidenceMode(input?.options?.evidenceMode);
  const strictQuality = normalizeStrictQuality(input?.options?.strictQuality || config?.quality?.strictFailFast);
  const deepAssistOptions = normalizeDeepAssistOptions(input?.options?.deepAssist || {});
  const researchSetup = normalizeResearchSetupContext(input?.options?.researchSetup || {});

  const onProgress = typeof callbacks?.onProgress === "function" ? callbacks.onProgress : () => {};
  const onDebugSession = typeof callbacks?.onDebugSession === "function" ? callbacks.onDebugSession : null;
  let state = input?.initialState ? clone(input.initialState) : createInitialState(input);
  state.options = {
    evidenceMode,
    deepAssist: deepAssistOptions,
    researchSetup,
  };
  state.analysisMeta = {
    ...(state.analysisMeta || {}),
    analysisMode: evidenceMode === "deep-assist" ? "matrix-deep-assist" : "matrix",
    evidenceMode,
    strictQuality,
    decisionContext: researchSetup.decisionContext,
    userRoleContext: researchSetup.userRoleContext,
    qualityGrade: state.analysisMeta?.qualityGrade || "standard",
    degradedReasons: Array.isArray(state.analysisMeta?.degradedReasons) ? state.analysisMeta.degradedReasons : [],
    safetyGuardrails: state.analysisMeta?.safetyGuardrails && typeof state.analysisMeta.safetyGuardrails === "object"
      ? state.analysisMeta.safetyGuardrails
      : {
        triggered: false,
        totalEvents: 0,
        timeoutEvents: 0,
        retryExhaustedEvents: 0,
        parseFailureEvents: 0,
        providerFailureEvents: 0,
        events: [],
      },
    completionState: cleanText(state.analysisMeta?.completionState) || "running",
    terminalReasonCodes: Array.isArray(state.analysisMeta?.terminalReasonCodes)
      ? state.analysisMeta.terminalReasonCodes.map((item) => cleanText(item)).filter(Boolean)
      : [],
    counterfactualQueriesGenerated: Number(state.analysisMeta?.counterfactualQueriesGenerated || 0),
    counterfactualFindingsUsed: Number(state.analysisMeta?.counterfactualFindingsUsed || 0),
    deepAssistRecoveryTriggered: !!state.analysisMeta?.deepAssistRecoveryTriggered,
    deepAssistRecoveryCandidates: Number(state.analysisMeta?.deepAssistRecoveryCandidates || 0),
    deepAssistRecoveryBudgetCells: Number(state.analysisMeta?.deepAssistRecoveryBudgetCells || 0),
    deepAssistRecoveryDroppedByBudget: Number(state.analysisMeta?.deepAssistRecoveryDroppedByBudget || 0),
    deepAssistRecoveryUpgraded: Number(state.analysisMeta?.deepAssistRecoveryUpgraded || 0),
    deepAssistRecoveryValidatedLow: Number(state.analysisMeta?.deepAssistRecoveryValidatedLow || 0),
    deepAssistRecoveryFailed: !!state.analysisMeta?.deepAssistRecoveryFailed,
    lowConfidenceBudgetStrategy: cleanText(state.analysisMeta?.lowConfidenceBudgetStrategy || "adaptive") || "adaptive",
    deepAssistRecoveryDiagnostics: Array.isArray(state.analysisMeta?.deepAssistRecoveryDiagnostics)
      ? state.analysisMeta.deepAssistRecoveryDiagnostics
      : [],
    sourceUniverse: state.analysisMeta?.sourceUniverse && typeof state.analysisMeta.sourceUniverse === "object"
      ? state.analysisMeta.sourceUniverse
      : emptySourceUniverseSummary(),
    matrixChunking: state.analysisMeta?.matrixChunking && typeof state.analysisMeta.matrixChunking === "object"
      ? state.analysisMeta.matrixChunking
      : {},
    matrixNormalization: state.analysisMeta?.matrixNormalization && typeof state.analysisMeta.matrixNormalization === "object"
      ? state.analysisMeta.matrixNormalization
      : {},
    matrixEarlyCoverageGate: state.analysisMeta?.matrixEarlyCoverageGate && typeof state.analysisMeta.matrixEarlyCoverageGate === "object"
      ? state.analysisMeta.matrixEarlyCoverageGate
      : null,
    redTeamCallMade: !!state.analysisMeta?.redTeamCallMade,
    redTeamHighSeverityCount: Number(state.analysisMeta?.redTeamHighSeverityCount || 0),
    synthesizerCallMade: !!state.analysisMeta?.synthesizerCallMade,
    synthesizerModel: cleanText(state.analysisMeta?.synthesizerModel),
    requiredSubjectsRequested: Number(state.analysisMeta?.requiredSubjectsRequested || 0),
    requiredSubjectsMissing: Number(state.analysisMeta?.requiredSubjectsMissing || 0),
    decisionGradePassed: !!state.analysisMeta?.decisionGradePassed,
    decisionGradeFailureReason: cleanText(state.analysisMeta?.decisionGradeFailureReason),
    decisionGradeGate: state.analysisMeta?.decisionGradeGate && typeof state.analysisMeta.decisionGradeGate === "object"
      ? state.analysisMeta.decisionGradeGate
      : null,
    deepAssistProvidersRequested: evidenceMode === "deep-assist" ? deepAssistOptions.providers.length : Number(state.analysisMeta?.deepAssistProvidersRequested || 0),
  };
  const sourceFetchCache = new Map();
  const debugSession = createAnalysisDebugSession({
    useCaseId: state.id,
    analysisMode: evidenceMode === "deep-assist" ? "matrix-deep-assist" : "matrix",
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
  const analystWebTokens = Number(limits.phase1EvidenceWeb) || Math.max(12000, analystTokens + 2000);
  const criticTokens = Number(limits.critic) || 6000;
  const responseTokens = Number(limits.phase3Response) || 4200;
  const discoveryTokens = Number(limits.phase3Response) || 3200;

  const analystPrompt = cleanText(config?.prompts?.matrixAnalyst) || MATRIX_ANALYST_PROMPT;
  const criticPrompt = cleanText(config?.prompts?.matrixCritic) || MATRIX_CRITIC_PROMPT;

  try {
    const resolvedInput = await resolveMatrixResearchInput(
      input,
      config,
      { transport },
      { requireConfirmation: false, debugSession }
    );

    state.analysisMeta.subjectDiscoveryRequested = true;
    state.analysisMeta.subjectDiscoverySuggestedCount = resolvedInput?.discovery?.normalizedSubjects?.length || 0;
    state.analysisMeta.requiredSubjectsRequested = Number((resolvedInput?.requiredSubjects || []).length || 0);
    state.analysisMeta.requiredSubjectsMissing = Number((resolvedInput?.missingRequiredSubjects || []).length || 0);
    state.analysisMeta.subjectCanonicalization = resolvedInput?.subjectCanonicalization || { mergedAliases: [] };
    state.analysisMeta = mergeMeta(state.analysisMeta, resolvedInput?.discoveryMeta, "subject_discovery");

    const subjects = resolvedInput.subjects;
    const attributes = normalizeAttributeList(config?.attributes || []);
    const derivedAttributes = attributes.filter((attribute) => attribute.derived);
    const baseAttributes = attributes.filter((attribute) => !attribute.derived);
    const derivedAttributeIds = new Set(derivedAttributes.map((attribute) => attribute.id));
    const layout = normalizeLayoutHint(config?.matrixLayout);
    const decisionQuestion = cleanText(researchSetup.decisionContext)
      || resolvedInput?.decisionQuestion
      || extractDecisionQuestion(state.rawInput)
      || state.rawInput;
    const relatedDiscovery = config?.relatedDiscovery !== false;
    state.attributes = buildMatrixAttributes({
      rawInput: state.rawInput,
      decisionQuestion,
      researchSetup,
      subjects,
    });

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
        executiveSummary: null,
        coverage: { totalCells: subjects.length * attributes.length, lowConfidenceCells: 0, contestedCells: 0 },
        discovery: null,
        subjectResolution: {
          usedSubjectDiscovery: !!resolvedInput.usedSubjectDiscovery,
          extractedSubjects: resolvedInput.extractedSubjects || [],
          localSubjects: resolvedInput.localSubjects || [],
          requiredSubjects: resolvedInput.requiredSubjects || [],
          missingRequiredSubjects: resolvedInput.missingRequiredSubjects || [],
          subjectCanonicalization: resolvedInput?.subjectCanonicalization || { mergedAliases: [] },
          notes: resolvedInput?.discovery?.notes || "",
        },
      },
    });

    update("matrix_baseline", {});
    const baselineMatrix = await runChunkedAnalystMatrixPass({
      transport,
      analystPrompt,
      requestOptions: roleOptions(config, "analyst"),
      rawInput: state.rawInput,
      decisionQuestion,
      subjects,
      attributes,
      passLabel: "baseline memory-only pass",
      phase: "matrix_baseline",
      liveSearch: false,
      tokenLimit: analystTokens,
      limits: config?.limits || {},
      debugSession,
      analysisMeta: state.analysisMeta,
      researchSetup,
    });
    enforceMatrixChunkCompleteness(baselineMatrix, "matrix_baseline", state.analysisMeta, debugSession);
    state.analysisMeta.matrixChunking = {
      ...(state.analysisMeta.matrixChunking || {}),
      matrix_baseline: baselineMatrix?.chunking || null,
    };
    state.analysisMeta.matrixNormalization = {
      ...(state.analysisMeta.matrixNormalization || {}),
      matrix_baseline: baselineMatrix?.normalization || null,
    };
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

    const webMatrix = await runChunkedAnalystMatrixPass({
      transport,
      analystPrompt,
      requestOptions: roleOptions(config, "analyst"),
      rawInput: state.rawInput,
      decisionQuestion,
      subjects,
      attributes,
      passLabel: "web-assisted pass",
      phase: "matrix_web",
      liveSearch: true,
      tokenLimit: analystWebTokens,
      limits: config?.limits || {},
      debugSession,
      analysisMeta: state.analysisMeta,
      researchSetup,
    });
    enforceMatrixChunkCompleteness(webMatrix, "matrix_web", state.analysisMeta, debugSession);
    state.analysisMeta.matrixChunking = {
      ...(state.analysisMeta.matrixChunking || {}),
      matrix_web: webMatrix?.chunking || null,
    };
    state.analysisMeta.matrixNormalization = {
      ...(state.analysisMeta.matrixNormalization || {}),
      matrix_web: webMatrix?.normalization || null,
    };
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

    const runReconcilePass = async (qualityGuard = null, attempt = "initial") => {
      const matrix = await runChunkedAnalystMatrixPass({
        transport,
        analystPrompt,
        requestOptions: roleOptions(config, "analyst"),
        rawInput: state.rawInput,
        decisionQuestion,
        subjects,
        attributes,
        passLabel: `reconcile merge pass (${attempt})`,
        phase: "matrix_reconcile",
        liveSearch: false,
        tokenLimit: analystTokens,
        limits: config?.limits || {},
        debugSession,
        analysisMeta: state.analysisMeta,
        researchSetup,
        buildPromptForChunk: (chunkSubjects) => {
          const subjectIds = new Set(chunkSubjects.map((item) => item.id));
          const baselineChunk = sliceMatrixBySubjects(baselineMatrix, subjectIds);
          const webChunk = sliceMatrixBySubjects(webMatrix, subjectIds);
          return buildMatrixReconcilePrompt({
            rawInput: state.rawInput,
            decisionQuestion,
            subjects: chunkSubjects,
            attributes,
            baseline: baselineChunk,
            web: webChunk,
            qualityGuard,
            researchSetup,
          });
        },
      });
      enforceMatrixChunkCompleteness(matrix, "matrix_reconcile", state.analysisMeta, debugSession);
      state.analysisMeta.matrixChunking = {
        ...(state.analysisMeta.matrixChunking || {}),
        [`matrix_reconcile_${attempt}`]: matrix?.chunking || null,
      };
      state.analysisMeta.matrixNormalization = {
        ...(state.analysisMeta.matrixNormalization || {}),
        [`matrix_reconcile_${attempt}`]: matrix?.normalization || null,
      };
      await verifyMatrixCellSources(matrix, state.analysisMeta, sourceFetchCache, {
        penalizeConfidence: true,
        transport,
      });
      appendAnalysisDebugEvent(debugSession, {
        type: "reconcile_pass_complete",
        phase: "matrix_reconcile",
        attempt,
      });
      return matrix;
    };

    let reconciledMatrix = await runReconcilePass(null, "initial");
    const initialHealth = evaluateMatrixReconcileHealth(subjects, attributes, baselineMatrix, webMatrix, reconciledMatrix);
    state.analysisMeta.matrixReconcileHealth = initialHealth;
    state.analysisMeta.matrixHybridStats = matrixHybridStats(subjects, attributes, baselineMatrix, webMatrix, reconciledMatrix);

    if (initialHealth.suspicious) {
      state.analysisMeta.matrixReconcileRetryTriggered = true;
      state.analysisMeta.matrixReconcileRetryAttempts += 1;
      state.analysisMeta.matrixReconcileRetryReason = initialHealth.notes.join(" ");
      appendAnalysisDebugEvent(debugSession, {
        type: "reconcile_retry_triggered",
        phase: "matrix_reconcile",
        attempt: "quality_guard",
        diagnostics: initialHealth,
        note: state.analysisMeta.matrixReconcileRetryReason,
      });

      const focusCells = reconciledMatrix.cells
        .filter((cell) => normalizeConfidence(cell.confidence) === "low")
        .slice(0, 8)
        .map((cell) => ({ subjectId: cell.subjectId, attributeId: cell.attributeId }));

      const retryCandidate = await runReconcilePass({
        notes: initialHealth.notes,
        focusCells,
      }, "quality_guard_retry");
      const retryHealth = evaluateMatrixReconcileHealth(subjects, attributes, baselineMatrix, webMatrix, retryCandidate);
      const beforeScore = scoreMatrixReconcileCandidate(initialHealth);
      const retryScore = scoreMatrixReconcileCandidate(retryHealth);
      const useRetry = !retryHealth.suspicious || retryScore > beforeScore;

      state.analysisMeta.matrixReconcileRetryUsed = useRetry;
      state.analysisMeta.matrixReconcileRetryDiagnostics = {
        initial: initialHealth,
        retry: retryHealth,
        selected: useRetry ? "retry" : "initial",
        qualityScoreInitial: beforeScore,
        qualityScoreRetry: retryScore,
      };

      appendAnalysisDebugEvent(debugSession, {
        type: "reconcile_retry_completed",
        phase: "matrix_reconcile",
        attempt: "quality_guard",
        useRetry,
        diagnostics: state.analysisMeta.matrixReconcileRetryDiagnostics,
      });

      if (useRetry) {
        reconciledMatrix = retryCandidate;
        state.analysisMeta.matrixReconcileHealth = retryHealth;
        state.analysisMeta.matrixHybridStats = matrixHybridStats(subjects, attributes, baselineMatrix, webMatrix, reconciledMatrix);
      }
    }

    const finalReconcileHealth = evaluateMatrixReconcileHealth(subjects, attributes, baselineMatrix, webMatrix, reconciledMatrix);
    state.analysisMeta.matrixReconcileHealth = finalReconcileHealth;
    state.analysisMeta.matrixHybridStats = matrixHybridStats(subjects, attributes, baselineMatrix, webMatrix, reconciledMatrix);
    if (finalReconcileHealth.suspicious) {
      const note = finalReconcileHealth.notes.join(" ")
        || "Matrix reconcile remained implausibly unchanged after quality guard checks.";
      appendAnalysisDebugEvent(debugSession, {
        type: "reconcile_quality_guard_failed",
        phase: "matrix_reconcile",
        attempt: "final",
        diagnostics: finalReconcileHealth,
        note,
      });
      markDegraded(state.analysisMeta, "matrix_reconcile_quality_guard", note);
    }

    update("matrix_targeted", {
      matrix: {
        ...state.matrix,
        ...reconciledMatrix,
        coverage: summarizeCoverage(reconciledMatrix.cells),
      },
      analysisMeta: state.analysisMeta,
    });

    const targetedPlan = selectMatrixTargetedCells(reconciledMatrix.cells, config?.limits || {}, derivedAttributeIds);
    const lowCells = targetedPlan.selected;

    state.analysisMeta.lowConfidenceInitialCount = targetedPlan.allCount;
    state.analysisMeta.lowConfidenceUpgradedCount = 0;
    state.analysisMeta.lowConfidenceValidatedLowCount = 0;
    state.analysisMeta.lowConfidenceCycleFailures = 0;
    state.analysisMeta.lowConfidenceTargetedSearchUsed = false;
    state.analysisMeta.lowConfidenceTargetedWebSearchCalls = 0;
    state.analysisMeta.lowConfidenceTargetedFallbackReason = null;
    state.analysisMeta.lowConfidenceRoundRobinApplied = true;
    state.analysisMeta.lowConfidenceBudgetCells = targetedPlan.budgetCells;
    state.analysisMeta.lowConfidenceBudgetUsed = 0;
    state.analysisMeta.lowConfidenceDroppedByBudget = targetedPlan.droppedByBudget;
    state.analysisMeta.lowConfidenceBudgetStrategy = cleanText(targetedPlan.strategy || "adaptive") || "adaptive";
    state.analysisMeta.targetedCellDiagnostics = [];

    let strategistHints = { niche: "", aliases: [], cellHints: {} };
    try {
      const strategistPrompt = buildMatrixQueryStrategistPrompt({
        rawInput: state.rawInput,
        decisionQuestion,
        subjects,
        attributes,
        candidateCells: lowCells,
        researchSetup,
      });
      const strategistRes = await transport.callAnalyst(
        [{ role: "user", content: strategistPrompt }],
        analystPrompt,
        1400,
        {
          ...capabilityOptions(config, "retrieval", "analyst"),
          liveSearch: false,
          includeMeta: true,
        }
      );
      state.analysisMeta = mergeTargetedMeta(state.analysisMeta, strategistRes?.meta);
      strategistHints = normalizeMatrixStrategistHints(
        extractJson(strategistRes?.text || strategistRes, {}, {
          phase: "matrix_targeted_strategist",
          attempt: "initial",
          prompt: strategistPrompt,
          debugSession,
        }),
        subjects,
        attributes
      );
      state.analysisMeta.targetedRetrievalNiche = strategistHints.niche || "";
      state.analysisMeta.targetedRetrievalAliases = strategistHints.aliases || [];
    } catch (_) {
      strategistHints = { niche: "", aliases: [], cellHints: {} };
    }

    for (const cell of lowCells) {
      state.analysisMeta.lowConfidenceBudgetUsed = Number(state.analysisMeta.lowConfidenceBudgetUsed || 0) + 1;
      const subject = subjects.find((item) => item.id === cell.subjectId);
      const attribute = attributes.find((item) => item.id === cell.attributeId);
      if (!subject || !attribute) continue;

      const diag = {
        cellKey: buildCellKey(cell.subjectId, cell.attributeId),
        subjectId: cell.subjectId,
        attributeId: cell.attributeId,
        subject: subject.label,
        attribute: attribute.label,
        confidenceBefore: normalizeConfidence(cell.confidence),
      };
      const strategistForCell = strategistHints?.cellHints?.[buildCellKey(cell.subjectId, cell.attributeId)] || {};
      const aliasHints = normalizeStringList(strategistHints?.aliases, 6, 110);
      const attributePlaybook = matrixAttributePlaybook(attribute, subject.label);

      const fallbackPlan = {
        gap: attributePlaybook.gap || `Evidence is weak for ${subject.label} x ${attribute.label}.`,
        queries: [...new Set([
          ...normalizeStringList(strategistForCell?.querySeeds, 4, 170),
          ...normalizeStringList(attributePlaybook.querySeeds, 4, 170),
          ...normalizeStringList(aliasHints.map((alias) => `${alias} ${attribute.label} evidence`), 2, 170),
          `${subject.label} ${attribute.label} case study metrics`,
          `${subject.label} ${attribute.label} benchmark evidence`,
          `${subject.label} ${attribute.label} customer outcome`,
        ])].slice(0, 4),
        counterfactualQueries: [...new Set([
          ...normalizeStringList(strategistForCell?.counterfactualQueries, 4, 170),
          ...normalizeStringList(attributePlaybook.counterfactualQueries, 4, 170),
          `${subject.label} ${attribute.label} criticism`,
          `${subject.label} ${attribute.label} failure cases`,
          `${subject.label} alternatives outperforming ${attribute.label}`,
        ])].slice(0, Math.max(1, Number(config?.limits?.counterfactualQueriesPerDim || 2))),
      };
      diag.fallbackQueries = fallbackPlan.queries;
      diag.fallbackCounterfactualQueries = fallbackPlan.counterfactualQueries;
      diag.sourceTargets = [...new Set([
        ...normalizeStringList(strategistForCell?.sourceTargets, 4, 170),
        ...normalizeStringList(attributePlaybook.sourceTargets, 4, 170),
      ])].slice(0, 5);

      let queryPlan = fallbackPlan;
      try {
        const queryPrompt = buildLowConfidenceQueryPrompt({
          rawInput: state.rawInput,
          decisionQuestion,
          subject,
          attribute,
          cell,
          researchSetup,
          counterfactualLimit: Math.max(1, Number(config?.limits?.counterfactualQueriesPerDim || 2)),
        });
        const queryRes = await transport.callAnalyst(
          [{ role: "user", content: queryPrompt }],
          analystPrompt,
          1400,
          {
            ...capabilityOptions(config, "retrieval", "analyst"),
            liveSearch: false,
            includeMeta: true,
          }
        );
        state.analysisMeta = mergeTargetedMeta(state.analysisMeta, queryRes?.meta);
        queryPlan = normalizeQueryPlan(
          extractJson(queryRes?.text || queryRes, {}, {
            phase: "matrix_targeted_query_plan",
            attempt: diag.cellKey,
            prompt: queryPrompt,
            debugSession,
          }),
          fallbackPlan
        );
        queryPlan.queries = [...new Set([
          ...normalizeStringList(strategistForCell?.querySeeds, 3, 170),
          ...normalizeStringList(queryPlan.queries, 4, 170),
        ])].slice(0, 4);
        queryPlan.counterfactualQueries = [...new Set([
          ...normalizeStringList(strategistForCell?.counterfactualQueries, 4, 170),
          ...normalizeStringList(queryPlan?.counterfactualQueries, 4, 170),
        ])]
          .filter((query) => !queryPlan.queries.includes(query))
          .slice(0, Math.max(1, Number(config?.limits?.counterfactualQueriesPerDim || 2)));
        diag.queryPlan = queryPlan;
      } catch (queryErr) {
        queryPlan = fallbackPlan;
        diag.queryPlan = queryPlan;
        diag.queryPlanError = cleanText(queryErr?.message || "query_plan_failed");
      }

      state.analysisMeta.counterfactualQueriesGenerated = Number(state.analysisMeta.counterfactualQueriesGenerated || 0)
        + Number(queryPlan?.counterfactualQueries?.length || 0);

      let harvest = {
        findings: [],
        queryCoverage: [
          ...normalizeStringList(queryPlan?.queries, 8, 170),
          ...normalizeStringList(queryPlan?.counterfactualQueries, 8, 170),
        ].map((query) => ({ query, useful: false, note: "No useful findings captured." })),
      };
      try {
        const searchPrompt = buildLowConfidenceSearchPrompt({
          rawInput: state.rawInput,
          decisionQuestion,
          subject,
          attribute,
          queryPlan,
          cell,
          researchSetup,
        });
        const searchRes = await transport.callAnalyst(
          [{ role: "user", content: searchPrompt }],
          analystPrompt,
          2600,
          {
            ...capabilityOptions(config, "retrieval", "analyst"),
            liveSearch: true,
            includeMeta: true,
          }
        );
        state.analysisMeta = mergeTargetedMeta(state.analysisMeta, searchRes?.meta);
        harvest = normalizeSearchHarvest(
          extractJson(searchRes?.text || searchRes, {}, {
            phase: "matrix_targeted_search_harvest",
            attempt: diag.cellKey,
            prompt: searchPrompt,
            debugSession,
          }),
          queryPlan
        );
        diag.queryCoverage = harvest?.queryCoverage || [];
        diag.findingsCount = (harvest?.findings || []).length;
      } catch (searchErr) {
        harvest = {
          findings: [],
          queryCoverage: [
            ...normalizeStringList(queryPlan?.queries, 8, 170),
            ...normalizeStringList(queryPlan?.counterfactualQueries, 8, 170),
          ].map((query) => ({ query, useful: false, note: "No useful findings captured." })),
        };
        diag.queryCoverage = harvest?.queryCoverage || [];
        diag.findingsCount = 0;
        diag.searchError = cleanText(searchErr?.message || "search_failed");
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
          researchSetup,
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

        const parsed = extractJson(rescoreRes?.text || rescoreRes, {}, {
          phase: "matrix_targeted_rescore",
          attempt: diag.cellKey,
          prompt: rescorePrompt,
          debugSession,
        });
        const nextConfidence = normalizeConfidence(parsed?.confidence || cell.confidence);
        const upgraded = confidenceRank(nextConfidence) > confidenceRank(cell.confidence);

        const updatedCell = {
          ...cell,
          value: cleanText(parsed?.value || cell.value),
          full: cleanText(parsed?.full || cell.full || parsed?.value || cell.value),
          risks: cleanText(parsed?.risks || cell.risks),
          arguments: mergeHarvestFindingsIntoMatrixArguments(parsed?.arguments || cell.arguments || {}, harvest),
          confidence: nextConfidence,
          confidenceReason: cleanText(parsed?.confidenceReason || cell.confidenceReason),
          sources: mergeSources(cell.sources, parsed?.sources, (harvest.findings || []).map((entry) => entry.source)),
        };

        reconciledMatrix = upsertCell(reconciledMatrix, updatedCell);
        if (upgraded) {
          state.analysisMeta.lowConfidenceUpgradedCount += 1;
          diag.status = "upgraded";
        } else if (nextConfidence === "low") {
          state.analysisMeta.lowConfidenceValidatedLowCount += 1;
          diag.status = "validated_low";
        } else {
          diag.status = "updated";
        }
        diag.confidenceAfter = nextConfidence;
        diag.usefulQueryCount = (harvest?.queryCoverage || []).filter((entry) => entry?.useful).length;
        diag.counterfactualFindingCount = (harvest?.findings || [])
          .filter((entry) => cleanText(entry?.evidenceType).toLowerCase() === "counterfactual")
          .length;
        state.analysisMeta.counterfactualFindingsUsed = Number(state.analysisMeta.counterfactualFindingsUsed || 0)
          + Number(diag.counterfactualFindingCount || 0);
        state.analysisMeta.targetedCellDiagnostics.push(diag);
      } catch (rescoreErr) {
        state.analysisMeta.lowConfidenceCycleFailures += 1;
        diag.status = "rescore_failed";
        diag.rescoreError = cleanText(rescoreErr?.message || "rescore_failed");
        state.analysisMeta.targetedCellDiagnostics.push(diag);
      }
      appendAnalysisDebugEvent(debugSession, {
        type: "matrix_targeted_cell_diagnostics",
        phase: "matrix_targeted",
        attempt: diag.cellKey,
        extra: diag,
      });
    }

    await verifyMatrixCellSources(reconciledMatrix, state.analysisMeta, sourceFetchCache, {
      penalizeConfidence: true,
      transport,
    });

    if (evidenceMode === "deep-assist") {
      update("matrix_deep_assist", {
        matrix: {
          ...state.matrix,
          ...reconciledMatrix,
          coverage: summarizeCoverage(reconciledMatrix.cells),
        },
        analysisMeta: state.analysisMeta,
      });
      try {
        reconciledMatrix = await runMatrixDeepAssistEnrichment({
          state,
          config,
          transport,
          debugSession,
          analysisMeta: state.analysisMeta,
          strictQuality,
          rawInput: state.rawInput,
          decisionQuestion,
          subjects,
          attributes,
          baseMatrix: reconciledMatrix,
          analystPrompt,
          tokenLimits: config?.limits?.tokenLimits || {},
          researchSetup,
        });
        await verifyMatrixCellSources(reconciledMatrix, state.analysisMeta, sourceFetchCache, {
          penalizeConfidence: true,
          transport,
        });

        const deepAssistRecovery = selectDeepAssistRecoveryCells(
          reconciledMatrix.cells,
          config?.limits || {},
          derivedAttributeIds,
          state.analysisMeta
        );
        state.analysisMeta.deepAssistRecoveryTriggered = deepAssistRecovery.selected.length > 0;
        state.analysisMeta.deepAssistRecoveryCandidates = deepAssistRecovery.allCount;
        state.analysisMeta.deepAssistRecoveryBudgetCells = deepAssistRecovery.budgetCells;
        state.analysisMeta.deepAssistRecoveryDroppedByBudget = deepAssistRecovery.droppedByBudget;
        state.analysisMeta.deepAssistRecoveryDiagnostics = deepAssistRecovery.diagnostics;
        state.analysisMeta.deepAssistRecoveryUpgraded = 0;
        state.analysisMeta.deepAssistRecoveryValidatedLow = 0;

        if (deepAssistRecovery.selected.length) {
          let deepAssistStrategistHints = { niche: "", aliases: [], cellHints: {} };
          try {
            const strategistPrompt = buildMatrixQueryStrategistPrompt({
              rawInput: state.rawInput,
              decisionQuestion,
              subjects,
              attributes,
              candidateCells: deepAssistRecovery.selected,
              researchSetup,
            });
            const strategistRes = await transport.callAnalyst(
              [{ role: "user", content: strategistPrompt }],
              analystPrompt,
              1400,
              {
                ...capabilityOptions(config, "retrieval", "analyst"),
                liveSearch: false,
                includeMeta: true,
              }
            );
            state.analysisMeta = mergeTargetedMeta(state.analysisMeta, strategistRes?.meta);
            deepAssistStrategistHints = normalizeMatrixStrategistHints(
              extractJson(strategistRes?.text || strategistRes, {}, {
                phase: "matrix_deep_assist_targeted_strategist",
                attempt: "initial",
                prompt: strategistPrompt,
                debugSession,
              }),
              subjects,
              attributes
            );
          } catch (_) {
            deepAssistStrategistHints = { niche: "", aliases: [], cellHints: {} };
          }

          for (const cell of deepAssistRecovery.selected) {
            const subject = subjects.find((item) => item.id === cell.subjectId);
            const attribute = attributes.find((item) => item.id === cell.attributeId);
            if (!subject || !attribute) continue;
            const diag = {
              cycleLabel: "deep_assist_recovery",
              cellKey: buildCellKey(cell.subjectId, cell.attributeId),
              subjectId: cell.subjectId,
              attributeId: cell.attributeId,
              confidenceBefore: normalizeConfidence(cell.confidence),
              providerAgreement: cleanText(cell.providerAgreement).toLowerCase(),
            };
            const strategistForCell = deepAssistStrategistHints?.cellHints?.[buildCellKey(cell.subjectId, cell.attributeId)] || {};
            const aliasHints = normalizeStringList(deepAssistStrategistHints?.aliases, 6, 110);
            const attributePlaybook = matrixAttributePlaybook(attribute, subject.label);
            const fallbackPlan = {
              gap: attributePlaybook.gap || `Post-merge Deep Assist conflict/uncertainty for ${subject.label} x ${attribute.label}.`,
              queries: [...new Set([
                ...normalizeStringList(strategistForCell?.querySeeds, 4, 170),
                ...normalizeStringList(attributePlaybook.querySeeds, 4, 170),
                ...normalizeStringList(aliasHints.map((alias) => `${alias} ${attribute.label} evidence`), 2, 170),
                `${subject.label} ${attribute.label} benchmark evidence`,
                `${subject.label} ${attribute.label} deployment outcomes`,
              ])].slice(0, 4),
              counterfactualQueries: [...new Set([
                ...normalizeStringList(strategistForCell?.counterfactualQueries, 4, 170),
                ...normalizeStringList(attributePlaybook.counterfactualQueries, 4, 170),
                `${subject.label} ${attribute.label} criticism`,
                `${subject.label} ${attribute.label} failure cases`,
              ])].slice(0, Math.max(1, Number(config?.limits?.counterfactualQueriesPerDim || 2))),
            };

            let queryPlan = fallbackPlan;
            try {
              const queryPrompt = buildLowConfidenceQueryPrompt({
                rawInput: state.rawInput,
                decisionQuestion,
                subject,
                attribute,
                cell,
                researchSetup,
                counterfactualLimit: Math.max(1, Number(config?.limits?.counterfactualQueriesPerDim || 2)),
              });
              const queryRes = await transport.callAnalyst(
                [{ role: "user", content: queryPrompt }],
                analystPrompt,
                1400,
                {
                  ...capabilityOptions(config, "retrieval", "analyst"),
                  liveSearch: false,
                  includeMeta: true,
                }
              );
              state.analysisMeta = mergeTargetedMeta(state.analysisMeta, queryRes?.meta);
              queryPlan = normalizeQueryPlan(
                extractJson(queryRes?.text || queryRes, {}, {
                  phase: "matrix_deep_assist_targeted_query_plan",
                  attempt: diag.cellKey,
                  prompt: queryPrompt,
                  debugSession,
                }),
                fallbackPlan
              );
            } catch (_) {
              queryPlan = fallbackPlan;
            }
            state.analysisMeta.counterfactualQueriesGenerated = Number(state.analysisMeta.counterfactualQueriesGenerated || 0)
              + Number(queryPlan?.counterfactualQueries?.length || 0);

            let harvest = {
              findings: [],
              queryCoverage: [
                ...normalizeStringList(queryPlan?.queries, 8, 170),
                ...normalizeStringList(queryPlan?.counterfactualQueries, 8, 170),
              ].map((query) => ({ query, useful: false, note: "No useful findings captured." })),
            };
            try {
              const searchPrompt = buildLowConfidenceSearchPrompt({
                rawInput: state.rawInput,
                decisionQuestion,
                subject,
                attribute,
                queryPlan,
                cell,
                researchSetup,
              });
              const searchRes = await transport.callAnalyst(
                [{ role: "user", content: searchPrompt }],
                analystPrompt,
                2600,
                {
                  ...capabilityOptions(config, "retrieval", "analyst"),
                  liveSearch: true,
                  includeMeta: true,
                }
              );
              state.analysisMeta = mergeTargetedMeta(state.analysisMeta, searchRes?.meta);
              harvest = normalizeSearchHarvest(
                extractJson(searchRes?.text || searchRes, {}, {
                  phase: "matrix_deep_assist_targeted_search_harvest",
                  attempt: diag.cellKey,
                  prompt: searchPrompt,
                  debugSession,
                }),
                queryPlan
              );
            } catch (_) {
              harvest = {
                findings: [],
                queryCoverage: [
                  ...normalizeStringList(queryPlan?.queries, 8, 170),
                  ...normalizeStringList(queryPlan?.counterfactualQueries, 8, 170),
                ].map((query) => ({ query, useful: false, note: "No useful findings captured." })),
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
                researchSetup,
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
              const parsed = extractJson(rescoreRes?.text || rescoreRes, {}, {
                phase: "matrix_deep_assist_targeted_rescore",
                attempt: diag.cellKey,
                prompt: rescorePrompt,
                debugSession,
              });
              const nextConfidence = normalizeConfidence(parsed?.confidence || cell.confidence);
              const upgraded = confidenceRank(nextConfidence) > confidenceRank(cell.confidence);
              const updatedCell = {
                ...cell,
                value: cleanText(parsed?.value || cell.value),
                full: cleanText(parsed?.full || cell.full || parsed?.value || cell.value),
                risks: cleanText(parsed?.risks || cell.risks),
                arguments: mergeHarvestFindingsIntoMatrixArguments(parsed?.arguments || cell.arguments || {}, harvest),
                confidence: nextConfidence,
                confidenceReason: cleanText(parsed?.confidenceReason || cell.confidenceReason),
                sources: mergeSources(cell.sources, parsed?.sources, (harvest.findings || []).map((entry) => entry.source)),
              };
              reconciledMatrix = upsertCell(reconciledMatrix, updatedCell);
              if (upgraded) state.analysisMeta.deepAssistRecoveryUpgraded += 1;
              else if (nextConfidence === "low") state.analysisMeta.deepAssistRecoveryValidatedLow += 1;
              const counterfactualFindingCount = (harvest?.findings || [])
                .filter((entry) => cleanText(entry?.evidenceType).toLowerCase() === "counterfactual")
                .length;
              state.analysisMeta.counterfactualFindingsUsed = Number(state.analysisMeta.counterfactualFindingsUsed || 0)
                + Number(counterfactualFindingCount || 0);
              appendAnalysisDebugEvent(debugSession, {
                type: "matrix_targeted_cell_diagnostics",
                phase: "matrix_targeted",
                attempt: diag.cellKey,
                extra: {
                  ...diag,
                  confidenceAfter: nextConfidence,
                  status: upgraded ? "upgraded" : (nextConfidence === "low" ? "validated_low" : "updated"),
                  usefulQueryCount: (harvest?.queryCoverage || []).filter((entry) => entry?.useful).length,
                  counterfactualFindingCount,
                },
              });
            } catch (recoveryErr) {
              state.analysisMeta.deepAssistRecoveryFailed = true;
              appendAnalysisDebugEvent(debugSession, {
                type: "matrix_deep_assist_recovery_failed",
                phase: "matrix_targeted",
                attempt: diag.cellKey,
                error: cleanText(recoveryErr?.message || "deep_assist_recovery_failed"),
              });
              failIfStrictQuality(
                strictQuality,
                `Strict quality mode: matrix deep-assist recovery failed for ${diag.cellKey}. ${cleanText(recoveryErr?.message || "deep_assist_recovery_failed")}`,
                "STRICT_MATRIX_DEEP_ASSIST_RECOVERY_FAILED"
              );
            }
          }

          await verifyMatrixCellSources(reconciledMatrix, state.analysisMeta, sourceFetchCache, {
            penalizeConfidence: true,
            transport,
          });
        }
      } catch (deepAssistErr) {
        const note = deepAssistErr?.message || "Matrix deep assist enrichment failed.";
        markDegraded(state.analysisMeta, "matrix_deep_assist_enrichment_failed", note);
        appendAnalysisDebugEvent(debugSession, {
          type: "matrix_deep_assist_failed",
          phase: "matrix_deep_assist",
          attempt: "final",
          error: note,
        });
        failIfStrictQuality(
          strictQuality,
          `Strict quality mode: matrix deep-assist enrichment failed. ${note}`,
          "STRICT_MATRIX_DEEP_ASSIST_FAILED"
        );
        throw deepAssistErr;
      }
    }

    const earlyCoverageGate = evaluateMatrixEarlyCatastrophicCoverage(
      reconciledMatrix,
      subjects,
      attributes,
      config
    );
    state.analysisMeta.matrixEarlyCoverageGate = earlyCoverageGate.diagnostics;
    if (earlyCoverageGate.shouldAbort) {
      const note = cleanText(earlyCoverageGate.reason || "Matrix run aborted by early catastrophic coverage gate.");
      markDegraded(state.analysisMeta, "matrix_early_catastrophic_coverage_abort", note);
      appendAnalysisDebugEvent(debugSession, {
        type: "matrix_early_coverage_abort",
        phase: "matrix_targeted",
        note,
        diagnostics: earlyCoverageGate.diagnostics,
      });
      const abortErr = new Error(note);
      abortErr.code = "MATRIX_EARLY_COVERAGE_ABORT";
      abortErr.retryable = false;
      throw abortErr;
    }

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
      researchSetup,
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
    const criticFlags = normalizeCriticFlags(
      extractJson(criticRes?.text || criticRes, {}, {
        phase: "matrix_critic",
        attempt: "initial",
        prompt: criticPromptText,
        debugSession,
      }),
      subjects,
      attributes
    );
    const criticMonitoring = computeCriticFlagMonitoring({
      matrix: reconciledMatrix,
      criticFlags,
      config,
    });
    state.analysisMeta.criticCellsAudited = criticMonitoring.totalAuditedCells;
    state.analysisMeta.criticFlagsRaised = criticMonitoring.flagsRaised;
    state.analysisMeta.criticFlagRate = criticMonitoring.flagRate;
    state.analysisMeta.criticFlagRateLowConfidenceRate = criticMonitoring.lowConfidenceRate;
    state.analysisMeta.criticFlagRateAlert = criticMonitoring.alertMessage;
    if (criticMonitoring.alert) {
      appendAnalysisDebugEvent(debugSession, {
        type: "critic_flag_rate_alert",
        phase: "matrix_critic",
        flagRate: criticMonitoring.flagRate,
        lowConfidenceRate: criticMonitoring.lowConfidenceRate,
        thresholds: criticMonitoring.thresholds,
        note: criticMonitoring.alertMessage,
      });
    }
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
        researchSetup,
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
      const responses = normalizeAnalystResponses(
        extractJson(responseRes?.text || responseRes, {}, {
          phase: "matrix_response",
          attempt: "initial",
          prompt: responsePrompt,
          debugSession,
        }),
        subjects,
        attributes
      );

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
          full: cleanText(response.full || cell.full || response.value || cell.value),
          risks: cleanText(response.risks || cell.risks),
          arguments: normalizeMatrixCellArguments(response.arguments || cell.arguments || {}),
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

    update("matrix_consistency", {
      matrix: {
        ...state.matrix,
        ...resolvedMatrix,
        coverage: summarizeCoverage(resolvedMatrix.cells),
      },
      analysisMeta: state.analysisMeta,
    });

    try {
      const consistencyPrompt = buildMatrixConsistencyPrompt({
        decisionQuestion,
        subjects,
        attributes,
        matrix: resolvedMatrix,
      });
      const consistencyRes = await transport.callCritic(
        [{ role: "user", content: consistencyPrompt }],
        criticPrompt,
        Math.max(2600, Math.min(4200, criticTokens)),
        {
          ...roleOptions(config, "critic"),
          liveSearch: true,
          includeMeta: true,
        }
      );
      state.analysisMeta = mergeMeta(state.analysisMeta, consistencyRes?.meta, "critic");
      const consistencyParsed = extractJson(consistencyRes?.text || consistencyRes, {}, {
        phase: "matrix_consistency",
        attempt: "initial",
        prompt: consistencyPrompt,
        debugSession,
      });
      const consistencyFlags = normalizeConsistencyFlags(consistencyParsed, subjects, attributes);
      state.analysisMeta.matrixConsistencyFlags = consistencyFlags.length;
      if (consistencyFlags.length) {
        resolvedMatrix.cells = applyConsistencyFlags(resolvedMatrix.cells, consistencyFlags);
        resolvedMatrix.coverage = summarizeCoverage(resolvedMatrix.cells);
      }
      if (cleanText(consistencyParsed?.summary)) {
        resolvedMatrix.crossMatrixSummary = [
          cleanText(resolvedMatrix.crossMatrixSummary),
          `Consistency audit: ${cleanText(consistencyParsed.summary)}`,
        ].filter(Boolean).join(" ");
      }
    } catch (consistencyErr) {
      const note = consistencyErr?.message || "Matrix consistency audit failed.";
      markDegraded(state.analysisMeta, "matrix_consistency_audit_failed", note);
      appendAnalysisDebugEvent(debugSession, {
        type: "matrix_consistency_failed",
        phase: "matrix_consistency",
        attempt: "final",
        error: note,
      });
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: matrix consistency audit failed. ${note}`,
        "STRICT_MATRIX_CONSISTENCY_FAILED"
      );
    }

    if (derivedAttributes.length) {
      update("matrix_derived", {
        matrix: {
          ...state.matrix,
          ...resolvedMatrix,
          coverage: summarizeCoverage(resolvedMatrix.cells),
        },
        analysisMeta: state.analysisMeta,
      });
      try {
        const derivedPrompt = buildMatrixDerivedAttributesPrompt({
          rawInput: state.rawInput,
          decisionQuestion,
          subjects,
          baseAttributes,
          derivedAttributes,
          matrix: resolvedMatrix,
          researchSetup,
        });
        const derivedRes = await transport.callAnalyst(
          [{ role: "user", content: derivedPrompt }],
          analystPrompt,
          Math.max(2200, Math.min(4200, responseTokens)),
          {
            ...roleOptions(config, "analyst"),
            liveSearch: false,
            includeMeta: true,
          }
        );
        state.analysisMeta = mergeMeta(state.analysisMeta, derivedRes?.meta, "analyst");
        const derivedCells = normalizeDerivedCells(
          extractJson(derivedRes?.text || derivedRes, {}, {
            phase: "matrix_derived",
            attempt: "initial",
            prompt: derivedPrompt,
            debugSession,
          }),
          subjects,
          derivedAttributes
        );
        state.analysisMeta.matrixDerivedAttributeCount = derivedAttributes.length;
        state.analysisMeta.matrixDerivedGeneratedCount = derivedCells.length;
        if (derivedCells.length) {
          const merged = resolvedMatrix.cells.map((cell) => {
            const replacement = derivedCells.find((entry) => (
              entry.subjectId === cell.subjectId && entry.attributeId === cell.attributeId
            ));
            return replacement ? { ...cell, ...replacement } : cell;
          });
          const existingKeys = new Set(merged.map((cell) => buildCellKey(cell.subjectId, cell.attributeId)));
          derivedCells.forEach((entry) => {
            const key = buildCellKey(entry.subjectId, entry.attributeId);
            if (!existingKeys.has(key)) merged.push(entry);
          });
          resolvedMatrix.cells = merged;
          resolvedMatrix.coverage = summarizeCoverage(resolvedMatrix.cells);
          await verifyMatrixCellSources(resolvedMatrix, state.analysisMeta, sourceFetchCache, {
            penalizeConfidence: true,
            transport,
          });
        }
      } catch (derivedErr) {
        const note = derivedErr?.message || "Derived attribute generation failed.";
        markDegraded(state.analysisMeta, "matrix_derived_failed", note);
        appendAnalysisDebugEvent(debugSession, {
          type: "matrix_derived_failed",
          phase: "matrix_derived",
          attempt: "final",
          error: note,
        });
        failIfStrictQuality(
          strictQuality,
          `Strict quality mode: matrix derived attribute generation failed. ${note}`,
          "STRICT_MATRIX_DERIVED_FAILED"
        );
      }
    }

    update("matrix_red_team", {
      matrix: {
        ...state.matrix,
        ...resolvedMatrix,
        coverage: summarizeCoverage(resolvedMatrix.cells),
      },
      analysisMeta: state.analysisMeta,
    });

    try {
      const redTeamPrompt = buildMatrixRedTeamPrompt({
        rawInput: state.rawInput,
        decisionQuestion,
        matrix: resolvedMatrix,
        maxCells: Math.max(8, Math.min(24, Number(config?.limits?.matrixRedTeamMaxCells || 24))),
        researchSetup,
      });
      const redTeamRes = await transport.callCritic(
        [{ role: "user", content: redTeamPrompt }],
        cleanText(config?.prompts?.redTeam) || MATRIX_RED_TEAM_PROMPT,
        Math.max(2800, Math.min(4600, responseTokens)),
        {
          ...roleOptions(config, "critic"),
          liveSearch: false,
          includeMeta: true,
        }
      );
      state.analysisMeta = mergeMeta(state.analysisMeta, redTeamRes?.meta, "critic");
      const parsedRedTeam = extractJson(redTeamRes?.text || redTeamRes, {}, {
        phase: "matrix_red_team",
        attempt: "initial",
        prompt: redTeamPrompt,
        debugSession,
      });
      const redTeamApplied = applyMatrixRedTeam(resolvedMatrix, parsedRedTeam, subjects, attributes);
      resolvedMatrix.cells = redTeamApplied.matrix.cells;
      resolvedMatrix.redTeam = redTeamApplied.matrix.redTeam;
      state.analysisMeta.redTeamCallMade = true;
      state.analysisMeta.redTeamHighSeverityCount = Number(redTeamApplied.highSeverityCount || 0);
    } catch (redTeamErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "matrix_red_team_failed",
        phase: "matrix_red_team",
        attempt: "final",
        error: cleanText(redTeamErr?.message || "matrix_red_team_failed"),
      });
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: matrix red-team pass failed. ${cleanText(redTeamErr?.message || "matrix_red_team_failed")}`,
        "STRICT_MATRIX_RED_TEAM_FAILED"
      );
    }

    update("matrix_synthesis", {
      matrix: {
        ...state.matrix,
        ...resolvedMatrix,
        coverage: summarizeCoverage(resolvedMatrix.cells),
      },
      analysisMeta: state.analysisMeta,
    });

    try {
      const synthesisPrompt = buildMatrixSynthesizerPrompt({
        rawInput: state.rawInput,
        decisionQuestion,
        matrix: resolvedMatrix,
        analysisMeta: state.analysisMeta,
        researchSetup,
      });
      const synthOptions = roleOptionsWithFallback(config, "synthesizer", "critic");
      const synthCaller = typeof transport.callSynthesizer === "function"
        ? transport.callSynthesizer.bind(transport)
        : (typeof transport.callCritic === "function"
          ? transport.callCritic.bind(transport)
          : transport.callAnalyst.bind(transport));
      const synthesisRes = await synthCaller(
        [{ role: "user", content: synthesisPrompt }],
        cleanText(config?.prompts?.synthesizer) || cleanText(config?.prompts?.analystResponse) || MATRIX_ANALYST_PROMPT,
        Math.max(2800, Math.min(4600, responseTokens)),
        {
          ...synthOptions,
          liveSearch: false,
          includeMeta: true,
        }
      );
      state.analysisMeta = mergeMeta(state.analysisMeta, synthesisRes?.meta, "analyst");
      state.analysisMeta.synthesizerCallMade = true;
      state.analysisMeta.synthesizerModel = modelSignatureFromOptions(synthOptions);
      const parsedSynthesis = extractJson(synthesisRes?.text || synthesisRes, {}, {
        phase: "matrix_synthesis",
        attempt: "initial",
        prompt: synthesisPrompt,
        debugSession,
      });
      resolvedMatrix.executiveSummary = {
        decisionAnswer: cleanText(parsedSynthesis?.decisionAnswer),
        closestThreats: cleanText(parsedSynthesis?.closestThreats),
        whitespace: cleanText(parsedSynthesis?.whitespace),
        strategicClassification: cleanText(parsedSynthesis?.strategicClassification),
        keyRisks: cleanText(parsedSynthesis?.keyRisks),
        decisionImplications: cleanText(parsedSynthesis?.decisionImplications),
        uncertaintyNotes: cleanText(parsedSynthesis?.uncertaintyNotes),
        providerAgreementHighlights: cleanText(parsedSynthesis?.providerAgreementHighlights),
      };
    } catch (synthesisErr) {
      const note = synthesisErr?.message || "Matrix executive synthesis failed.";
      markDegraded(state.analysisMeta, "matrix_executive_synthesis_failed", note);
      appendAnalysisDebugEvent(debugSession, {
        type: "matrix_synthesis_failed",
        phase: "matrix_synthesis",
        attempt: "final",
        error: note,
      });
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: matrix executive synthesis failed. ${note}`,
        "STRICT_MATRIX_SYNTHESIS_FAILED"
      );
      resolvedMatrix.executiveSummary = resolvedMatrix.executiveSummary || {
        decisionAnswer: "",
        closestThreats: "",
        whitespace: "",
        strategicClassification: "",
        keyRisks: "",
        decisionImplications: "",
        uncertaintyNotes: "",
        providerAgreementHighlights: "",
      };
    }

    update("matrix_summary", {
      matrix: {
        ...state.matrix,
        ...resolvedMatrix,
        coverage: summarizeCoverage(resolvedMatrix.cells),
      },
      analysisMeta: state.analysisMeta,
    });

    const coverageSlaResult = evaluateMatrixCoverageSla(resolvedMatrix, subjects, attributes, config);
    state.analysisMeta.matrixCoverageSLA = coverageSlaResult.diagnostics;
    state.analysisMeta.matrixCoverageSLAPassed = !!coverageSlaResult.pass;
    state.analysisMeta.matrixCoverageSLAFailureReason = coverageSlaResult.failureReason || "";
    if (!coverageSlaResult.pass) {
      appendAnalysisDebugEvent(debugSession, {
        type: "coverage_sla_failed",
        phase: "matrix_summary",
        diagnostics: coverageSlaResult.diagnostics,
        note: coverageSlaResult.failureReason,
      });
      markDegraded(
        state.analysisMeta,
        "matrix_coverage_sla_failed",
        coverageSlaResult.failureReason || "Matrix coverage requirements were not met."
      );
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: matrix coverage SLA failed. ${coverageSlaResult.failureReason || "Matrix coverage requirements were not met."}`,
        "STRICT_MATRIX_COVERAGE_SLA_FAILED"
      );
    }

    const decisionGradeResult = evaluateMatrixDecisionGrade({
      matrix: resolvedMatrix,
      subjects,
      attributes,
      analysisMeta: state.analysisMeta,
      requiredSubjects: resolvedInput?.requiredSubjects || [],
      config,
    });
    state.analysisMeta.decisionGradeGate = decisionGradeResult.diagnostics;
    state.analysisMeta.decisionGradePassed = !!decisionGradeResult.pass;
    state.analysisMeta.decisionGradeFailureReason = decisionGradeResult.failureReason || "";
    if (!decisionGradeResult.pass) {
      appendAnalysisDebugEvent(debugSession, {
        type: "decision_grade_failed",
        phase: "matrix_summary",
        diagnostics: decisionGradeResult.diagnostics,
        note: decisionGradeResult.failureReason,
      });
      markDegraded(
        state.analysisMeta,
        "matrix_decision_grade_failed",
        decisionGradeResult.failureReason || "Decision-grade gate requirements were not met."
      );
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: matrix decision-grade gate failed. ${decisionGradeResult.failureReason || "Decision-grade gate requirements were not met."}`,
        "STRICT_MATRIX_DECISION_GRADE_FAILED"
      );
    }

    const staleObservedCells = Number(state.analysisMeta.staleEvidenceObservedCells || 0);
    state.analysisMeta.staleEvidenceRatio = staleObservedCells
      ? Number(state.analysisMeta.staleEvidenceRatioSum || 0) / staleObservedCells
      : 0;
    state.analysisMeta.sourceUniverse = buildMatrixSourceUniverse(resolvedMatrix);
    state.analysisMeta.providerContributions = {
      ...(state.analysisMeta.providerContributions || {}),
      native: [
        { provider: "analyst", webSearchCalls: Number(state.analysisMeta.webSearchCalls || 0) },
        { provider: "critic", webSearchCalls: Number(state.analysisMeta.criticWebSearchCalls || 0) },
        { provider: "targeted", webSearchCalls: Number(state.analysisMeta.lowConfidenceTargetedWebSearchCalls || 0) },
        { provider: "discovery", webSearchCalls: Number(state.analysisMeta.discoveryWebSearchCalls || 0) },
      ],
    };
    setCompletionState(state.analysisMeta, "complete");

    if (relatedDiscovery) {
      update("matrix_discover", {});
      let discovery = {
        suggestedSubjects: [],
        suggestedAttributes: [],
        notes: "",
      };
      try {
        const discoveryPromptText = buildMatrixDiscoveryPrompt({
          rawInput: state.rawInput,
          decisionQuestion,
          subjects,
          attributes,
          researchSetup,
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
        discovery = normalizeMatrixDiscovery(
          extractJson(discoverRes?.text || discoverRes, {}, {
            phase: "matrix_discover",
            attempt: "initial",
            prompt: discoveryPromptText,
            debugSession,
          })
        );
      } catch (discoveryErr) {
        state.analysisMeta.discoveryFailureReason = cleanText(discoveryErr?.message || "Discovery step failed.");
        appendAnalysisDebugEvent(debugSession, {
          type: "phase_degraded",
          phase: "matrix_discover",
          note: state.analysisMeta.discoveryFailureReason,
        });
        failIfStrictQuality(
          strictQuality,
          `Strict quality mode: matrix discovery failed. ${state.analysisMeta.discoveryFailureReason}`,
          "STRICT_MATRIX_DISCOVERY_FAILED"
        );
      }

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
    setCompletionState(
      state.analysisMeta,
      "failed",
      "matrix_pipeline_failed",
      err?.message || String(err)
    );
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
