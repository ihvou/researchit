import { safeParseJSON, buildDimRubrics } from "../lib/json.js";
import { buildRubricCalibrationBlock } from "../lib/rubric.js";
import { normalizeConfidenceLevel } from "../lib/confidence.js";
import { ensureDimensionArgumentShape } from "../lib/arguments.js";
import { runMatrixAnalysis } from "./matrix.js";
import {
  createAnalysisDebugSession,
  appendAnalysisDebugEvent,
  finalizeAnalysisDebugSession,
} from "../lib/debug.js";
import { SYS_ANALYST, SYS_CRITIC, SYS_ANALYST_RESPONSE, SYS_RED_TEAM } from "../prompts/defaults.js";

let ACTIVE_RUNTIME = null;
const DEFAULT_DEEP_ASSIST_PROVIDERS = ["chatgpt", "claude", "gemini"];

function cleanString(value) {
  return String(value || "").trim();
}

function normalizeEvidenceMode(value) {
  return cleanString(value).toLowerCase() === "deep-assist" ? "deep-assist" : "native";
}

function normalizeResearchSetupContext(raw = {}) {
  const setup = raw && typeof raw === "object" ? raw : {};
  return {
    decisionContext: cleanString(setup.decisionContext),
    userRoleContext: cleanString(setup.userRoleContext),
  };
}

function normalizeStrictQuality(value) {
  const raw = cleanString(value).toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function failIfStrictQuality(strictQuality, message, code = "STRICT_QUALITY_ABORT") {
  if (!strictQuality) return;
  const err = new Error(cleanString(message) || "Strict quality mode aborted the run.");
  err.code = code;
  err.retryable = false;
  throw err;
}

function buildResearchSetupContextBlock(researchSetup = {}) {
  const context = normalizeResearchSetupContext(researchSetup);
  const lines = [
    context.decisionContext
      ? `Decision context: ${context.decisionContext}`
      : "Decision context: not provided.",
    context.userRoleContext
      ? `User role/context: ${context.userRoleContext}`
      : "User role/context: not provided.",
  ];
  return lines.join("\n");
}

function ensureDegradedMeta(analysisMeta = {}) {
  if (!analysisMeta || typeof analysisMeta !== "object") return;
  if (!analysisMeta.qualityGrade) analysisMeta.qualityGrade = "standard";
  if (!Array.isArray(analysisMeta.degradedReasons)) analysisMeta.degradedReasons = [];
}

function markDegraded(analysisMeta = {}, reasonCode = "quality_guard", detail = "") {
  ensureDegradedMeta(analysisMeta);
  analysisMeta.qualityGrade = "degraded";
  const entry = {
    code: cleanString(reasonCode) || "quality_guard",
    detail: cleanString(detail),
  };
  const already = analysisMeta.degradedReasons.some((item) => item?.code === entry.code && item?.detail === entry.detail);
  if (!already) analysisMeta.degradedReasons.push(entry);
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
  const message = cleanString(err?.message || err);
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
  const code = cleanString(normalizedFailure.code) || "deep_assist_provider_failed";
  const detail = cleanString(normalizedFailure.detail);
  const provider = cleanString(providerId);
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
        cleanString(failureDetail) || "Analysis did not reach a completed terminal state."
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
      .map((item) => cleanString(item?.code))
      .filter(Boolean)
  )];
}

function normalizeDeepAssistOptions(raw = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const providers = Array.isArray(input.providers)
    ? input.providers.map((value) => cleanString(value).toLowerCase()).filter(Boolean)
    : [];
  const selected = providers.length ? [...new Set(providers)] : DEFAULT_DEEP_ASSIST_PROVIDERS;
  const minProviders = Math.max(1, Math.min(selected.length, Number(input.minProviders) || 2));
  const maxWaitMs = Math.max(20000, Number(input.maxWaitMs) || 300000);
  const maxRetries = Math.max(0, Math.min(3, Number(input.maxRetries) || 1));
  return {
    providers: selected,
    minProviders,
    maxWaitMs,
    maxRetries,
  };
}

function deepAssistProviderLabel(providerId) {
  const key = cleanString(providerId).toLowerCase();
  if (key === "chatgpt") return "ChatGPT";
  if (key === "claude") return "Claude";
  if (key === "gemini") return "Gemini";
  return key || "Provider";
}

function resolveDeepAssistProviderRequestOptions(providerId, role = "analyst", deepAssistOptions = null) {
  const runtime = getRuntime();
  const providerKey = cleanString(providerId).toLowerCase();
  const roleDefaults = runtime?.models?.[role] || {};
  const providerDefaults = runtime?.deepAssist?.providers?.[providerKey] || {};
  const providerRoleCfg = providerDefaults?.[role] && typeof providerDefaults?.[role] === "object"
    ? providerDefaults[role]
    : providerDefaults;

  const maxWaitMs = Math.max(20000, Number(deepAssistOptions?.maxWaitMs) || 300000);
  const maxRetries = Math.max(0, Math.min(3, Number(deepAssistOptions?.maxRetries) || 1));
  return {
    provider: cleanString(providerRoleCfg?.provider || roleDefaults?.provider || "openai"),
    model: cleanString(providerRoleCfg?.model || roleDefaults?.model),
    webSearchModel: cleanString(
      providerRoleCfg?.webSearchModel
      || providerRoleCfg?.model
      || roleDefaults?.webSearchModel
      || roleDefaults?.model
    ),
    baseUrl: cleanString(providerRoleCfg?.baseUrl || roleDefaults?.baseUrl),
    timeoutMs: maxWaitMs,
    retry: { maxRetries },
  };
}

function getRuntime() {
  if (!ACTIVE_RUNTIME) throw new Error("Analysis runtime is not initialized.");
  return ACTIVE_RUNTIME;
}

function withRoleModelOptions(role, options = {}) {
  const runtime = getRuntime();
  const modelCfg = runtime?.models?.[role] || {};
  const merged = { ...(options || {}) };
  if (!merged.provider && typeof modelCfg.provider === "string" && modelCfg.provider.trim()) {
    merged.provider = modelCfg.provider.trim();
  }
  if (!merged.model && typeof modelCfg.model === "string" && modelCfg.model.trim()) {
    merged.model = modelCfg.model.trim();
  }
  if (!merged.webSearchModel && typeof modelCfg.webSearchModel === "string" && modelCfg.webSearchModel.trim()) {
    merged.webSearchModel = modelCfg.webSearchModel.trim();
  }
  if (!merged.baseUrl && typeof modelCfg.baseUrl === "string" && modelCfg.baseUrl.trim()) {
    merged.baseUrl = modelCfg.baseUrl.trim();
  }
  return merged;
}

function withCapabilityModelOptions(capability, fallbackRole = "analyst", options = {}) {
  const runtime = getRuntime();
  const capabilityKey = cleanString(capability);
  const capabilityCfg = capabilityKey ? runtime?.models?.[capabilityKey] : null;
  const merged = { ...(options || {}) };
  const hasCapabilityConfig = !!(capabilityCfg && typeof capabilityCfg === "object" && (
    cleanString(capabilityCfg.provider)
    || cleanString(capabilityCfg.model)
    || cleanString(capabilityCfg.webSearchModel)
    || cleanString(capabilityCfg.baseUrl)
  ));
  if (hasCapabilityConfig) {
    if (!merged.provider && cleanString(capabilityCfg.provider)) merged.provider = cleanString(capabilityCfg.provider);
    if (!merged.model && cleanString(capabilityCfg.model)) merged.model = cleanString(capabilityCfg.model);
    if (!merged.webSearchModel && cleanString(capabilityCfg.webSearchModel)) merged.webSearchModel = cleanString(capabilityCfg.webSearchModel);
    if (!merged.baseUrl && cleanString(capabilityCfg.baseUrl)) merged.baseUrl = cleanString(capabilityCfg.baseUrl);
    return withRoleModelOptions(fallbackRole, merged);
  }
  if (capabilityKey === "retrieval") {
    return merged;
  }
  return withRoleModelOptions(fallbackRole, merged);
}

async function callAnalystAPI(messages, systemPrompt, maxTokens = 5000, options = {}) {
  const merged = withRoleModelOptions("analyst", options);
  return getRuntime().transport.callAnalyst(messages, systemPrompt, maxTokens, merged);
}

async function callCriticAPI(messages, systemPrompt, maxTokens = 5000, options = {}) {
  const merged = withRoleModelOptions("critic", options);
  return getRuntime().transport.callCritic(messages, systemPrompt, maxTokens, merged);
}

function withRoleModelOptionsFallback(primaryRole, fallbackRole, options = {}) {
  const primary = withRoleModelOptions(primaryRole, {});
  const fallback = withRoleModelOptions(fallbackRole, {});
  const merged = { ...(options || {}) };
  if (!merged.provider && (primary.provider || fallback.provider)) merged.provider = primary.provider || fallback.provider;
  if (!merged.model && (primary.model || fallback.model)) merged.model = primary.model || fallback.model;
  if (!merged.webSearchModel && (primary.webSearchModel || fallback.webSearchModel)) {
    merged.webSearchModel = primary.webSearchModel || fallback.webSearchModel;
  }
  if (!merged.baseUrl && (primary.baseUrl || fallback.baseUrl)) merged.baseUrl = primary.baseUrl || fallback.baseUrl;
  return merged;
}

function modelSignatureFromOptions(options = {}) {
  const provider = cleanString(options?.provider) || "default";
  const model = cleanString(options?.model) || "default";
  return `${provider}:${model}`;
}

async function callSynthesizerAPI(messages, systemPrompt, maxTokens = 4200, options = {}) {
  const merged = withRoleModelOptionsFallback("synthesizer", "critic", options);
  const transport = getRuntime().transport;
  const callSynth = typeof transport?.callSynthesizer === "function"
    ? transport.callSynthesizer.bind(transport)
    : (typeof transport?.callCritic === "function"
      ? transport.callCritic.bind(transport)
      : transport.callAnalyst.bind(transport));
  return {
    options: merged,
    response: await callSynth(messages, systemPrompt, maxTokens, merged),
  };
}

function analystPrompt() {
  return getRuntime()?.prompts?.analyst || SYS_ANALYST;
}

function buildDimJsonTemplate(dims, condensed = false) {
  if (condensed) {
    return dims.map((d) =>
      `"${d.id}": {"score": <1-5>, "confidence": "<high|medium|low>", "confidenceReason": "<1 sentence>", "brief": "<max 20 words>", "full": "<1 paragraph, max 80 words, cite 1-2 named companies>", "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}], "risks": "<max 20 words>", "arguments": {"supporting":[{"id":"sup-1","claim":"<max 12 words>","detail":"<max 18 words>","sources":[{"name":"...","quote":"<max 12 words>","url":"..."}]}], "limiting":[{"id":"lim-1","claim":"<max 12 words>","detail":"<max 18 words>","sources":[{"name":"...","quote":"<max 12 words>","url":"..."}]}]}}`
    ).join(",\n    ");
  }

  return dims.map((d) =>
    `"${d.id}": {
      "score": <integer 1-5 based on rubric>,
      "confidence": "<high|medium|low>",
      "confidenceReason": "<1 sentence: why confidence is at this level>",
      "brief": "<single sentence summary, max 25 words>",
      "full": "<detailed 3-5 paragraph analysis citing named companies with specific metrics, trends, and market context>",
      "sources": [
        {"name": "<source name>", "quote": "<paraphrased insight, max 15 words>", "url": "<real URL if known, else omit field>"}
      ],
      "risks": "<1-2 sentences on key risks or caveats for this dimension>",
      "arguments": {
        "supporting": [
          {
            "id": "<stable id like sup-1>",
            "claim": "<bold one-line supporting claim>",
            "detail": "<1-2 sentence explanation>",
            "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}]
          }
        ],
        "limiting": [
          {
            "id": "<stable id like lim-1>",
            "claim": "<bold one-line limiting claim>",
            "detail": "<1-2 sentence explanation>",
            "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}]
          }
        ]
      }
    }`
  ).join(",\n    ");
}

function buildDimEvidenceJsonTemplate(dims, condensed = false) {
  if (condensed) {
    return dims.map((d) =>
      `"${d.id}": {"evidence": [{"point": "<max 16 words>", "relevance": "<max 10 words>", "source": {"name": "...", "quote": "<max 12 words>", "url": "...", "sourceType": "<vendor|press|independent>"}}], "missingEvidence": "<max 20 words>"}`
    ).join(",\n    ");
  }

  return dims.map((d) =>
    `"${d.id}": {
      "evidence": [
        {
          "point": "<discrete verifiable fact or market signal>",
          "relevance": "<why this matters for this dimension>",
          "source": {"name": "<source name>", "quote": "<paraphrased insight, max 15 words>", "url": "<real URL if known>", "sourceType": "<vendor|press|independent>"}
        }
      ],
      "missingEvidence": "<what key evidence is still missing for strong confidence>"
    }`
  ).join(",\n    ");
}

const DEFAULT_PROMPT_FRAMING_FIELDS = [
  { id: "researchObject", label: "Research Object", description: "What is being evaluated." },
  { id: "decisionQuestion", label: "Decision Question", description: "What decision this research informs." },
  { id: "scopeContext", label: "Scope / Context", description: "Explicit segment/geo/timeframe/constraint boundaries." },
];

function normalizePromptFramingFields(fields = []) {
  const input = Array.isArray(fields) ? fields : [];
  const normalized = input
    .map((field, idx) => {
      const rawId = String(field?.id || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
      const fallbackId = `field_${idx + 1}`;
      const id = rawId || fallbackId;
      return {
        id,
        label: String(field?.label || rawId || fallbackId).trim() || fallbackId,
        description: String(field?.description || "").trim(),
      };
    })
    .filter((field) => field.id);
  return normalized.length ? normalized : DEFAULT_PROMPT_FRAMING_FIELDS;
}

function buildFramingFieldsTemplate(framingFields, condensed = false) {
  const fields = normalizePromptFramingFields(framingFields);
  if (condensed) {
    return fields
      .map((field) => `"${field.id}": "<extracted value or unspecified>"`)
      .join(", ");
  }
  return fields
    .map((field) => `        "${field.id}": "<extracted value or unspecified>"`)
    .join(",\n");
}

function buildInputFramingRulesBlock(inputSpec = {}, framingFields = []) {
  const description = String(inputSpec?.description || "").trim();
  const fields = normalizePromptFramingFields(framingFields);
  const fieldLines = fields
    .map((field) => `- ${field.label} (${field.id}): ${field.description || "extract only from explicit user input; otherwise set to \"unspecified\"."}`)
    .join("\n");

  return `INPUT FRAMING RULES:
- Input expectation for this research type: ${description || "Accept broad or detailed user input."}
- Preserve user wording in "attributes.inputFrame.providedInput" (verbatim, do not rewrite).
- Never invent specifics (segment, buyer, geography, timeline, budget, metrics). If not explicitly stated, set field value to "unspecified".
- "assumptionsUsed" must be [] unless an assumption is strictly necessary; any assumption must be explicit and minimal.
- "confidenceLimits" must describe what cannot be concluded due to missing specificity or evidence.
- Populate "attributes.inputFrame.framingFields" using:
${fieldLines}`;
}

function buildAttributesTemplate({ condensed = false, framingFields = [] } = {}) {
  const framingFieldsTemplate = buildFramingFieldsTemplate(framingFields, condensed);
  if (condensed) {
    return `{"title":"<max 8 words>","problemStatement":"<adaptive 1-8 sentences>","solutionStatement":"<adaptive 1-8 sentences>","expandedDescription":"<2 sentences>","vertical":"<industry or unspecified>","buyerPersona":"<role or unspecified>","aiSolutionType":"<AI/ML type or unspecified>","typicalTimeline":"<estimate or unspecified>","deliveryModel":"<engagement type or unspecified>","inputFrame":{"providedInput":"<exact user input>","framingFields":{${framingFieldsTemplate}},"assumptionsUsed":[],"confidenceLimits":"<what remains unknown>"}}`;
  }
  return `{
    "title": "<descriptive title, max 8 words>",
    "problemStatement": "<adaptive detail: short input => 1-2 sentences; detailed input => 6-8 sentences (business pain, constraints, impact)>",
    "solutionStatement": "<adaptive detail: short input => 1-2 sentences; detailed input => 6-8 sentences (approach, workflow, value path)>",
    "expandedDescription": "<2-3 sentences: neutral summary of what is being evaluated>",
    "vertical": "<primary industry vertical or unspecified>",
    "buyerPersona": "<primary decision maker role or unspecified>",
    "aiSolutionType": "<specific AI/ML technology type or unspecified>",
    "typicalTimeline": "<realistic end-to-end estimate or unspecified>",
    "deliveryModel": "<engagement type or unspecified>",
    "inputFrame": {
      "providedInput": "<repeat user input verbatim>",
      "framingFields": {
${framingFieldsTemplate}
      },
      "assumptionsUsed": [],
      "confidenceLimits": "<what cannot be concluded from provided input/evidence>"
    }
  }`;
}

function extractDimensionSearchKeywords(dim, max = 6) {
  const source = `${dim?.label || ""} ${dim?.brief || ""} ${dim?.fullDef || ""}`.toLowerCase();
  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "your", "across",
    "where", "when", "what", "which", "while", "about", "than", "over", "under",
    "score", "scores", "dimension", "use", "case", "cases", "does", "into", "also",
    "must", "should", "would", "could", "have", "has", "had", "been", "being",
    "there", "their", "them", "they", "across", "within", "without", "only",
    "more", "less", "very", "high", "medium", "low", "client", "clients", "project",
    "delivery", "outsourcer", "outsourcing", "enterprise", "business",
  ]);

  const terms = source
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !stopWords.has(t));

  const seen = new Set();
  const unique = [];
  for (const term of terms) {
    if (seen.has(term)) continue;
    seen.add(term);
    unique.push(term);
    if (unique.length >= max) break;
  }
  return unique;
}

function extractDimensionSearchIntent(dim) {
  const lines = String(dim?.fullDef || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const keyLine = lines.find((line) => /^(important|critical|scope|outsourcing|polarity|scoring method)/i.test(line))
    || lines.find((line) => /^score 5/i.test(line))
    || lines[0]
    || "";
  return clip(keyLine.replace(/\s+/g, " "), 180);
}

function buildDynamicSearchPlan(dims, topCount = 3) {
  const targets = [...dims]
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
    .slice(0, Math.min(topCount, dims.length));

  return targets.map((dim) => {
    const keywords = extractDimensionSearchKeywords(dim, 6);
    const keywordTail = keywords.length ? ` ${keywords.join(" ")}` : "";
    const queryA = `"[vertical] [use case] ${dim.label} named deployment metrics${keywordTail} 2024 2025"`;
    const queryB = `"[use case] ${dim.label} independent benchmark case study${keywordTail}"`;
    return [
      `- ${dim.label} [${dim.id}] (weight ${dim.weight}%): run at least 1 dedicated query.`,
      `  - Rubric focus: ${extractDimensionSearchIntent(dim) || dim.brief || "Find evidence directly tied to this dimension rubric."}`,
      `  - Suggested templates: ${queryA} | ${queryB}`,
    ].join("\n");
  }).join("\n");
}

function buildPhase1EvidencePrompt(desc, dims, {
  liveSearch = false,
  condensed = false,
  inputSpec = {},
  framingFields = [],
  researchSetup = {},
} = {}) {
  const mandatorySearchPlan = buildDynamicSearchPlan(dims, 3);
  const setupContext = buildResearchSetupContextBlock(researchSetup);

  const liveSearchBlock = liveSearch
    ? `\nLIVE SEARCH MODE:
- Use web search to verify high-confidence claims.
- Prefer current sources (last 24 months) where possible.
- Include real URLs for each dimension when available.
- MANDATORY SEARCH DEPTH: before finalizing JSON, run dedicated searches for:
${mandatorySearchPlan}
- If a mandatory search returns no reliable evidence, state that explicitly in that dimension's "missingEvidence" field with the query intent.\n`
    : "";

  const evidenceTemplate = buildDimEvidenceJsonTemplate(dims, condensed);
  const attributesTemplate = buildAttributesTemplate({ condensed, framingFields });
  const framingRules = buildInputFramingRulesBlock(inputSpec, framingFields);

  return `Step 1 of 2 - EVIDENCE ENUMERATION ONLY.
Analyze this strategic research input:

"${desc}"

RUN CONTEXT:
${setupContext}

SCORING DIMENSIONS (for relevance only in this step - DO NOT SCORE YET):
${buildDimRubrics(dims)}${liveSearchBlock}
PROBLEM / SOLUTION DETAIL RULE:
- Keep statements proportional to user input detail.
- If input is short/high-level, keep each statement concise (1-2 sentences).
- If input is detailed, summarize with richer detail (6-8 sentences per statement).
${framingRules}

Rules for this step:
- Enumerate evidence only: verifiable facts, deployments, metrics, market signals, and caveats.
- Do NOT assign scores, confidence levels, or narrative conclusions.
- Keep evidence discrete (bullet-like facts), not long prose.
- Source credibility is mandatory per evidence point:
  - sourceType "vendor": vendor blog, product page, self-reported marketing claim.
  - sourceType "press": major press, earnings call, regulatory filing.
  - sourceType "independent": peer-reviewed, benchmark, audit, neutral analyst research.
- If a dimension relies mostly on vendor claims, state that clearly in "missingEvidence" and request independent corroboration.

Return ONLY this JSON structure, fully populated for ALL dimension IDs (${dims.map((d) => d.id).join(", ")}):

{
  "attributes": ${attributesTemplate},
  "dimensions": {
    ${evidenceTemplate}
  }
}`;
}

function buildPhase1ScoringPrompt(desc, dims, evidencePayload, {
  condensed = false,
  passLabel = "initial analyst pass",
  framingFields = [],
  researchSetup = {},
} = {}) {
  const dimTemplate = buildDimJsonTemplate(dims, condensed);
  const attrsTemplate = buildAttributesTemplate({ condensed, framingFields });
  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Step 2 of 2 - RUBRIC SCORING FROM ENUMERATED EVIDENCE.
Use case:
"${desc}"

Run context:
${setupContext}

Pass context:
${passLabel}

Enumerated evidence from Step 1:
${JSON.stringify(evidencePayload || {}, null, 2)}

Rubric:
${buildDimRubrics(dims)}

Confidence calibration (required for every dimension):
- High: named deployments with verifiable metrics and strong market familiarity.
- Medium: deployments exist but evidence is sparse, self-reported, or rapidly changing.
- Low: fewer than two verifiable deployments, underrepresented vertical, or heavy extrapolation.

Hard rules:
- Derive scores mechanically from the enumerated evidence above.
- Do NOT add new facts, deployments, or claims not present in Step 1 evidence.
- If evidence is weak or mixed, score conservatively and explain limits.
- Do not assign score 4-5 when confidence is low or evidence language is mostly weak/uncertain.
- If score is 4-5, include explicit strong-evidence wording (for example multiple verifiable deployments or independent corroboration).
- Keep attributes consistent with Step 1 unless a clear correction is needed.
- Keep "attributes.inputFrame.providedInput" verbatim.
- Do not infer missing specifics in framing fields; keep "unspecified" where missing.
- Keep "assumptionsUsed" explicit and minimal (empty array when none).

Return ONLY this JSON:
{
  "attributes": ${attrsTemplate},
  "dimensions": {
    ${dimTemplate}
  }
}`;
}

function clip(text, max = 260) {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function shortText(value, max = 1800) {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}... [trimmed]`;
}

function clampScore(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function normalizeSourceList(items, maxItems = 12) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const source = {
      name: String(item.name || "").trim(),
      quote: String(item.quote || "").trim(),
      url: String(item.url || "").trim(),
      sourceType: String(item.sourceType || "").trim().toLowerCase(),
      verificationStatus: String(item.verificationStatus || "").trim(),
      verificationNote: String(item.verificationNote || "").trim(),
      displayStatus: String(item.displayStatus || "").trim().toLowerCase(),
    };
    if (!source.name && !source.quote && !source.url) continue;
    if (!source.displayStatus) {
      source.displayStatus = deriveSourceDisplayStatus(source, { staleEvidenceRatio: null });
    }
    const key = `${source.name}|${source.quote}|${source.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
    if (out.length >= maxItems) break;
  }
  return out;
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

function isVendorPrimaryDimension(dimensionId = "", dimensionLabel = "") {
  const text = `${cleanString(dimensionId)} ${cleanString(dimensionLabel)}`.toLowerCase();
  if (!text) return false;
  return (
    /\b(icp|persona|buyer|segment|positioning|pricing|price|tier|package|channel|acquisition|gtm|workflow)\b/.test(text)
    || text.includes("target-icp")
    || text.includes("core-position")
  );
}

function deriveSourceDisplayStatus(source = {}, options = {}) {
  const verificationStatus = cleanString(source?.verificationStatus);
  const sourceType = cleanString(source?.sourceType).toLowerCase();
  const staleEvidenceRatio = Number(options?.staleEvidenceRatio);
  const dimensionId = cleanString(options?.dimensionId);
  const dimensionLabel = cleanString(options?.dimensionLabel);
  const allowVendorAsPrimary = !!options?.allowVendorAsPrimary || isVendorPrimaryDimension(dimensionId, dimensionLabel);
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
  if (sourceType === "independent" || sourceType === "press") {
    return "corroborating";
  }
  return "unverified";
}

function annotateSourceListDisplayStatus(sources = [], options = {}) {
  return normalizeSourceList(sources, 40).map((source) => ({
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

function mergeSourceUniverseCounts(target = {}, source = {}) {
  target.cited = Number(target.cited || 0) + Number(source.cited || 0);
  target.corroborating = Number(target.corroborating || 0) + Number(source.corroborating || 0);
  target.unverified = Number(target.unverified || 0) + Number(source.unverified || 0);
  target.excludedMarketing = Number(target.excludedMarketing || 0) + Number(source.excludedMarketing || 0);
  target.excludedStale = Number(target.excludedStale || 0) + Number(source.excludedStale || 0);
  target.total = Number(target.total || 0) + Number(source.total || 0);
  return target;
}

function buildScorecardSourceUniverse(payload = {}, dims = []) {
  const totals = emptySourceUniverseSummary();
  const seen = new Set();
  const addSource = (source = {}) => {
    if (!source || typeof source !== "object") return;
    const key = `${cleanString(source.name)}|${cleanString(source.quote)}|${cleanString(source.url)}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    const status = cleanString(source.displayStatus).toLowerCase() || deriveSourceDisplayStatus(source, { staleEvidenceRatio: null });
    if (status === "cited") totals.cited += 1;
    else if (status === "corroborating") totals.corroborating += 1;
    else if (status === "excluded_marketing") totals.excludedMarketing += 1;
    else if (status === "excluded_stale") totals.excludedStale += 1;
    else totals.unverified += 1;
    totals.total += 1;
  };

  if (Array.isArray(payload?.sources)) {
    annotateSourceListDisplayStatus(payload.sources).forEach(addSource);
  }

  (Array.isArray(dims) ? dims : []).forEach((dim) => {
    const dimState = payload?.dimensions?.[dim?.id] || {};
    const staleEvidenceRatio = Number(dimState?.staleEvidenceRatio);
    const sources = annotateSourceListDisplayStatus(dimState?.sources, {
      staleEvidenceRatio: Number.isFinite(staleEvidenceRatio) ? staleEvidenceRatio : null,
      dimensionId: cleanString(dim?.id),
      dimensionLabel: cleanString(dim?.label),
    });
    sources.forEach(addSource);
    const supporting = Array.isArray(dimState?.arguments?.supporting) ? dimState.arguments.supporting : [];
    const limiting = Array.isArray(dimState?.arguments?.limiting) ? dimState.arguments.limiting : [];
    [...supporting, ...limiting].forEach((arg) => {
      annotateSourceListDisplayStatus(arg?.sources, {
        dimensionId: cleanString(dim?.id),
        dimensionLabel: cleanString(dim?.label),
      }).forEach(addSource);
    });
  });

  return totals;
}

