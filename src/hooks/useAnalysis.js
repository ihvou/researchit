import { callAnalystAPI, callCriticAPI } from "../lib/api";
import { safeParseJSON, buildDimRubrics } from "../lib/json";
import { buildRubricCalibrationBlock } from "../lib/rubric";
import { normalizeConfidenceLevel } from "../lib/confidence";
import {
  createAnalysisDebugSession,
  appendAnalysisDebugEvent,
  downloadAnalysisDebugSession,
  storeCompletedAnalysisDebugSession,
} from "../lib/debug";
import { SYS_ANALYST, SYS_CRITIC, SYS_ANALYST_RESPONSE } from "../prompts/system";

function buildDimJsonTemplate(dims, condensed = false) {
  if (condensed) {
    return dims.map((d) =>
      `"${d.id}": {"score": <1-5>, "confidence": "<high|medium|low>", "confidenceReason": "<1 sentence>", "brief": "<max 20 words>", "full": "<1 paragraph, max 80 words, cite 1-2 named companies>", "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}], "risks": "<max 20 words>"}`
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
      "risks": "<1-2 sentences on key risks or caveats for this dimension>"
    }`
  ).join(",\n    ");
}

function buildPhase1Prompt(desc, dims, { liveSearch = false, condensed = false } = {}) {
  const liveSearchBlock = liveSearch
    ? `\nLIVE SEARCH MODE:
- Use web search to verify high-confidence claims.
- Prefer current sources (last 24 months) where possible.
- Include real URLs for each dimension when available.\n`
    : "";

  const dimTemplate = buildDimJsonTemplate(dims, condensed);
  const attributesTemplate = condensed
    ? `{"title": "<max 8 words>", "expandedDescription": "<2 sentences>", "vertical": "<industry>", "buyerPersona": "<role>", "aiSolutionType": "<AI/ML type>", "typicalTimeline": "<estimate>", "deliveryModel": "<engagement type>"}`
    : `{
    "title": "<descriptive title, max 8 words>",
    "expandedDescription": "<2-3 sentences: what the AI does, how it creates value, why an outsourcer should care>",
    "vertical": "<primary industry vertical>",
    "buyerPersona": "<job title of primary decision maker>",
    "aiSolutionType": "<specific AI/ML technology type>",
    "typicalTimeline": "<realistic end-to-end delivery estimate>",
    "deliveryModel": "<how outsourcer engages: build-and-transfer, managed service, etc>"
  }`;

  return `Analyze this AI use case for an outsourcing company that builds CUSTOM AI solutions for enterprise clients:

"${desc}"

SCORING DIMENSIONS - use the rubric below to score each one 1-5:
${buildDimRubrics(dims)}${liveSearchBlock}
CONFIDENCE CALIBRATION (required for every dimension):
- High: named deployments with verifiable metrics and strong market familiarity.
- Medium: deployments exist but evidence is sparse, self-reported, or rapidly changing.
- Low: fewer than two verifiable deployments, underrepresented vertical, or heavy extrapolation.

Return ONLY this JSON structure, fully populated for ALL 11 dimension IDs (${dims.map((d) => d.id).join(", ")}):

{
  "attributes": ${attributesTemplate},
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

function buildHybridReconcilePrompt(desc, dims, baseline, web, condensed = false) {
  const comparison = dims.map((d) => {
    const b = baseline?.dimensions?.[d.id] || {};
    const w = web?.dimensions?.[d.id] || {};
    return [
      `DIMENSION: ${d.label} [${d.id}]`,
      `BASELINE score: ${b.score ?? "n/a"}/5`,
      `BASELINE confidence: ${b.confidence || "n/a"}`,
      `BASELINE confidence reason: "${clip(b.confidenceReason, 150)}"`,
      `BASELINE brief: "${clip(b.brief, 180)}"`,
      `BASELINE sources: ${sourceSummary(b.sources)}`,
      `BASELINE full snapshot: "${clip(b.full, 320)}"`,
      `WEB score: ${w.score ?? "n/a"}/5`,
      `WEB confidence: ${w.confidence || "n/a"}`,
      `WEB confidence reason: "${clip(w.confidenceReason, 150)}"`,
      `WEB brief: "${clip(w.brief, 180)}"`,
      `WEB sources: ${sourceSummary(w.sources)}`,
      `WEB full snapshot: "${clip(w.full, 320)}"`,
    ].join("\n");
  }).join("\n\n");

  const dimTemplate = buildDimJsonTemplate(dims, condensed);
  const attrsTemplate = condensed
    ? `{"title": "<max 8 words>", "expandedDescription": "<2 sentences>", "vertical": "<industry>", "buyerPersona": "<role>", "aiSolutionType": "<AI/ML type>", "typicalTimeline": "<estimate>", "deliveryModel": "<engagement type>"}`
    : `{
    "title": "<descriptive title, max 8 words>",
    "expandedDescription": "<2-3 sentences: what the AI does, how it creates value, why an outsourcer should care>",
    "vertical": "<primary industry vertical>",
    "buyerPersona": "<job title of primary decision maker>",
    "aiSolutionType": "<specific AI/ML technology type>",
    "typicalTimeline": "<realistic end-to-end delivery estimate>",
    "deliveryModel": "<how outsourcer engages: build-and-transfer, managed service, etc>"
  }`;

  return `You are a reliability reviewer combining two analyst drafts for the same use case.
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
- If changing a baseline score by 2+ points, ensure the full reasoning clearly justifies the change.
- Keep the same outsourcing-delivery framing.
- Output confidence and confidenceReason for every dimension using the same high/medium/low calibration:
  - High: named deployments with verifiable metrics and strong market familiarity.
  - Medium: deployments exist but evidence is sparse, self-reported, or rapidly changing.
  - Low: fewer than two verifiable deployments, underrepresented vertical, or heavy extrapolation.

Return ONLY this JSON structure, fully populated for ALL 11 dimension IDs (${dims.map((d) => d.id).join(", ")}):
{
  "attributes": ${attrsTemplate},
  "dimensions": {
    ${dimTemplate}
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
      `Analyst brief: "${clip(dim.brief, 190)}"`,
      `Analyst full snapshot: "${clip(dim.full, 320)}"`,
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

  return `Generate related AI use case candidates for an outsourcing AI delivery company.

Original use case:
"${desc}"

Final analysis conclusion:
${finalScores?.conclusion || "No conclusion provided."}

Final dimension snapshots:
${snapshotBlock}

Weakest dimensions to target first:
${weakestBlock}

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

Return ONLY this JSON:
{
  "candidates": [
    {
      "title": "<short candidate title>",
      "analysisInput": "<1-2 sentence use case prompt>",
      "rationale": "<one sentence: why this is likely to score better>",
      "expectedImprovedDimensions": ["<id1>", "<id2>", "<id3 optional>"]
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

    out.push({
      title: title.slice(0, 120),
      analysisInput: analysisInput.slice(0, 360),
      rationale: rationale.slice(0, 220),
      expectedImprovedDimensions,
    });
    if (out.length >= 5) break;
  }

  return out;
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
    if (!Number.isFinite(current)) {
      out.dimensions[d.id] = out.dimensions[d.id] || {};
      out.dimensions[d.id].finalScore = adj;
      out.dimensions[d.id].scoreChanged = true;
      changed.push({ id: d.id, from: null, to: adj });
      return;
    }
    if (current !== adj) {
      out.dimensions[d.id].finalScore = adj;
      out.dimensions[d.id].scoreChanged = true;
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

async function runAnalystPass(promptBuilder, dims, analysisMeta, debugContext, debugSession, { liveSearch = false, maxTokens = 12000 }) {
  try {
    const fullPrompt = promptBuilder(false);
    const fullRes = await callAnalystAPI(
      [{ role: "user", content: fullPrompt }],
      SYS_ANALYST,
      maxTokens,
      { liveSearch, includeMeta: true }
    );
    absorbAnalystMeta(analysisMeta, fullRes.meta);
    appendAnalysisDebugEvent(debugSession, {
      type: "model_response",
      phase: "analyst",
      attempt: "full",
      liveSearch,
      responseLength: fullRes.text?.length || 0,
      meta: fullRes.meta || null,
      prompt: shortText(fullPrompt, 30000),
      responseExcerpt: shortText(fullRes.text, 6000),
      response: shortText(fullRes.text, 100000),
    });
    return ensureDimensionConfidence(parseWithDiagnostics(fullRes.text, {
      phase: "analyst",
      attempt: "full",
      useCaseId: debugContext.useCaseId,
      analysisMode: debugContext.analysisMode,
      prompt: fullPrompt,
    }, debugSession), dims);
  } catch (parseErr) {
    appendAnalysisDebugEvent(debugSession, {
      type: "phase_retry_triggered",
      phase: "analyst",
      attempt: "full",
      error: parseErr.message || String(parseErr),
    });
    console.warn("Analyst parse failed, retrying with condensed prompt:", parseErr.message);
    const condensedPrompt = promptBuilder(true);
    const condensedRes = await callAnalystAPI(
      [{ role: "user", content: condensedPrompt }],
      SYS_ANALYST,
      8000,
      { liveSearch, includeMeta: true }
    );
    absorbAnalystMeta(analysisMeta, condensedRes.meta);
    appendAnalysisDebugEvent(debugSession, {
      type: "model_response",
      phase: "analyst",
      attempt: "condensed_retry",
      liveSearch,
      responseLength: condensedRes.text?.length || 0,
      meta: condensedRes.meta || null,
      prompt: shortText(condensedPrompt, 30000),
      responseExcerpt: shortText(condensedRes.text, 6000),
      response: shortText(condensedRes.text, 100000),
    });
    return ensureDimensionConfidence(parseWithDiagnostics(condensedRes.text, {
      phase: "analyst",
      attempt: "condensed_retry",
      useCaseId: debugContext.useCaseId,
      analysisMode: debugContext.analysisMode,
      prompt: condensedPrompt,
    }, debugSession), dims);
  }
}

async function runHybridPhase1(desc, dims, updateUC, id, analysisMeta, debugSession) {
  const debugContext = { useCaseId: id, analysisMode: analysisMeta.analysisMode };
  updateUC(id, (u) => ({ ...u, phase: "analyst_baseline" }));
  const baseline = await runAnalystPass(
    (condensed) => buildPhase1Prompt(desc, dims, { liveSearch: false, condensed }),
    dims,
    analysisMeta,
    debugContext,
    debugSession,
    { liveSearch: false, maxTokens: 12000 }
  );

  updateUC(id, (u) => ({ ...u, phase: "analyst_web" }));
  const web = await runAnalystPass(
    (condensed) => buildPhase1Prompt(desc, dims, { liveSearch: true, condensed }),
    dims,
    analysisMeta,
    debugContext,
    debugSession,
    { liveSearch: true, maxTokens: 12000 }
  );

  updateUC(id, (u) => ({ ...u, phase: "analyst_reconcile" }));
  const reconciled = await runAnalystPass(
    (condensed) => buildHybridReconcilePrompt(desc, dims, baseline, web, condensed),
    dims,
    analysisMeta,
    debugContext,
    debugSession,
    { liveSearch: false, maxTokens: 12000 }
  );

  analysisMeta.hybridStats = computeHybridDeltaStats(dims, baseline, web, reconciled);
  return reconciled;
}

export async function runAnalysis(desc, dims, updateUC, id, options = {}) {
  const analysisMode = options.analysisMode || (options.liveSearch ? "live_search" : "standard");
  const liveSearch = analysisMode === "live_search";
  const criticLiveSearch = analysisMode !== "standard";
  const downloadDebugLog = !!options.downloadDebugLog;

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
    liveSearch,
  });

  const debate = [];
  const analysisMeta = {
    analysisMode,
    liveSearchRequested: analysisMode !== "standard",
    liveSearchUsed: false,
    webSearchCalls: 0,
    liveSearchFallbackReason: null,
    criticLiveSearchRequested: criticLiveSearch,
    criticLiveSearchUsed: false,
    criticWebSearchCalls: 0,
    criticLiveSearchFallbackReason: null,
    discoveryLiveSearchRequested: analysisMode !== "standard",
    discoveryLiveSearchUsed: false,
    discoveryWebSearchCalls: 0,
    discoveryLiveSearchFallbackReason: null,
    discoverCandidatesCount: 0,
    hybridStats: null,
  };

  let runStatus = "failed";
  let runError = null;
  try {
    // Phase 1: Analyst
    updateUC(id, (u) => ({ ...u, phase: analysisMode === "hybrid" ? "analyst_baseline" : "analyst" }));

    const p1 = analysisMode === "hybrid"
      ? await runHybridPhase1(desc, dims, updateUC, id, analysisMeta, debugSession)
      : await runAnalystPass(
        (condensed) => buildPhase1Prompt(desc, dims, { liveSearch, condensed }),
        dims,
        analysisMeta,
        { useCaseId: id, analysisMode },
        debugSession,
        { liveSearch, maxTokens: 12000 }
      );

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
      SYS_CRITIC,
      6000,
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
        SYS_CRITIC,
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

Critic's overall feedback: ${p2.overallFeedback || ""}

Rubric calibration reminders (higher score is always better):
${buildRubricCalibrationBlock(dims, { wordCap: 11 })}

Per-dimension critiques:
${dims.map((d) => {
  const c = p2.dimensions?.[d.id];
  return `- ${d.label}: ${c?.scoreJustified ? "Score justified" : `Critic suggests ${c?.suggestedScore}/5`} - ${c?.critique || "no specific challenge"}`;
}).join("\n")}

Respond per dimension: defend your score with NEW evidence not previously cited, OR concede and revise with clear reasoning.
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
Do NOT mention the critic or use first-person phrasing.

Return ONLY this JSON:
{
  "analystResponse": "<2-3 sentence overall response to the critique>",
  "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}],
  "dimensions": {
    ${dims.map((d) => `"${d.id}": {
      "finalScore": <your final score 1-5 - may differ from original>,
      "scoreChanged": <true if you revised the score>,
      "confidence": "<high|medium|low>",
      "confidenceReason": "<1 sentence explaining confidence level>",
      "brief": "<2-3 plain-language sentences, max 65 words, explain why this score is deserved and what prevents a higher score>",
      "response": "<3-4 sentences: concede or defend with new specific evidence>",
      "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}]
    }`).join(",\n    ")}
  },
  "conclusion": "<2-3 sentence strategic recommendation: should the outsourcing company pursue this, and how?>"
}`;

    let r3 = await callAnalystAPI([{ role: "user", content: phase3Prompt }], SYS_ANALYST_RESPONSE, 6000);
    appendAnalysisDebugEvent(debugSession, {
      type: "model_response",
      phase: "finalizing",
      attempt: "full",
      responseLength: r3?.length || 0,
      prompt: shortText(phase3Prompt, 30000),
      responseExcerpt: shortText(r3, 6000),
      response: shortText(r3, 100000),
    });

    let p3;
    try {
      p3 = ensureDimensionConfidence(parseWithDiagnostics(r3, {
        phase: "finalizing",
        attempt: "full",
        useCaseId: id,
        analysisMode,
        prompt: phase3Prompt,
      }, debugSession), dims);
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
- Keep each dimension "response" <= 45 words.
- Keep "conclusion" <= 50 words.
`;
      r3 = await callAnalystAPI([{ role: "user", content: phase3RetryPrompt }], SYS_ANALYST_RESPONSE, 4200);
      appendAnalysisDebugEvent(debugSession, {
        type: "model_response",
        phase: "finalizing",
        attempt: "condensed_retry",
        responseLength: r3?.length || 0,
        prompt: shortText(phase3RetryPrompt, 30000),
        responseExcerpt: shortText(r3, 6000),
        response: shortText(r3, 100000),
      });
      p3 = ensureDimensionConfidence(parseWithDiagnostics(r3, {
        phase: "finalizing",
        attempt: "condensed_retry",
        useCaseId: id,
        analysisMode,
        prompt: phase3RetryPrompt,
      }, debugSession), dims);
    }

    let finalResponse = p3;
    try {
      const consistencyPrompt = buildConsistencyCheckPrompt(desc, dims, p1, p2, p3);
      const r4 = await callAnalystAPI([{ role: "user", content: consistencyPrompt }], SYS_ANALYST_RESPONSE, 3000);
      appendAnalysisDebugEvent(debugSession, {
        type: "model_response",
        phase: "finalizing_consistency",
        attempt: "full",
        responseLength: r4?.length || 0,
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
      finalResponse = ensureDimensionConfidence(adjusted, dims);
      appendAnalysisDebugEvent(debugSession, {
        type: "consistency_check_applied",
        phase: "finalizing_consistency",
        attempt: "final",
        changedCount: changed.length,
        changed,
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
    const discoveryLiveSearch = analysisMode !== "standard";
    let discover = {
      candidates: [],
      error: null,
      generatedAt: new Date().toISOString(),
    };
    const weakestFallbackIds = weakestDimensions(dims, finalResponse, 3).map((item) => item.dim.id);
    const discoverPrompt = buildDiscoverPrompt(desc, dims, p1, finalResponse);

    try {
      const discoverRes = await callAnalystAPI(
        [{ role: "user", content: discoverPrompt }],
        SYS_ANALYST,
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
          SYS_ANALYST,
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

      const candidates = normalizeDiscoverCandidates(p5, dims, weakestFallbackIds);
      discover = {
        ...discover,
        candidates,
      };
      analysisMeta.discoverCandidatesCount = candidates.length;
      appendAnalysisDebugEvent(debugSession, {
        type: "phase_complete",
        phase: "discover",
        attempt: "final",
        candidateCount: candidates.length,
      });
    } catch (discoverErr) {
      discover.error = discoverErr.message || String(discoverErr);
      analysisMeta.discoverCandidatesCount = 0;
      appendAnalysisDebugEvent(debugSession, {
        type: "discover_failed",
        phase: "discover",
        attempt: "final",
        error: discover.error,
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
    if (downloadDebugLog) {
      downloadAnalysisDebugSession(debugSession, {
        status: runStatus,
        error: runError,
        analysisMeta,
      });
    }
    storeCompletedAnalysisDebugSession(debugSession, {
      status: runStatus,
      error: runError,
      analysisMeta,
    });
  }
}
