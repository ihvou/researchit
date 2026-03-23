import { callAnalystAPI, callCriticAPI } from "../lib/api";
import { safeParseJSON, buildDimRubrics } from "../lib/json";
import { buildRubricCalibrationBlock } from "../lib/rubric";
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
      `"${d.id}": {"score": <1-5>, "brief": "<max 20 words>", "full": "<1 paragraph, max 80 words, cite 1-2 named companies>", "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}], "risks": "<max 20 words>"}`
    ).join(",\n    ");
  }

  return dims.map((d) =>
    `"${d.id}": {
      "score": <integer 1-5 based on rubric>,
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
      `BASELINE brief: "${clip(b.brief, 180)}"`,
      `BASELINE sources: ${sourceSummary(b.sources)}`,
      `BASELINE full snapshot: "${clip(b.full, 320)}"`,
      `WEB score: ${w.score ?? "n/a"}/5`,
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

Return ONLY this JSON structure, fully populated for ALL 11 dimension IDs (${dims.map((d) => d.id).join(", ")}):
{
  "attributes": ${attrsTemplate},
  "dimensions": {
    ${dimTemplate}
  }
}`;
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

function absorbMeta(analysisMeta, meta) {
  if (!meta) return;
  if (meta.liveSearchUsed) analysisMeta.liveSearchUsed = true;
  analysisMeta.webSearchCalls += Number(meta.webSearchCalls || 0);
  if (!analysisMeta.liveSearchFallbackReason && meta.liveSearchFallbackReason) {
    analysisMeta.liveSearchFallbackReason = meta.liveSearchFallbackReason;
  }
}

async function runAnalystPass(promptBuilder, analysisMeta, debugContext, debugSession, { liveSearch = false, maxTokens = 12000 }) {
  try {
    const fullPrompt = promptBuilder(false);
    const fullRes = await callAnalystAPI(
      [{ role: "user", content: fullPrompt }],
      SYS_ANALYST,
      maxTokens,
      { liveSearch, includeMeta: true }
    );
    absorbMeta(analysisMeta, fullRes.meta);
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
    return parseWithDiagnostics(fullRes.text, {
      phase: "analyst",
      attempt: "full",
      useCaseId: debugContext.useCaseId,
      analysisMode: debugContext.analysisMode,
      prompt: fullPrompt,
    }, debugSession);
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
    absorbMeta(analysisMeta, condensedRes.meta);
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
    return parseWithDiagnostics(condensedRes.text, {
      phase: "analyst",
      attempt: "condensed_retry",
      useCaseId: debugContext.useCaseId,
      analysisMode: debugContext.analysisMode,
      prompt: condensedPrompt,
    }, debugSession);
  }
}

async function runHybridPhase1(desc, dims, updateUC, id, analysisMeta, debugSession) {
  const debugContext = { useCaseId: id, analysisMode: analysisMeta.analysisMode };
  updateUC(id, (u) => ({ ...u, phase: "analyst_baseline" }));
  const baseline = await runAnalystPass(
    (condensed) => buildPhase1Prompt(desc, dims, { liveSearch: false, condensed }),
    analysisMeta,
    debugContext,
    debugSession,
    { liveSearch: false, maxTokens: 12000 }
  );

  updateUC(id, (u) => ({ ...u, phase: "analyst_web" }));
  const web = await runAnalystPass(
    (condensed) => buildPhase1Prompt(desc, dims, { liveSearch: true, condensed }),
    analysisMeta,
    debugContext,
    debugSession,
    { liveSearch: true, maxTokens: 12000 }
  );

  updateUC(id, (u) => ({ ...u, phase: "analyst_reconcile" }));
  const reconciled = await runAnalystPass(
    (condensed) => buildHybridReconcilePrompt(desc, dims, baseline, web, condensed),
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
    const phase2Prompt = `Review this analyst assessment of the AI use case: "${p1.attributes?.title || desc}"

Analyst scores (outsourcing delivery context):
${dims.map((d) => `- ${d.label} [${d.id}]: ${p1.dimensions?.[d.id]?.score}/5 - ${p1.dimensions?.[d.id]?.brief || ""}`).join("\n")}

Rubric calibration reminders (higher score is always better):
${buildRubricCalibrationBlock(dims, { wordCap: 11 })}

Important:
- If your critique is mainly about higher risk, disruption, complexity, weak evidence, or stronger SaaS pressure, your suggested score should usually stay flat or move lower.
- Do not invert rubric direction.

Return ONLY this JSON:
{
  "overallFeedback": "<2-3 sentence overall critique - what is the analyst getting right and wrong?>",
  "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}],
  "dimensions": {
    ${dims.map((d) => `"${d.id}": {
      "scoreJustified": <true if score is defensible, false if over/under-stated>,
      "suggestedScore": <your suggested score 1-5>,
      "critique": "<2-3 sentences: specific challenge with named incumbent vendors, SaaS products, or counter-evidence>",
      "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}]
    }`).join(",\n    ")}
  }
}`;

    let r2 = await callCriticAPI([{ role: "user", content: phase2Prompt }], SYS_CRITIC, 5000);
    appendAnalysisDebugEvent(debugSession, {
      type: "model_response",
      phase: "critic",
      attempt: "full",
      responseLength: r2?.length || 0,
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
      r2 = await callCriticAPI([{ role: "user", content: phase2RetryPrompt }], SYS_CRITIC, 3800);
      appendAnalysisDebugEvent(debugSession, {
        type: "model_response",
        phase: "critic",
        attempt: "condensed_retry",
        responseLength: r2?.length || 0,
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
    updateUC(id, (u) => ({ ...u, critique: p2, phase: "finalizing", debate: [...debate] }));

    // Phase 3: Analyst responds
    const phase3Prompt = `You are the analyst who assessed "${p1.attributes?.title || desc}".

Your original scores:
${dims.map((d) => `- ${d.label}: ${p1.dimensions?.[d.id]?.score}/5`).join("\n")}

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
Do NOT mention the critic or use first-person phrasing.

Return ONLY this JSON:
{
  "analystResponse": "<2-3 sentence overall response to the critique>",
  "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}],
  "dimensions": {
    ${dims.map((d) => `"${d.id}": {
      "finalScore": <your final score 1-5 - may differ from original>,
      "scoreChanged": <true if you revised the score>,
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
      p3 = parseWithDiagnostics(r3, {
        phase: "finalizing",
        attempt: "full",
        useCaseId: id,
        analysisMode,
        prompt: phase3Prompt,
      }, debugSession);
    } catch (err) {
      console.warn("Analyst response parse failed, retrying with strict condensed prompt:", err.message);
      const phase3RetryPrompt = `${phase3Prompt}

STRICT JSON RULES:
- Return exactly one valid JSON object. No markdown, no prose before/after.
- Use double quotes for every key and string value.
- Escape any internal quote as \\".
- No trailing commas.
- Keep "analystResponse" <= 45 words.
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
      p3 = parseWithDiagnostics(r3, {
        phase: "finalizing",
        attempt: "condensed_retry",
        useCaseId: id,
        analysisMode,
        prompt: phase3RetryPrompt,
      }, debugSession);
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
      finalResponse = adjusted;
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
    updateUC(id, (u) => ({ ...u, finalScores: finalResponse, status: "complete", phase: "complete", debate: [...debate] }));
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