function mergeSourceLists(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    const normalized = normalizeSourceList(list, 40);
    for (const source of normalized) {
      const key = `${source.name}|${source.quote}|${source.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(source);
    }
  }
  return out.slice(0, 16);
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

function stripExistingVerificationReason(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  return raw.replace(/\s*Source verification check:[^.]*\.\s*/gi, " ").replace(/\s+/g, " ").trim();
}

function normalizeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch (_) {
    return "";
  }
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
  if (!pageText) {
    return { verified: false, matchType: "none", quoteCoverage: 0 };
  }

  const normalizedQuote = normalizeMatchText(source.quote);
  const normalizedName = normalizeMatchText(source.name);
  let matchType = "none";
  let quoteCoverage = 0;

  if (normalizedQuote.length >= 12) {
    if (pageText.includes(normalizedQuote)) {
      return { verified: true, matchType: "exact_quote", quoteCoverage: 1 };
    }
    const quoteParts = normalizedQuote.split(" ").filter(Boolean);
    if (quoteParts.length >= 6) {
      const head = quoteParts.slice(0, 6).join(" ");
      const tail = quoteParts.slice(-6).join(" ");
      if (pageText.includes(head) && pageText.includes(tail)) {
        return { verified: true, matchType: "span_quote", quoteCoverage: 0.8 };
      }
    }
    quoteCoverage = fuzzyQuoteCoverage(normalizedQuote, pageText);
    if (quoteCoverage >= 0.72) {
      return { verified: true, matchType: "fuzzy_quote", quoteCoverage };
    }
    if (quoteCoverage > 0) matchType = "partial_quote";
  }

  if (normalizedName.length >= 4 && pageText.includes(normalizedName)) {
    return { verified: false, matchType: matchType === "partial_quote" ? "partial_quote_name" : "name_only", quoteCoverage };
  }
  return { verified: false, matchType, quoteCoverage };
}

async function fetchSourceWithCache(url, sourceFetchCache = new Map()) {
  const normalizedUrl = normalizeHttpUrl(url);
  if (!normalizedUrl) {
    return { ok: false, error: "invalid_url", snapshot: null };
  }
  if (sourceFetchCache.has(normalizedUrl)) {
    return sourceFetchCache.get(normalizedUrl);
  }

  const transport = getRuntime()?.transport;
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

async function verifySourceListWithFetch(sources = [], sourceFetchCache, analysisMeta) {
  const normalizedSources = normalizeSourceList(sources, 16);
  if (!getRuntime()?.transport?.fetchSource) {
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
    const fetched = await fetchSourceWithCache(normalizedUrl, sourceFetchCache);
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

function applySourceVerificationPenalty(dim = {}, counters = {}, analysisMeta = {}) {
  const checked = Number(counters.checked || 0);
  if (!checked) return { penalized: false };

  const verified = Number(counters.verified || 0);
  const ratio = verified / checked;
  if (ratio >= 0.5) {
    const baseReason = stripExistingVerificationReason(dim.confidenceReason);
    dim.confidenceReason = baseReason;
    return { penalized: false };
  }

  const current = normalizeConfidenceLevel(dim.confidence) || "medium";
  const downgraded = confidenceFromRank(confidenceRank(current) - 1, current);
  const note = `Source verification check: ${verified}/${checked} cited URLs contained the quoted claim text.`;
  const baseReason = stripExistingVerificationReason(dim.confidenceReason);
  dim.confidenceReason = [baseReason, note].filter(Boolean).join(" ");
  if (downgraded !== current) {
    dim.confidence = downgraded;
    analysisMeta.sourceVerificationPenalizedDimensions += 1;
    return { penalized: true, from: current, to: downgraded };
  }
  return { penalized: false };
}

function extractEvidenceYearFromSource(source = {}) {
  const years = extractEvidenceYearsFromSource(source);
  if (!years.length) return null;
  return Math.max(...years);
}

function downgradeConfidenceOneStep(level) {
  return confidenceFromRank(confidenceRank(level) - 1, level);
}

function applyEvidenceQualityCaps(dim = {}, analysisMeta = {}) {
  const sources = normalizeSourceList(dim?.sources, 20);
  const currentConfidence = normalizeConfidenceLevel(dim?.confidence) || "medium";
  let nextConfidence = currentConfidence;

  const vendorSources = sources.filter((source) => source.sourceType === "vendor").length;
  const independentSources = sources.filter((source) => source.sourceType === "independent").length;
  const sourceCount = sources.length;
  const sourcesWithUrl = sources.filter((source) => normalizeHttpUrl(source.url)).length;

  if (sourceCount > 0) {
    analysisMeta.sourceDiversityTotalDimensions = Number(analysisMeta.sourceDiversityTotalDimensions || 0) + 1;
  }

  if (sourceCount > 0 && independentSources < 1 && confidenceRank(nextConfidence) > confidenceRank("medium")) {
    nextConfidence = "medium";
    analysisMeta.sourceDiversityConfidenceCaps = Number(analysisMeta.sourceDiversityConfidenceCaps || 0) + 1;
    const existing = cleanString(dim.confidenceReason);
    dim.confidenceReason = [existing, "Confidence capped: no independent corroborating source was cited."]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  const years = sources
    .map((source) => extractEvidenceYearFromSource(source))
    .filter((year) => Number.isFinite(year));
  const currentYear = new Date().getFullYear();
  const staleCutoff = currentYear - 2;
  const staleCount = years.filter((year) => year < staleCutoff).length;
  const staleRatio = years.length ? (staleCount / years.length) : 0;
  dim.staleEvidenceRatio = staleRatio;

  if (Number.isFinite(staleRatio)) {
    analysisMeta.staleEvidenceObservedDimensions = Number(analysisMeta.staleEvidenceObservedDimensions || 0) + 1;
    analysisMeta.staleEvidenceRatioSum = Number(analysisMeta.staleEvidenceRatioSum || 0) + staleRatio;
  }

  if (staleRatio >= 0.6 && confidenceRank(nextConfidence) > confidenceRank("low")) {
    const prev = nextConfidence;
    nextConfidence = downgradeConfidenceOneStep(nextConfidence);
    if (nextConfidence !== prev) {
      analysisMeta.staleEvidenceConfidenceCaps = Number(analysisMeta.staleEvidenceConfidenceCaps || 0) + 1;
      const existing = cleanString(dim.confidenceReason);
      dim.confidenceReason = [existing, `Confidence reduced: evidence appears mostly stale (pre-${staleCutoff + 1}).`]
        .filter(Boolean)
        .join(" ")
        .trim();
    }
  }

  if (sourceCount > 0 && confidenceRank(nextConfidence) > confidenceRank("medium")) {
    const verifiedInPage = sources.filter((source) => source.verificationStatus === "verified_in_page").length;
    const verificationRatio = sourceCount ? (verifiedInPage / sourceCount) : 0;
    if (verificationRatio < 0.3) {
      nextConfidence = "medium";
      analysisMeta.verificationConfidenceCaps = Number(analysisMeta.verificationConfidenceCaps || 0) + 1;
      const existing = cleanString(dim.confidenceReason);
      dim.confidenceReason = [existing, "Confidence capped: quote verification coverage is limited."]
        .filter(Boolean)
        .join(" ")
        .trim();
    }
  }

  if (sourceCount > 0 && confidenceRank(nextConfidence) > confidenceRank("medium")) {
    const urlCoverage = sourceCount ? (sourcesWithUrl / sourceCount) : 0;
    if (urlCoverage < 0.6) {
      nextConfidence = "medium";
      analysisMeta.urlCoverageConfidenceCaps = Number(analysisMeta.urlCoverageConfidenceCaps || 0) + 1;
      const existing = cleanString(dim.confidenceReason);
      dim.confidenceReason = [existing, "Confidence capped: too few cited sources include verifiable URLs."]
        .filter(Boolean)
        .join(" ")
        .trim();
    }
  }

  if (!sourceCount && confidenceRank(nextConfidence) > confidenceRank("low")) {
    nextConfidence = "low";
    analysisMeta.zeroSourceConfidenceCaps = Number(analysisMeta.zeroSourceConfidenceCaps || 0) + 1;
    const existing = cleanString(dim.confidenceReason);
    dim.confidenceReason = [existing, "Confidence reduced: no cited sources were returned for this dimension."]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  dim.sourceMix = {
    total: sourceCount,
    withUrl: sourcesWithUrl,
    independent: independentSources,
    vendor: vendorSources,
    press: sources.filter((source) => source.sourceType === "press").length,
  };
  dim.sources = annotateSourceListDisplayStatus(sources, {
    staleEvidenceRatio: staleRatio,
    dimensionId: cleanString(dim?.id),
    dimensionLabel: cleanString(dim?.label),
  });
  dim.confidence = nextConfidence;
}

async function verifyScorecardSources({
  payload,
  dims,
  analysisMeta,
  sourceFetchCache,
  debugSession,
  phase,
  penalizeConfidence = true,
}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(dims) || !dims.length) return payload;
  payload.dimensions = payload.dimensions || {};

  for (const dim of dims) {
    const dimState = payload.dimensions?.[dim.id];
    if (!dimState || typeof dimState !== "object") continue;

    const verified = await verifySourceListWithFetch(dimState.sources, sourceFetchCache, analysisMeta);
    dimState.sources = verified.sources;

    if (penalizeConfidence) {
      const penalty = applySourceVerificationPenalty(dimState, verified.counters, analysisMeta);
      if (penalty.penalized) {
        appendAnalysisDebugEvent(debugSession, {
          type: "source_verification_penalty",
          phase,
          attempt: dim.id,
          extra: {
            dimensionId: dim.id,
            checked: verified.counters.checked,
            verified: verified.counters.verified,
            notFound: verified.counters.notFound,
            fetchFailed: verified.counters.fetchFailed,
            confidenceFrom: penalty.from,
            confidenceTo: penalty.to,
          },
        });
      }
      applyEvidenceQualityCaps(dimState, analysisMeta);
    } else {
      dimState.sources = annotateSourceListDisplayStatus(dimState.sources, {
        staleEvidenceRatio: Number.isFinite(Number(dimState?.staleEvidenceRatio))
          ? Number(dimState.staleEvidenceRatio)
          : null,
        dimensionId: cleanString(dim?.id),
        dimensionLabel: cleanString(dim?.label),
      });
    }
  }

  if (Array.isArray(payload.sources)) {
    const verifiedTop = await verifySourceListWithFetch(payload.sources, sourceFetchCache, analysisMeta);
    payload.sources = annotateSourceListDisplayStatus(verifiedTop.sources);
  }
  return payload;
}

function normalizedSourceName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countNewNamedSources(currentList = [], baselineList = []) {
  const baseline = new Set(
    (Array.isArray(baselineList) ? baselineList : [])
      .map((s) => normalizedSourceName(s?.name))
      .filter(Boolean)
  );
  const current = new Set(
    (Array.isArray(currentList) ? currentList : [])
      .map((s) => normalizedSourceName(s?.name))
      .filter(Boolean)
  );
  let count = 0;
  current.forEach((name) => {
    if (!baseline.has(name)) count += 1;
  });
  return count;
}

function normalizeStringList(values, maxItems = 6, maxLen = 180) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((v) => v.slice(0, maxLen));
}

function normalizeInputFrame(rawInput, frame, framingFields = []) {
  const inputFrame = frame && typeof frame === "object" ? frame : {};
  const fields = normalizePromptFramingFields(framingFields);
  const rawValues = inputFrame?.framingFields && typeof inputFrame.framingFields === "object"
    ? inputFrame.framingFields
    : {};

  const normalizedValues = {};
  fields.forEach((field) => {
    const value = String(rawValues?.[field.id] || "").trim();
    normalizedValues[field.id] = value || "unspecified";
  });

  return {
    providedInput: String(inputFrame?.providedInput || rawInput || "").trim() || String(rawInput || "").trim(),
    framingFields: normalizedValues,
    assumptionsUsed: normalizeStringList(inputFrame?.assumptionsUsed, 5, 220),
    confidenceLimits: String(inputFrame?.confidenceLimits || "").trim()
      || "Input and evidence limits leave parts of this assessment uncertain.",
  };
}

function normalizeAttributesShape(rawAttributes, rawInput, framingFields = []) {
  const attrs = rawAttributes && typeof rawAttributes === "object" ? { ...rawAttributes } : {};
  attrs.title = String(attrs.title || "").trim();
  attrs.problemStatement = String(attrs.problemStatement || "").trim();
  attrs.solutionStatement = String(attrs.solutionStatement || "").trim();
  attrs.expandedDescription = String(attrs.expandedDescription || "").trim();
  attrs.vertical = String(attrs.vertical || "").trim();
  attrs.buyerPersona = String(attrs.buyerPersona || "").trim();
  attrs.aiSolutionType = String(attrs.aiSolutionType || "").trim();
  attrs.typicalTimeline = String(attrs.typicalTimeline || "").trim();
  attrs.deliveryModel = String(attrs.deliveryModel || "").trim();
  attrs.inputFrame = normalizeInputFrame(rawInput, attrs.inputFrame, framingFields);
  return attrs;
}

function normalizeEvidenceSourceType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (["vendor", "press", "independent"].includes(raw)) return raw;
  if (raw.includes("vendor") || raw.includes("marketing") || raw.includes("product")) return "vendor";
  if (raw.includes("press") || raw.includes("news") || raw.includes("earnings") || raw.includes("filing")) return "press";
  if (raw.includes("independent") || raw.includes("peer") || raw.includes("audit") || raw.includes("benchmark")) return "independent";
  return "";
}

function defaultTargetedQueries(desc, dimLabel, gapHint, attributes = {}) {
  const title = String(attributes?.title || "").trim();
  const vertical = String(attributes?.vertical || "").trim();
  const aiType = String(attributes?.aiSolutionType || "").trim();
  const dim = String(dimLabel || "").trim() || "dimension";
  const base = title || desc || "strategic research input";
  const market = vertical || "target industry";
  const ai = aiType || "AI solution";
  const gap = String(gapHint || "").trim();

  return normalizeStringList([
    `${base} ${market} ${dim} verified deployment metrics`,
    `${market} ${ai} case study independent outcomes ${dim}`,
    `${base} benchmark baseline vs post implementation ${dim}`,
    gap ? `${gap} ${market} source` : "",
  ], 4, 170);
}

function hasSpecificMissingEvidenceGap(text) {
  const gap = String(text || "").trim();
  if (!gap || gap.length < 22) return false;

  const lower = gap.toLowerCase();
  const genericOnlyPatterns = [
    /^more evidence needed[.\s]*$/i,
    /^additional evidence needed[.\s]*$/i,
    /^insufficient evidence[.\s]*$/i,
    /^limited evidence[.\s]*$/i,
    /^evidence is sparse[.\s]*$/i,
  ];
  if (genericOnlyPatterns.some((re) => re.test(gap))) return false;

  const specificityHints = [
    "case study", "deployment", "benchmark", "earnings", "annual report", "audited",
    "trial", "peer-reviewed", "vendor", "analyst report", "regulator", "filing",
    "hospital", "bank", "retailer", "source", "named", "metrics", "pre/post",
  ];
  const hasHint = specificityHints.some((k) => lower.includes(k));
  const hasYear = /\b20\d{2}\b/.test(gap);
  const hasEntityLikeToken = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/.test(gap);

  return hasHint || hasYear || hasEntityLikeToken;
}

function buildNicheQueryStrategistPrompt(desc, dims, attributes = {}, researchSetup = {}) {
  const title = String(attributes?.title || "").trim();
  const vertical = String(attributes?.vertical || "").trim();
  const solution = String(attributes?.aiSolutionType || "").trim();
  const buyer = String(attributes?.buyerPersona || "").trim();
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  const profile = [
    title ? `Title: ${title}` : "",
    vertical ? `Vertical: ${vertical}` : "",
    solution ? `Solution: ${solution}` : "",
    buyer ? `Buyer: ${buyer}` : "",
  ].filter(Boolean).join("\n");

  return `You are a retrieval strategist preparing targeted evidence search guidance.

Research input:
"${desc}"

Run context:
${setupContext}

Context profile:
${profile || "None provided."}

Dimensions under review:
${dims.map((d) => `- ${d.id}: ${d.label}${d?.researchHints?.queryTemplates?.length ? ` | query templates: ${d.researchHints.queryTemplates.join(" ; ")}` : ""}`).join("\n")}

Task:
- Infer the likely niche/domain from the input.
- Produce targeted alias/acquisition/rebrand hints (company aliases, product renames, merged entities) to improve retrieval recall.
- For each dimension, provide 2-4 supporting query seeds, 2-3 counterfactual/disconfirming queries, and source targets.
- Counterfactual queries should explicitly look for failure modes, disconfirming evidence, incumbent advantages, or why the thesis may fail.
- Keep outputs factual and concise.

Return JSON only:
{
  "niche": "<short niche label>",
  "aliases": ["<alias or rebrand hint>"],
  "dimensionHints": {
    ${dims.map((d) => `"${d.id}": {"querySeeds":["<supporting query seed>"], "counterfactualQueries":["<disconfirming query seed>"], "sourceTargets":["<target source type>"]}`).join(",\n    ")}
  }
}`;
}

function normalizeStrategistHints(payload = {}, dims = []) {
  const dimensionHintsRaw = payload?.dimensionHints && typeof payload.dimensionHints === "object"
    ? payload.dimensionHints
    : {};
  const byDim = {};
  dims.forEach((dim) => {
    const raw = dimensionHintsRaw?.[dim.id] || {};
    byDim[dim.id] = {
      querySeeds: normalizeStringList(raw?.querySeeds, 4, 170),
      counterfactualQueries: normalizeStringList(raw?.counterfactualQueries, 4, 170),
      sourceTargets: normalizeStringList(raw?.sourceTargets, 4, 170),
    };
  });
  return {
    niche: cleanString(payload?.niche),
    aliases: normalizeStringList(payload?.aliases, 8, 120),
    dimensionHints: byDim,
  };
}

function dimensionPressureScore(dimState = {}, dimId = "", lowSet = new Set(), mediumGapSet = new Set()) {
  const confidence = normalizeConfidenceLevel(dimState?.confidence) || "low";
  const sourceCount = Array.isArray(dimState?.sources)
    ? dimState.sources.filter((item) => item && (item.url || item.name || item.quote)).length
    : 0;
  const queryGap = String(dimState?.missingEvidence || "").trim();
  let score = 0;
  if (lowSet.has(dimId) || confidence === "low") score += 4;
  else if (mediumGapSet.has(dimId) || confidence === "medium") score += 2;
  if (sourceCount === 0) score += 3;
  else if (sourceCount < 2) score += 2;
  else if (sourceCount < 4) score += 1;
  if (hasSpecificMissingEvidenceGap(queryGap)) score += 2;
  if (String(dimState?.confidenceReason || "").toLowerCase().includes("uncertain")) score += 1;
  return score;
}

function selectTargetedCycleDimensions(phase1Payload, dims, limits = {}) {
  const low = [];
  const mediumWithSpecificGap = [];

  for (const d of dims) {
    const dim = phase1Payload?.dimensions?.[d.id] || {};
    const confidence = normalizeConfidenceLevel(dim?.confidence);
    const missingEvidence = String(dim?.missingEvidence || "").trim();
    if (confidence === "low") {
      low.push(d.id);
      continue;
    }
    if (confidence === "medium" && hasSpecificMissingEvidenceGap(missingEvidence)) {
      mediumWithSpecificGap.push(d.id);
    }
  }

  const lowSet = new Set(low);
  const mediumGapSet = new Set(mediumWithSpecificGap);
  const candidates = [...new Set([...low, ...mediumWithSpecificGap])].map((dimId) => {
    const state = phase1Payload?.dimensions?.[dimId] || {};
    const pressure = dimensionPressureScore(state, dimId, lowSet, mediumGapSet);
    const sourceCount = Array.isArray(state?.sources)
      ? state.sources.filter((src) => src && (src.url || src.name || src.quote)).length
      : 0;
    return {
      dimId,
      bucket: lowSet.has(dimId) ? "low" : "medium_gap",
      pressure,
      sourceCount,
    };
  });

  const maxBudget = Number(limits?.targetedBudgetUnits);
  const budgetUnits = Number.isFinite(maxBudget)
    ? Math.max(1, Math.min(candidates.length || 1, Math.round(maxBudget)))
    : Math.min(candidates.length || 0, Math.max(4, Math.min(8, low.length + mediumWithSpecificGap.length)));

  const buckets = {
    low: candidates
      .filter((item) => item.bucket === "low")
      .sort((a, b) => b.pressure - a.pressure || a.sourceCount - b.sourceCount),
    medium_gap: candidates
      .filter((item) => item.bucket === "medium_gap")
      .sort((a, b) => b.pressure - a.pressure || a.sourceCount - b.sourceCount),
  };

  const runOrder = [];
  let cursor = 0;
  const bucketOrder = ["low", "medium_gap"];
  while (runOrder.length < budgetUnits) {
    let picked = false;
    for (let i = 0; i < bucketOrder.length; i += 1) {
      const key = bucketOrder[(cursor + i) % bucketOrder.length];
      const next = buckets[key].shift();
      if (!next) continue;
      runOrder.push(next.dimId);
      cursor = (cursor + i + 1) % bucketOrder.length;
      picked = true;
      break;
    }
    if (!picked) break;
  }

  return {
    candidateIds: runOrder,
    allCandidateIds: candidates.map((item) => item.dimId),
    lowIds: low,
    mediumGapIds: mediumWithSpecificGap,
    budgetUnits,
  };
}

function buildForcedTargetedSelection(phase1Payload, dims, forcedCandidateIds = [], limits = {}) {
  const validSet = new Set((Array.isArray(dims) ? dims : []).map((dim) => dim.id));
  const forced = [...new Set((Array.isArray(forcedCandidateIds) ? forcedCandidateIds : [])
    .map((value) => cleanString(value))
    .filter((value) => value && validSet.has(value)))];

  const lowIds = [];
  const mediumGapIds = [];
  forced.forEach((dimId) => {
    const dim = phase1Payload?.dimensions?.[dimId] || {};
    const confidence = normalizeConfidenceLevel(dim?.confidence);
    if (confidence === "low") lowIds.push(dimId);
    else if (confidence === "medium" && hasSpecificMissingEvidenceGap(dim?.missingEvidence)) mediumGapIds.push(dimId);
  });

  const maxBudget = Number(limits?.deepAssistRecoveryBudget ?? limits?.targetedBudgetUnits);
  const budgetUnits = Number.isFinite(maxBudget)
    ? Math.max(1, Math.min(forced.length || 1, Math.round(maxBudget)))
    : Math.min(forced.length, Math.max(1, Math.min(4, forced.length)));

  return {
    candidateIds: forced.slice(0, budgetUnits),
    allCandidateIds: forced,
    lowIds,
    mediumGapIds,
    budgetUnits,
  };
}

function selectDeepAssistRecoveryDimensions(phase1Payload, dims, analysisMeta = {}, limits = {}) {
  const candidates = [];
  (Array.isArray(dims) ? dims : []).forEach((dim) => {
    const dimState = phase1Payload?.dimensions?.[dim.id] || {};
    const confidence = normalizeConfidenceLevel(dimState?.confidence) || "low";
    const sourceCount = normalizeSourceList(dimState?.sources, 16).length;
    const providerAgreement = cleanString(dimState?.providerAgreement).toLowerCase();
    const reasons = [];
    let pressure = 0;

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
    if (!reasons.length) return;

    candidates.push({
      dimId: dim.id,
      reasons,
      pressure: pressure + dimensionPressureScore(dimState, dim.id, new Set(), new Set()),
      sourceCount,
    });
  });

  candidates.sort((a, b) => b.pressure - a.pressure || a.sourceCount - b.sourceCount);
  const allCandidateIds = candidates.map((item) => item.dimId);
  const maxBudget = Number(limits?.deepAssistRecoveryBudget ?? limits?.targetedBudgetUnits);
  const budgetUnits = Number.isFinite(maxBudget)
    ? Math.max(1, Math.min(allCandidateIds.length || 1, Math.round(maxBudget)))
    : Math.min(allCandidateIds.length, Math.max(1, Math.min(4, allCandidateIds.length)));
  const candidateIds = allCandidateIds.slice(0, budgetUnits);
  return {
    candidateIds,
    allCandidateIds,
    budgetUnits,
    droppedByBudget: Math.max(0, allCandidateIds.length - candidateIds.length),
    diagnostics: candidates.map((item) => ({
      dimensionId: item.dimId,
      reasons: item.reasons,
      pressure: item.pressure,
      sourceCount: item.sourceCount,
    })),
  };
}

function parseWithDiagnostics(rawText, context, debugSession) {
  try {
    return safeParseJSON(rawText);
  } catch (err) {
    const snippetMatch = err.message.match(/ near: ([\s\S]*)$/);
    const parseNear = snippetMatch ? snippetMatch[1] : "";
    appendAnalysisDebugEvent(debugSession, {
      type: "json_parse_failure",
      phase: context.phase,
      attempt: context.attempt,
      useCaseId: context.useCaseId,
      analysisMode: context.analysisMode,
      error: err.message,
      parseNear,
      responseLength: rawText?.length || 0,
      prompt: shortText(context.prompt, 30000),
      responseExcerpt: shortText(rawText, 6000),
      response: shortText(rawText, 100000),
      extra: context.extra || null,
    });
    throw err;
  }
}

function sourceSummary(sources = []) {
  if (!sources?.length) return "none";
  return sources
    .slice(0, 3)
    .map((s) => `${s.name || "unknown"}${s.url ? ` (${s.url})` : ""}`)
    .join("; ");
}

function buildHybridReconcileEvidencePrompt(desc, dims, baseline, web, {
  condensed = false,
  framingFields = [],
  qualityGuard = null,
  researchSetup = {},
} = {}) {
  const comparison = dims.map((d) => {
    const b = baseline?.dimensions?.[d.id] || {};
    const w = web?.dimensions?.[d.id] || {};
    return [
      `DIMENSION: ${d.label} [${d.id}]`,
      `BASELINE score: ${b.score ?? "n/a"}/5`,
      `BASELINE confidence: ${b.confidence || "n/a"}`,
      `BASELINE confidence reason: "${clip(b.confidenceReason, 150)}"`,
      `BASELINE missing evidence: "${clip(b.missingEvidence, 160)}"`,
      `BASELINE brief: "${clip(b.brief, 180)}"`,
      `BASELINE sources: ${sourceSummary(b.sources)}`,
      `BASELINE full snapshot: "${clip(b.full, 320)}"`,
      `WEB score: ${w.score ?? "n/a"}/5`,
      `WEB confidence: ${w.confidence || "n/a"}`,
      `WEB confidence reason: "${clip(w.confidenceReason, 150)}"`,
      `WEB missing evidence: "${clip(w.missingEvidence, 160)}"`,
      `WEB brief: "${clip(w.brief, 180)}"`,
      `WEB sources: ${sourceSummary(w.sources)}`,
      `WEB full snapshot: "${clip(w.full, 320)}"`,
    ].join("\n");
  }).join("\n\n");

  const evidenceTemplate = buildDimEvidenceJsonTemplate(dims, condensed);
  const attrsTemplate = buildAttributesTemplate({ condensed, framingFields });
  const guard = qualityGuard && typeof qualityGuard === "object" ? qualityGuard : null;
  const focusDimensionIds = Array.isArray(guard?.focusDimensionIds)
    ? guard.focusDimensionIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const guardNotes = Array.isArray(guard?.notes)
    ? guard.notes.map((note) => String(note || "").trim()).filter(Boolean)
    : [];
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  const qualityGuardBlock = guard
    ? `\nRECONCILE QUALITY GUARD:
- This reconcile pass was retried because the previous merge looked implausibly unchanged.
- Focus dimensions with unresolved confidence gaps: ${focusDimensionIds.length ? focusDimensionIds.join(", ") : "none specified"}.
- Explicit concerns to address:
${guardNotes.length ? guardNotes.map((note) => `  - ${note}`).join("\n") : "  - Previous reconcile underused web-assisted deltas while uncertainty remained high."}
- Keep every dimension complete and explicitly state gaps instead of silently reusing weaker baseline wording.\n`
    : "";

  return `Step 1 of 2 - EVIDENCE ENUMERATION ONLY (HYBRID RECONCILE).
You are a reliability reviewer combining two analyst drafts for the same use case.
Use case: "${desc}"

Run context:
${setupContext}

DRAFT A (BASELINE): no live web search.
Attributes A:
${JSON.stringify(baseline?.attributes || {}, null, 2)}

DRAFT B (WEB): live web-search assisted.
Attributes B:
${JSON.stringify(web?.attributes || {}, null, 2)}

Per-dimension comparison:
${comparison}

Rules:
- Prefer points backed by strong, verifiable evidence.
- Do not overreact to weak web snippets.
- When confidence differs between drafts, prefer evidence from the higher-confidence draft.
- When both drafts flag the same missing evidence, preserve that gap.
- When one draft fills a gap that the other flags, include the gap-filling evidence.
- Do not silently copy one draft across all dimensions when drafts materially disagree.
- Enumerate evidence only. Do NOT output scores or confidence in this step.
- Keep coherent attributes across drafts.
- Preserve inputFrame.providedInput verbatim and keep missing framing fields as "unspecified".
${qualityGuardBlock}

Return ONLY this JSON:
{
  "attributes": ${attrsTemplate},
  "dimensions": {
    ${evidenceTemplate}
  }
}`;
}

function buildCriticPrompt(desc, dims, p1, { liveSearch = false, researchSetup = {} } = {}) {
  const evidenceSnapshots = dims.map((d) => {
    const dim = p1?.dimensions?.[d.id] || {};
    return [
      `DIMENSION: ${d.label} [${d.id}]`,
      `Analyst score: ${dim.score ?? "n/a"}/5`,
      `Analyst confidence: ${dim.confidence || "n/a"}`,
      `Analyst brief: "${clip(dim.brief, 260)}"`,
      `Analyst full snapshot: "${clip(dim.full, 800)}"`,
      `Analyst cited sources: ${sourceSummary(dim.sources)}`,
    ].join("\n");
  }).join("\n\n");
  const mandateBlock = liveSearch
    ? `Your mandate (web-audit critic, not a second analyst):
- Use live web search to verify the analyst's specific claims, numbers, and named deployments.
- Search for contradictory or newer evidence that weakens overconfident claims.
- Verify current SaaS/incumbent vendor position before citing them.
- If evidence is stale, unverified, or contradictory, state that explicitly and suggest a lower or unchanged score.
- Do not re-research from scratch; focus on auditing and stress-testing analyst evidence.`
    : `Your mandate (memory-only critic for this run):
- Live web search is disabled in this mode. Audit analyst claims using provided evidence and your internal knowledge.
- Flag any claims that appear weak, outdated, or insufficiently verified.
- Challenge with realistic incumbent/SaaS pressure where relevant, and state uncertainty when verification is limited.
- Do not re-research from scratch; focus on adversarial review of analyst evidence.`;

  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Audit this analyst assessment: "${p1?.attributes?.title || desc}"

Use case description:
"${desc}"

Run context:
${setupContext}

${mandateBlock}

Analyst evidence snapshots:
${evidenceSnapshots}

Rubric calibration reminders (higher score is always better):
${buildRubricCalibrationBlock(dims, { wordCap: 11 })}

Important:
- If your critique is mainly about higher risk, disruption, complexity, weak evidence, or stronger SaaS pressure, your suggested score should usually stay flat or move lower.
- Do not invert rubric direction.

Return ONLY this JSON:
{
  "overallFeedback": "<2-3 sentence overall critique - what is verified, what is weak or outdated?>",
  "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}],
  "dimensions": {
    ${dims.map((d) => `"${d.id}": {
      "scoreJustified": <true if score is defensible, false if over/under-stated>,
      "suggestedScore": <your suggested score 1-5>,
      "critique": "<2-3 sentences: audit findings, contradictions, incumbent pressure, or unverified analyst claims>",
      "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}]
    }`).join(",\n    ")}
  }
}`;
}

function buildLowConfidenceQueryPlanPrompt(desc, dim, currentDim = {}, attributes = {}, strategistHint = {}, researchSetup = {}) {
  const dimLabel = dim?.label || dim?.id || "Dimension";
  const gapHint = clip(
    currentDim?.missingEvidence
    || currentDim?.confidenceReason
    || currentDim?.risks
    || "Evidence is sparse for this dimension.",
    220
  );
  const researchHints = dim?.researchHints && typeof dim.researchHints === "object" ? dim.researchHints : {};
  const templateHints = normalizeStringList(researchHints?.queryTemplates, 4, 170);
  const whereHints = normalizeStringList(researchHints?.whereToLook, 4, 170);
  const strategistSeeds = normalizeStringList(strategistHint?.querySeeds, 4, 170);
  const strategistCounterfactual = normalizeStringList(strategistHint?.counterfactualQueries, 4, 170);
  const strategistTargets = normalizeStringList(strategistHint?.sourceTargets, 4, 170);
  const aliasHints = normalizeStringList(strategistHint?.aliases, 8, 120);
  const counterfactualLimitRaw = Number(getRuntime()?.limits?.counterfactualQueriesPerDim);
  const counterfactualLimit = Number.isFinite(counterfactualLimitRaw)
    ? Math.max(1, Math.min(4, Math.round(counterfactualLimitRaw)))
    : 2;
  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `You are generating targeted search queries for one low-confidence scoring dimension.

Use case:
"${desc}"

Run context:
${setupContext}

Dimension:
${dimLabel} [${dim?.id}]

Current score + confidence:
- Score: ${currentDim?.score ?? "n/a"}/5
- Confidence: ${currentDim?.confidence || "low"}
- Confidence reason: ${clip(currentDim?.confidenceReason, 180)}
- Missing evidence hint: ${gapHint}

Context:
- Title: ${attributes?.title || ""}
- Vertical: ${attributes?.vertical || ""}
- AI solution: ${attributes?.aiSolutionType || ""}

Dimension-specific hint templates:
- Query templates: ${templateHints.length ? templateHints.join(" | ") : "none"}
- Suggested evidence targets: ${whereHints.length ? whereHints.join(" | ") : "none"}

Niche strategist hints:
- Query seeds: ${strategistSeeds.length ? strategistSeeds.join(" | ") : "none"}
- Counterfactual seeds: ${strategistCounterfactual.length ? strategistCounterfactual.join(" | ") : "none"}
- Source targets: ${strategistTargets.length ? strategistTargets.join(" | ") : "none"}
- Alias/rebrand hints: ${aliasHints.length ? aliasHints.join(" | ") : "none"}

Task:
- Produce 3 to 4 highly specific supporting search queries to close the evidence gap.
- Produce ${counterfactualLimit} to ${Math.min(counterfactualLimit + 1, 4)} counterfactual/disconfirming queries to challenge the current assumption.
- Queries must target verifiable deployments, metrics, and current market facts.
- Avoid generic queries like "AI trends".

Return ONLY this JSON:
{
  "gap": "<single sentence evidence gap>",
  "queries": [
    "<query 1>",
    "<query 2>",
    "<query 3>",
    "<query 4 optional>"
  ],
  "counterfactualQueries": [
    "<counterfactual query 1>",
    "<counterfactual query 2>"
  ]
}`;
}

function normalizeLowConfidenceQueryPlan(payload, fallbackQueries = [], fallbackGap = "") {
  const queries = [
    ...normalizeStringList(payload?.queries, 4, 170),
    ...normalizeStringList(fallbackQueries, 4, 170),
  ];
  const unique = [...new Set(queries)].slice(0, 4);
  const counterfactualLimitRaw = Number(getRuntime()?.limits?.counterfactualQueriesPerDim);
  const counterfactualLimit = Number.isFinite(counterfactualLimitRaw)
    ? Math.max(1, Math.min(4, Math.round(counterfactualLimitRaw)))
    : 2;
  const counterfactualQueries = [...new Set(
    normalizeStringList(payload?.counterfactualQueries, 4, 170)
  )]
    .filter((query) => !unique.includes(query))
    .slice(0, counterfactualLimit);
  return {
    gap: String(payload?.gap || "").trim() || String(fallbackGap || "").trim() || "Evidence for this dimension is still weak.",
    queries: unique,
    counterfactualQueries,
  };
}

function buildLowConfidenceSearchHarvestPrompt(desc, dim, queryPlan, currentDim = {}, researchSetup = {}) {
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  return `Run targeted live web research for this one low-confidence dimension and return raw findings only.

Use case:
"${desc}"

Run context:
${setupContext}

Dimension:
${dim?.label || dim?.id} [${dim?.id}]

Current snapshot:
- Score: ${currentDim?.score ?? "n/a"}/5
- Confidence: ${currentDim?.confidence || "low"}
- Gap: ${queryPlan?.gap || "Evidence gap not specified."}

Queries to run:
${(queryPlan?.queries || []).map((q, idx) => `${idx + 1}. ${q}`).join("\n")}

Counterfactual queries to run:
${(queryPlan?.counterfactualQueries || []).length
  ? (queryPlan.counterfactualQueries || []).map((q, idx) => `${idx + 1}. ${q}`).join("\n")
  : "- none"}

Rules:
- Focus on concrete facts, deployments, release changes, or benchmark signals.
- Keep findings factual and source-linked. No scoring in this step.
- If a query has no useful result, mark it as not useful.
- Label each finding as "supporting" or "counterfactual" based on the query intent.

Return ONLY this JSON:
{
  "findings": [
    {
      "query": "<exact query>",
      "evidenceType": "<supporting|counterfactual>",
      "fact": "<single concrete fact>",
      "source": {"name": "<source name>", "quote": "<max 15 words>", "url": "<url>"}
    }
  ],
  "queryCoverage": [
    {"query": "<exact query>", "useful": <true|false>, "note": "<short note>"}
  ]
}`;
}

function normalizeLowConfidenceSearchHarvest(payload, queryPlan) {
  const counterfactualSet = new Set(
    normalizeStringList(queryPlan?.counterfactualQueries, 8, 170).map((item) => item.toLowerCase())
  );
  const findings = Array.isArray(payload?.findings)
    ? payload.findings
      .map((f) => {
        const query = String(f?.query || "").trim();
        const fact = String(f?.fact || "").trim();
        const evidenceTypeRaw = String(f?.evidenceType || "").trim().toLowerCase();
        const evidenceType = evidenceTypeRaw === "counterfactual"
          || counterfactualSet.has(query.toLowerCase())
          ? "counterfactual"
          : "supporting";
        const source = f?.source && typeof f.source === "object"
          ? {
              name: String(f.source.name || "").trim(),
              quote: String(f.source.quote || "").trim(),
              url: String(f.source.url || "").trim(),
            }
          : null;
        if (!fact || !source || (!source.name && !source.quote && !source.url)) return null;
        return {
          query: query || "",
          evidenceType,
          fact: fact.slice(0, 260),
          source,
        };
      })
      .filter(Boolean)
      .slice(0, 10)
    : [];

  const queryCoverage = Array.isArray(payload?.queryCoverage)
    ? payload.queryCoverage
      .map((item) => ({
        query: String(item?.query || "").trim(),
        useful: !!item?.useful,
        note: String(item?.note || "").trim().slice(0, 160),
      }))
      .filter((item) => item.query)
      .slice(0, 6)
    : [];

  const allQueries = [
    ...normalizeStringList(queryPlan?.queries, 6, 170),
    ...normalizeStringList(queryPlan?.counterfactualQueries, 6, 170),
  ];
  const fallbackCoverage = allQueries.map((q) => ({
    query: q,
    useful: findings.some((f) => f.query && f.query === q),
    note: findings.some((f) => f.query && f.query === q) ? "Returned at least one useful fact." : "No clearly useful fact captured.",
  }));

  return {
    findings,
    queryCoverage: queryCoverage.length ? queryCoverage : fallbackCoverage,
  };
}

function buildLowConfidenceRescorePrompt(desc, dim, currentDim, queryPlan, harvest, researchSetup = {}) {
  const dimRubric = buildDimRubrics([dim]);
  const findingsBlock = JSON.stringify(harvest || {}, null, 2);
  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Re-evaluate ONE low-confidence dimension using targeted live-search findings.

Use case:
"${desc}"

Run context:
${setupContext}

Dimension:
${dim?.label || dim?.id} [${dim?.id}]

Current dimension state:
${JSON.stringify({
  score: currentDim?.score,
  confidence: currentDim?.confidence,
  confidenceReason: currentDim?.confidenceReason,
  brief: currentDim?.brief,
  full: currentDim?.full,
  risks: currentDim?.risks,
  missingEvidence: currentDim?.missingEvidence,
  sources: currentDim?.sources || [],
  arguments: currentDim?.arguments || {},
}, null, 2)}

Targeted query plan:
${JSON.stringify(queryPlan || {}, null, 2)}

Targeted search findings:
${findingsBlock}

Rubric:
${dimRubric}

Rules:
- Use current state plus targeted findings. Do not invent unsupported claims.
- Raise confidence only if findings materially reduce uncertainty.
- If confidence remains low, keep score conservative and provide a precise research brief based on attempted queries.
- Keep all text concise and plain-language.
- Explicitly weigh supporting vs counterfactual findings; counterfactual findings should influence limiting arguments.

Return ONLY this JSON:
{
  "score": <integer 1-5>,
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "brief": "<2-3 sentences, max 65 words>",
  "full": "<1 concise paragraph, max 150 words>",
  "risks": "<1-2 sentences>",
  "missingEvidence": "<what is still missing>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"..."}],
  "arguments": {
    "supporting": [
      {
        "id": "sup-1",
        "claim": "<max 12 words>",
        "detail": "<max 25 words>",
        "sources": [{"name":"...","quote":"<max 15 words>","url":"..."}]
      }
    ],
    "limiting": [
      {
        "id": "lim-1",
        "claim": "<max 12 words>",
        "detail": "<max 25 words>",
        "sources": [{"name":"...","quote":"<max 15 words>","url":"..."}]
      }
    ]
  },
  "researchBrief": {
    "missingEvidence": "<specific remaining gap>",
    "whereToLook": ["<source target 1>", "<source target 2>", "<source target 3>"],
    "suggestedQueries": ["<refined query 1>", "<refined query 2>", "<refined query 3>"]
  }
}`;
}

function normalizeLowConfidenceResearchBrief(brief, fallback = {}) {
  if (!brief || typeof brief !== "object") return null;
  const missingEvidence = String(brief?.missingEvidence || "").trim() || String(fallback?.missingEvidence || "").trim();
  const whereToLook = normalizeStringList(brief?.whereToLook, 4, 170);
  const suggestedQueries = normalizeStringList(brief?.suggestedQueries, 4, 170);
  if (!missingEvidence && !whereToLook.length && !suggestedQueries.length) return null;
  return {
    missingEvidence: missingEvidence || "Evidence gap remains unresolved after targeted search.",
    whereToLook: whereToLook.length ? whereToLook : normalizeStringList(fallback?.whereToLook, 3, 170),
    suggestedQueries: suggestedQueries.length ? suggestedQueries : normalizeStringList(fallback?.suggestedQueries, 4, 170),
  };
}

function mergeHarvestFindingsIntoArguments(baseArguments = {}, harvest = {}) {
  const normalized = ensureDimensionArgumentShape({ arguments: baseArguments }, "");
  const supporting = Array.isArray(normalized?.supporting)
    ? [...normalized.supporting]
    : [];
  const limiting = Array.isArray(normalized?.limiting)
    ? [...normalized.limiting]
    : [];

  const existing = new Set(
    [...supporting, ...limiting]
      .map((entry) => cleanString(entry?.claim).toLowerCase())
      .filter(Boolean)
  );

  (Array.isArray(harvest?.findings) ? harvest.findings : []).forEach((entry, idx) => {
    const fact = cleanString(entry?.fact);
    if (!fact) return;
    const key = fact.toLowerCase();
    if (existing.has(key)) return;
    existing.add(key);
    const target = String(entry?.evidenceType || "").toLowerCase() === "counterfactual"
      ? limiting
      : supporting;
    const idPrefix = target === limiting ? "lim-harvest" : "sup-harvest";
    target.push({
      id: `${idPrefix}-${idx + 1}`,
      claim: clip(fact, 90),
      detail: cleanString(entry?.query)
        ? `Targeted query: ${clip(entry.query, 120)}`
        : "Captured during targeted low-confidence recovery.",
      sources: normalizeSourceList([entry?.source]),
    });
  });

  return {
    supporting: supporting.slice(0, 6),
    limiting: limiting.slice(0, 6),
  };
}

function normalizeLowConfidenceRescore(payload, dim, currentDim, queryPlan, harvest) {
  const score = clampScore(payload?.score, clampScore(currentDim?.score, 3));
  const confidence = normalizeConfidenceLevel(payload?.confidence) || "low";
  const confidenceReason = String(payload?.confidenceReason || "").trim()
    || (confidence === "low"
      ? "Targeted search did not produce enough verifiable evidence to raise confidence."
      : "Targeted search improved evidence depth for this dimension.");
  const brief = String(payload?.brief || "").trim();
  const full = String(payload?.full || "").trim();
  const risks = String(payload?.risks || "").trim();
  const missingEvidence = String(payload?.missingEvidence || "").trim()
    || String(queryPlan?.gap || currentDim?.missingEvidence || "").trim();

  const normalizedArgHolder = ensureDimensionArgumentShape({
    arguments: payload?.arguments,
    brief,
    risks,
    sources: payload?.sources,
  }, dim?.id);

  const fallbackBrief = {
    missingEvidence,
    whereToLook: [
      "Independent analyst datasets and benchmark publications.",
      "Named deployment case studies from operators, not vendor-only blogs.",
      "Internal delivery retrospectives and client references.",
    ],
    suggestedQueries: queryPlan?.queries || [],
  };
  const researchBrief = normalizeLowConfidenceResearchBrief(payload?.researchBrief, fallbackBrief);

  const searchSources = (harvest?.findings || [])
    .map((f) => f?.source)
    .filter(Boolean);

  return {
    score,
    confidence,
    confidenceReason,
    brief,
    full,
    risks,
    missingEvidence,
    sources: mergeSourceLists(currentDim?.sources, payload?.sources, searchSources),
    arguments: mergeHarvestFindingsIntoArguments(normalizedArgHolder, harvest),
    researchBrief,
  };
}

function finalScoreForDim(finalScores, dimId) {
  const n = Number(finalScores?.dimensions?.[dimId]?.finalScore);
  return Number.isFinite(n) ? n : null;
}

function weakestDimensions(dims, finalScores, count = 4) {
  return dims
    .map((d) => ({
      dim: d,
      score: finalScoreForDim(finalScores, d.id),
    }))
    .filter((item) => item.score != null)
    .sort((a, b) => a.score - b.score || b.dim.weight - a.dim.weight)
    .slice(0, count);
}

function buildDiscoverPrompt(desc, dims, p1, finalScores, researchSetup = {}) {
  const weakest = weakestDimensions(dims, finalScores, 4);
  const weakestBlock = weakest.length
    ? weakest.map((item) => `- ${item.dim.label} [${item.dim.id}]: ${item.score}/5`).join("\n")
    : "- No weak dimensions available";

  const snapshotBlock = dims.map((d) => {
    const init = p1?.dimensions?.[d.id];
    const fin = finalScores?.dimensions?.[d.id];
    const score = fin?.finalScore ?? init?.score ?? "n/a";
    const brief = fin?.brief || init?.brief || "";
    return `- ${d.label} [${d.id}]: ${score}/5 | "${clip(brief, 180)}"`;
  }).join("\n");

  const weakLimitsBlock = weakest.length
    ? weakest.map((item) => {
      const dimData = finalScores?.dimensions?.[item.dim.id] || {};
      const limiting = Array.isArray(dimData?.arguments?.limiting) ? dimData.arguments.limiting : [];
      const factorLines = limiting
        .map((f) => `${clip(f?.claim || "", 90)}${f?.detail ? ` - ${clip(f.detail, 120)}` : ""}`)
        .filter(Boolean)
        .slice(0, 3);
      const fallback = clip(dimData?.response || dimData?.brief || dimData?.risks || "", 130) || "No explicit limiting factor captured.";
      const factors = factorLines.length ? factorLines.map((line) => `  - ${line}`).join("\n") : `  - ${fallback}`;
      return `- ${item.dim.label} [${item.dim.id}] limiting factors:\n${factors}`;
    }).join("\n")
    : "- No limiting-factor details available";

  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Generate related AI use case candidates for an outsourcing AI delivery company.

Original use case:
"${desc}"

Run context:
${setupContext}

Final analysis conclusion:
${finalScores?.conclusion || "No conclusion provided."}

Final dimension snapshots:
${snapshotBlock}

Weakest dimensions to target first:
${weakestBlock}

Specific limiting factors behind weak scores:
${weakLimitsBlock}

Task:
- Generate 3 to 5 related candidates that are specifically designed to improve weak dimensions.
- Do NOT return generic adjacent ideas; each candidate must clearly address weaknesses above.
- Prefer narrower, actionable variants where custom delivery opportunity is stronger.
- If Build vs. Buy is weak, suggest niches with weaker SaaS dominance.
- If Evidence is weak, suggest variants with stronger deployment track record.
- If Change Management is weak, suggest variants with lower workflow disruption.

For each candidate include:
- title
- analysisInput: 1-2 sentence prompt that can be analyzed directly
- rationale: one sentence explaining why it should score better
- expectedImprovedDimensions: 2-3 dimension IDs from this allowed list: ${dims.map((d) => d.id).join(", ")}
- targetedWeaknesses: 2-3 entries, each tied to a specific limiting factor:
  - dimensionId: one of the allowed IDs
  - limitingFactor: short quote/summary of the limiting factor being fixed
  - resolutionApproach: how this candidate addresses that limiting factor

Return ONLY this JSON:
{
  "candidates": [
    {
      "title": "<short candidate title>",
      "analysisInput": "<1-2 sentence use case prompt>",
      "rationale": "<one sentence: why this is likely to score better>",
      "expectedImprovedDimensions": ["<id1>", "<id2>", "<id3 optional>"],
      "targetedWeaknesses": [
        {
          "dimensionId": "<id>",
          "limitingFactor": "<specific limiting factor text>",
          "resolutionApproach": "<how candidate addresses it>"
        }
      ]
    }
  ]
}`;
}

function cleanDiscoverText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function uniqueIds(values = []) {
  return [...new Set(values)];
}

function normalizeDiscoverCandidates(payload, dims, weakestFallbackIds = []) {
  const allowed = new Set(dims.map((d) => d.id));
  const seen = new Set();
  const source = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const out = [];

  for (const raw of source) {
    if (!raw || typeof raw !== "object") continue;
    const title = cleanDiscoverText(raw.title);
    const analysisInput = cleanDiscoverText(raw.analysisInput, title);
    const rationale = cleanDiscoverText(raw.rationale);
    if (!title || !analysisInput || !rationale) continue;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const expected = uniqueIds((raw.expectedImprovedDimensions || [])
      .map((v) => String(v || "").trim())
      .filter((id) => allowed.has(id)))
      .slice(0, 3);

    const expectedImprovedDimensions = expected.length
      ? expected
      : weakestFallbackIds.slice(0, 3);

    const targetedWeaknesses = Array.isArray(raw.targetedWeaknesses)
      ? raw.targetedWeaknesses
        .map((item) => {
          const dimensionId = String(item?.dimensionId || "").trim();
          if (!allowed.has(dimensionId)) return null;
          const limitingFactor = cleanDiscoverText(item?.limitingFactor);
          const resolutionApproach = cleanDiscoverText(item?.resolutionApproach);
          if (!limitingFactor || !resolutionApproach) return null;
          return {
            dimensionId,
            limitingFactor: limitingFactor.slice(0, 180),
            resolutionApproach: resolutionApproach.slice(0, 180),
          };
        })
        .filter(Boolean)
        .slice(0, 4)
      : [];

    out.push({
      title: title.slice(0, 120),
      analysisInput: analysisInput.slice(0, 360),
      rationale: rationale.slice(0, 220),
      expectedImprovedDimensions,
      targetedWeaknesses,
    });
    if (out.length >= 5) break;
  }

  return out;
}

function discoverValidationPrompt(desc, dims, finalScores, candidate, expectedIds, researchSetup = {}) {
  const labelById = new Map(dims.map((d) => [d.id, d.label]));
  const scoreLines = expectedIds
    .map((id) => {
      const current = finalScoreForDim(finalScores, id);
      return `- ${labelById.get(id) || id} [${id}]: current ${current == null ? "n/a" : `${current}/5`}`;
    })
    .join("\n");

  const weaknessLines = (candidate?.targetedWeaknesses || [])
    .filter((w) => expectedIds.includes(w.dimensionId))
    .map((w) => (
      `- ${labelById.get(w.dimensionId) || w.dimensionId} [${w.dimensionId}] | Limiting factor: ${w.limitingFactor} | Approach: ${w.resolutionApproach}`
    ))
    .join("\n");

  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Validate whether this discovery candidate is likely to improve the claimed weak dimensions.

Original use case:
"${desc}"

Run context:
${setupContext}

Candidate:
- title: ${candidate?.title || ""}
- analysisInput: ${candidate?.analysisInput || ""}
- rationale: ${candidate?.rationale || ""}

Claimed improvement dimensions and current scores:
${scoreLines}

Targeted limiting factors (if provided):
${weaknessLines || "- none provided"}

Task:
- For each claimed dimension, estimate a conservative predicted score (1-5) for the candidate.
- Only raise a score if the candidate clearly addresses the listed limiting factor.
- If evidence is uncertain, keep score flat or lower.
- Use concise reasons.

Return ONLY this JSON:
{
  "summary": "<one sentence validation summary>",
  "dimensions": {
    ${expectedIds.map((id) => `"${id}": {"predictedScore": <1-5>, "reason": "<max 18 words>"}`).join(",\n    ")}
  }
}`;
}

function normalizeDiscoverValidation(payload, expectedIds) {
  const out = {
    summary: cleanDiscoverText(payload?.summary),
    dimensions: {},
  };
  expectedIds.forEach((id) => {
    const predicted = Number(payload?.dimensions?.[id]?.predictedScore);
    const predictedScore = Number.isFinite(predicted) ? Math.max(1, Math.min(5, Math.round(predicted))) : null;
    const reason = cleanDiscoverText(payload?.dimensions?.[id]?.reason).slice(0, 180);
    out.dimensions[id] = { predictedScore, reason };
  });
  return out;
}

async function validateDiscoverCandidates({
  desc,
  dims,
  finalScores,
  candidates,
  analysisMeta,
  debugSession,
  analysisMode,
  researchSetup = {},
  liveSearch = true,
}) {
  const validated = [];
  const rejected = [];

  for (let idx = 0; idx < (candidates || []).length; idx += 1) {
    const candidate = candidates[idx];
    const expectedIds = (candidate?.expectedImprovedDimensions || [])
      .filter((id) => dims.some((d) => d.id === id))
      .slice(0, 3);
    if (!expectedIds.length) {
      rejected.push({ title: candidate?.title || `candidate-${idx + 1}`, reason: "No valid claimed dimensions." });
      continue;
    }

    const prompt = discoverValidationPrompt(desc, dims, finalScores, candidate, expectedIds, researchSetup);
    try {
      const res = await callAnalystAPI(
        [{ role: "user", content: prompt }],
        analystPrompt(),
        1800,
        { liveSearch, includeMeta: true }
      );
      absorbDiscoveryMeta(analysisMeta, res.meta);
      const text = res.text || "";
      appendAnalysisDebugEvent(debugSession, {
        type: "model_response",
        phase: "discover_validation",
        attempt: `candidate_${idx + 1}`,
        liveSearch,
        responseLength: text.length,
        meta: res.meta || null,
        prompt: shortText(prompt, 30000),
        responseExcerpt: shortText(text, 6000),
        response: shortText(text, 100000),
        extra: { title: candidate?.title || "" },
      });

      const parsed = parseWithDiagnostics(text, {
        phase: "discover_validation",
        attempt: `candidate_${idx + 1}`,
        useCaseId: debugSession?.useCaseId || "",
        analysisMode,
        prompt,
      }, debugSession);

      const normalized = normalizeDiscoverValidation(parsed, expectedIds);
      const checks = expectedIds.map((id) => {
        const currentScore = finalScoreForDim(finalScores, id);
        const predictedScore = normalized.dimensions?.[id]?.predictedScore;
        const improved = Number.isFinite(currentScore) && Number.isFinite(predictedScore) && predictedScore > currentScore;
        return {
          dimensionId: id,
          currentScore,
          predictedScore,
          improved,
          reason: normalized.dimensions?.[id]?.reason || "",
        };
      });

      const pass = checks.every((c) => c.improved);
      if (pass) {
        const improvedDimensions = checks.filter((c) => c.improved).map((c) => c.dimensionId);
        validated.push({
          ...candidate,
          preValidation: {
            status: "validated",
            summary: normalized.summary || "Validated: candidate is likely to improve claimed weak dimensions.",
            checks,
            improvedDimensions,
          },
        });
      } else {
        rejected.push({
          title: candidate?.title || `candidate-${idx + 1}`,
          reason: "Predicted scores did not improve all claimed dimensions.",
          checks,
        });
      }
    } catch (err) {
      rejected.push({
        title: candidate?.title || `candidate-${idx + 1}`,
        reason: err.message || String(err),
      });
      appendAnalysisDebugEvent(debugSession, {
        type: "discover_validation_failed",
        phase: "discover_validation",
        attempt: `candidate_${idx + 1}`,
        error: err.message || String(err),
        extra: { title: candidate?.title || "" },
      });
    }
  }

  return { validated, rejected };
}

function calcWeightedFromDimScores(dimScores, dims) {
  let wSum = 0;
  let wTotal = 0;
  dims.forEach((d) => {
    const score = Number(dimScores?.[d.id]?.score);
    if (Number.isFinite(score)) {
      wSum += score * d.weight;
      wTotal += d.weight;
    }
  });
  if (!wTotal) return null;
  return Number(((wSum / wTotal / 5) * 100).toFixed(1));
}

function computeHybridDeltaStats(dims, baseline, web, final) {
  let changedFromBaseline = 0;
  let changedFromWeb = 0;
  let largeDeltaFromBaseline = 0;

  dims.forEach((d) => {
    const bs = Number(baseline?.dimensions?.[d.id]?.score);
    const ws = Number(web?.dimensions?.[d.id]?.score);
    const fs = Number(final?.dimensions?.[d.id]?.score);

    if (!Number.isFinite(fs)) return;
    if (Number.isFinite(bs) && fs !== bs) changedFromBaseline += 1;
    if (Number.isFinite(ws) && fs !== ws) changedFromWeb += 1;
    if (Number.isFinite(bs) && Math.abs(fs - bs) >= 2) largeDeltaFromBaseline += 1;
  });

  return {
    changedFromBaseline,
    changedFromWeb,
    largeDeltaFromBaseline,
    baselineWeightedScore: calcWeightedFromDimScores(baseline?.dimensions, dims),
    webWeightedScore: calcWeightedFromDimScores(web?.dimensions, dims),
    reconciledWeightedScore: calcWeightedFromDimScores(final?.dimensions, dims),
  };
}

function countScoreDelta(dims, left, right) {
  let changed = 0;
  dims.forEach((d) => {
    const a = clampScore(left?.dimensions?.[d.id]?.score, null);
    const b = clampScore(right?.dimensions?.[d.id]?.score, null);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    if (a !== b) changed += 1;
  });
  return changed;
}

function countLowConfidenceDimensions(payload, dims) {
  let low = 0;
  dims.forEach((d) => {
    const conf = normalizeConfidenceLevel(payload?.dimensions?.[d.id]?.confidence);
    if (conf === "low") low += 1;
  });
  return low;
}

function evaluateScorecardReconcileHealth(dims, baseline, web, reconciled) {
  const total = Math.max(1, dims.length);
  const baseVsWebChanged = countScoreDelta(dims, baseline, web);
  const recVsBaseChanged = countScoreDelta(dims, baseline, reconciled);
  const recVsWebChanged = countScoreDelta(dims, web, reconciled);
  const lowConfidenceCount = countLowConfidenceDimensions(reconciled, dims);
  const lowConfidenceRatio = lowConfidenceCount / total;
  const strongDisagreementThreshold = Math.max(2, Math.ceil(total * 0.25));
  const highUncertaintyThreshold = Math.max(2, Math.ceil(total * 0.3));
  const suspicious = (
    baseVsWebChanged >= strongDisagreementThreshold
      && recVsWebChanged === 0
      && lowConfidenceCount >= highUncertaintyThreshold
  ) || (
    baseVsWebChanged >= strongDisagreementThreshold
      && recVsBaseChanged <= 1
      && lowConfidenceRatio >= 0.45
  );

  const notes = [];
  if (baseVsWebChanged >= strongDisagreementThreshold) {
    notes.push(`Baseline vs web disagree on ${baseVsWebChanged}/${total} dimensions.`);
  }
  if (recVsWebChanged === 0) {
    notes.push("Reconcile is identical to web pass despite unresolved uncertainty.");
  }
  if (recVsBaseChanged <= 1) {
    notes.push("Reconcile remained near-baseline even though drafts diverged.");
  }
  if (lowConfidenceCount >= highUncertaintyThreshold) {
    notes.push(`Low-confidence dimensions remain high: ${lowConfidenceCount}/${total}.`);
  }

  return {
    totalDimensions: total,
    baseVsWebChanged,
    recVsBaseChanged,
    recVsWebChanged,
    lowConfidenceCount,
    lowConfidenceRatio,
    suspicious,
    notes,
  };
}

function scoreReconcileCandidate(diag = {}) {
  const recVsWeb = Number(diag.recVsWebChanged || 0);
  const recVsBase = Number(diag.recVsBaseChanged || 0);
  const lowRatio = Number(diag.lowConfidenceRatio || 0);
  const changedBlend = Math.max(recVsWeb, recVsBase);
  const uncertaintyPenalty = lowRatio * 2;
  const suspiciousPenalty = diag.suspicious ? 2 : 0;
  return changedBlend - uncertaintyPenalty - suspiciousPenalty;
}

function buildConsistencyCheckPrompt(desc, dims, p1, p2, p3, researchSetup = {}) {
  const rubricBlock = buildRubricCalibrationBlock(dims, { wordCap: 12 });
  const snapshots = dims.map((d) => {
    const init = p1?.dimensions?.[d.id];
    const crit = p2?.dimensions?.[d.id];
    const fin = p3?.dimensions?.[d.id];
    return [
      `DIMENSION: ${d.label} [${d.id}]`,
      `Initial score: ${init?.score ?? "n/a"}/5`,
      `Critic suggested: ${crit?.suggestedScore ?? "n/a"}/5`,
      `Final score: ${fin?.finalScore ?? "n/a"}/5`,
      `Critic critique: "${clip(crit?.critique, 240)}"`,
      `Final brief: "${clip(fin?.brief, 220)}"`,
      `Final response: "${clip(fin?.response, 260)}"`,
    ].join("\n");
  }).join("\n\n");

  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Audit final scores for rubric consistency for this use case:
"${p1?.attributes?.title || desc}"

Run context:
${setupContext}

Rubric calibration reminders (higher score is better):
${rubricBlock}

Score snapshots:
${snapshots}

Task:
- Keep a final score if it is consistent with rubric direction and evidence.
- If inconsistent, adjust to the nearest defensible integer (1-5).
- Be conservative: do not raise scores unless evidence clearly supports it.

Return ONLY this JSON:
{
  "dimensions": {
    ${dims.map((d) => `"${d.id}": {"adjustedScore": <1-5>, "changed": <true/false>, "reason": "<max 20 words>"}`).join(",\n    ")}
  }
}`;
}

function applyConsistencyAdjustments(p3, audit, dims) {
  const out = JSON.parse(JSON.stringify(p3 || {}));
  out.dimensions = out.dimensions || {};
  const changed = [];

  dims.forEach((d) => {
    const current = Number(out.dimensions?.[d.id]?.finalScore);
    const proposed = Number(audit?.dimensions?.[d.id]?.adjustedScore);
    if (!Number.isFinite(proposed)) return;
    const adj = Math.max(1, Math.min(5, Math.round(proposed)));
    const auditReason = String(
      audit?.dimensions?.[d.id]?.reason
      || "Adjusted for rubric consistency after cross-phase audit."
    ).trim();
    if (!Number.isFinite(current)) {
      out.dimensions[d.id] = out.dimensions[d.id] || {};
      out.dimensions[d.id].finalScore = adj;
      out.dimensions[d.id].scoreChanged = true;
      out.dimensions[d.id].decision = "concede";
      out.dimensions[d.id].revisionBasis = "rubric_alignment";
      out.dimensions[d.id].revisionJustification = auditReason;
      changed.push({ id: d.id, from: null, to: adj });
      return;
    }
    if (current !== adj) {
      out.dimensions[d.id].finalScore = adj;
      out.dimensions[d.id].scoreChanged = true;
      out.dimensions[d.id].decision = "concede";
      out.dimensions[d.id].revisionBasis = "rubric_alignment";
      out.dimensions[d.id].revisionJustification = auditReason;
      changed.push({ id: d.id, from: current, to: adj });
    }
  });

  return { adjusted: out, changed };
}

function buildCrossDimensionCoherencePrompt(desc, dims, finalPayload = {}, researchSetup = {}) {
  const snapshots = dims.map((d) => {
    const row = finalPayload?.dimensions?.[d.id] || {};
    return {
      id: d.id,
      label: d.label,
      polarityHint: d.polarityHint || "",
      score: clampScore(row?.finalScore, null),
      confidence: normalizeConfidenceLevel(row?.confidence) || "low",
      brief: clip(row?.brief, 180),
      response: clip(row?.response, 220),
      risks: clip(row?.risks, 140),
    };
  });

  const setupContext = buildResearchSetupContextBlock(researchSetup);

  return `Audit cross-dimension coherence for this completed research output.

Research input:
"${desc}"

Run context:
${setupContext}

Dimensions snapshot:
${JSON.stringify(snapshots, null, 2)}

Task:
- Flag contradictions across dimensions (for example, strong defensibility paired with strong commoditization pressure).
- Prioritize only material conflicts that could mislead a decision.
- Suggest conservative score caps when contradiction is significant.

Return JSON only:
{
  "conflicts": [
    {
      "dimensionId": "<dimension id to adjust>",
      "conflictsWith": "<other dimension id>",
      "suggestedCap": <1-5>,
      "note": "<short contradiction explanation>"
    }
  ]
}`;
}

function normalizeCrossDimensionConflicts(payload = {}, dims = []) {
  const validIds = new Set(dims.map((d) => d.id));
  const raw = Array.isArray(payload?.conflicts) ? payload.conflicts : [];
  return raw
    .map((entry) => {
      const dimensionId = cleanString(entry?.dimensionId);
      if (!validIds.has(dimensionId)) return null;
      const conflictsWith = cleanString(entry?.conflictsWith);
      const suggestedCap = clampScore(entry?.suggestedCap, null);
      const note = cleanString(entry?.note).slice(0, 260);
      if (!Number.isFinite(suggestedCap)) return null;
      return { dimensionId, conflictsWith, suggestedCap, note };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function applyCrossDimensionCoherenceAdjustments(payload = {}, conflicts = []) {
  const out = payload && typeof payload === "object"
    ? JSON.parse(JSON.stringify(payload))
    : {};
  out.dimensions = out.dimensions && typeof out.dimensions === "object" ? out.dimensions : {};
  const adjustments = [];

  conflicts.forEach((conflict) => {
    const target = out.dimensions?.[conflict.dimensionId];
    if (!target) return;
    const current = clampScore(target?.finalScore, null);
    const cap = clampScore(conflict?.suggestedCap, null);
    if (!Number.isFinite(current) || !Number.isFinite(cap)) return;
    if (current <= cap) return;
    target.finalScore = cap;
    target.scoreChanged = true;
    target.decision = "concede";
    target.revisionBasis = "cross_dimension_coherence";
    target.revisionJustification = conflict?.note
      || `Adjusted for cross-dimension coherence with ${conflict?.conflictsWith || "another dimension"}.`;
    adjustments.push({
      dimensionId: conflict.dimensionId,
      conflictsWith: conflict?.conflictsWith || "",
      from: current,
      to: cap,
      note: conflict?.note || "",
    });
  });

  return { adjusted: out, adjustments };
}

function ensureDimensionConfidence(payload, dims) {
  const out = payload || {};
  out.dimensions = out.dimensions || {};

  dims.forEach((d) => {
    out.dimensions[d.id] = out.dimensions[d.id] || {};
    const dim = out.dimensions[d.id];
    const normalized = normalizeConfidenceLevel(dim.confidence);
    const sourceCount = Array.isArray(dim.sources)
      ? dim.sources.filter((s) => s && (s.url || s.name || s.quote)).length
      : 0;

    if (normalized) {
      dim.confidence = normalized;
    } else {
      dim.confidence = sourceCount >= 3 ? "medium" : "low";
    }

    const reason = typeof dim.confidenceReason === "string" ? dim.confidenceReason.trim() : "";
    if (reason) {
      dim.confidenceReason = reason;
    } else if (dim.confidence === "high") {
      dim.confidenceReason = "Strong named evidence is available, but key claims should still be spot-checked.";
    } else if (dim.confidence === "medium") {
      dim.confidenceReason = "Evidence exists, but verification depth is uneven across available sources.";
    } else {
      dim.confidenceReason = "Confidence is limited because explicit, verifiable deployments are sparse.";
    }
  });

  return out;
}

function ensureDimensionArguments(payload, dims) {
  const out = payload || {};
  out.dimensions = out.dimensions || {};
  dims.forEach((d) => {
    out.dimensions[d.id] = out.dimensions[d.id] || {};
    const shape = ensureDimensionArgumentShape(out.dimensions[d.id], d.id);
    out.dimensions[d.id].arguments = shape;
  });
  return out;
}

function ensureFinalAnalystSummary(payload, dims) {
  const out = payload || {};
  const top = typeof out.analystResponse === "string" ? out.analystResponse.trim() : "";
  if (top) {
    out.analystResponse = top;
    return out;
  }

  const snippets = dims
    .map((d) => String(out.dimensions?.[d.id]?.response || "").trim())
    .filter(Boolean)
    .slice(0, 2);

  out.analystResponse = snippets.length
    ? snippets.join(" ")
    : "Analyst finalized per-dimension updates after critique.";
  return out;
}

function mergePhase3WithBaseline(payload, phase1, dims) {
  const out = payload && typeof payload === "object" ? { ...payload } : {};
  out.attributes = out.attributes && typeof out.attributes === "object"
    ? { ...out.attributes }
    : { ...(phase1?.attributes || {}) };
  out.sources = mergeSourceLists(out.sources, phase1?.sources);
  out.dimensions = out.dimensions && typeof out.dimensions === "object" ? { ...out.dimensions } : {};

  dims.forEach((d) => {
    const base = phase1?.dimensions?.[d.id] || {};
    const fin = out.dimensions?.[d.id] || {};
    const baseScore = clampScore(base?.score, 3);
    const nextScore = clampScore(fin?.finalScore, baseScore);
    const merged = {
      ...base,
      ...fin,
      finalScore: nextScore,
      scoreChanged: Number.isFinite(baseScore) && Number.isFinite(nextScore) ? nextScore !== baseScore : !!fin?.scoreChanged,
      confidence: normalizeConfidenceLevel(fin?.confidence) || normalizeConfidenceLevel(base?.confidence) || "medium",
      confidenceReason: String(fin?.confidenceReason || "").trim() || String(base?.confidenceReason || "").trim(),
      brief: String(fin?.brief || "").trim() || String(base?.brief || "").trim(),
      full: String(fin?.full || "").trim() || String(base?.full || "").trim(),
      risks: String(fin?.risks || "").trim() || String(base?.risks || "").trim(),
      missingEvidence: String(fin?.missingEvidence || "").trim() || String(base?.missingEvidence || "").trim(),
      response: String(fin?.response || "").trim(),
      sources: mergeSourceLists(fin?.sources, base?.sources),
      arguments: fin?.arguments || base?.arguments || null,
    };
    out.dimensions[d.id] = merged;
  });

  return out;
}

function confidenceRank(level) {
  const normalized = normalizeConfidenceLevel(level);
  if (normalized === "high") return 3;
  if (normalized === "medium") return 2;
  if (normalized === "low") return 1;
  return 0;
}

function confidenceFromRank(rank, fallback = "medium") {
  if (rank >= 3) return "high";
  if (rank >= 2) return "medium";
  if (rank >= 1) return "low";
  return fallback;
}

function isNewSpecificConfidenceGap(gapText, phase1Dim = {}) {
  const gap = String(gapText || "").trim();
  if (!hasSpecificMissingEvidenceGap(gap)) return false;
  const priorGap = [
    String(phase1Dim?.missingEvidence || "").trim(),
    String(phase1Dim?.confidenceReason || "").trim(),
  ].filter(Boolean).join(" ").toLowerCase();
  if (!priorGap) return true;
  const normalizedGap = gap.toLowerCase();
  if (priorGap.includes(normalizedGap)) return false;
  if (normalizedGap.length > 28 && priorGap.includes(normalizedGap.slice(0, 28))) return false;
  return true;
}

function normalizePhase3Decision(rawValue, initialScore, finalScore) {
  const raw = String(rawValue || "").trim().toLowerCase();
  if (!raw) {
    if (Number.isFinite(initialScore) && Number.isFinite(finalScore) && finalScore === initialScore) return "defend";
    if (Number.isFinite(initialScore) && Number.isFinite(finalScore) && finalScore !== initialScore) return "concede";
    return "defend";
  }
  if (["defend", "keep", "maintain", "uphold", "hold"].includes(raw)) return "defend";
  if (["concede", "revise", "change", "adjust"].includes(raw)) return "concede";
  if (raw.includes("defend") || raw.includes("keep")) return "defend";
  if (raw.includes("concede") || raw.includes("revise") || raw.includes("adjust")) return "concede";
  return Number.isFinite(initialScore) && Number.isFinite(finalScore) && finalScore !== initialScore
    ? "concede"
    : "defend";
}

function hasSpecificRevisionReason(text, phase1Dim = {}, criticDim = {}) {
  const reason = String(text || "").trim();
  if (reason.length < 24) return false;
  if (hasSpecificMissingEvidenceGap(reason)) return true;

  const lower = reason.toLowerCase();
  const signalWords = [
    "evidence", "source", "deployment", "benchmark", "metric", "audited", "study",
    "outcome", "regulator", "compliance", "baseline", "counterfactual", "variance",
  ];
  const hasSignalWord = signalWords.some((w) => lower.includes(w));
  const hasNumericSignal = /\b20\d{2}\b/.test(reason) || /\b\d+(?:\.\d+)?%?\b/.test(reason);
  const hasEntityLikeToken = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/.test(reason);
  const priorContext = [
    String(phase1Dim?.confidenceReason || ""),
    String(phase1Dim?.missingEvidence || ""),
    String(criticDim?.critique || ""),
  ].join(" ").toLowerCase();
  const nonTrivial = reason.length >= 48 || (hasNumericSignal && hasSignalWord);
  if (!nonTrivial) return false;
  if (!(hasSignalWord || hasNumericSignal || hasEntityLikeToken)) return false;
  if (priorContext && priorContext.includes(reason.toLowerCase()) && reason.length < 64) return false;
  return true;
}

function inferRevisionBasis(rawBasis, reasonText) {
  const basis = String(rawBasis || "").trim().toLowerCase();
  const allowed = new Set(["new_evidence", "evidence_gap", "rubric_alignment", "rubric_misalignment", "none"]);
  if (allowed.has(basis)) return basis;
  const lower = String(reasonText || "").toLowerCase();
  if (/(missing|gap|sparse|insufficient|uncertain)/.test(lower)) return "evidence_gap";
  if (/(rubric|threshold|criteria|calibration|anchor)/.test(lower)) return "rubric_alignment";
  if (/(new|updated|latest|fresh|recent|audit|benchmark)/.test(lower)) return "new_evidence";
  return "none";
}

function enforcePhase3DecisionRules(payload, phase1, phase2, dims) {
  const out = payload && typeof payload === "object"
    ? JSON.parse(JSON.stringify(payload))
    : {};
  out.dimensions = out.dimensions && typeof out.dimensions === "object" ? out.dimensions : {};
  const adjustments = [];

  for (const d of dims) {
    const id = d.id;
    out.dimensions[id] = out.dimensions[id] || {};
    const finalDim = out.dimensions[id];
    const initialDim = phase1?.dimensions?.[id] || {};
    const criticDim = phase2?.dimensions?.[id] || {};

    const initialScore = clampScore(initialDim?.score, null);
    const criticSuggested = clampScore(criticDim?.suggestedScore, null);
    let finalScore = clampScore(finalDim?.finalScore, initialScore);
    const hasExplicitDecision = Boolean(
      String(finalDim?.decision || "").trim() || String(finalDim?.stance || "").trim()
    );
    const decision = normalizePhase3Decision(finalDim?.decision || finalDim?.stance, initialScore, finalScore);
    const changed = Number.isFinite(initialScore) && Number.isFinite(finalScore) && finalScore !== initialScore;
    const revisionReason = String(
      finalDim?.revisionJustification
      || finalDim?.scoreChangeReason
      || finalDim?.confidenceGap
      || finalDim?.response
      || ""
    ).trim();
    const revisionBasis = inferRevisionBasis(finalDim?.revisionBasis, revisionReason);
    const hasSpecificReason = hasSpecificRevisionReason(revisionReason, initialDim, criticDim);

    if (changed) {
      if (!hasExplicitDecision || decision !== "concede" || !hasSpecificReason || revisionBasis === "none") {
        const from = finalScore;
        finalScore = initialScore;
        finalDim.finalScore = initialScore;
        finalDim.scoreChanged = false;
        finalDim.decision = "defend";
        finalDim.revisionBasis = "none";
        finalDim.revisionJustification = "Score unchanged because concession lacked specific evidence-backed rationale.";
        adjustments.push({
          dimensionId: id,
          type: "revert_unsupported_concession",
          from,
          to: initialScore,
          detail: "Score change reverted: explicit concession + specific rationale required.",
        });
      } else {
        finalDim.scoreChanged = true;
        finalDim.decision = "concede";
        finalDim.revisionBasis = revisionBasis;
        if (!String(finalDim?.revisionJustification || "").trim()) {
          finalDim.revisionJustification = clip(revisionReason, 180);
        }
      }
    } else {
      finalDim.finalScore = initialScore ?? finalScore;
      finalDim.scoreChanged = false;
      finalDim.decision = "defend";
      finalDim.revisionBasis = "none";
      finalDim.revisionJustification = "";
      const newNamedSourceCount = countNewNamedSources(finalDim?.sources, initialDim?.sources);
      if (newNamedSourceCount === 0) {
        if (!String(finalDim?.confidenceGap || "").trim()) {
          finalDim.confidenceGap = "No new named source beyond Phase 1 evidence.";
        }
        adjustments.push({
          dimensionId: id,
          type: "defense_without_new_source",
          from: initialScore,
          to: initialScore,
          detail: "Defense reused prior sources; confidence should be capped unless a new named source is added.",
        });
      }
    }

    if (Number.isFinite(criticSuggested) && Number.isFinite(finalDim?.finalScore) && finalDim.finalScore === criticSuggested) {
      finalDim.criticAligned = true;
    } else {
      finalDim.criticAligned = false;
    }
  }

  return { adjusted: out, adjustments };
}

function enforcePhase3ConfidenceRules(payload, phase1, phase2, dims) {
  const out = payload && typeof payload === "object"
    ? JSON.parse(JSON.stringify(payload))
    : {};
  out.dimensions = out.dimensions && typeof out.dimensions === "object" ? out.dimensions : {};
  const adjustments = [];

  for (const d of dims) {
    const id = d.id;
    const initialDim = phase1?.dimensions?.[id] || {};
    const criticDim = phase2?.dimensions?.[id] || {};
    out.dimensions[id] = out.dimensions[id] || {};
    const finalDim = out.dimensions[id];

    const initialScore = clampScore(initialDim?.score, null);
    const finalScore = clampScore(finalDim?.finalScore, initialScore);
    const initialConfidence = normalizeConfidenceLevel(initialDim?.confidence) || "medium";
    let finalConfidence = normalizeConfidenceLevel(finalDim?.confidence) || initialConfidence;

    const defendedScore = Number.isFinite(initialScore) && Number.isFinite(finalScore) && initialScore === finalScore;
    const criticSuggested = clampScore(criticDim?.suggestedScore, null);
    const criticAligned = Number.isFinite(criticSuggested) && Number.isFinite(finalScore) && criticSuggested === finalScore;
    const confidenceGapText = String(
      finalDim?.newEvidenceGap
      || finalDim?.confidenceGap
      || finalDim?.confidenceChangeReason
      || ""
    ).trim();

    if (defendedScore) {
      const newNamedSourceCount = countNewNamedSources(finalDim?.sources, initialDim?.sources);
      if (newNamedSourceCount === 0) {
        const targetRank = initialConfidence === "high"
          ? confidenceRank("medium")
          : confidenceRank("low");
        if (confidenceRank(finalConfidence) > targetRank) {
          const prev = finalConfidence;
          finalConfidence = confidenceFromRank(targetRank, "medium");
          adjustments.push({
            dimensionId: id,
            type: "defense_no_new_source_confidence_cap",
            from: prev,
            to: finalConfidence,
            detail: "Defended score kept without new named source; confidence capped until fresh evidence is cited.",
          });
        }
        if (!String(finalDim?.confidenceGap || "").trim()) {
          finalDim.confidenceGap = "No new named source beyond Phase 1 evidence.";
        }
      }
      // Defended dimensions cannot lose confidence; floor is at least medium.
      if (newNamedSourceCount > 0) {
        const minRank = Math.max(confidenceRank(initialConfidence), confidenceRank("medium"));
        if (confidenceRank(finalConfidence) < minRank) {
          const prev = finalConfidence;
          finalConfidence = confidenceFromRank(minRank, initialConfidence);
          adjustments.push({
            dimensionId: id,
            type: "defense_floor",
            from: prev,
            to: finalConfidence,
            detail: `Score defended (${initialScore}/5); confidence cannot decrease below Phase 1 and medium floor.`,
          });
        }
      }
    } else if (confidenceRank(finalConfidence) < confidenceRank(initialConfidence)) {
      // Concessions may reduce confidence only with a new specific gap.
      const hasNewSpecificGap = isNewSpecificConfidenceGap(
        confidenceGapText || finalDim?.confidenceReason || finalDim?.response || "",
        initialDim
      );
      if (!hasNewSpecificGap) {
        const prev = finalConfidence;
        finalConfidence = initialConfidence;
        adjustments.push({
          dimensionId: id,
          type: criticAligned ? "concession_no_new_gap" : "revision_no_new_gap",
          from: prev,
          to: finalConfidence,
          detail: "Confidence drop reverted because no specific new evidence gap was provided.",
        });
      }
    }

    finalDim.confidence = finalConfidence;
    if (!String(finalDim?.confidenceReason || "").trim()) {
      finalDim.confidenceReason = defendedScore
        ? "Confidence remains stable because the score was defended with supporting evidence."
        : "Confidence reflects available evidence depth after critique.";
    }
  }

  return { adjusted: out, adjustments };
}

function polaritySignalCounts(text = "") {
  const normalized = String(text || "").toLowerCase();
  const negativePatterns = [
    /\binsufficient evidence\b/g,
    /\bno reliable evidence\b/g,
    /\bweak evidence\b/g,
    /\blimited evidence\b/g,
    /\bthin evidence\b/g,
    /\bhigh uncertainty\b/g,
    /\buncertain\b/g,
    /\bunproven\b/g,
    /\bspeculative\b/g,
    /\bhigh risk\b/g,
    /\bimmature\b/g,
  ];
  const positivePatterns = [
    /\bstrong evidence\b/g,
    /\bmultiple independent sources\b/g,
    /\bverifiable\b/g,
    /\bwell evidenced\b/g,
    /\brepeatable\b/g,
    /\bvalidated\b/g,
    /\bproven\b/g,
    /\bdurable advantage\b/g,
  ];

  const countMatches = (patterns) => patterns.reduce((sum, pattern) => {
    const matches = normalized.match(pattern);
    return sum + (matches ? matches.length : 0);
  }, 0);

  return {
    negative: countMatches(negativePatterns),
    positive: countMatches(positivePatterns),
  };
}

function isInversePolarityHint(dim = {}) {
  const hint = cleanString(dim?.polarityHint).toLowerCase();
  if (!hint) return false;
  return (
    hint.includes("higher score = worse")
    || hint.includes("higher score means worse")
    || hint.includes("lower score = better")
    || hint.includes("low score is better")
    || hint.includes("inverse polarity")
    || hint.includes("higher is worse")
  );
}

function enforcePhase3PolarityRules(payload, phase1, dims) {
  const out = payload && typeof payload === "object"
    ? JSON.parse(JSON.stringify(payload))
    : {};
  out.dimensions = out.dimensions && typeof out.dimensions === "object" ? out.dimensions : {};
  const adjustments = [];

  for (const d of dims) {
    const id = d.id;
    const initialDim = phase1?.dimensions?.[id] || {};
    out.dimensions[id] = out.dimensions[id] || {};
    const finalDim = out.dimensions[id];

    const initialScore = clampScore(initialDim?.score, null);
    let finalScore = clampScore(finalDim?.finalScore, initialScore);
    const finalConfidence = normalizeConfidenceLevel(finalDim?.confidence) || "medium";
    const basis = String(finalDim?.revisionBasis || "").trim().toLowerCase();
    const textBundle = [
      finalDim?.brief,
      finalDim?.response,
      finalDim?.confidenceReason,
      finalDim?.revisionJustification,
      finalDim?.confidenceGap,
    ].filter(Boolean).join(" ");
    const signals = polaritySignalCounts(textBundle);
    const inversePolarity = isInversePolarityHint(d);

    if (basis === "evidence_gap" && Number.isFinite(initialScore) && Number.isFinite(finalScore) && finalScore > initialScore) {
      const from = finalScore;
      finalScore = initialScore;
      finalDim.finalScore = finalScore;
      finalDim.scoreChanged = false;
      finalDim.decision = "defend";
      finalDim.revisionBasis = "none";
      finalDim.revisionJustification = "Score increase removed because revisionBasis was evidence_gap.";
      adjustments.push({
        dimensionId: id,
        type: "evidence_gap_cannot_raise_score",
        from,
        to: finalScore,
        detail: "Evidence-gap concessions cannot produce higher scores.",
      });
    }

    if (Number.isFinite(finalScore) && finalScore >= 4 && finalConfidence === "low") {
      const from = finalScore;
      finalScore = 3;
      finalDim.finalScore = finalScore;
      finalDim.scoreChanged = Number.isFinite(initialScore) ? finalScore !== initialScore : true;
      if (!String(finalDim?.revisionJustification || "").trim()) {
        finalDim.revisionJustification = "High score reduced because confidence remained low after critique.";
      }
      adjustments.push({
        dimensionId: id,
        type: "high_score_low_confidence_cap",
        from,
        to: finalScore,
        detail: "Scores 4-5 are not allowed with low confidence after final checks.",
      });
    }

    if (!inversePolarity && Number.isFinite(finalScore) && finalScore >= 4 && signals.negative >= 2 && signals.positive === 0) {
      const from = finalScore;
      finalScore = 3;
      finalDim.finalScore = finalScore;
      finalDim.scoreChanged = Number.isFinite(initialScore) ? finalScore !== initialScore : true;
      if (!String(finalDim?.revisionJustification || "").trim()) {
        finalDim.revisionJustification = "Score capped due to negative evidence wording inconsistent with 4-5 rating.";
      }
      adjustments.push({
        dimensionId: id,
        type: "polarity_text_score_mismatch",
        from,
        to: finalScore,
        detail: "Narrative indicates weak evidence while score remained high.",
      });
    }

    if (inversePolarity && Number.isFinite(finalScore) && finalScore <= 2 && signals.negative >= 2 && signals.positive === 0) {
      const from = finalScore;
      finalScore = 3;
      finalDim.finalScore = finalScore;
      finalDim.scoreChanged = Number.isFinite(initialScore) ? finalScore !== initialScore : true;
      if (!String(finalDim?.revisionJustification || "").trim()) {
        finalDim.revisionJustification = "Score adjusted because inverse-polarity dimension had negative evidence wording with overly optimistic rating.";
      }
      adjustments.push({
        dimensionId: id,
        type: "polarity_text_score_mismatch_inverse",
        from,
        to: finalScore,
        detail: "Inverse-polarity dimension narrative indicates weak evidence while score remained too optimistic.",
      });
    }
  }

  return { adjusted: out, adjustments };
}

function sanitizeEvidenceItem(item) {
  if (!item || typeof item !== "object") return null;
  const point = String(item.point || "").trim();
  if (!point) return null;
  const source = item.source && typeof item.source === "object"
    ? {
        name: String(item.source.name || "").trim(),
        quote: String(item.source.quote || "").trim(),
        url: String(item.source.url || "").trim(),
        sourceType: normalizeEvidenceSourceType(item.source.sourceType),
      }
    : null;
  return {
    point,
    relevance: String(item.relevance || "").trim(),
    source,
  };
}

function ensureEvidencePayload(payload, dims) {
  const out = payload && typeof payload === "object" ? { ...payload } : {};
  out.attributes = out.attributes && typeof out.attributes === "object" ? out.attributes : {};
  out.dimensions = out.dimensions && typeof out.dimensions === "object" ? { ...out.dimensions } : {};

  dims.forEach((d) => {
    const raw = out.dimensions?.[d.id];
    const evidence = Array.isArray(raw?.evidence)
      ? raw.evidence.map(sanitizeEvidenceItem).filter(Boolean).slice(0, 14)
      : [];
    out.dimensions[d.id] = {
      evidence,
      missingEvidence: String(raw?.missingEvidence || "").trim(),
    };
  });

  return out;
}

function attachEnumeratedEvidence(scoredPayload, evidencePayload, dims) {
  const out = ensureDimensionArguments(ensureDimensionConfidence(scoredPayload, dims), dims);
  out.attributes = {
    ...(evidencePayload?.attributes || {}),
    ...(out.attributes && typeof out.attributes === "object" ? out.attributes : {}),
  };
  out.dimensions = out.dimensions && typeof out.dimensions === "object" ? { ...out.dimensions } : {};

  dims.forEach((d) => {
    out.dimensions[d.id] = out.dimensions[d.id] || {};
    const ev = evidencePayload?.dimensions?.[d.id] || {};
    out.dimensions[d.id].evidenceEnumerated = Array.isArray(ev.evidence) ? ev.evidence : [];
    out.dimensions[d.id].missingEvidence = String(ev.missingEvidence || "");
  });

  return out;
}

function absorbAnalystMeta(analysisMeta, meta) {
  if (!meta) return;
  if (meta.liveSearchUsed) analysisMeta.liveSearchUsed = true;
  analysisMeta.webSearchCalls += Number(meta.webSearchCalls || 0);
  if (!analysisMeta.liveSearchFallbackReason && meta.liveSearchFallbackReason) {
    analysisMeta.liveSearchFallbackReason = meta.liveSearchFallbackReason;
  }
}

function absorbCriticMeta(analysisMeta, meta) {
  if (!meta) return;
  if (meta.liveSearchUsed) analysisMeta.criticLiveSearchUsed = true;
  analysisMeta.criticWebSearchCalls += Number(meta.webSearchCalls || 0);
  if (!analysisMeta.criticLiveSearchFallbackReason && meta.liveSearchFallbackReason) {
    analysisMeta.criticLiveSearchFallbackReason = meta.liveSearchFallbackReason;
  }
}

function absorbDiscoveryMeta(analysisMeta, meta) {
  if (!meta) return;
  if (meta.liveSearchUsed) analysisMeta.discoveryLiveSearchUsed = true;
  analysisMeta.discoveryWebSearchCalls += Number(meta.webSearchCalls || 0);
  if (!analysisMeta.discoveryLiveSearchFallbackReason && meta.liveSearchFallbackReason) {
    analysisMeta.discoveryLiveSearchFallbackReason = meta.liveSearchFallbackReason;
  }
}

function absorbLowConfidenceMeta(analysisMeta, meta) {
  if (!meta) return;
  if (meta.liveSearchUsed) analysisMeta.lowConfidenceTargetedSearchUsed = true;
  analysisMeta.lowConfidenceTargetedWebSearchCalls += Number(meta.webSearchCalls || 0);
  if (!analysisMeta.lowConfidenceTargetedFallbackReason && meta.liveSearchFallbackReason) {
    analysisMeta.lowConfidenceTargetedFallbackReason = meta.liveSearchFallbackReason;
  }
}

async function runAnalystPass({
  evidencePromptBuilder,
  scoringPromptBuilder,
  dims,
  analysisMeta,
  debugContext,
  debugSession,
  liveSearch = false,
  evidenceMaxTokens = 9000,
  scoringMaxTokens = 12000,
  passLabel = "analyst",
  requestOptions = {},
}) {
  const resolvedEvidenceOptions = liveSearch
    ? withCapabilityModelOptions("retrieval", "analyst", requestOptions || {})
    : withRoleModelOptions("analyst", requestOptions || {});
  const resolvedScoringOptions = withRoleModelOptions("analyst", requestOptions || {});
  let evidencePayload;
  try {
    const fullPrompt = evidencePromptBuilder(false);
    const fullRes = await callAnalystAPI(
      [{ role: "user", content: fullPrompt }],
      analystPrompt(),
      evidenceMaxTokens,
      { ...(resolvedEvidenceOptions || {}), liveSearch, includeMeta: true }
    );
    absorbAnalystMeta(analysisMeta, fullRes.meta);
    appendAnalysisDebugEvent(debugSession, {
      type: "model_response",
      phase: "analyst_evidence",
      attempt: `${passLabel}_full`,
      liveSearch,
      responseLength: fullRes.text?.length || 0,
      meta: fullRes.meta || null,
      prompt: shortText(fullPrompt, 30000),
      responseExcerpt: shortText(fullRes.text, 6000),
      response: shortText(fullRes.text, 100000),
    });
    evidencePayload = ensureEvidencePayload(parseWithDiagnostics(fullRes.text, {
      phase: "analyst_evidence",
      attempt: `${passLabel}_full`,
      useCaseId: debugContext.useCaseId,
      analysisMode: debugContext.analysisMode,
      prompt: fullPrompt,
    }, debugSession), dims);
  } catch (parseErr) {
    appendAnalysisDebugEvent(debugSession, {
      type: "phase_retry_triggered",
      phase: "analyst_evidence",
      attempt: `${passLabel}_full`,
      error: parseErr.message || String(parseErr),
    });
    console.warn("Analyst evidence parse failed, retrying with condensed prompt:", parseErr.message);
    const condensedPrompt = evidencePromptBuilder(true);
    const condensedRes = await callAnalystAPI(
      [{ role: "user", content: condensedPrompt }],
      analystPrompt(),
      8000,
      { ...(resolvedEvidenceOptions || {}), liveSearch, includeMeta: true }
    );
    absorbAnalystMeta(analysisMeta, condensedRes.meta);
    appendAnalysisDebugEvent(debugSession, {
      type: "model_response",
      phase: "analyst_evidence",
      attempt: `${passLabel}_condensed_retry`,
      liveSearch,
      responseLength: condensedRes.text?.length || 0,
      meta: condensedRes.meta || null,
      prompt: shortText(condensedPrompt, 30000),
      responseExcerpt: shortText(condensedRes.text, 6000),
      response: shortText(condensedRes.text, 100000),
    });
    evidencePayload = ensureEvidencePayload(parseWithDiagnostics(condensedRes.text, {
      phase: "analyst_evidence",
      attempt: `${passLabel}_condensed_retry`,
      useCaseId: debugContext.useCaseId,
      analysisMode: debugContext.analysisMode,
      prompt: condensedPrompt,
    }, debugSession), dims);
  }

  appendAnalysisDebugEvent(debugSession, {
    type: "phase_complete",
    phase: "analyst_evidence",
    attempt: passLabel,
    responseLength: JSON.stringify(evidencePayload || {}).length,
  });

  try {
    const fullPrompt = scoringPromptBuilder(evidencePayload, false);
    const fullRes = await callAnalystAPI(
      [{ role: "user", content: fullPrompt }],
      analystPrompt(),
      scoringMaxTokens,
      { ...(resolvedScoringOptions || {}), liveSearch: false, includeMeta: true }
    );
    absorbAnalystMeta(analysisMeta, fullRes.meta);
    appendAnalysisDebugEvent(debugSession, {
      type: "model_response",
      phase: "analyst_scoring",
      attempt: `${passLabel}_full`,
      liveSearch: false,
      responseLength: fullRes.text?.length || 0,
      meta: fullRes.meta || null,
      prompt: shortText(fullPrompt, 30000),
      responseExcerpt: shortText(fullRes.text, 6000),
      response: shortText(fullRes.text, 100000),
    });

    const scored = parseWithDiagnostics(fullRes.text, {
      phase: "analyst_scoring",
      attempt: `${passLabel}_full`,
      useCaseId: debugContext.useCaseId,
      analysisMode: debugContext.analysisMode,
      prompt: fullPrompt,
    }, debugSession);

    const merged = attachEnumeratedEvidence(scored, evidencePayload, dims);
    appendAnalysisDebugEvent(debugSession, {
      type: "phase_complete",
      phase: "analyst_scoring",
      attempt: passLabel,
      responseLength: JSON.stringify(merged || {}).length,
    });
    return merged;
  } catch (parseErr) {
    appendAnalysisDebugEvent(debugSession, {
      type: "phase_retry_triggered",
      phase: "analyst_scoring",
      attempt: `${passLabel}_full`,
      error: parseErr.message || String(parseErr),
    });
    console.warn("Analyst scoring parse failed, retrying with condensed prompt:", parseErr.message);

    const condensedPrompt = scoringPromptBuilder(evidencePayload, true);
    const condensedRes = await callAnalystAPI(
      [{ role: "user", content: condensedPrompt }],
      analystPrompt(),
      8000,
      { ...(resolvedScoringOptions || {}), liveSearch: false, includeMeta: true }
    );
    absorbAnalystMeta(analysisMeta, condensedRes.meta);
    appendAnalysisDebugEvent(debugSession, {
      type: "model_response",
      phase: "analyst_scoring",
      attempt: `${passLabel}_condensed_retry`,
      liveSearch: false,
      responseLength: condensedRes.text?.length || 0,
      meta: condensedRes.meta || null,
      prompt: shortText(condensedPrompt, 30000),
      responseExcerpt: shortText(condensedRes.text, 6000),
      response: shortText(condensedRes.text, 100000),
    });
    const scored = parseWithDiagnostics(condensedRes.text, {
      phase: "analyst_scoring",
      attempt: `${passLabel}_condensed_retry`,
      useCaseId: debugContext.useCaseId,
      analysisMode: debugContext.analysisMode,
      prompt: condensedPrompt,
    }, debugSession);
    const merged = attachEnumeratedEvidence(scored, evidencePayload, dims);
    appendAnalysisDebugEvent(debugSession, {
      type: "phase_complete",
      phase: "analyst_scoring",
      attempt: `${passLabel}_condensed_retry`,
      responseLength: JSON.stringify(merged || {}).length,
    });
    return merged;
  }
}

async function runHybridPhase1(
  desc,
  dims,
  updateUC,
  id,
  analysisMeta,
  debugSession,
  tokenLimits = {},
  {
    inputSpec = {},
    framingFields = [],
    allowDegraded = false,
    researchSetup = {},
  } = {}
) {
  const evidenceMaxTokens = Number(tokenLimits.phase1Evidence) || 10000;
  const scoringMaxTokens = Number(tokenLimits.phase1Scoring) || 12000;
  const debugContext = { useCaseId: id, analysisMode: analysisMeta.analysisMode };
  updateUC(id, (u) => ({ ...u, phase: "analyst_baseline" }));
  const baseline = await runAnalystPass({
    evidencePromptBuilder: (condensed) => buildPhase1EvidencePrompt(desc, dims, {
      liveSearch: false,
      condensed,
      inputSpec,
      framingFields,
      researchSetup,
    }),
    scoringPromptBuilder: (evidence, condensed) => buildPhase1ScoringPrompt(desc, dims, evidence, {
      condensed,
      passLabel: "baseline analyst pass (memory-only)",
      framingFields,
      researchSetup,
    }),
    dims,
    analysisMeta,
    debugContext,
    debugSession,
    liveSearch: false,
    evidenceMaxTokens,
    scoringMaxTokens,
    passLabel: "analyst_baseline",
  });

  updateUC(id, (u) => ({ ...u, phase: "analyst_web" }));
  const web = await runAnalystPass({
    evidencePromptBuilder: (condensed) => buildPhase1EvidencePrompt(desc, dims, {
      liveSearch: true,
      condensed,
      inputSpec,
      framingFields,
      researchSetup,
    }),
    scoringPromptBuilder: (evidence, condensed) => buildPhase1ScoringPrompt(desc, dims, evidence, {
      condensed,
      passLabel: "web-assisted analyst pass",
      framingFields,
      researchSetup,
    }),
    dims,
    analysisMeta,
    debugContext,
    debugSession,
    liveSearch: true,
    evidenceMaxTokens,
    scoringMaxTokens,
    passLabel: "analyst_web",
  });

  updateUC(id, (u) => ({ ...u, phase: "analyst_reconcile" }));
  const reconciled = await runAnalystPass({
    evidencePromptBuilder: (condensed) => buildHybridReconcileEvidencePrompt(desc, dims, baseline, web, {
      condensed,
      framingFields,
      researchSetup,
    }),
    scoringPromptBuilder: (evidence, condensed) => buildPhase1ScoringPrompt(desc, dims, evidence, {
      condensed,
      passLabel: "hybrid reliability reconcile (score from merged evidence)",
      framingFields,
      researchSetup,
    }),
    dims,
    analysisMeta,
    debugContext,
    debugSession,
    liveSearch: false,
    evidenceMaxTokens,
    scoringMaxTokens,
    passLabel: "analyst_reconcile",
  });

  let reconciledFinal = reconciled;
  const initialHealth = evaluateScorecardReconcileHealth(dims, baseline, web, reconciledFinal);
  analysisMeta.hybridReconcileHealth = initialHealth;
  analysisMeta.hybridStats = computeHybridDeltaStats(dims, baseline, web, reconciledFinal);

  if (initialHealth.suspicious) {
    analysisMeta.hybridReconcileRetryTriggered = true;
    analysisMeta.hybridReconcileRetryAttempts += 1;
    analysisMeta.hybridReconcileRetryReason = initialHealth.notes.join(" ");
    appendAnalysisDebugEvent(debugSession, {
      type: "reconcile_retry_triggered",
      phase: "analyst_reconcile",
      attempt: "quality_guard",
      diagnostics: initialHealth,
      note: analysisMeta.hybridReconcileRetryReason,
    });

    const focusDimensionIds = dims
      .filter((d) => normalizeConfidenceLevel(reconciledFinal?.dimensions?.[d.id]?.confidence) === "low")
      .map((d) => d.id)
      .slice(0, 5);

    const retryCandidate = await runAnalystPass({
      evidencePromptBuilder: (condensed) => buildHybridReconcileEvidencePrompt(desc, dims, baseline, web, {
        condensed,
        framingFields,
        researchSetup,
        qualityGuard: {
          notes: initialHealth.notes,
          focusDimensionIds,
        },
      }),
      scoringPromptBuilder: (evidence, condensed) => buildPhase1ScoringPrompt(desc, dims, evidence, {
        condensed,
        passLabel: "hybrid reliability reconcile retry (quality-guarded)",
        framingFields,
        researchSetup,
      }),
      dims,
      analysisMeta,
      debugContext,
      debugSession,
      liveSearch: false,
      evidenceMaxTokens,
      scoringMaxTokens,
      passLabel: "analyst_reconcile_retry",
    });

    const retryHealth = evaluateScorecardReconcileHealth(dims, baseline, web, retryCandidate);
    const beforeScore = scoreReconcileCandidate(initialHealth);
    const retryScore = scoreReconcileCandidate(retryHealth);
    const useRetry = !retryHealth.suspicious || retryScore > beforeScore;

    analysisMeta.hybridReconcileRetryUsed = useRetry;
    analysisMeta.hybridReconcileRetryDiagnostics = {
      initial: initialHealth,
      retry: retryHealth,
      selected: useRetry ? "retry" : "initial",
      qualityScoreInitial: beforeScore,
      qualityScoreRetry: retryScore,
    };
    appendAnalysisDebugEvent(debugSession, {
      type: "reconcile_retry_completed",
      phase: "analyst_reconcile",
      attempt: "quality_guard",
      useRetry,
      diagnostics: analysisMeta.hybridReconcileRetryDiagnostics,
    });

    if (useRetry) {
      reconciledFinal = retryCandidate;
      analysisMeta.hybridReconcileHealth = retryHealth;
      analysisMeta.hybridStats = computeHybridDeltaStats(dims, baseline, web, reconciledFinal);
    }
  }

  const finalHealth = evaluateScorecardReconcileHealth(dims, baseline, web, reconciledFinal);
  analysisMeta.hybridReconcileHealth = finalHealth;
  analysisMeta.hybridStats = computeHybridDeltaStats(dims, baseline, web, reconciledFinal);
  if (finalHealth.suspicious) {
    const note = finalHealth.notes.join(" ") || "Hybrid reconcile remained implausibly unchanged after quality guard checks.";
    appendAnalysisDebugEvent(debugSession, {
      type: "reconcile_quality_guard_failed",
      phase: "analyst_reconcile",
      attempt: "final",
      diagnostics: finalHealth,
      note,
    });
    if (!allowDegraded) {
      throw new Error(`Hybrid reconcile quality guard failed. ${note}`);
    }
    markDegraded(analysisMeta, "hybrid_reconcile_quality_guard", note);
  }

  return reconciledFinal;
}

function scorecardProviderAgreement(entries = []) {
  if (!entries.length) return "none";
  if (entries.length === 1) return "single";
  const scores = entries.map((entry) => clampScore(entry?.score, null)).filter((value) => Number.isFinite(value));
  const confRanks = entries.map((entry) => confidenceRank(entry?.confidence)).filter((value) => Number.isFinite(value));
  const scoreSpread = scores.length ? (Math.max(...scores) - Math.min(...scores)) : 0;
  const confSpread = confRanks.length ? (Math.max(...confRanks) - Math.min(...confRanks)) : 0;
  if (scoreSpread <= 1 && confSpread <= 1) return "agree";
  if (scoreSpread <= 2) return "partial";
  return "contradict";
}

function pickBestDeepAssistDimension(entries = []) {
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

function mergeDeepAssistScorecardPayloads(desc, dims, providerRuns = []) {
  const basePayload = providerRuns?.[0]?.payload && typeof providerRuns[0].payload === "object"
    ? JSON.parse(JSON.stringify(providerRuns[0].payload))
    : { attributes: {}, dimensions: {} };
  basePayload.attributes = normalizeAttributesShape(basePayload.attributes, desc);
  basePayload.dimensions = basePayload.dimensions && typeof basePayload.dimensions === "object"
    ? { ...basePayload.dimensions }
    : {};
  basePayload.deepAssist = {
    providers: providerRuns.map((run) => ({
      id: run.providerId,
      label: run.label,
      status: run.status,
      error: run.error || "",
      durationMs: Number(run.durationMs || 0),
    })),
    providersSucceeded: providerRuns.filter((run) => run.status === "ok").length,
  };

  for (const dim of dims) {
    const id = dim.id;
    const entries = providerRuns
      .filter((run) => run.status === "ok")
      .map((run) => {
        const dimState = run?.payload?.dimensions?.[id];
        if (!dimState || typeof dimState !== "object") return null;
        return {
          providerId: run.providerId,
          providerLabel: run.label,
          score: clampScore(dimState?.score, null),
          confidence: normalizeConfidenceLevel(dimState?.confidence) || "medium",
          confidenceReason: String(dimState?.confidenceReason || "").trim(),
          brief: String(dimState?.brief || "").trim(),
          full: String(dimState?.full || "").trim(),
          risks: String(dimState?.risks || "").trim(),
          missingEvidence: String(dimState?.missingEvidence || "").trim(),
          sources: normalizeSourceList(dimState?.sources),
          arguments: ensureDimensionArgumentShape(dimState?.arguments),
          researchBrief: dimState?.researchBrief || null,
        };
      })
      .filter(Boolean);

    if (!entries.length) {
      basePayload.dimensions[id] = {
        ...(basePayload.dimensions?.[id] || {}),
        score: clampScore(basePayload.dimensions?.[id]?.score, 3),
        confidence: normalizeConfidenceLevel(basePayload.dimensions?.[id]?.confidence) || "low",
        confidenceReason: String(basePayload.dimensions?.[id]?.confidenceReason || "Deep Assist providers did not return this dimension.").trim(),
        providerAgreement: "none",
        providerSignals: [],
      };
      continue;
    }

    const agreement = scorecardProviderAgreement(entries);
    const best = pickBestDeepAssistDimension(entries) || entries[0];
    const validScores = entries.map((entry) => entry.score).filter((value) => Number.isFinite(value));
    const averagedScore = validScores.length
      ? Math.max(1, Math.min(5, Math.round(validScores.reduce((sum, value) => sum + value, 0) / validScores.length)))
      : clampScore(best?.score, 3);
    let mergedConfidence = normalizeConfidenceLevel(best?.confidence) || "medium";
    if (agreement === "contradict" && confidenceRank(mergedConfidence) > confidenceRank("medium")) {
      mergedConfidence = "medium";
    }
    const mergedSources = mergeSourceLists(...entries.map((entry) => entry.sources));
    const gapNotes = [...new Set(entries.map((entry) => cleanString(entry.missingEvidence)).filter(Boolean))];
    const disagreementGap = agreement === "contradict"
      ? "Providers returned contradictory findings. Targeted recovery should validate this dimension with additional evidence."
      : "";
    const missingEvidence = [gapNotes.join(" "), disagreementGap].filter(Boolean).join(" ").trim();

    basePayload.dimensions[id] = {
      ...(basePayload.dimensions?.[id] || {}),
      score: averagedScore,
      confidence: mergedConfidence,
      confidenceReason: [
        cleanString(best?.confidenceReason),
        agreement === "agree" ? "Multi-provider deep-assist signals align." : "",
        agreement === "partial" ? "Provider findings partially align; keep confidence conservative." : "",
        agreement === "contradict" ? "Provider findings conflict; confidence capped pending targeted validation." : "",
      ].filter(Boolean).join(" ").trim(),
      brief: cleanString(best?.brief || basePayload.dimensions?.[id]?.brief),
      full: cleanString(best?.full || basePayload.dimensions?.[id]?.full),
      risks: cleanString(best?.risks || basePayload.dimensions?.[id]?.risks),
      missingEvidence,
      sources: mergedSources,
      arguments: ensureDimensionArgumentShape(best?.arguments || basePayload.dimensions?.[id]?.arguments),
      researchBrief: best?.researchBrief || basePayload.dimensions?.[id]?.researchBrief || null,
      providerAgreement: agreement,
      providerSignals: entries.map((entry) => ({
        provider: entry.providerId,
        providerLabel: entry.providerLabel,
        score: entry.score,
        confidence: entry.confidence,
        confidenceReason: entry.confidenceReason,
        sourceCount: normalizeSourceList(entry.sources).length,
        brief: cleanString(entry.brief),
      })),
    };
  }

  return basePayload;
}

async function runDeepAssistPhase1(
  desc,
  dims,
  updateUC,
  id,
  analysisMeta,
  debugSession,
  tokenLimits = {},
  {
    inputSpec = {},
    framingFields = [],
    deepAssist = {},
    researchSetup = {},
  } = {}
) {
  const deepAssistOptions = normalizeDeepAssistOptions(deepAssist);
  const evidenceMaxTokens = Number(tokenLimits.phase1Evidence) || 10000;
  const scoringMaxTokens = Number(tokenLimits.phase1Scoring) || 12000;
  const debugContext = { useCaseId: id, analysisMode: analysisMeta.analysisMode };
  ensureDegradedMeta(analysisMeta);
  analysisMeta.evidenceMode = "deep-assist";
  analysisMeta.deepAssistProvidersRequested = deepAssistOptions.providers.length;
  analysisMeta.deepAssistMinProviders = deepAssistOptions.minProviders;
  analysisMeta.deepAssistProvidersSucceeded = 0;
  analysisMeta.deepAssistProvidersFailed = 0;
  analysisMeta.deepAssistProviderRuns = [];

  updateUC(id, (u) => ({ ...u, phase: "deep_assist_collect" }));

  const providerRuns = await Promise.all(
    deepAssistOptions.providers.map(async (providerId) => {
      const label = deepAssistProviderLabel(providerId);
      const passLabel = `deep_assist_${providerId}`;
      const requestOptions = resolveDeepAssistProviderRequestOptions(providerId, "analyst", deepAssistOptions);
      const stepTimeoutMs = Math.max(
        40000,
        (Number(requestOptions?.timeoutMs) || deepAssistOptions.maxWaitMs || 300000) * 2 + 15000
      );
      const startedAt = Date.now();
      const providerMeta = {
        liveSearchUsed: false,
        webSearchCalls: 0,
        liveSearchFallbackReason: null,
      };
      try {
        const payload = await withStepTimeout(
          `${label} deep assist provider step`,
          stepTimeoutMs,
          () => runAnalystPass({
            evidencePromptBuilder: (condensed) => buildPhase1EvidencePrompt(desc, dims, {
              liveSearch: true,
              condensed,
              inputSpec,
              framingFields,
              researchSetup,
            }),
            scoringPromptBuilder: (evidence, condensed) => buildPhase1ScoringPrompt(desc, dims, evidence, {
              condensed,
              passLabel: `${label} deep assist pass`,
              framingFields,
              researchSetup,
            }),
            dims,
            analysisMeta: providerMeta,
            debugContext,
            debugSession,
            liveSearch: true,
            evidenceMaxTokens,
            scoringMaxTokens,
            passLabel,
            requestOptions,
          })
        );
        const durationMs = Math.max(0, Date.now() - startedAt);
        absorbAnalystMeta(analysisMeta, providerMeta);
        const webSearchCalls = Number(providerMeta.webSearchCalls || 0);
        appendAnalysisDebugEvent(debugSession, {
          type: "deep_assist_provider_complete",
          phase: "deep_assist_collect",
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
          payload,
        };
      } catch (err) {
        const durationMs = Math.max(0, Date.now() - startedAt);
        absorbAnalystMeta(analysisMeta, providerMeta);
        const failure = classifyDeepAssistGuardrailFailure(err);
        trackSafetyGuardrail(analysisMeta, failure, providerId);
        appendAnalysisDebugEvent(debugSession, {
          type: "deep_assist_provider_failed",
          phase: "deep_assist_collect",
          attempt: providerId,
          durationMs,
          reasonCode: failure.code,
          error: err?.message || String(err),
        });
        return {
          providerId,
          label,
          status: "failed",
          durationMs,
          webSearchCalls: Number(providerMeta.webSearchCalls || 0),
          error: err?.message || String(err),
          failureCode: failure.code,
          payload: null,
        };
      }
    })
  );

  analysisMeta.deepAssistProviderRuns = providerRuns.map((run) => ({
    providerId: run.providerId,
    label: run.label,
    status: run.status,
    durationMs: run.durationMs,
    webSearchCalls: run.webSearchCalls,
    error: run.error || "",
  }));
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
      const key = cleanString(run.failureCode) || "deep_assist_provider_failed";
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
  }

  const successfulRuns = providerRuns.filter((run) => run.status === "ok" && run.payload);
  if (!successfulRuns.length) {
    markDegraded(
      analysisMeta,
      "deep_assist_no_provider_success",
      "All Deep Assist providers failed. Falling back to native hybrid evidence flow."
    );
    appendAnalysisDebugEvent(debugSession, {
      type: "deep_assist_fallback_native",
      phase: "deep_assist_collect",
      attempt: "fallback",
      note: "No provider succeeded. Falling back to native hybrid phase 1.",
    });
    return runHybridPhase1(desc, dims, updateUC, id, analysisMeta, debugSession, tokenLimits, {
      inputSpec,
      framingFields,
      researchSetup,
      allowDegraded: true,
    });
  }

  if (successfulRuns.length < deepAssistOptions.minProviders) {
    markDegraded(
      analysisMeta,
      "deep_assist_min_provider_not_met",
      `Deep Assist succeeded with ${successfulRuns.length}/${deepAssistOptions.minProviders} required providers.`
    );
  }

  updateUC(id, (u) => ({ ...u, phase: "deep_assist_merge" }));
  const merged = mergeDeepAssistScorecardPayloads(desc, dims, providerRuns);
  appendAnalysisDebugEvent(debugSession, {
    type: "deep_assist_merge_complete",
    phase: "deep_assist_merge",
    attempt: "final",
    providerCount: successfulRuns.length,
    responseLength: JSON.stringify(merged || {}).length,
  });
  return merged;
}

async function runLowConfidenceExtraCycle({
  desc,
  dims,
  phase1Payload,
  updateUC,
  id,
  analysisMeta,
  debugSession,
  analysisMode,
  researchSetup = {},
  forcedCandidateIds = [],
  cycleLabel = "native_targeted",
}) {
  const current = JSON.parse(JSON.stringify(phase1Payload || {}));
  current.dimensions = current.dimensions || {};
  const runtimeLimits = getRuntime()?.limits || {};
  const selection = (Array.isArray(forcedCandidateIds) && forcedCandidateIds.length)
    ? buildForcedTargetedSelection(current, dims, forcedCandidateIds, runtimeLimits)
    : selectTargetedCycleDimensions(current, dims, runtimeLimits);
  const candidateIds = selection.candidateIds;

  analysisMeta.lowConfidenceInitialCount = selection.allCandidateIds.length;
  analysisMeta.lowConfidenceOnlyCount = selection.lowIds.length;
  analysisMeta.mediumGapTargetedCount = selection.mediumGapIds.length;
  analysisMeta.lowConfidenceUpgradedCount = 0;
  analysisMeta.lowConfidenceValidatedLowCount = 0;
  analysisMeta.lowConfidenceCycleFailures = 0;
  analysisMeta.lowConfidenceTargetedSearchUsed = false;
  analysisMeta.lowConfidenceTargetedWebSearchCalls = 0;
  analysisMeta.lowConfidenceTargetedFallbackReason = null;
  analysisMeta.lowConfidenceRoundRobinApplied = true;
  analysisMeta.lowConfidenceBudgetUnits = selection.budgetUnits;
  analysisMeta.lowConfidenceBudgetUsed = 0;
  analysisMeta.lowConfidenceDroppedByBudget = Math.max(0, selection.allCandidateIds.length - candidateIds.length);
  analysisMeta.targetedDimensionDiagnostics = [];
  if (!Number.isFinite(Number(analysisMeta.counterfactualQueriesGenerated))) {
    analysisMeta.counterfactualQueriesGenerated = 0;
  }
  if (!Number.isFinite(Number(analysisMeta.counterfactualFindingsUsed))) {
    analysisMeta.counterfactualFindingsUsed = 0;
  }

  let strategistHints = { niche: "", aliases: [], dimensionHints: {} };
  try {
    const strategistPrompt = buildNicheQueryStrategistPrompt(desc, dims, current.attributes || {}, researchSetup);
    const strategistRes = await callAnalystAPI(
      [{ role: "user", content: strategistPrompt }],
      analystPrompt(),
      1400,
      {
        ...withCapabilityModelOptions("retrieval", "analyst", { includeMeta: true }),
        liveSearch: false,
      }
    );
    absorbLowConfidenceMeta(analysisMeta, strategistRes.meta);
    const parsedStrategist = parseWithDiagnostics(strategistRes.text, {
      phase: "analyst_targeted_query_strategist",
      attempt: "full",
      useCaseId: id,
      analysisMode,
      prompt: strategistPrompt,
    }, debugSession);
    strategistHints = normalizeStrategistHints(parsedStrategist, dims);
    analysisMeta.targetedRetrievalNiche = strategistHints.niche || "";
    analysisMeta.targetedRetrievalAliases = strategistHints.aliases || [];
    appendAnalysisDebugEvent(debugSession, {
      type: "phase_detail",
      phase: "analyst_targeted_query_strategist",
      attempt: "full",
      responseLength: strategistRes.text?.length || 0,
      meta: strategistRes.meta || null,
      prompt: shortText(strategistPrompt, 30000),
      responseExcerpt: shortText(strategistRes.text, 6000),
      response: shortText(strategistRes.text, 100000),
      extra: {
        niche: strategistHints.niche,
        aliasCount: strategistHints.aliases?.length || 0,
      },
    });
  } catch (strategistErr) {
    appendAnalysisDebugEvent(debugSession, {
      type: "phase_detail_fallback",
      phase: "analyst_targeted_query_strategist",
      attempt: "fallback",
      error: strategistErr?.message || String(strategistErr),
    });
  }

  if (!candidateIds.length) {
    appendAnalysisDebugEvent(debugSession, {
      type: "phase_complete",
      phase: "analyst_targeted",
      attempt: "skipped",
      candidateCount: 0,
    });
    return current;
  }

  updateUC(id, (u) => ({
    ...u,
    phase: "analyst_targeted",
    attributes: current.attributes || u.attributes,
    dimScores: current.dimensions || u.dimScores,
    analysisMeta: { ...(u.analysisMeta || {}), ...analysisMeta },
  }));

  const attributes = current.attributes || {};
  for (let idx = 0; idx < candidateIds.length; idx += 1) {
    const dimId = candidateIds[idx];
    const dim = dims.find((d) => d.id === dimId);
    if (!dim) continue;
    analysisMeta.lowConfidenceBudgetUsed = Number(analysisMeta.lowConfidenceBudgetUsed || 0) + 1;

    const before = current.dimensions?.[dimId] || {};
    const fallbackGap = before?.missingEvidence || before?.confidenceReason || before?.risks || "";
    const strategistForDim = strategistHints?.dimensionHints?.[dimId] || {};
    const aliasHints = normalizeStringList(strategistHints?.aliases, 6, 110);
    const aliasQueries = aliasHints.map((alias) => `${alias} ${dim.label} evidence`).slice(0, 2);
    const fallbackQueries = [
      ...normalizeStringList(strategistForDim?.querySeeds, 4, 170),
      ...normalizeStringList(dim?.researchHints?.queryTemplates, 4, 170),
      ...aliasQueries,
      ...defaultTargetedQueries(desc, dim.label, fallbackGap, attributes),
    ];
    const fallbackCounterfactualQueries = [...new Set(normalizeStringList([
      ...normalizeStringList(strategistForDim?.counterfactualQueries, 4, 170),
      `${attributes?.title || desc} ${dim.label} failure cases`,
      `${attributes?.title || desc} ${dim.label} criticism`,
      `${attributes?.title || desc} alternatives outperforming ${dim.label}`,
    ], 4, 170))].slice(0, Math.max(1, Number(runtimeLimits?.counterfactualQueriesPerDim || 2)));
    const fallbackQueryList = [...new Set(normalizeStringList(fallbackQueries, 6, 170))].slice(0, 4);
    const dimDiag = {
      dimensionId: dimId,
      label: dim.label || dimId,
      bucket: selection.lowIds.includes(dimId) ? "low" : "medium_gap",
      confidenceBefore: normalizeConfidenceLevel(before?.confidence) || "low",
      fallbackQueries: fallbackQueryList,
      fallbackCounterfactualQueries,
      strategistSeeds: normalizeStringList(strategistForDim?.querySeeds, 4, 170),
      strategistCounterfactual: normalizeStringList(strategistForDim?.counterfactualQueries, 4, 170),
      sourceTargets: normalizeStringList([
        ...(strategistForDim?.sourceTargets || []),
        ...(dim?.researchHints?.whereToLook || []),
      ], 6, 170),
    };
    const retrievalOptions = withCapabilityModelOptions("retrieval", "analyst", { includeMeta: true });

    let queryPlan = {
      gap: fallbackGap || "Evidence gap remains unresolved.",
      queries: fallbackQueryList,
      counterfactualQueries: fallbackCounterfactualQueries,
    };
    try {
      const queryPrompt = buildLowConfidenceQueryPlanPrompt(
        desc,
        dim,
        before,
        attributes,
        {
          ...strategistForDim,
          aliases: strategistHints?.aliases || [],
        },
        researchSetup
      );
      const queryRes = await callAnalystAPI(
        [{ role: "user", content: queryPrompt }],
        analystPrompt(),
        1200,
        { ...retrievalOptions, liveSearch: false }
      );
      absorbLowConfidenceMeta(analysisMeta, queryRes.meta);
      appendAnalysisDebugEvent(debugSession, {
        type: "model_response",
        phase: "analyst_targeted_query_plan",
        attempt: `${dimId}_full`,
        liveSearch: false,
        responseLength: queryRes.text?.length || 0,
        meta: queryRes.meta || null,
        prompt: shortText(queryPrompt, 30000),
        responseExcerpt: shortText(queryRes.text, 6000),
        response: shortText(queryRes.text, 100000),
        extra: { dimensionId: dimId },
      });
      const parsedPlan = parseWithDiagnostics(queryRes.text, {
        phase: "analyst_targeted_query_plan",
        attempt: `${dimId}_full`,
        useCaseId: id,
        analysisMode,
        prompt: queryPrompt,
        extra: { dimensionId: dimId },
      }, debugSession);
      queryPlan = normalizeLowConfidenceQueryPlan(parsedPlan, fallbackQueryList, fallbackGap);
      queryPlan.queries = [...new Set([
        ...normalizeStringList(strategistForDim?.querySeeds, 3, 170),
        ...normalizeStringList(queryPlan.queries, 4, 170),
      ])].slice(0, 4);
      queryPlan.counterfactualQueries = [...new Set([
        ...normalizeStringList(strategistForDim?.counterfactualQueries, 4, 170),
        ...normalizeStringList(queryPlan.counterfactualQueries, 4, 170),
      ])]
        .filter((query) => !queryPlan.queries.includes(query))
        .slice(0, Math.max(1, Number(runtimeLimits?.counterfactualQueriesPerDim || 2)));
      dimDiag.queryPlan = queryPlan;
    } catch (planErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "low_conf_query_plan_fallback",
        phase: "analyst_targeted_query_plan",
        attempt: `${dimId}_fallback`,
        error: planErr.message || String(planErr),
        extra: { dimensionId: dimId, fallbackQueries: fallbackQueryList },
      });
      queryPlan = normalizeLowConfidenceQueryPlan({}, fallbackQueryList, fallbackGap);
      queryPlan.counterfactualQueries = fallbackCounterfactualQueries;
      dimDiag.queryPlan = queryPlan;
      dimDiag.queryPlanError = planErr?.message || String(planErr);
    }

    analysisMeta.counterfactualQueriesGenerated += Number(queryPlan?.counterfactualQueries?.length || 0);

    const allRecoveryQueries = [
      ...normalizeStringList(queryPlan?.queries, 6, 170),
      ...normalizeStringList(queryPlan?.counterfactualQueries, 6, 170),
    ];
    let harvest = {
      findings: [],
      queryCoverage: allRecoveryQueries.map((q) => ({ query: q, useful: false, note: "No useful fact captured." })),
    };
    try {
      const searchPrompt = buildLowConfidenceSearchHarvestPrompt(desc, dim, queryPlan, before, researchSetup);
      const searchRes = await callAnalystAPI(
        [{ role: "user", content: searchPrompt }],
        analystPrompt(),
        2600,
        { ...retrievalOptions, liveSearch: true }
      );
      absorbLowConfidenceMeta(analysisMeta, searchRes.meta);
      appendAnalysisDebugEvent(debugSession, {
        type: "model_response",
        phase: "analyst_targeted_search",
        attempt: `${dimId}_full`,
        liveSearch: true,
        responseLength: searchRes.text?.length || 0,
        meta: searchRes.meta || null,
        prompt: shortText(searchPrompt, 30000),
        responseExcerpt: shortText(searchRes.text, 6000),
        response: shortText(searchRes.text, 100000),
        extra: { dimensionId: dimId },
      });
      const parsedHarvest = parseWithDiagnostics(searchRes.text, {
        phase: "analyst_targeted_search",
        attempt: `${dimId}_full`,
        useCaseId: id,
        analysisMode,
        prompt: searchPrompt,
        extra: { dimensionId: dimId },
      }, debugSession);
      harvest = normalizeLowConfidenceSearchHarvest(parsedHarvest, queryPlan);
      dimDiag.queryCoverage = harvest?.queryCoverage || [];
      dimDiag.findingsCount = (harvest?.findings || []).length;
    } catch (searchErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "low_conf_search_fallback",
        phase: "analyst_targeted_search",
        attempt: `${dimId}_fallback`,
        error: searchErr.message || String(searchErr),
        extra: { dimensionId: dimId },
      });
      dimDiag.queryCoverage = harvest?.queryCoverage || [];
      dimDiag.findingsCount = 0;
      dimDiag.searchError = searchErr?.message || String(searchErr);
    }

    try {
      const rescorePrompt = buildLowConfidenceRescorePrompt(desc, dim, before, queryPlan, harvest, researchSetup);
      const rescoreRes = await callAnalystAPI(
        [{ role: "user", content: rescorePrompt }],
        analystPrompt(),
        2800,
        { ...withRoleModelOptions("analyst", { includeMeta: true }), liveSearch: false }
      );
      absorbLowConfidenceMeta(analysisMeta, rescoreRes.meta);
      appendAnalysisDebugEvent(debugSession, {
        type: "model_response",
        phase: "analyst_targeted_rescore",
        attempt: `${dimId}_full`,
        liveSearch: false,
        responseLength: rescoreRes.text?.length || 0,
        meta: rescoreRes.meta || null,
        prompt: shortText(rescorePrompt, 30000),
        responseExcerpt: shortText(rescoreRes.text, 6000),
        response: shortText(rescoreRes.text, 100000),
        extra: { dimensionId: dimId },
      });
      const parsedRescore = parseWithDiagnostics(rescoreRes.text, {
        phase: "analyst_targeted_rescore",
        attempt: `${dimId}_full`,
        useCaseId: id,
        analysisMode,
        prompt: rescorePrompt,
        extra: { dimensionId: dimId },
      }, debugSession);

      const normalized = normalizeLowConfidenceRescore(parsedRescore, dim, before, queryPlan, harvest);
      const nextConfidence = normalizeConfidenceLevel(normalized.confidence) || "low";
      const beforeConfidence = normalizeConfidenceLevel(before?.confidence) || "low";
      const upgraded = confidenceRank(nextConfidence) > confidenceRank(beforeConfidence);
      const usefulQueryCount = (harvest?.queryCoverage || []).filter((q) => q.useful).length;
      const counterfactualFindingCount = (harvest?.findings || [])
        .filter((entry) => String(entry?.evidenceType || "").toLowerCase() === "counterfactual")
        .length;
      analysisMeta.counterfactualFindingsUsed += counterfactualFindingCount;
      const unsuccessfulQueries = (harvest?.queryCoverage || [])
        .filter((q) => !q.useful)
        .map((q) => q.query)
        .filter(Boolean)
        .slice(0, 4);

      if (upgraded) {
        current.dimensions[dimId] = {
          ...before,
          score: normalized.score,
          confidence: normalized.confidence,
          confidenceReason: normalized.confidenceReason,
          brief: normalized.brief || before.brief,
          full: normalized.full || before.full,
          risks: normalized.risks || before.risks,
          missingEvidence: normalized.missingEvidence || before.missingEvidence,
          sources: normalized.sources?.length ? normalized.sources : before.sources,
          arguments: normalized.arguments || before.arguments,
          researchBrief: normalized.researchBrief || null,
          lowConfidenceCycle: {
            executed: true,
            confidenceBefore: beforeConfidence,
            confidenceAfter: nextConfidence,
            upgraded: true,
            usefulQueryCount,
            attemptedQueries: queryPlan.queries,
            counterfactualQueries: queryPlan.counterfactualQueries || [],
            unsuccessfulQueries,
            validatedAt: new Date().toISOString(),
          },
        };
        analysisMeta.lowConfidenceUpgradedCount += 1;
        dimDiag.status = "upgraded";
      } else {
        const existingResearchBrief = normalized.researchBrief || {
          missingEvidence: normalized.missingEvidence || fallbackGap || "Evidence gap remains unresolved.",
          whereToLook: [
            "Independent analyst and benchmark reports.",
            "Named operator case studies with measured outcomes.",
            "Internal delivery retrospectives and client references.",
          ],
          suggestedQueries: queryPlan.queries,
        };
        current.dimensions[dimId] = {
          ...before,
          score: normalized.score,
          confidence: nextConfidence,
          confidenceReason: normalized.confidenceReason,
          missingEvidence: normalized.missingEvidence || before.missingEvidence,
          sources: normalized.sources?.length ? normalized.sources : before.sources,
          researchBrief: {
            ...existingResearchBrief,
            missingEvidence: `${existingResearchBrief.missingEvidence}${unsuccessfulQueries.length ? ` Queries with weak public coverage: ${unsuccessfulQueries.join("; ")}` : ""}`,
            suggestedQueries: queryPlan.queries,
          },
          lowConfidenceCycle: {
            executed: true,
            confidenceBefore: beforeConfidence,
            confidenceAfter: nextConfidence,
            upgraded: false,
            usefulQueryCount,
            attemptedQueries: queryPlan.queries,
            counterfactualQueries: queryPlan.counterfactualQueries || [],
            unsuccessfulQueries,
            validatedAt: new Date().toISOString(),
          },
        };
        if (nextConfidence === "low") analysisMeta.lowConfidenceValidatedLowCount += 1;
        dimDiag.status = nextConfidence === "low" ? "validated_low" : "updated";
      }
      dimDiag.confidenceAfter = nextConfidence;
      dimDiag.usefulQueryCount = usefulQueryCount;
      dimDiag.counterfactualFindingCount = counterfactualFindingCount;
      dimDiag.unsuccessfulQueries = unsuccessfulQueries;
      analysisMeta.targetedDimensionDiagnostics.push(dimDiag);

      updateUC(id, (u) => ({
        ...u,
        dimScores: current.dimensions,
        analysisMeta: { ...(u.analysisMeta || {}), ...analysisMeta },
      }));
    } catch (rescoreErr) {
      analysisMeta.lowConfidenceCycleFailures += 1;
      dimDiag.status = "rescore_failed";
      dimDiag.error = rescoreErr?.message || String(rescoreErr);
      analysisMeta.targetedDimensionDiagnostics.push(dimDiag);
      appendAnalysisDebugEvent(debugSession, {
        type: "low_conf_rescore_failed",
        phase: "analyst_targeted_rescore",
        attempt: `${dimId}_failed`,
        error: rescoreErr.message || String(rescoreErr),
        extra: { dimensionId: dimId },
      });
    }
    appendAnalysisDebugEvent(debugSession, {
      type: "targeted_dimension_diagnostics",
      phase: "analyst_targeted",
      attempt: dimId,
      extra: { ...dimDiag, cycleLabel },
    });
  }

  const normalizedFinal = ensureDimensionArguments(ensureDimensionConfidence(current, dims), dims);
  appendAnalysisDebugEvent(debugSession, {
    type: "phase_complete",
    phase: "analyst_targeted",
    attempt: "final",
    cycleLabel,
    candidateCount: selection.allCandidateIds.length,
    budgetUnits: selection.budgetUnits,
    budgetUsed: analysisMeta.lowConfidenceBudgetUsed,
    droppedByBudget: analysisMeta.lowConfidenceDroppedByBudget,
    lowCandidates: selection.lowIds.length,
    mediumGapCandidates: selection.mediumGapIds.length,
    upgradedCount: analysisMeta.lowConfidenceUpgradedCount,
    validatedLowCount: analysisMeta.lowConfidenceValidatedLowCount,
    failures: analysisMeta.lowConfidenceCycleFailures,
  });
  return normalizedFinal;
}

function buildScorecardRedTeamPrompt(desc, dims, finalResponse, researchSetup = {}) {
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  const summary = (Array.isArray(dims) ? dims : []).map((dim) => {
    const item = finalResponse?.dimensions?.[dim.id] || {};
    const limiting = Array.isArray(item?.arguments?.limiting)
      ? item.arguments.limiting.map((entry) => cleanString(entry?.claim || entry?.detail)).filter(Boolean).slice(0, 2)
      : [];
    return {
      id: dim.id,
      label: dim.label,
      score: clampScore(item?.finalScore, clampScore(item?.score, null)),
      confidence: normalizeConfidenceLevel(item?.confidence) || "low",
      risks: cleanString(item?.risks),
      limitingArguments: limiting,
      missingEvidence: cleanString(item?.missingEvidence),
      providerAgreement: cleanString(item?.providerAgreement),
    };
  });

  return `You are the Red Team for a completed evidence-first scorecard analysis.

Research input:
"${desc}"

Run context:
${setupContext}

Current structured output:
${JSON.stringify({
    conclusion: cleanString(finalResponse?.conclusion),
    dimensions: summary,
  }, null, 2)}

Task:
- Construct the strongest credible case for why this conclusion could be wrong.
- Focus on structural market risks, failure modes, incumbent/adversary response, and catastrophic assumption errors.
- Do not revise scores. Add risk context only.
- Keep each threat concise and specific.

Return JSON only:
{
  "redTeamVerdict": "<1-2 sentence overall counter-case>",
  "dimensions": {
    ${(Array.isArray(dims) ? dims : []).map((dim) => `"${dim.id}": {"threat":"<strongest counter-argument>", "missedRisk":"<risk not already explicit>", "severityIfWrong":"<high|medium|low>"}`).join(",\n    ")}
  }
}`;
}

function normalizeScorecardRedTeamPayload(raw = {}, dims = []) {
  const entries = {};
  (Array.isArray(dims) ? dims : []).forEach((dim) => {
    const item = raw?.dimensions?.[dim.id] || {};
    const severityRaw = cleanString(item?.severityIfWrong).toLowerCase();
    const severityIfWrong = severityRaw === "high" || severityRaw === "medium" || severityRaw === "low"
      ? severityRaw
      : "medium";
    const threat = cleanString(item?.threat);
    const missedRisk = cleanString(item?.missedRisk);
    if (!threat && !missedRisk) return;
    entries[dim.id] = {
      threat,
      missedRisk,
      severityIfWrong,
    };
  });
  return {
    redTeamVerdict: cleanString(raw?.redTeamVerdict),
    dimensions: entries,
  };
}

function applyScorecardRedTeam(finalResponse = {}, dims = [], raw = {}) {
  const normalized = normalizeScorecardRedTeamPayload(raw, dims);
  const output = finalResponse && typeof finalResponse === "object" ? { ...finalResponse } : {};
  output.dimensions = output.dimensions && typeof output.dimensions === "object" ? { ...output.dimensions } : {};
  output.redTeam = normalized;

  let highSeverityCount = 0;
  (Array.isArray(dims) ? dims : []).forEach((dim) => {
    const red = normalized?.dimensions?.[dim.id];
    if (!red) return;
    if (red.severityIfWrong === "high") highSeverityCount += 1;
    const dimState = output.dimensions?.[dim.id];
    if (!dimState || typeof dimState !== "object") return;
    const redRiskLine = [cleanString(red.threat), cleanString(red.missedRisk)]
      .filter(Boolean)
      .join(" ");
    if (!redRiskLine) return;
    const existingRisks = cleanString(dimState.risks);
    const addition = `Red Team (${red.severityIfWrong}): ${redRiskLine}`;
    dimState.risks = [existingRisks, addition].filter(Boolean).join(" ").trim();
  });
  return { output, highSeverityCount };
}

function buildScorecardSynthesizerPrompt(desc, dims, finalResponse = {}, analysisMeta = {}, researchSetup = {}) {
  const setupContext = buildResearchSetupContextBlock(researchSetup);
  const compactDimensions = (Array.isArray(dims) ? dims : []).map((dim) => {
    const item = finalResponse?.dimensions?.[dim.id] || {};
    const limiting = Array.isArray(item?.arguments?.limiting)
      ? item.arguments.limiting.map((entry) => cleanString(entry?.claim || entry?.detail)).filter(Boolean).slice(0, 2)
      : [];
    return {
      id: dim.id,
      label: dim.label,
      score: clampScore(item?.finalScore, clampScore(item?.score, null)),
      confidence: normalizeConfidenceLevel(item?.confidence) || "low",
      confidenceReason: cleanString(item?.confidenceReason),
      limitingArguments: limiting,
      risks: cleanString(item?.risks),
      providerAgreement: cleanString(item?.providerAgreement || ""),
    };
  });

  return `You are an independent synthesizer for a completed strategic research scorecard.

Research input:
"${desc}"

Run context:
${setupContext}

Structured scoring state (no raw source prose):
${JSON.stringify({
    weightedScore: finalResponse?.weightedScore || null,
    conclusion: cleanString(finalResponse?.conclusion),
    providerSignals: analysisMeta?.providerContributions || {},
    redTeam: finalResponse?.redTeam || {},
    dimensions: compactDimensions,
  }, null, 2)}

Task:
- Write a neutral executive synthesis grounded ONLY in the structured signals above.
- Avoid rewriting analyst prose.
- Include the strongest dissent case.

Return JSON only:
{
  "executiveSummary": "<3-5 sentence synthesis>",
  "decisionImplication": "<what this means for the decision right now>",
  "keyUncertainties": ["<uncertainty 1>", "<uncertainty 2>"],
  "dissent": "<strongest case against the current conclusion>"
}`;
}

function normalizeScorecardSynthesizerPayload(raw = {}) {
  const keyUncertainties = Array.isArray(raw?.keyUncertainties)
    ? raw.keyUncertainties.map((entry) => cleanString(entry)).filter(Boolean).slice(0, 6)
    : [];
  return {
    executiveSummary: cleanString(raw?.executiveSummary),
    decisionImplication: cleanString(raw?.decisionImplication),
    keyUncertainties,
    dissent: cleanString(raw?.dissent),
  };
}

async function runAnalysisLegacy(desc, dims, updateUC, id, options = {}) {
  const evidenceMode = normalizeEvidenceMode(options?.evidenceMode);
  const strictQuality = normalizeStrictQuality(options?.strictQuality || options?.quality?.strictFailFast);
  const analysisMode = evidenceMode === "deep-assist" ? "deep-assist" : "hybrid";
  const criticLiveSearch = true;
  const downloadDebugLog = !!options.downloadDebugLog;
  const relatedDiscoveryEnabled = options.relatedDiscovery !== false;
  const inputSpec = options?.inputSpec || {};
  const framingFields = normalizePromptFramingFields(options?.framingFields || []);
  const researchSetup = normalizeResearchSetupContext(options?.researchSetup || {});
  const deepAssist = normalizeDeepAssistOptions(options?.deepAssist || {});
  const prompts = {
    analyst: options?.prompts?.analyst || SYS_ANALYST,
    critic: options?.prompts?.critic || SYS_CRITIC,
    analystResponse: options?.prompts?.analystResponse || SYS_ANALYST_RESPONSE,
    redTeam: options?.prompts?.redTeam || SYS_RED_TEAM,
    synthesizer: options?.prompts?.synthesizer || SYS_ANALYST_RESPONSE,
  };
  const tokenLimits = {
    phase1Evidence: options?.limits?.tokenLimits?.phase1Evidence || 10000,
    phase1Scoring: options?.limits?.tokenLimits?.phase1Scoring || 12000,
    critic: options?.limits?.tokenLimits?.critic || 6000,
    phase3Response: options?.limits?.tokenLimits?.phase3Response || 6000,
  };

  const debugSession = createAnalysisDebugSession({
    useCaseId: id,
    analysisMode,
    rawInput: desc,
    dims,
  });
  const sourceFetchCache = new Map();
  appendAnalysisDebugEvent(debugSession, {
    type: "analysis_start",
    phase: "analyst",
    attempt: "init",
    analysisMode,
    liveSearch: true,
  });

  const debate = [];
  const analysisMeta = {
    analysisMode,
    evidenceMode,
    strictQuality,
    liveSearchRequested: true,
    liveSearchUsed: false,
    webSearchCalls: 0,
    liveSearchFallbackReason: null,
    criticLiveSearchRequested: criticLiveSearch,
    criticLiveSearchUsed: false,
    criticWebSearchCalls: 0,
    criticLiveSearchFallbackReason: null,
    discoveryLiveSearchRequested: relatedDiscoveryEnabled,
    discoveryLiveSearchUsed: false,
    discoveryWebSearchCalls: 0,
    discoveryLiveSearchFallbackReason: null,
    generatedDiscoverCandidatesCount: 0,
    discoverCandidatesCount: 0,
    rejectedDiscoverCandidatesCount: 0,
    lowConfidenceInitialCount: 0,
    lowConfidenceOnlyCount: 0,
    mediumGapTargetedCount: 0,
    lowConfidenceUpgradedCount: 0,
    lowConfidenceValidatedLowCount: 0,
    lowConfidenceCycleFailures: 0,
    lowConfidenceTargetedSearchUsed: false,
    lowConfidenceTargetedWebSearchCalls: 0,
    lowConfidenceTargetedFallbackReason: null,
    lowConfidenceRoundRobinApplied: false,
    lowConfidenceBudgetUnits: 0,
    lowConfidenceBudgetUsed: 0,
    lowConfidenceDroppedByBudget: 0,
    targetedRetrievalNiche: "",
    targetedRetrievalAliases: [],
    targetedDimensionDiagnostics: [],
    counterfactualQueriesGenerated: 0,
    counterfactualFindingsUsed: 0,
    deepAssistRecoveryTriggered: false,
    deepAssistRecoveryCandidates: 0,
    deepAssistRecoveryBudgetUnits: 0,
    deepAssistRecoveryDroppedByBudget: 0,
    deepAssistRecoveryUpgraded: 0,
    deepAssistRecoveryValidatedLow: 0,
    deepAssistRecoveryFailed: false,
    deepAssistRecoveryDiagnostics: [],
    sourceVerificationChecked: 0,
    sourceVerificationVerified: 0,
    sourceVerificationNotFound: 0,
    sourceVerificationFetchFailed: 0,
    sourceVerificationInvalidUrl: 0,
    sourceVerificationPartialMatch: 0,
    sourceVerificationNameOnly: 0,
    sourceVerificationPenalizedDimensions: 0,
    sourceVerificationSkippedReason: null,
    phase3DecisionGuardAdjustments: 0,
    phase3ConfidenceGuardAdjustments: 0,
    phase3PolarityGuardAdjustments: 0,
    crossDimensionCoherenceFlags: 0,
    crossDimensionCoherenceAdjustments: 0,
    hybridStats: null,
    hybridReconcileHealth: null,
    hybridReconcileRetryTriggered: false,
    hybridReconcileRetryAttempts: 0,
    hybridReconcileRetryUsed: false,
    hybridReconcileRetryReason: "",
    hybridReconcileRetryDiagnostics: null,
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
    sourceDiversityTotalDimensions: 0,
    sourceDiversityConfidenceCaps: 0,
    staleEvidenceObservedDimensions: 0,
    staleEvidenceRatioSum: 0,
    staleEvidenceConfidenceCaps: 0,
    verificationConfidenceCaps: 0,
    urlCoverageConfidenceCaps: 0,
    zeroSourceConfidenceCaps: 0,
    sourceUniverse: emptySourceUniverseSummary(),
    redTeamCallMade: false,
    redTeamHighSeverityCount: 0,
    synthesizerCallMade: false,
    synthesizerModel: "",
    providerContributions: {},
    decisionContext: researchSetup.decisionContext,
    userRoleContext: researchSetup.userRoleContext,
  };

  let runStatus = "failed";
  let runError = null;
  try {
    // Phase 1: Analyst
    updateUC(id, (u) => ({ ...u, phase: evidenceMode === "deep-assist" ? "deep_assist_collect" : "analyst_baseline" }));
    const p1Base = evidenceMode === "deep-assist"
      ? await runDeepAssistPhase1(desc, dims, updateUC, id, analysisMeta, debugSession, tokenLimits, {
          inputSpec,
          framingFields,
          deepAssist,
          researchSetup,
        })
      : await runHybridPhase1(desc, dims, updateUC, id, analysisMeta, debugSession, tokenLimits, {
          inputSpec,
          framingFields,
          researchSetup,
          allowDegraded: true,
        });
    p1Base.attributes = normalizeAttributesShape(p1Base?.attributes, desc, framingFields);
    let p1 = p1Base;

    if (evidenceMode === "deep-assist") {
      const deepAssistRecoverySelection = selectDeepAssistRecoveryDimensions(
        p1Base,
        dims,
        analysisMeta,
        getRuntime()?.limits || {}
      );
      analysisMeta.deepAssistRecoveryCandidates = deepAssistRecoverySelection.allCandidateIds.length;
      analysisMeta.deepAssistRecoveryBudgetUnits = deepAssistRecoverySelection.budgetUnits;
      analysisMeta.deepAssistRecoveryDroppedByBudget = deepAssistRecoverySelection.droppedByBudget;
      analysisMeta.deepAssistRecoveryDiagnostics = deepAssistRecoverySelection.diagnostics;
      analysisMeta.deepAssistRecoveryUpgraded = 0;
      analysisMeta.deepAssistRecoveryValidatedLow = 0;
      analysisMeta.deepAssistRecoveryTriggered = deepAssistRecoverySelection.candidateIds.length > 0;

      if (deepAssistRecoverySelection.candidateIds.length) {
        try {
          p1 = await runLowConfidenceExtraCycle({
            desc,
            dims,
            phase1Payload: p1Base,
            updateUC,
            id,
            analysisMeta,
            debugSession,
            analysisMode,
            researchSetup,
            forcedCandidateIds: deepAssistRecoverySelection.candidateIds,
            cycleLabel: "deep_assist_recovery",
          });
          analysisMeta.deepAssistRecoveryUpgraded = Number(analysisMeta.lowConfidenceUpgradedCount || 0);
          analysisMeta.deepAssistRecoveryValidatedLow = Number(analysisMeta.lowConfidenceValidatedLowCount || 0);
        } catch (lowConfErr) {
          appendAnalysisDebugEvent(debugSession, {
            type: "low_conf_cycle_failed",
            phase: "analyst_targeted",
            attempt: "deep_assist_recovery",
            error: lowConfErr.message || String(lowConfErr),
          });
          analysisMeta.deepAssistRecoveryFailed = true;
          p1 = p1Base;
        }
      } else {
        appendAnalysisDebugEvent(debugSession, {
          type: "phase_complete",
          phase: "analyst_targeted",
          attempt: "deep_assist_recovery_skipped",
          note: "All Deep Assist dimensions met agreement/confidence/source thresholds.",
        });
      }
    } else {
      try {
        p1 = await runLowConfidenceExtraCycle({
          desc,
          dims,
          phase1Payload: p1Base,
          updateUC,
          id,
          analysisMeta,
          debugSession,
          analysisMode,
          researchSetup,
          cycleLabel: "native_targeted",
        });
      } catch (lowConfErr) {
        appendAnalysisDebugEvent(debugSession, {
          type: "low_conf_cycle_failed",
          phase: "analyst_targeted",
          attempt: "final",
          error: lowConfErr.message || String(lowConfErr),
        });
        failIfStrictQuality(
          strictQuality,
          `Strict quality mode: low-confidence recovery failed. ${lowConfErr?.message || String(lowConfErr)}`,
          "STRICT_LOW_CONF_CYCLE_FAILED"
        );
        p1 = p1Base;
      }
      if (analysisMeta.lowConfidenceInitialCount > 0 && analysisMeta.lowConfidenceUpgradedCount === 0) {
        try {
          analysisMeta.lowConfidenceRefinementAttempted = true;
          p1 = await runLowConfidenceExtraCycle({
            desc,
            dims,
            phase1Payload: p1,
            updateUC,
            id,
            analysisMeta,
            debugSession,
            analysisMode,
            researchSetup,
            cycleLabel: "native_targeted_refinement",
          });
        } catch (lowConfRetryErr) {
          analysisMeta.lowConfidenceRefinementFailed = true;
          appendAnalysisDebugEvent(debugSession, {
            type: "low_conf_refinement_failed",
            phase: "analyst_targeted",
            attempt: "refinement",
            error: lowConfRetryErr.message || String(lowConfRetryErr),
          });
          failIfStrictQuality(
            strictQuality,
            `Strict quality mode: low-confidence refinement failed. ${lowConfRetryErr?.message || String(lowConfRetryErr)}`,
            "STRICT_LOW_CONF_REFINEMENT_FAILED"
          );
        }
      }
    }
    p1.attributes = normalizeAttributesShape(p1?.attributes, desc, framingFields);
    try {
      p1 = await verifyScorecardSources({
        payload: p1,
        dims,
        analysisMeta,
        sourceFetchCache,
        debugSession,
        phase: "analyst_source_verification",
        penalizeConfidence: true,
      });
    } catch (verificationErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "source_verification_failed",
        phase: "analyst_source_verification",
        attempt: "phase1",
        error: verificationErr.message || String(verificationErr),
      });
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: analyst source verification failed. ${verificationErr?.message || String(verificationErr)}`,
        "STRICT_SOURCE_VERIFICATION_FAILED"
      );
    }

    appendAnalysisDebugEvent(debugSession, {
      type: "phase_complete",
      phase: "analyst",
      attempt: "final",
      responseLength: JSON.stringify(p1 || {}).length,
    });

    debate.push({ phase: "initial", content: p1 });
    updateUC(id, (u) => ({
      ...u,
      attributes: p1.attributes,
      dimScores: p1.dimensions,
      phase: "critic",
      debate: [...debate],
      analysisMeta: { ...(u.analysisMeta || {}), ...analysisMeta },
    }));

    // Phase 2: Critic
    const phase2Prompt = buildCriticPrompt(desc, dims, p1, { liveSearch: criticLiveSearch, researchSetup });

    const criticRes = await callCriticAPI(
      [{ role: "user", content: phase2Prompt }],
      prompts.critic,
      tokenLimits.critic,
      { liveSearch: criticLiveSearch, includeMeta: true }
    );
    absorbCriticMeta(analysisMeta, criticRes.meta);
    let r2 = criticRes.text;
    appendAnalysisDebugEvent(debugSession, {
      type: "model_response",
      phase: "critic",
      attempt: "full",
      responseLength: r2?.length || 0,
      meta: criticRes.meta || null,
      prompt: shortText(phase2Prompt, 30000),
      responseExcerpt: shortText(r2, 6000),
      response: shortText(r2, 100000),
    });

    let p2;
    try {
      p2 = parseWithDiagnostics(r2, {
        phase: "critic",
        attempt: "full",
        useCaseId: id,
        analysisMode,
        prompt: phase2Prompt,
      }, debugSession);
    } catch (err) {
      console.warn("Critic parse failed, retrying with strict condensed prompt:", err.message);
      const phase2RetryPrompt = `${phase2Prompt}

STRICT JSON RULES:
- Return exactly one valid JSON object. No markdown, no prose before/after.
- Use double quotes for every key and string value.
- Escape any internal quote as \\".
- No trailing commas.
- Keep "overallFeedback" <= 40 words.
- Keep each dimension "critique" <= 35 words.
`;
      const criticRetryRes = await callCriticAPI(
        [{ role: "user", content: phase2RetryPrompt }],
        prompts.critic,
        4200,
        { liveSearch: criticLiveSearch, includeMeta: true }
      );
      absorbCriticMeta(analysisMeta, criticRetryRes.meta);
      r2 = criticRetryRes.text;
      appendAnalysisDebugEvent(debugSession, {
        type: "model_response",
        phase: "critic",
        attempt: "condensed_retry",
        responseLength: r2?.length || 0,
        meta: criticRetryRes.meta || null,
        prompt: shortText(phase2RetryPrompt, 30000),
        responseExcerpt: shortText(r2, 6000),
        response: shortText(r2, 100000),
      });
      p2 = parseWithDiagnostics(r2, {
        phase: "critic",
        attempt: "condensed_retry",
        useCaseId: id,
        analysisMode,
        prompt: phase2RetryPrompt,
      }, debugSession);
    }

    {
      const hmDims = dims.filter((d) => {
        const confidence = normalizeConfidenceLevel(p1?.dimensions?.[d.id]?.confidence) || "low";
        return confidence === "high" || confidence === "medium";
      });
      const flaggedDims = hmDims.filter((d) => {
        const entry = p2?.dimensions?.[d.id] || {};
        const scoreJustified = entry?.scoreJustified;
        const suggested = clampScore(entry?.suggestedScore, null);
        const initialScore = clampScore(p1?.dimensions?.[d.id]?.score, null);
        const critique = cleanString(entry?.critique);
        if (scoreJustified === false) return true;
        if (Number.isFinite(suggested) && Number.isFinite(initialScore) && suggested !== initialScore) return true;
        if (critique.length > 8 && /weak|thin|uncertain|overconfident|unsupported|contradict|stale|outdated/i.test(critique)) {
          return true;
        }
        return false;
      });
      const requiresStrictRetry = hmDims.length >= 4 && flaggedDims.length === 0;
      if (requiresStrictRetry) {
        const strictPrompt = `${phase2Prompt}

STRICT AUDIT PROTOCOL:
- Audit ALL high/medium-confidence dimensions independently.
- For each dimension, explicitly state whether the analyst overreached.
- Flag contradictions, stale evidence, and unsupported claims even if subtle.
- If no reliable disconfirming evidence exists, still note what remains unverified.
- Return actionable flags; avoid blanket "justified" outcomes.`;
        try {
          const strictRes = await callCriticAPI(
            [{ role: "user", content: strictPrompt }],
            prompts.critic,
            Math.max(3000, Math.min(5200, tokenLimits.critic)),
            { liveSearch: criticLiveSearch, includeMeta: true }
          );
          absorbCriticMeta(analysisMeta, strictRes.meta);
          appendAnalysisDebugEvent(debugSession, {
            type: "model_response",
            phase: "critic",
            attempt: "strict_retry",
            responseLength: strictRes.text?.length || 0,
            meta: strictRes.meta || null,
            prompt: shortText(strictPrompt, 30000),
            responseExcerpt: shortText(strictRes.text, 6000),
            response: shortText(strictRes.text, 100000),
          });
          const strictParsed = parseWithDiagnostics(strictRes.text, {
            phase: "critic",
            attempt: "strict_retry",
            useCaseId: id,
            analysisMode,
            prompt: strictPrompt,
          }, debugSession);
          const strictFlagged = hmDims.filter((d) => {
            const entry = strictParsed?.dimensions?.[d.id] || {};
            return entry?.scoreJustified === false;
          });
          if (strictFlagged.length >= flaggedDims.length) {
            p2 = strictParsed;
          }
          appendAnalysisDebugEvent(debugSession, {
            type: "critic_strict_retry_applied",
            phase: "critic",
            attempt: "strict_retry",
            hmDimensions: hmDims.length,
            strictFlagged: strictFlagged.length,
          });
        } catch (strictErr) {
          appendAnalysisDebugEvent(debugSession, {
            type: "critic_strict_retry_failed",
            phase: "critic",
            attempt: "strict_retry",
            error: strictErr.message || String(strictErr),
          });
        }
      }
    }

    appendAnalysisDebugEvent(debugSession, {
      type: "phase_complete",
      phase: "critic",
      attempt: "final",
      responseLength: JSON.stringify(p2 || {}).length,
    });
    try {
      p2 = await verifyScorecardSources({
        payload: p2,
        dims,
        analysisMeta,
        sourceFetchCache,
        debugSession,
        phase: "critic_source_verification",
        penalizeConfidence: false,
      });
    } catch (verificationErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "source_verification_failed",
        phase: "critic_source_verification",
        attempt: "phase2",
        error: verificationErr.message || String(verificationErr),
      });
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: critic source verification failed. ${verificationErr?.message || String(verificationErr)}`,
        "STRICT_SOURCE_VERIFICATION_FAILED"
      );
    }

    debate.push({ phase: "critique", content: p2 });
    updateUC(id, (u) => ({
      ...u,
      critique: p2,
      phase: "finalizing",
      debate: [...debate],
      analysisMeta: { ...(u.analysisMeta || {}), ...analysisMeta },
    }));

    // Phase 3: Analyst responds
    const phase3Prompt = `You are the analyst who assessed "${p1.attributes?.title || desc}".

Run context:
${buildResearchSetupContextBlock(researchSetup)}

Your original scores and confidence:
${dims.map((d) => `- ${d.label}: ${p1.dimensions?.[d.id]?.score}/5 (${p1.dimensions?.[d.id]?.confidence || "n/a"} confidence)`).join("\n")}
Phase 1 confidence anchors:
${dims.map((d) => `- ${d.id}=${p1.dimensions?.[d.id]?.confidence || "n/a"}`).join("\n")}

Critic's overall feedback: ${p2.overallFeedback || ""}

Rubric calibration reminders (higher score is always better):
${buildRubricCalibrationBlock(dims, { wordCap: 11 })}

Per-dimension critiques:
${dims.map((d) => {
  const c = p2.dimensions?.[d.id];
  return `- ${d.label}: ${c?.scoreJustified ? "Score justified" : `Critic suggests ${c?.suggestedScore}/5`} - ${c?.critique || "no specific challenge"}`;
}).join("\n")}

Respond per dimension: defend your score with NEW evidence not previously cited, OR concede and revise with clear reasoning.
Mandatory decision rules:
- Set "decision" to exactly "defend" or "concede" for each dimension.
- If decision is "defend": keep finalScore equal to original score for that dimension.
- If decision is "defend": cite at least ONE new named source not cited in Phase 1.
- If defending without a new named source, lower confidence (high->medium, medium->low) and state what evidence is missing.
- If decision is "concede": include a specific "revisionBasis" and "revisionJustification".
- Do not auto-match critic suggestions. Keep original score unless concession is clearly justified by specific evidence.
Also provide a neutral plain-language brief for each dimension:
- Write 2-3 short sentences.
- Explain why the score is at this level (why it is not lower).
- Explain what limits it from a higher score (why it is not higher).
- Use natural wording; DO NOT use template phrases like "Above 0 because" or "Below 5 because".
- Keep it understandable for non-domain readers; avoid unexplained jargon/acronyms.
- Do not invert rubric direction.
- Polarity self-check: if your wording emphasizes weak/thin/uncertain evidence, do not output score 4-5.
- Polarity self-check: score 4-5 requires concrete strong-evidence wording and cannot be paired with low confidence.
Set confidence for every dimension:
- High: named deployments with verifiable metrics and strong market familiarity.
- Medium: deployments exist but evidence is sparse, self-reported, or moving fast.
- Low: fewer than two verifiable deployments, underrepresented vertical, or heavy extrapolation.
Confidence revision constraints:
- If decision is "defend", confidence cannot decrease vs Phase 1 and cannot be below medium.
- If decision is "concede", confidence may decrease only if "confidenceGap" states a specific new evidence gap.
Do NOT mention the critic or use first-person phrasing.

Return ONLY this JSON:
{
  "analystResponse": "<2-3 sentence overall response to the critique>",
  "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}],
  "dimensions": {
    ${dims.map((d) => `"${d.id}": {
      "finalScore": <your final score 1-5 - may differ from original>,
      "scoreChanged": <true if you revised the score>,
      "decision": "<defend|concede>",
      "revisionBasis": "<none|new_evidence|evidence_gap|rubric_alignment|rubric_misalignment>",
      "revisionJustification": "<required if score changes; one concrete sentence>",
      "confidenceGap": "<required only if confidence decreases; else empty string>",
      "confidence": "<high|medium|low>",
      "confidenceReason": "<1 sentence explaining confidence level>",
      "brief": "<2-3 plain-language sentences, max 65 words, explain why this score is deserved and what prevents a higher score>",
      "response": "<3-4 sentences: concede or defend with new specific evidence>",
      "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}]
    }`).join(",\n    ")}
  },
  "conclusion": "<2-3 sentence strategic recommendation: should the outsourcing company pursue this, and how?>"
}`;

    const phase3Res = await callAnalystAPI(
      [{ role: "user", content: phase3Prompt }],
      prompts.analystResponse,
      tokenLimits.phase3Response,
      { liveSearch: true, includeMeta: true }
    );
    absorbAnalystMeta(analysisMeta, phase3Res.meta);
    let r3 = phase3Res.text;
    appendAnalysisDebugEvent(debugSession, {
      type: "model_response",
      phase: "finalizing",
      attempt: "full",
      responseLength: r3?.length || 0,
      meta: phase3Res.meta || null,
      prompt: shortText(phase3Prompt, 30000),
      responseExcerpt: shortText(r3, 6000),
      response: shortText(r3, 100000),
    });

    let p3;
    try {
      const parsedPhase3 = parseWithDiagnostics(r3, {
        phase: "finalizing",
        attempt: "full",
        useCaseId: id,
        analysisMode,
        prompt: phase3Prompt,
      }, debugSession);
      const mergedPhase3 = mergePhase3WithBaseline(parsedPhase3, p1, dims);
      p3 = ensureFinalAnalystSummary(ensureDimensionArguments(ensureDimensionConfidence(mergedPhase3, dims), dims), dims);
    } catch (err) {
      console.warn("Analyst response parse failed, retrying with strict condensed prompt:", err.message);
      const phase3RetryPrompt = `${phase3Prompt}

STRICT JSON RULES:
- Return exactly one valid JSON object. No markdown, no prose before/after.
- Use double quotes for every key and string value.
- Escape any internal quote as \\".
- No trailing commas.
- Keep "analystResponse" <= 45 words.
- Keep each dimension "confidenceReason" <= 24 words.
- Keep each dimension "brief" <= 65 words, 2-3 plain-language sentences, and explain why score is not lower and not higher.
- Do not use the literal phrasing "Above 0 because" / "Below 5 because".
- Set each dimension "decision" to "defend" or "concede".
- If decision is "defend", include at least one new named source not cited in Phase 1.
- If a score changes, include "revisionBasis" (not "none") and a specific "revisionJustification".
- If confidence decreases, include specific "confidenceGap"; otherwise keep it empty.
- Keep each dimension "response" <= 45 words.
- Keep each dimension "sources" to max 1 item.
- Keep "conclusion" <= 50 words.
`;
      const phase3RetryRes = await callAnalystAPI(
        [{ role: "user", content: phase3RetryPrompt }],
        prompts.analystResponse,
        4200,
        { liveSearch: true, includeMeta: true }
      );
      absorbAnalystMeta(analysisMeta, phase3RetryRes.meta);
      r3 = phase3RetryRes.text;
      appendAnalysisDebugEvent(debugSession, {
        type: "model_response",
        phase: "finalizing",
        attempt: "condensed_retry",
        responseLength: r3?.length || 0,
        meta: phase3RetryRes.meta || null,
        prompt: shortText(phase3RetryPrompt, 30000),
        responseExcerpt: shortText(r3, 6000),
        response: shortText(r3, 100000),
      });
      try {
        const parsedRetry = parseWithDiagnostics(r3, {
          phase: "finalizing",
          attempt: "condensed_retry",
          useCaseId: id,
          analysisMode,
          prompt: phase3RetryPrompt,
        }, debugSession);
        const mergedRetry = mergePhase3WithBaseline(parsedRetry, p1, dims);
        p3 = ensureFinalAnalystSummary(ensureDimensionArguments(ensureDimensionConfidence(mergedRetry, dims), dims), dims);
      } catch (retryErr) {
        appendAnalysisDebugEvent(debugSession, {
          type: "phase_retry_triggered",
          phase: "finalizing",
          attempt: "emergency_minimal",
          error: retryErr.message || String(retryErr),
        });
        const emergencyPrompt = `Return ONLY valid JSON with this exact schema, no extra keys:
{
  "analystResponse": "<max 35 words>",
  "dimensions": {
    ${dims.map((d) => `"${d.id}": {"finalScore": <1-5>, "decision":"<defend|concede>", "revisionBasis":"<none|new_evidence|evidence_gap|rubric_alignment|rubric_misalignment>", "revisionJustification":"<max 18 words>", "confidence":"<high|medium|low>", "confidenceReason":"<max 16 words>", "brief":"<max 32 words>", "response":"<max 24 words>", "sources":[{"name":"...","quote":"<max 10 words>","url":"..."}]}`).join(",\n    ")}
  },
  "conclusion": "<max 32 words>"
}`;
        const emergencyRes = await callAnalystAPI(
          [{ role: "user", content: emergencyPrompt }],
          prompts.analystResponse,
          2400,
          { liveSearch: true, includeMeta: true }
        );
        absorbAnalystMeta(analysisMeta, emergencyRes.meta);
        appendAnalysisDebugEvent(debugSession, {
          type: "model_response",
          phase: "finalizing",
          attempt: "emergency_minimal",
          responseLength: emergencyRes.text?.length || 0,
          meta: emergencyRes.meta || null,
          prompt: shortText(emergencyPrompt, 30000),
          responseExcerpt: shortText(emergencyRes.text, 6000),
          response: shortText(emergencyRes.text, 100000),
        });
        try {
          const parsedEmergency = parseWithDiagnostics(emergencyRes.text, {
            phase: "finalizing",
            attempt: "emergency_minimal",
            useCaseId: id,
            analysisMode,
            prompt: emergencyPrompt,
          }, debugSession);
          const mergedEmergency = mergePhase3WithBaseline(parsedEmergency, p1, dims);
          p3 = ensureFinalAnalystSummary(ensureDimensionArguments(ensureDimensionConfidence(mergedEmergency, dims), dims), dims);
        } catch (emergencyErr) {
          appendAnalysisDebugEvent(debugSession, {
            type: "emergency_phase3_fallback",
            phase: "finalizing",
            attempt: "baseline_merge",
            error: emergencyErr.message || String(emergencyErr),
          });
          const fallbackPayload = {
            analystResponse: "Phase 3 response was truncated; baseline analyst scoring is retained with confidence safeguards.",
            conclusion: p1?.conclusion || "",
            dimensions: {},
          };
          dims.forEach((d) => {
            const base = p1?.dimensions?.[d.id] || {};
            fallbackPayload.dimensions[d.id] = {
              finalScore: clampScore(base?.score, 3),
              scoreChanged: false,
              decision: "defend",
              revisionBasis: "none",
              revisionJustification: "",
              confidence: normalizeConfidenceLevel(base?.confidence) || "medium",
              confidenceReason: String(base?.confidenceReason || "").trim(),
              brief: String(base?.brief || "").trim(),
              response: "Baseline score retained due malformed finalizing response output.",
              sources: mergeSourceLists(base?.sources),
            };
          });
          const mergedFallback = mergePhase3WithBaseline(fallbackPayload, p1, dims);
          p3 = ensureFinalAnalystSummary(ensureDimensionArguments(ensureDimensionConfidence(mergedFallback, dims), dims), dims);
        }
      }
    }

    {
      const decisionPass = enforcePhase3DecisionRules(p3, p1, p2, dims);
      analysisMeta.phase3DecisionGuardAdjustments += decisionPass.adjustments.length;
      const confidencePass = enforcePhase3ConfidenceRules(decisionPass.adjusted, p1, p2, dims);
      analysisMeta.phase3ConfidenceGuardAdjustments += confidencePass.adjustments.length;
      const polarityPass = enforcePhase3PolarityRules(confidencePass.adjusted, p1, dims);
      analysisMeta.phase3PolarityGuardAdjustments += polarityPass.adjustments.length;
      p3 = ensureFinalAnalystSummary(ensureDimensionArguments(ensureDimensionConfidence(polarityPass.adjusted, dims), dims), dims);
      appendAnalysisDebugEvent(debugSession, {
        type: "phase3_guard_applied",
        phase: "finalizing",
        attempt: "post_parse",
        decisionAdjustments: decisionPass.adjustments.length,
        confidenceAdjustments: confidencePass.adjustments.length,
        polarityAdjustments: polarityPass.adjustments.length,
        details: {
          decision: decisionPass.adjustments,
          confidence: confidencePass.adjustments,
          polarity: polarityPass.adjustments,
        },
      });
    }

    let finalResponse = p3;
    try {
      const consistencyPrompt = buildConsistencyCheckPrompt(desc, dims, p1, p2, p3, researchSetup);
      const consistencyRes = await callAnalystAPI(
        [{ role: "user", content: consistencyPrompt }],
        prompts.analystResponse,
        3000,
        { liveSearch: true, includeMeta: true }
      );
      absorbAnalystMeta(analysisMeta, consistencyRes.meta);
      const r4 = consistencyRes.text;
      appendAnalysisDebugEvent(debugSession, {
        type: "model_response",
        phase: "finalizing_consistency",
        attempt: "full",
        responseLength: r4?.length || 0,
        meta: consistencyRes.meta || null,
        prompt: shortText(consistencyPrompt, 30000),
        responseExcerpt: shortText(r4, 6000),
        response: shortText(r4, 100000),
      });
      const audit = parseWithDiagnostics(r4, {
        phase: "finalizing_consistency",
        attempt: "full",
        useCaseId: id,
        analysisMode,
        prompt: consistencyPrompt,
      }, debugSession);
      const { adjusted, changed } = applyConsistencyAdjustments(p3, audit, dims);
      const decisionPass = enforcePhase3DecisionRules(adjusted, p1, p2, dims);
      analysisMeta.phase3DecisionGuardAdjustments += decisionPass.adjustments.length;
      const confidencePass = enforcePhase3ConfidenceRules(decisionPass.adjusted, p1, p2, dims);
      analysisMeta.phase3ConfidenceGuardAdjustments += confidencePass.adjustments.length;
      const polarityPass = enforcePhase3PolarityRules(confidencePass.adjusted, p1, dims);
      analysisMeta.phase3PolarityGuardAdjustments += polarityPass.adjustments.length;
      finalResponse = ensureFinalAnalystSummary(ensureDimensionArguments(ensureDimensionConfidence(polarityPass.adjusted, dims), dims), dims);
      appendAnalysisDebugEvent(debugSession, {
        type: "consistency_check_applied",
        phase: "finalizing_consistency",
        attempt: "final",
        changedCount: changed.length,
        changed,
        decisionGuardAdjustments: decisionPass.adjustments.length,
        confidenceGuardAdjustments: confidencePass.adjustments.length,
        polarityGuardAdjustments: polarityPass.adjustments.length,
      });
    } catch (consistencyErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "consistency_check_failed",
        phase: "finalizing_consistency",
        attempt: "final",
        error: consistencyErr.message || String(consistencyErr),
      });
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: consistency check failed. ${consistencyErr?.message || String(consistencyErr)}`,
        "STRICT_CONSISTENCY_FAILED"
      );
    }
    try {
      const coherencePrompt = buildCrossDimensionCoherencePrompt(desc, dims, finalResponse, researchSetup);
      const coherenceRes = await callCriticAPI(
        [{ role: "user", content: coherencePrompt }],
        prompts.critic,
        Math.max(2200, Math.min(4200, tokenLimits.critic)),
        { liveSearch: true, includeMeta: true }
      );
      absorbCriticMeta(analysisMeta, coherenceRes.meta);
      const coherenceParsed = parseWithDiagnostics(coherenceRes.text, {
        phase: "finalizing_cross_dimension",
        attempt: "full",
        useCaseId: id,
        analysisMode,
        prompt: coherencePrompt,
      }, debugSession);
      const conflicts = normalizeCrossDimensionConflicts(coherenceParsed, dims);
      analysisMeta.crossDimensionCoherenceFlags = conflicts.length;
      const coherenceApplied = applyCrossDimensionCoherenceAdjustments(finalResponse, conflicts);
      analysisMeta.crossDimensionCoherenceAdjustments = coherenceApplied.adjustments.length;
      if (coherenceApplied.adjustments.length) {
        const decisionPass = enforcePhase3DecisionRules(coherenceApplied.adjusted, p1, p2, dims);
        analysisMeta.phase3DecisionGuardAdjustments += decisionPass.adjustments.length;
        const confidencePass = enforcePhase3ConfidenceRules(decisionPass.adjusted, p1, p2, dims);
        analysisMeta.phase3ConfidenceGuardAdjustments += confidencePass.adjustments.length;
        const polarityPass = enforcePhase3PolarityRules(confidencePass.adjusted, p1, dims);
        analysisMeta.phase3PolarityGuardAdjustments += polarityPass.adjustments.length;
        finalResponse = ensureFinalAnalystSummary(ensureDimensionArguments(ensureDimensionConfidence(polarityPass.adjusted, dims), dims), dims);
      }
      appendAnalysisDebugEvent(debugSession, {
        type: "cross_dimension_coherence_applied",
        phase: "finalizing_cross_dimension",
        attempt: "final",
        flagCount: conflicts.length,
        appliedCount: coherenceApplied.adjustments.length,
        adjustments: coherenceApplied.adjustments,
      });
    } catch (coherenceErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "cross_dimension_coherence_failed",
        phase: "finalizing_cross_dimension",
        attempt: "final",
        error: coherenceErr?.message || String(coherenceErr),
      });
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: cross-dimension coherence failed. ${coherenceErr?.message || String(coherenceErr)}`,
        "STRICT_COHERENCE_FAILED"
      );
    }
    finalResponse = finalResponse && typeof finalResponse === "object" ? finalResponse : {};
    finalResponse.attributes = normalizeAttributesShape(finalResponse?.attributes, desc, framingFields);
    try {
      finalResponse = await verifyScorecardSources({
        payload: finalResponse,
        dims,
        analysisMeta,
        sourceFetchCache,
        debugSession,
        phase: "final_source_verification",
        penalizeConfidence: true,
      });
    } catch (verificationErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "source_verification_failed",
        phase: "final_source_verification",
        attempt: "phase3",
        error: verificationErr.message || String(verificationErr),
      });
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: final source verification failed. ${verificationErr?.message || String(verificationErr)}`,
        "STRICT_SOURCE_VERIFICATION_FAILED"
      );
    }

    try {
      updateUC(id, (u) => ({
        ...u,
        phase: "red_team",
        finalScores: finalResponse,
        analysisMeta: { ...(u.analysisMeta || {}), ...analysisMeta },
      }));
      const redTeamPrompt = buildScorecardRedTeamPrompt(desc, dims, finalResponse, researchSetup);
      const redTeamRes = await callCriticAPI(
        [{ role: "user", content: redTeamPrompt }],
        prompts.redTeam,
        Math.max(2200, Math.min(4200, tokenLimits.critic)),
        { liveSearch: false, includeMeta: true }
      );
      absorbCriticMeta(analysisMeta, redTeamRes.meta);
      const redTeamParsed = parseWithDiagnostics(redTeamRes.text, {
        phase: "red_team",
        attempt: "full",
        useCaseId: id,
        analysisMode,
        prompt: redTeamPrompt,
      }, debugSession);
      const redTeamApplied = applyScorecardRedTeam(finalResponse, dims, redTeamParsed);
      finalResponse = redTeamApplied.output;
      analysisMeta.redTeamCallMade = true;
      analysisMeta.redTeamHighSeverityCount = Number(redTeamApplied.highSeverityCount || 0);
      appendAnalysisDebugEvent(debugSession, {
        type: "red_team_applied",
        phase: "red_team",
        attempt: "final",
        highSeverityCount: analysisMeta.redTeamHighSeverityCount,
      });
    } catch (redTeamErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "red_team_failed",
        phase: "red_team",
        attempt: "final",
        error: redTeamErr?.message || String(redTeamErr),
      });
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: red-team pass failed. ${redTeamErr?.message || String(redTeamErr)}`,
        "STRICT_RED_TEAM_FAILED"
      );
    }

    try {
      updateUC(id, (u) => ({
        ...u,
        phase: "synthesizer",
        finalScores: finalResponse,
        analysisMeta: { ...(u.analysisMeta || {}), ...analysisMeta },
      }));
      const synthesizerPrompt = buildScorecardSynthesizerPrompt(desc, dims, finalResponse, analysisMeta, researchSetup);
      const synthCall = await callSynthesizerAPI(
        [{ role: "user", content: synthesizerPrompt }],
        prompts.synthesizer,
        Math.max(2200, Math.min(4200, tokenLimits.phase3Response)),
        { liveSearch: false, includeMeta: true }
      );
      analysisMeta.synthesizerCallMade = true;
      analysisMeta.synthesizerModel = modelSignatureFromOptions(synthCall.options);
      absorbAnalystMeta(analysisMeta, synthCall.response?.meta);
      const synthParsed = parseWithDiagnostics(synthCall.response?.text || synthCall.response, {
        phase: "synthesizer",
        attempt: "full",
        useCaseId: id,
        analysisMode,
        prompt: synthesizerPrompt,
      }, debugSession);
      const synthesis = normalizeScorecardSynthesizerPayload(synthParsed);
      finalResponse.executiveSummary = synthesis;
      if (synthesis?.decisionImplication) {
        if (!cleanString(finalResponse.originalConclusion)) {
          finalResponse.originalConclusion = cleanString(finalResponse.conclusion);
        }
        finalResponse.conclusion = synthesis.decisionImplication;
      }
      appendAnalysisDebugEvent(debugSession, {
        type: "synthesizer_applied",
        phase: "synthesizer",
        attempt: "final",
        model: analysisMeta.synthesizerModel,
      });
    } catch (synthErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "synthesizer_failed",
        phase: "synthesizer",
        attempt: "final",
        error: synthErr?.message || String(synthErr),
      });
      failIfStrictQuality(
        strictQuality,
        `Strict quality mode: synthesizer pass failed. ${synthErr?.message || String(synthErr)}`,
        "STRICT_SYNTHESIZER_FAILED"
      );
    }

    analysisMeta.sourceUniverse = buildScorecardSourceUniverse(finalResponse, dims);

    appendAnalysisDebugEvent(debugSession, {
      type: "phase_complete",
      phase: "finalizing",
      attempt: "final",
      responseLength: JSON.stringify(finalResponse || {}).length,
    });

    debate.push({ phase: "response", content: finalResponse });
    updateUC(id, (u) => ({
      ...u,
      finalScores: finalResponse,
      phase: "discover",
      debate: [...debate],
      analysisMeta: { ...(u.analysisMeta || {}), ...analysisMeta },
    }));

    // Phase 4: Related use case discovery (non-blocking)
    const discoveryLiveSearch = relatedDiscoveryEnabled;
    let discover = {
      candidates: [],
      rejectedCandidates: [],
      error: null,
      generatedAt: new Date().toISOString(),
      generatedCandidatesCount: 0,
      validatedCandidatesCount: 0,
    };
    const weakestFallbackIds = weakestDimensions(dims, finalResponse, 3).map((item) => item.dim.id);
    const discoverPrompt = buildDiscoverPrompt(desc, dims, p1, finalResponse, researchSetup);

    if (relatedDiscoveryEnabled) {
      try {
      const discoverRes = await callAnalystAPI(
        [{ role: "user", content: discoverPrompt }],
        prompts.analyst,
        3200,
        { liveSearch: discoveryLiveSearch, includeMeta: true }
      );
      absorbDiscoveryMeta(analysisMeta, discoverRes.meta);
      let r5 = discoverRes.text;
      appendAnalysisDebugEvent(debugSession, {
        type: "model_response",
        phase: "discover",
        attempt: "full",
        liveSearch: discoveryLiveSearch,
        responseLength: r5?.length || 0,
        meta: discoverRes.meta || null,
        prompt: shortText(discoverPrompt, 30000),
        responseExcerpt: shortText(r5, 6000),
        response: shortText(r5, 100000),
      });

      let p5;
      try {
        p5 = parseWithDiagnostics(r5, {
          phase: "discover",
          attempt: "full",
          useCaseId: id,
          analysisMode,
          prompt: discoverPrompt,
        }, debugSession);
      } catch (err) {
        const discoverRetryPrompt = `${discoverPrompt}

STRICT JSON RULES:
- Return exactly one valid JSON object. No markdown, no prose before/after.
- Use double quotes for every key and string value.
- Escape any internal quote as \\".
- No trailing commas.
- Keep title <= 12 words.
- Keep rationale <= 24 words.
- Keep analysisInput <= 45 words.
`;
        const discoverRetryRes = await callAnalystAPI(
          [{ role: "user", content: discoverRetryPrompt }],
          prompts.analyst,
          2400,
          { liveSearch: discoveryLiveSearch, includeMeta: true }
        );
        absorbDiscoveryMeta(analysisMeta, discoverRetryRes.meta);
        r5 = discoverRetryRes.text;
        appendAnalysisDebugEvent(debugSession, {
          type: "model_response",
          phase: "discover",
          attempt: "condensed_retry",
          liveSearch: discoveryLiveSearch,
          responseLength: r5?.length || 0,
          meta: discoverRetryRes.meta || null,
          prompt: shortText(discoverRetryPrompt, 30000),
          responseExcerpt: shortText(r5, 6000),
          response: shortText(r5, 100000),
        });
        p5 = parseWithDiagnostics(r5, {
          phase: "discover",
          attempt: "condensed_retry",
          useCaseId: id,
          analysisMode,
          prompt: discoverRetryPrompt,
        }, debugSession);
      }

      const generatedCandidates = normalizeDiscoverCandidates(p5, dims, weakestFallbackIds);
      const { validated: candidates, rejected } = await validateDiscoverCandidates({
        desc,
        dims,
        finalScores: finalResponse,
        candidates: generatedCandidates,
        analysisMeta,
        debugSession,
        analysisMode,
        researchSetup,
        liveSearch: discoveryLiveSearch,
      });
      discover = {
        ...discover,
        candidates,
        rejectedCandidates: rejected,
        generatedCandidatesCount: generatedCandidates.length,
        validatedCandidatesCount: candidates.length,
      };
      analysisMeta.generatedDiscoverCandidatesCount = generatedCandidates.length;
      analysisMeta.discoverCandidatesCount = candidates.length;
      analysisMeta.rejectedDiscoverCandidatesCount = rejected.length;
      appendAnalysisDebugEvent(debugSession, {
        type: "phase_complete",
        phase: "discover",
        attempt: "final",
        generatedCandidateCount: generatedCandidates.length,
        candidateCount: candidates.length,
        rejectedCandidateCount: rejected.length,
      });
      } catch (discoverErr) {
        discover.error = discoverErr.message || String(discoverErr);
        analysisMeta.generatedDiscoverCandidatesCount = 0;
        analysisMeta.discoverCandidatesCount = 0;
        analysisMeta.rejectedDiscoverCandidatesCount = 0;
        appendAnalysisDebugEvent(debugSession, {
          type: "discover_failed",
          phase: "discover",
          attempt: "final",
          error: discover.error,
        });
        failIfStrictQuality(
          strictQuality,
          `Strict quality mode: discovery pass failed. ${discover.error}`,
          "STRICT_DISCOVERY_FAILED"
        );
      }
    } else {
      appendAnalysisDebugEvent(debugSession, {
        type: "phase_complete",
        phase: "discover",
        attempt: "skipped",
        generatedCandidateCount: 0,
        candidateCount: 0,
        rejectedCandidateCount: 0,
      });
    }

    const staleObserved = Number(analysisMeta.staleEvidenceObservedDimensions || 0);
    analysisMeta.staleEvidenceRatio = staleObserved
      ? Number(analysisMeta.staleEvidenceRatioSum || 0) / staleObserved
      : 0;
    analysisMeta.providerContributions = {
      ...(analysisMeta.providerContributions || {}),
      native: [
        { provider: "analyst", webSearchCalls: Number(analysisMeta.webSearchCalls || 0) },
        { provider: "critic", webSearchCalls: Number(analysisMeta.criticWebSearchCalls || 0) },
        { provider: "targeted", webSearchCalls: Number(analysisMeta.lowConfidenceTargetedWebSearchCalls || 0) },
        { provider: "discovery", webSearchCalls: Number(analysisMeta.discoveryWebSearchCalls || 0) },
      ],
    };
    setCompletionState(analysisMeta, "complete");

    updateUC(id, (u) => ({
      ...u,
      finalScores: finalResponse,
      discover,
      status: "complete",
      phase: "complete",
      debate: [...debate],
      analysisMeta: { ...(u.analysisMeta || {}), ...analysisMeta },
    }));
    runStatus = "complete";
  } catch (err) {
    runError = err;
    setCompletionState(
      analysisMeta,
      "failed",
      "scorecard_pipeline_failed",
      err?.message || String(err)
    );
    appendAnalysisDebugEvent(debugSession, {
      type: "analysis_error",
      phase: "analysis",
      attempt: "final",
      error: err.message || String(err),
    });
    throw err;
  } finally {
    appendAnalysisDebugEvent(debugSession, {
      type: "analysis_end",
      phase: "analysis",
      attempt: "final",
      status: runStatus,
      analysisMeta,
    });
    const completedDebugSession = finalizeAnalysisDebugSession(debugSession, {
      status: runStatus,
      error: runError,
      analysisMeta,
    });
    if (typeof options.onDebugSession === "function") {
      options.onDebugSession(completedDebugSession, {
        downloadRequested: downloadDebugLog,
      });
    }
  }
}

