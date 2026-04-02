import { safeParseJSON, buildDimRubrics } from "../lib/json.js";
import { buildRubricCalibrationBlock } from "../lib/rubric.js";
import { normalizeConfidenceLevel } from "../lib/confidence.js";
import { ensureDimensionArgumentShape } from "../lib/arguments.js";
import {
  createAnalysisDebugSession,
  appendAnalysisDebugEvent,
  finalizeAnalysisDebugSession,
} from "../lib/debug.js";
import { SYS_ANALYST, SYS_CRITIC, SYS_ANALYST_RESPONSE } from "../prompts/defaults.js";

let ACTIVE_RUNTIME = null;

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

async function callAnalystAPI(messages, systemPrompt, maxTokens = 5000, options = {}) {
  const merged = withRoleModelOptions("analyst", options);
  return getRuntime().transport.callAnalyst(messages, systemPrompt, maxTokens, merged);
}

async function callCriticAPI(messages, systemPrompt, maxTokens = 5000, options = {}) {
  const merged = withRoleModelOptions("critic", options);
  return getRuntime().transport.callCritic(messages, systemPrompt, maxTokens, merged);
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

function buildAttributesTemplate(condensed = false) {
  if (condensed) {
    return `{"title": "<max 8 words>", "problemStatement": "<adaptive: 1-8 sentences based on input detail>", "solutionStatement": "<adaptive: 1-8 sentences based on input detail>", "expandedDescription": "<2 sentences>", "vertical": "<industry>", "buyerPersona": "<role>", "aiSolutionType": "<AI/ML type>", "typicalTimeline": "<estimate>", "deliveryModel": "<engagement type>"}`;
  }
  return `{
    "title": "<descriptive title, max 8 words>",
    "problemStatement": "<adaptive detail: short input => 1-2 sentences; detailed input => 6-8 sentences (business pain, constraints, impact)>",
    "solutionStatement": "<adaptive detail: short input => 1-2 sentences; detailed input => 6-8 sentences (AI approach, workflow, value path)>",
    "expandedDescription": "<2-3 sentences: what the AI does, how it creates value, why an outsourcer should care>",
    "vertical": "<primary industry vertical>",
    "buyerPersona": "<job title of primary decision maker>",
    "aiSolutionType": "<specific AI/ML technology type>",
    "typicalTimeline": "<realistic end-to-end delivery estimate>",
    "deliveryModel": "<how outsourcer engages: build-and-transfer, managed service, etc>"
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

function buildPhase1EvidencePrompt(desc, dims, { liveSearch = false, condensed = false } = {}) {
  const mandatorySearchPlan = buildDynamicSearchPlan(dims, 3);

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
  const attributesTemplate = buildAttributesTemplate(condensed);

  return `Step 1 of 2 - EVIDENCE ENUMERATION ONLY.
Analyze this AI use case for an outsourcing company that builds CUSTOM AI solutions for enterprise clients:

"${desc}"

SCORING DIMENSIONS (for relevance only in this step - DO NOT SCORE YET):
${buildDimRubrics(dims)}${liveSearchBlock}
PROBLEM / SOLUTION DETAIL RULE:
- Keep statements proportional to user input detail.
- If input is short/high-level, keep each statement concise (1-2 sentences).
- If input is detailed, summarize with richer detail (6-8 sentences per statement).

Rules for this step:
- Enumerate evidence only: verifiable facts, deployments, metrics, market signals, and caveats.
- Do NOT assign scores, confidence levels, or narrative conclusions.
- Keep evidence discrete (bullet-like facts), not long prose.
- Source credibility is mandatory per evidence point:
  - sourceType "vendor": vendor blog, product page, self-reported marketing claim.
  - sourceType "press": major press, earnings call, regulatory filing.
  - sourceType "independent": peer-reviewed, benchmark, audit, neutral analyst research.
- If a dimension relies mostly on vendor claims, state that clearly in "missingEvidence" and request independent corroboration.

Return ONLY this JSON structure, fully populated for ALL 11 dimension IDs (${dims.map((d) => d.id).join(", ")}):

{
  "attributes": ${attributesTemplate},
  "dimensions": {
    ${evidenceTemplate}
  }
}`;
}

function buildPhase1ScoringPrompt(desc, dims, evidencePayload, { condensed = false, passLabel = "initial analyst pass" } = {}) {
  const dimTemplate = buildDimJsonTemplate(dims, condensed);
  const attrsTemplate = buildAttributesTemplate(condensed);

  return `Step 2 of 2 - RUBRIC SCORING FROM ENUMERATED EVIDENCE.
Use case:
"${desc}"

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
- Keep attributes consistent with Step 1 unless a clear correction is needed.

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
    };
    if (!source.name && !source.quote && !source.url) continue;
    const key = `${source.name}|${source.quote}|${source.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
    if (out.length >= maxItems) break;
  }
  return out;
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
  const base = title || desc || "enterprise AI use case";
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

function selectTargetedCycleDimensions(phase1Payload, dims) {
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

  const candidateIds = [...new Set([...low, ...mediumWithSpecificGap])];
  return { candidateIds, lowIds: low, mediumGapIds: mediumWithSpecificGap };
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

function buildHybridReconcileEvidencePrompt(desc, dims, baseline, web, condensed = false) {
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
  const attrsTemplate = buildAttributesTemplate(condensed);

  return `Step 1 of 2 - EVIDENCE ENUMERATION ONLY (HYBRID RECONCILE).
You are a reliability reviewer combining two analyst drafts for the same use case.
Use case: "${desc}"

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
- Enumerate evidence only. Do NOT output scores or confidence in this step.
- Keep the same outsourcing-delivery framing and coherent attributes.

Return ONLY this JSON:
{
  "attributes": ${attrsTemplate},
  "dimensions": {
    ${evidenceTemplate}
  }
}`;
}

function buildCriticPrompt(desc, dims, p1, { liveSearch = false } = {}) {
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

  return `Audit this analyst assessment of the AI use case: "${p1?.attributes?.title || desc}"

Use case description:
"${desc}"

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

function buildLowConfidenceQueryPlanPrompt(desc, dim, currentDim = {}, attributes = {}) {
  const dimLabel = dim?.label || dim?.id || "Dimension";
  const gapHint = clip(
    currentDim?.missingEvidence
    || currentDim?.confidenceReason
    || currentDim?.risks
    || "Evidence is sparse for this dimension.",
    220
  );

  return `You are generating targeted search queries for one low-confidence scoring dimension.

Use case:
"${desc}"

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

Task:
- Produce 3 to 4 highly specific search queries to close the evidence gap.
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
  ]
}`;
}

function normalizeLowConfidenceQueryPlan(payload, fallbackQueries = [], fallbackGap = "") {
  const queries = [
    ...normalizeStringList(payload?.queries, 4, 170),
    ...normalizeStringList(fallbackQueries, 4, 170),
  ];
  const unique = [...new Set(queries)].slice(0, 4);
  return {
    gap: String(payload?.gap || "").trim() || String(fallbackGap || "").trim() || "Evidence for this dimension is still weak.",
    queries: unique,
  };
}

function buildLowConfidenceSearchHarvestPrompt(desc, dim, queryPlan, currentDim = {}) {
  return `Run targeted live web research for this one low-confidence dimension and return raw findings only.

Use case:
"${desc}"

Dimension:
${dim?.label || dim?.id} [${dim?.id}]

Current snapshot:
- Score: ${currentDim?.score ?? "n/a"}/5
- Confidence: ${currentDim?.confidence || "low"}
- Gap: ${queryPlan?.gap || "Evidence gap not specified."}

Queries to run:
${(queryPlan?.queries || []).map((q, idx) => `${idx + 1}. ${q}`).join("\n")}

Rules:
- Focus on concrete facts, deployments, release changes, or benchmark signals.
- Keep findings factual and source-linked. No scoring in this step.
- If a query has no useful result, mark it as not useful.

Return ONLY this JSON:
{
  "findings": [
    {
      "query": "<exact query>",
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
  const findings = Array.isArray(payload?.findings)
    ? payload.findings
      .map((f) => {
        const query = String(f?.query || "").trim();
        const fact = String(f?.fact || "").trim();
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

  const fallbackCoverage = (queryPlan?.queries || []).map((q) => ({
    query: q,
    useful: findings.some((f) => f.query && f.query === q),
    note: findings.some((f) => f.query && f.query === q) ? "Returned at least one useful fact." : "No clearly useful fact captured.",
  }));

  return {
    findings,
    queryCoverage: queryCoverage.length ? queryCoverage : fallbackCoverage,
  };
}

function buildLowConfidenceRescorePrompt(desc, dim, currentDim, queryPlan, harvest) {
  const dimRubric = buildDimRubrics([dim]);
  const findingsBlock = JSON.stringify(harvest || {}, null, 2);

  return `Re-evaluate ONE low-confidence dimension using targeted live-search findings.

Use case:
"${desc}"

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
    arguments: normalizedArgHolder,
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

function buildDiscoverPrompt(desc, dims, p1, finalScores) {
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

  return `Generate related AI use case candidates for an outsourcing AI delivery company.

Original use case:
"${desc}"

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

function discoverValidationPrompt(desc, dims, finalScores, candidate, expectedIds) {
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

  return `Validate whether this discovery candidate is likely to improve the claimed weak dimensions.

Original use case:
"${desc}"

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

    const prompt = discoverValidationPrompt(desc, dims, finalScores, candidate, expectedIds);
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

function buildConsistencyCheckPrompt(desc, dims, p1, p2, p3) {
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

  return `Audit final scores for rubric consistency for this use case:
"${p1?.attributes?.title || desc}"

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
  absorbAnalystMeta(analysisMeta, meta);
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
}) {
  let evidencePayload;
  try {
    const fullPrompt = evidencePromptBuilder(false);
    const fullRes = await callAnalystAPI(
      [{ role: "user", content: fullPrompt }],
      analystPrompt(),
      evidenceMaxTokens,
      { liveSearch, includeMeta: true }
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
      { liveSearch, includeMeta: true }
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
      { liveSearch: false, includeMeta: true }
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
      { liveSearch: false, includeMeta: true }
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

async function runHybridPhase1(desc, dims, updateUC, id, analysisMeta, debugSession, tokenLimits = {}) {
  const evidenceMaxTokens = Number(tokenLimits.phase1Evidence) || 10000;
  const scoringMaxTokens = Number(tokenLimits.phase1Scoring) || 12000;
  const debugContext = { useCaseId: id, analysisMode: analysisMeta.analysisMode };
  updateUC(id, (u) => ({ ...u, phase: "analyst_baseline" }));
  const baseline = await runAnalystPass({
    evidencePromptBuilder: (condensed) => buildPhase1EvidencePrompt(desc, dims, { liveSearch: false, condensed }),
    scoringPromptBuilder: (evidence, condensed) => buildPhase1ScoringPrompt(desc, dims, evidence, {
      condensed,
      passLabel: "baseline analyst pass (memory-only)",
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
    evidencePromptBuilder: (condensed) => buildPhase1EvidencePrompt(desc, dims, { liveSearch: true, condensed }),
    scoringPromptBuilder: (evidence, condensed) => buildPhase1ScoringPrompt(desc, dims, evidence, {
      condensed,
      passLabel: "web-assisted analyst pass",
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
    evidencePromptBuilder: (condensed) => buildHybridReconcileEvidencePrompt(desc, dims, baseline, web, condensed),
    scoringPromptBuilder: (evidence, condensed) => buildPhase1ScoringPrompt(desc, dims, evidence, {
      condensed,
      passLabel: "hybrid reliability reconcile (score from merged evidence)",
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

  analysisMeta.hybridStats = computeHybridDeltaStats(dims, baseline, web, reconciled);
  return reconciled;
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
}) {
  const current = JSON.parse(JSON.stringify(phase1Payload || {}));
  current.dimensions = current.dimensions || {};
  const selection = selectTargetedCycleDimensions(current, dims);
  const candidateIds = selection.candidateIds;

  analysisMeta.lowConfidenceInitialCount = candidateIds.length;
  analysisMeta.lowConfidenceOnlyCount = selection.lowIds.length;
  analysisMeta.mediumGapTargetedCount = selection.mediumGapIds.length;
  analysisMeta.lowConfidenceUpgradedCount = 0;
  analysisMeta.lowConfidenceValidatedLowCount = 0;
  analysisMeta.lowConfidenceCycleFailures = 0;
  analysisMeta.lowConfidenceTargetedSearchUsed = false;
  analysisMeta.lowConfidenceTargetedWebSearchCalls = 0;
  analysisMeta.lowConfidenceTargetedFallbackReason = null;

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

    const before = current.dimensions?.[dimId] || {};
    const fallbackGap = before?.missingEvidence || before?.confidenceReason || before?.risks || "";
    const fallbackQueries = defaultTargetedQueries(desc, dim.label, fallbackGap, attributes);

    let queryPlan = { gap: fallbackGap || "Evidence gap remains unresolved.", queries: fallbackQueries };
    try {
      const queryPrompt = buildLowConfidenceQueryPlanPrompt(desc, dim, before, attributes);
      const queryRes = await callAnalystAPI(
        [{ role: "user", content: queryPrompt }],
        analystPrompt(),
        1200,
        { liveSearch: false, includeMeta: true }
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
      queryPlan = normalizeLowConfidenceQueryPlan(parsedPlan, fallbackQueries, fallbackGap);
    } catch (planErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "low_conf_query_plan_fallback",
        phase: "analyst_targeted_query_plan",
        attempt: `${dimId}_fallback`,
        error: planErr.message || String(planErr),
        extra: { dimensionId: dimId, fallbackQueries },
      });
      queryPlan = normalizeLowConfidenceQueryPlan({}, fallbackQueries, fallbackGap);
    }

    let harvest = { findings: [], queryCoverage: queryPlan.queries.map((q) => ({ query: q, useful: false, note: "No useful fact captured." })) };
    try {
      const searchPrompt = buildLowConfidenceSearchHarvestPrompt(desc, dim, queryPlan, before);
      const searchRes = await callAnalystAPI(
        [{ role: "user", content: searchPrompt }],
        analystPrompt(),
        2600,
        { liveSearch: true, includeMeta: true }
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
    } catch (searchErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "low_conf_search_fallback",
        phase: "analyst_targeted_search",
        attempt: `${dimId}_fallback`,
        error: searchErr.message || String(searchErr),
        extra: { dimensionId: dimId },
      });
    }

    try {
      const rescorePrompt = buildLowConfidenceRescorePrompt(desc, dim, before, queryPlan, harvest);
      const rescoreRes = await callAnalystAPI(
        [{ role: "user", content: rescorePrompt }],
        analystPrompt(),
        2800,
        { liveSearch: false, includeMeta: true }
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
            unsuccessfulQueries,
            validatedAt: new Date().toISOString(),
          },
        };
        analysisMeta.lowConfidenceUpgradedCount += 1;
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
            unsuccessfulQueries,
            validatedAt: new Date().toISOString(),
          },
        };
        if (nextConfidence === "low") analysisMeta.lowConfidenceValidatedLowCount += 1;
      }

      updateUC(id, (u) => ({
        ...u,
        dimScores: current.dimensions,
        analysisMeta: { ...(u.analysisMeta || {}), ...analysisMeta },
      }));
    } catch (rescoreErr) {
      analysisMeta.lowConfidenceCycleFailures += 1;
      appendAnalysisDebugEvent(debugSession, {
        type: "low_conf_rescore_failed",
        phase: "analyst_targeted_rescore",
        attempt: `${dimId}_failed`,
        error: rescoreErr.message || String(rescoreErr),
        extra: { dimensionId: dimId },
      });
    }
  }

  const normalizedFinal = ensureDimensionArguments(ensureDimensionConfidence(current, dims), dims);
  appendAnalysisDebugEvent(debugSession, {
    type: "phase_complete",
    phase: "analyst_targeted",
    attempt: "final",
    candidateCount: candidateIds.length,
    lowCandidates: selection.lowIds.length,
    mediumGapCandidates: selection.mediumGapIds.length,
    upgradedCount: analysisMeta.lowConfidenceUpgradedCount,
    validatedLowCount: analysisMeta.lowConfidenceValidatedLowCount,
    failures: analysisMeta.lowConfidenceCycleFailures,
  });
  return normalizedFinal;
}

async function runAnalysisLegacy(desc, dims, updateUC, id, options = {}) {
  const analysisMode = "hybrid";
  const criticLiveSearch = true;
  const downloadDebugLog = !!options.downloadDebugLog;
  const relatedDiscoveryEnabled = options.relatedDiscovery !== false;
  const prompts = {
    analyst: options?.prompts?.analyst || SYS_ANALYST,
    critic: options?.prompts?.critic || SYS_CRITIC,
    analystResponse: options?.prompts?.analystResponse || SYS_ANALYST_RESPONSE,
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
    phase3DecisionGuardAdjustments: 0,
    phase3ConfidenceGuardAdjustments: 0,
    hybridStats: null,
  };

  let runStatus = "failed";
  let runError = null;
  try {
    // Phase 1: Analyst
    updateUC(id, (u) => ({ ...u, phase: "analyst_baseline" }));
    const p1Base = await runHybridPhase1(desc, dims, updateUC, id, analysisMeta, debugSession, tokenLimits);
    let p1 = p1Base;

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
      });
    } catch (lowConfErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "low_conf_cycle_failed",
        phase: "analyst_targeted",
        attempt: "final",
        error: lowConfErr.message || String(lowConfErr),
      });
      p1 = p1Base;
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
    const phase2Prompt = buildCriticPrompt(desc, dims, p1, { liveSearch: criticLiveSearch });

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

    appendAnalysisDebugEvent(debugSession, {
      type: "phase_complete",
      phase: "critic",
      attempt: "final",
      responseLength: JSON.stringify(p2 || {}).length,
    });

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
      p3 = ensureFinalAnalystSummary(ensureDimensionArguments(ensureDimensionConfidence(confidencePass.adjusted, dims), dims), dims);
      appendAnalysisDebugEvent(debugSession, {
        type: "phase3_guard_applied",
        phase: "finalizing",
        attempt: "post_parse",
        decisionAdjustments: decisionPass.adjustments.length,
        confidenceAdjustments: confidencePass.adjustments.length,
        details: {
          decision: decisionPass.adjustments,
          confidence: confidencePass.adjustments,
        },
      });
    }

    let finalResponse = p3;
    try {
      const consistencyPrompt = buildConsistencyCheckPrompt(desc, dims, p1, p2, p3);
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
      finalResponse = ensureFinalAnalystSummary(ensureDimensionArguments(ensureDimensionConfidence(confidencePass.adjusted, dims), dims), dims);
      appendAnalysisDebugEvent(debugSession, {
        type: "consistency_check_applied",
        phase: "finalizing_consistency",
        attempt: "final",
        changedCount: changed.length,
        changed,
        decisionGuardAdjustments: decisionPass.adjustments.length,
        confidenceGuardAdjustments: confidencePass.adjustments.length,
      });
    } catch (consistencyErr) {
      appendAnalysisDebugEvent(debugSession, {
        type: "consistency_check_failed",
        phase: "finalizing_consistency",
        attempt: "final",
        error: consistencyErr.message || String(consistencyErr),
      });
    }

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
    const discoverPrompt = buildDiscoverPrompt(desc, dims, p1, finalResponse);

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

  return {
    id,
    rawInput: desc,
    status: "analyzing",
    phase: "analyst_baseline",
    attributes: null,
    dimScores: null,
    critique: null,
    finalScores: null,
    debate: [],
    followUps: {},
    errorMsg: null,
    discover: null,
    origin,
    analysisMeta: {
      analysisMode: "hybrid",
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
      hybridStats: null,
    },
  };
}

export async function runAnalysis(input, config, callbacks = {}) {
  const transport = callbacks?.transport;
  if (!transport?.callAnalyst || !transport?.callCritic) {
    throw new Error("runAnalysis requires callbacks.transport with callAnalyst and callCritic.");
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
        relatedDiscovery: config?.relatedDiscovery !== false,
        onDebugSession: callbacks?.onDebugSession,
      }
    );
  } finally {
    ACTIVE_RUNTIME = previousRuntime;
  }

  return cloneState(useCaseState);
}