function cloneState(value) {
  return JSON.parse(JSON.stringify(value));
}

function createInitialUseCaseState(input) {
  const id = String(input?.id || "").trim();
  const desc = String(input?.description || "").trim();
  const origin = input?.origin || null;
  if (!id || !desc) {
    throw new Error("runAnalysis requires input.id and input.description.");
  }
  const evidenceMode = normalizeEvidenceMode(input?.options?.evidenceMode);
  const strictQuality = normalizeStrictQuality(input?.options?.strictQuality || input?.options?.quality?.strictFailFast);
  const deepAssist = normalizeDeepAssistOptions(input?.options?.deepAssist || {});
  const researchSetup = normalizeResearchSetupContext(input?.options?.researchSetup || {});

  return {
    id,
    rawInput: desc,
    status: "analyzing",
    phase: evidenceMode === "deep-assist" ? "deep_assist_collect" : "analyst_baseline",
    attributes: null,
    dimScores: null,
    critique: null,
    finalScores: null,
    debate: [],
    followUps: {},
    errorMsg: null,
    discover: null,
    origin,
    researchSetup,
    outputMode: "scorecard",
    analysisMeta: {
      analysisMode: evidenceMode === "deep-assist" ? "deep-assist" : "hybrid",
      evidenceMode,
      strictQuality,
      liveSearchRequested: true,
      liveSearchUsed: false,
      webSearchCalls: 0,
      liveSearchFallbackReason: null,
      criticLiveSearchRequested: true,
      criticLiveSearchUsed: false,
      criticWebSearchCalls: 0,
      criticLiveSearchFallbackReason: null,
      discoveryLiveSearchRequested: true,
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
      lowConfidenceRoundRobinApplied: false,
      lowConfidenceBudgetUnits: 0,
      lowConfidenceBudgetUsed: 0,
      lowConfidenceDroppedByBudget: 0,
      targetedRetrievalNiche: "",
      targetedRetrievalAliases: [],
      targetedDimensionDiagnostics: [],
      counterfactualQueriesGenerated: 0,
      counterfactualFindingsUsed: 0,
      deepAssistRecoveryTriggered: false,
      deepAssistRecoveryCandidates: 0,
      deepAssistRecoveryBudgetUnits: 0,
      deepAssistRecoveryDroppedByBudget: 0,
      deepAssistRecoveryUpgraded: 0,
      deepAssistRecoveryValidatedLow: 0,
      deepAssistRecoveryFailed: false,
      deepAssistRecoveryDiagnostics: [],
      sourceVerificationChecked: 0,
      sourceVerificationVerified: 0,
      sourceVerificationNotFound: 0,
      sourceVerificationFetchFailed: 0,
      sourceVerificationInvalidUrl: 0,
      sourceVerificationPartialMatch: 0,
      sourceVerificationNameOnly: 0,
      sourceVerificationPenalizedDimensions: 0,
      sourceVerificationSkippedReason: null,
      hybridStats: null,
      phase3DecisionGuardAdjustments: 0,
      phase3ConfidenceGuardAdjustments: 0,
      phase3PolarityGuardAdjustments: 0,
      crossDimensionCoherenceFlags: 0,
      crossDimensionCoherenceAdjustments: 0,
      hybridReconcileHealth: null,
      hybridReconcileRetryTriggered: false,
      hybridReconcileRetryAttempts: 0,
      hybridReconcileRetryUsed: false,
      hybridReconcileRetryReason: "",
      hybridReconcileRetryDiagnostics: null,
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
      sourceDiversityTotalDimensions: 0,
      sourceDiversityConfidenceCaps: 0,
      staleEvidenceObservedDimensions: 0,
      staleEvidenceRatioSum: 0,
      staleEvidenceConfidenceCaps: 0,
      verificationConfidenceCaps: 0,
      urlCoverageConfidenceCaps: 0,
      zeroSourceConfidenceCaps: 0,
      sourceUniverse: emptySourceUniverseSummary(),
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

export async function runAnalysis(input, config, callbacks = {}) {
  const transport = callbacks?.transport;
  if (!transport?.callAnalyst || !transport?.callCritic) {
    throw new Error("runAnalysis requires callbacks.transport with callAnalyst and callCritic.");
  }

  const outputMode = String(config?.outputMode || "scorecard").trim().toLowerCase();
  if (outputMode === "matrix") {
    return runMatrixAnalysis(input, config, callbacks);
  }

  const dims = Array.isArray(config?.dimensions) ? config.dimensions : [];
  if (!dims.length) {
    throw new Error("runAnalysis requires config.dimensions.");
  }

  const initial = input?.initialState ? cloneState(input.initialState) : createInitialUseCaseState(input);
  let useCaseState = initial;

  const onProgress = typeof callbacks?.onProgress === "function"
    ? callbacks.onProgress
    : () => {};

  const updateUC = (targetId, fn) => {
    if (targetId !== useCaseState.id) return;
    useCaseState = fn(useCaseState);
    onProgress(useCaseState.phase || "analysis", cloneState(useCaseState));
  };

  const previousRuntime = ACTIVE_RUNTIME;
  ACTIVE_RUNTIME = {
    transport,
    prompts: config?.prompts || {},
    models: config?.models || {},
    deepAssist: config?.deepAssist || {},
  };
  try {
    await runAnalysisLegacy(
      useCaseState.rawInput,
      dims,
      updateUC,
      useCaseState.id,
      {
        analysisMode: "hybrid",
        downloadDebugLog: !!input?.options?.downloadDebugLog,
        prompts: config?.prompts || {},
        limits: config?.limits || {},
        inputSpec: config?.inputSpec || {},
        framingFields: Array.isArray(config?.framingFields) ? config.framingFields : [],
        relatedDiscovery: config?.relatedDiscovery !== false,
        researchSetup: input?.options?.researchSetup || {},
        evidenceMode: input?.options?.evidenceMode,
        deepAssist: input?.options?.deepAssist || {},
        onDebugSession: callbacks?.onDebugSession,
      }
    );
  } finally {
    ACTIVE_RUNTIME = previousRuntime;
  }

  return cloneState(useCaseState);
}
