import { safeParseJSON } from "../lib/json.js";
import { SYS_FOLLOWUP } from "../prompts/defaults.js";
import { getEffectiveScore } from "../lib/scoring.js";
import { buildDimRubricReminder } from "../lib/rubric.js";
import { normalizeConfidenceLevel } from "../lib/confidence.js";
import { getDimensionView } from "../lib/dimensionView.js";
import {
  FOLLOW_UP_INTENTS,
  normalizeFollowUpIntent,
  fallbackIntentFromText,
  extractUrls,
  intentAllowsScoreProposal,
  intentNeedsAnalystResponse,
} from "../lib/followUpIntent.js";

const SYS_FOLLOWUP_INTENT = `You classify PM follow-up messages inside an AI analysis tool.

Classify into exactly one intent:
- challenge
- question
- reframe
- add_evidence
- note
- re_search

Rules:
- challenge: user disputes score/reasoning/cites counter-argument
- question: user asks for explanation/clarification, not contest
- reframe: user asks to rewrite wording/tone/audience/readability only
- add_evidence: user supplies URL(s) or pasted external evidence
- note: user leaves annotation for human reviewer; no model reply needed
- re_search: user asks for a fresh live web search or latest source check

Return ONLY JSON:
{
  "intent": "<one of the six intents>",
  "rationale": "<1 sentence>",
  "urls": ["...optional extracted URLs..."]
}`;

const FOLLOW_UP_SOURCE_QUALITY_RULES = `SOURCE QUALITY RULES:
- UNACCEPTABLE sources: vendor product/pricing pages, storefront homepages, app marketplace listings, SEO landing pages, generic marketing brochures.
- ACCEPTABLE sources: independent analyst reports, named case studies with metrics, earnings calls, press coverage with named outcomes, regulatory filings, peer-reviewed research, named customer outcomes.
- If no acceptable source is available, say that explicitly and keep sources empty. Do not substitute a marketing page.`;

const DEFAULT_LIMITS = {
  question: 1400,
  challenge: 2100,
  intentClassification: 450,
  reframe: 1600,
  addEvidence: 2200,
  reSearch: 2400,
};

function makeId(prefix = "fu") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSourceType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "vendor" || raw === "press" || raw === "independent") return raw;
  if (raw.includes("vendor") || raw.includes("marketing") || raw.includes("product")) return "vendor";
  if (raw.includes("press") || raw.includes("news") || raw.includes("earnings") || raw.includes("filing")) return "press";
  if (raw.includes("independent") || raw.includes("peer") || raw.includes("benchmark") || raw.includes("analyst")) return "independent";
  return "";
}

function normalizeSources(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((s) => s && (s.name || s.url || s.quote))
    .map((s) => ({
      name: String(s.name || "").trim(),
      quote: String(s.quote || "").trim().slice(0, 180),
      url: String(s.url || "").trim(),
      sourceType: normalizeSourceType(s.sourceType),
    }))
    .slice(0, 14);
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > 5) return null;
  return n;
}

function normalizeTargetArgument(input) {
  if (!input || typeof input !== "object") return null;
  const id = String(input.id || "").trim();
  if (!id) return null;
  const rawGroup = String(input.group || "").trim().toLowerCase();
  return {
    id,
    group: rawGroup === "limiting" ? "limiting" : "supporting",
    claim: String(input.claim || "").trim(),
    detail: String(input.detail || "").trim(),
  };
}

function normalizeArgumentUpdate(raw, fallbackTarget) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || fallbackTarget?.id || "").trim();
  if (!id) return null;
  const rawAction = String(raw.action || "").trim().toLowerCase();
  const action = rawAction === "discard" || rawAction === "modify" || rawAction === "keep" || rawAction === "none"
    ? rawAction
    : "";
  if (!action) return null;
  const rawGroup = String(raw.group || fallbackTarget?.group || "").trim().toLowerCase();
  const group = rawGroup === "limiting" ? "limiting" : "supporting";
  const reason = String(raw.reason || "").trim();

  if (action === "keep" || action === "none") {
    return { id, group, action, reason };
  }

  return {
    id,
    group,
    action,
    reason,
    updatedClaim: String(raw.updatedClaim || "").trim(),
    updatedDetail: String(raw.updatedDetail || "").trim(),
    sources: normalizeSources(raw.sources),
  };
}

function appendThreadMessage(updateUC, dimId, message) {
  updateUC((u) => ({
    ...u,
    followUps: {
      ...u.followUps,
      [dimId]: [...(u.followUps?.[dimId] || []), message],
    },
  }), "follow_up_thread");
}

function patchThreadMessage(updateUC, dimId, messageId, patch) {
  updateUC((u) => ({
    ...u,
    followUps: {
      ...u.followUps,
      [dimId]: (u.followUps?.[dimId] || []).map((msg) => (
        msg?.id === messageId ? { ...msg, ...patch } : msg
      )),
    },
  }), "follow_up_thread");
}

function matrixThreadKey(subjectId, attributeId) {
  return `matrix::${subjectId}::${attributeId}`;
}

function mergeUniqueSources(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    normalizeSources(list).forEach((source) => {
      const key = `${source.name}|${source.quote}|${source.url}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(source);
    });
  }
  return out.slice(0, 16);
}

async function classifyIntent({
  uc,
  dim,
  challenge,
  existingThread,
  callAnalyst,
  maxTokens,
  contextLabel = "",
}) {
  const fallback = fallbackIntentFromText(challenge);
  const prior = existingThread
    .slice(-4)
    .map((m) => `${m.role === "pm" ? "PM" : "Analyst"}: ${m.text || m.response || ""}`)
    .join("\n");

  const prompt = `Use case: "${uc.attributes?.title || uc.rawInput}"
Target: "${contextLabel || dim?.label || "Unknown"}"
Message: "${challenge}"
${prior ? `Recent thread context:\n${prior}\n` : ""}

Classify intent.`;

  try {
    const raw = await callAnalyst([{ role: "user", content: prompt }], SYS_FOLLOWUP_INTENT, maxTokens);
    const parsed = safeParseJSON(raw);
    const intent = normalizeFollowUpIntent(parsed?.intent) || fallback;
    const urls = [
      ...extractUrls(challenge),
      ...(Array.isArray(parsed?.urls) ? parsed.urls.flatMap((u) => extractUrls(String(u || ""))) : []),
    ].filter((url, idx, arr) => arr.indexOf(url) === idx);
    return {
      intent,
      rationale: String(parsed?.rationale || "").trim(),
      urls,
    };
  } catch (_) {
    return {
      intent: fallback,
      rationale: "Fallback heuristic classification used.",
      urls: extractUrls(challenge),
    };
  }
}

async function buildEvidenceContext(challenge, urls, fetchSource) {
  const normalizedUrls = urls.slice(0, 3);
  const fetched = [];

  for (const url of normalizedUrls) {
    try {
      const snap = await fetchSource(url);
      fetched.push({
        url: snap.url || url,
        title: snap.title || "",
        text: String(snap.text || "").slice(0, 5000),
      });
    } catch (err) {
      fetched.push({
        url,
        title: "",
        text: `Fetch failed: ${err.message}`,
      });
    }
  }

  const pasted = challenge.replace(/https?:\/\/[^\s<>"')]+/gi, " ").trim();
  const pastedEvidence = pasted.length > 80 ? pasted.slice(0, 2000) : "";

  const blocks = fetched.map((s, idx) => (
    `Source ${idx + 1}: ${s.title || "Untitled source"}\nURL: ${s.url}\nContent snapshot:\n${s.text}`
  ));
  if (pastedEvidence) {
    blocks.push(`PM pasted evidence text:\n${pastedEvidence}`);
  }

  return {
    contextText: blocks.join("\n\n"),
    fetchedSources: fetched
      .filter((s) => s.url)
      .map((s, idx) => ({
        name: s.title || `Provided source ${idx + 1}`,
        quote: "User-provided evidence snapshot",
        url: s.url,
      })),
  };
}

function extractProposedScore(parsed, effectiveScore, allowProposal) {
  if (!allowProposal || !parsed || typeof parsed !== "object") return null;
  const fromNew = clampScore(parsed.proposedScore);
  const fromLegacy = parsed.scoreAdjusted ? clampScore(parsed.newScore) : null;
  const proposed = fromNew ?? fromLegacy;
  if (proposed == null) return null;
  if (Number(proposed) === Number(effectiveScore)) return null;
  return proposed;
}

function normalizeConfidence(parsed, uc, dimId) {
  const currentConfidence = normalizeConfidenceLevel(
    uc.followUps?.[dimId]?.slice(-1)?.[0]?.confidence
    || uc.finalScores?.dimensions?.[dimId]?.confidence
    || uc.dimScores?.[dimId]?.confidence
  );

  const normalizedConfidence = normalizeConfidenceLevel(parsed?.confidence) || currentConfidence || "medium";
  const normalizedReason = typeof parsed?.confidenceReason === "string" && parsed.confidenceReason.trim()
    ? parsed.confidenceReason.trim()
    : normalizedConfidence === "high"
      ? "Strong named evidence remains available after this follow-up."
      : normalizedConfidence === "medium"
        ? "Evidence exists but still has partial verification gaps."
        : "Confidence remains limited because verification is still sparse.";

  return { normalizedConfidence, normalizedReason };
}

function wantsLiveSearch(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.searchNeeded === true) return true;
  const raw = String(parsed.searchNeeded || "").trim().toLowerCase();
  return raw === "true" || raw === "yes" || raw === "1";
}

function searchReasonText(parsed, fallback = "") {
  const reason = String(parsed?.searchReason || "").trim();
  return reason || fallback || "Fresh external verification is needed for this follow-up.";
}

function renderPromptHeader({ uc, dim, effectiveScore, threadHistory }) {
  return `Use case: "${uc.attributes?.title || uc.rawInput}"
Dimension: "${dim?.label || "Unknown"}"
Current effective score: ${effectiveScore}/5
Current brief: ${uc.dimScores?.[dim?.id]?.brief || ""}
Current full analysis: ${uc.dimScores?.[dim?.id]?.full || ""}
${threadHistory ? `Previous thread:\n${threadHistory}\n` : ""}`;
}

async function runIntentResponse({
  intent,
  uc,
  dim,
  challenge,
  effectiveScore,
  threadHistory,
  targetArgument,
  callAnalyst,
  fetchSource,
  followUpPrompt,
  limits,
}) {
  const baseHeader = renderPromptHeader({ uc, dim, effectiveScore, threadHistory });

  if (intent === FOLLOW_UP_INTENTS.NOTE) {
    return { skipAnalyst: true };
  }

  if (intent === FOLLOW_UP_INTENTS.QUESTION) {
    const prompt = `${baseHeader}
PM question: "${challenge}"

Answer as a plain-language explanation. No score revision proposal.
${FOLLOW_UP_SOURCE_QUALITY_RULES}

Return ONLY JSON:
{
  "response": "<clear explanation, 3-5 sentences, non-defensive>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
  "searchNeeded": <true|false>,
  "searchReason": "<1 sentence: why existing context is enough OR what specific gap needs web search>"
}`;
    const raw = await callAnalyst([{ role: "user", content: prompt }], followUpPrompt, limits.question);
    const parsed = safeParseJSON(raw);

    if (!wantsLiveSearch(parsed)) {
      return { parsed, meta: null };
    }

    const reason = searchReasonText(parsed, `Need fresh evidence for PM question on ${dim?.label || "this dimension"}.`);
    const searchPrompt = `${baseHeader}
PM question: "${challenge}"

You identified this evidence gap: "${reason}"
Run focused live web research and answer using current, high-quality evidence.
${FOLLOW_UP_SOURCE_QUALITY_RULES}

Return ONLY JSON:
{
  "response": "<clear explanation, 3-5 sentences, non-defensive>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
  "searchNeeded": false,
  "searchReason": "<short note on what was searched>"
}`;

    const data = await callAnalyst(
      [{ role: "user", content: searchPrompt }],
      followUpPrompt,
      Math.max(limits.question, 1700),
      { liveSearch: true, includeMeta: true }
    );
    return { parsed: safeParseJSON(data.text), meta: data.meta || null };
  }

  if (intent === FOLLOW_UP_INTENTS.REFRAME) {
    const prompt = `${baseHeader}
PM reframe request: "${challenge}"

Rewrite the explanation to match this request without changing underlying logic or score.
Return ONLY JSON:
{
  "brief": "<2-3 sentence rewritten brief, plain language>",
  "response": "<rewritten detailed explanation, 3-6 sentences>",
  "sources": []
}`;
    const raw = await callAnalyst([{ role: "user", content: prompt }], followUpPrompt, limits.reframe);
    return { parsed: safeParseJSON(raw), meta: null };
  }

  if (intent === FOLLOW_UP_INTENTS.ADD_EVIDENCE) {
    const urls = extractUrls(challenge);
    const evidence = await buildEvidenceContext(challenge, urls, fetchSource);
    const prompt = `${baseHeader}
PM evidence submission: "${challenge}"

New evidence content (fetched server-side and/or pasted):
${evidence.contextText || "No external source content was retrievable."}

Assess what changes and what does not. Propose a score revision only if evidence justifies it.
${FOLLOW_UP_SOURCE_QUALITY_RULES}
Rubric reminder:
${buildDimRubricReminder(dim, { wordCap: 16 })}

Return ONLY JSON:
{
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "brief": "<2-3 sentences for non-domain reader>",
  "response": "<3-6 sentences explaining impact of this evidence>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
  "proposedScore": <null or integer 1-5>,
  "proposalReason": "<1-2 sentences>"
}`;
    const raw = await callAnalyst([{ role: "user", content: prompt }], followUpPrompt, limits.addEvidence);
    const parsed = safeParseJSON(raw);
    if (!parsed?.sources?.length && evidence.fetchedSources.length) {
      parsed.sources = evidence.fetchedSources;
    }
    return { parsed, meta: null };
  }

  if (intent === FOLLOW_UP_INTENTS.RE_SEARCH) {
    const dimView = getDimensionView(uc, dim?.id, { dimLabel: dim?.label || "", dim });
    const gapHint = dimView?.researchBrief?.missingEvidence
      || uc.finalScores?.dimensions?.[dim?.id]?.confidenceReason
      || uc.dimScores?.[dim?.id]?.confidenceReason
      || uc.dimScores?.[dim?.id]?.risks
      || "Evidence for this dimension appears incomplete.";
    const queryHints = Array.isArray(dimView?.researchBrief?.suggestedQueries)
      ? dimView.researchBrief.suggestedQueries.slice(0, 4)
      : [];
    const queryHintBlock = queryHints.length
      ? `Suggested targeted queries:\n${queryHints.map((q, idx) => `${idx + 1}. ${q}`).join("\n")}\n\n`
      : "";

    const prompt = `${baseHeader}
PM requested targeted re-search: "${challenge}"

Evidence gap hint:
${gapHint}
${queryHintBlock}

Run a focused live web search for this dimension's weakest evidence points.
Use fresh external sources, then re-evaluate this dimension only.
${FOLLOW_UP_SOURCE_QUALITY_RULES}
Rubric reminder:
${buildDimRubricReminder(dim, { wordCap: 16 })}

Return ONLY JSON:
{
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "brief": "<2-3 sentence summary>",
  "response": "<3-6 sentences with fresh findings>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
  "proposedScore": <null or integer 1-5>,
  "proposalReason": "<1-2 sentences>"
}`;

    const data = await callAnalyst(
      [{ role: "user", content: prompt }],
      followUpPrompt,
      limits.reSearch,
      { liveSearch: true, includeMeta: true }
    );
    return { parsed: safeParseJSON(data.text), meta: data.meta || null };
  }

  const targetArgumentBlock = targetArgument
    ? `Target argument under review:
{
  "id": "${targetArgument.id}",
  "group": "${targetArgument.group}",
  "claim": "${targetArgument.claim}",
  "detail": "${targetArgument.detail}"
}

You are responding to a challenge focused on this argument.
- Keep: argument remains valid.
- Modify: rewrite claim/detail/sources for this argument.
- Discard: argument is no longer valid.
`
    : "";

  const prompt = `${baseHeader}
PM challenge: "${challenge}"
${targetArgumentBlock}

Respond directly. If valid, concede with an updated argument and proposed score.
If not valid, defend with new evidence.
${FOLLOW_UP_SOURCE_QUALITY_RULES}
Rubric reminder:
${buildDimRubricReminder(dim, { wordCap: 16 })}

Also include a neutral plain-language brief:
- 2-3 short sentences.
- Explain why this score is justified and what still prevents a higher score.
- Avoid template phrases and avoid first-person wording.

Return ONLY JSON:
{
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "brief": "<2-3 plain-language sentences>",
  "response": "<3-5 direct analytical sentences>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
  "argumentUpdate": {
    "id": "<argument id or empty>",
    "group": "<supporting|limiting>",
    "action": "<keep|discard|modify|none>",
    "updatedClaim": "<required if modify>",
    "updatedDetail": "<required if modify>",
    "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
    "reason": "<1 sentence why keep/modify/discard>"
  },
  "proposedScore": <null or integer 1-5>,
  "proposalReason": "<1-2 sentences>",
  "searchNeeded": <true|false>,
  "searchReason": "<1 sentence: why existing context is enough OR what specific gap needs web search>"
}`;
  const raw = await callAnalyst([{ role: "user", content: prompt }], followUpPrompt, limits.challenge);
  const parsed = safeParseJSON(raw);

  if (!wantsLiveSearch(parsed)) {
    return { parsed, meta: null };
  }

  const reason = searchReasonText(parsed, `Need fresh evidence for PM challenge on ${dim?.label || "this dimension"}.`);
  const searchPrompt = `${baseHeader}
PM challenge: "${challenge}"
${targetArgumentBlock}

Initial non-web draft highlighted this evidence gap: "${reason}"
Now run focused live web research to validate/adjust the answer.
${FOLLOW_UP_SOURCE_QUALITY_RULES}
Rubric reminder:
${buildDimRubricReminder(dim, { wordCap: 16 })}

Return ONLY JSON:
{
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "brief": "<2-3 plain-language sentences>",
  "response": "<3-5 direct analytical sentences>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
  "argumentUpdate": {
    "id": "<argument id or empty>",
    "group": "<supporting|limiting>",
    "action": "<keep|discard|modify|none>",
    "updatedClaim": "<required if modify>",
    "updatedDetail": "<required if modify>",
    "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
    "reason": "<1 sentence why keep/modify/discard>"
  },
  "proposedScore": <null or integer 1-5>,
  "proposalReason": "<1-2 sentences>",
  "searchNeeded": false,
  "searchReason": "<short note on what was searched>"
}`;
  const data = await callAnalyst(
    [{ role: "user", content: searchPrompt }],
    followUpPrompt,
    Math.max(limits.challenge, 2400),
    { liveSearch: true, includeMeta: true }
  );
  return { parsed: safeParseJSON(data.text), meta: data.meta || null };
}

function renderMatrixPromptHeader({ uc, subject, attribute, cell, threadHistory }) {
  return `Use case: "${uc.attributes?.title || uc.rawInput}"
Matrix cell: "${subject?.label || "Unknown subject"}" x "${attribute?.label || "Unknown attribute"}"
Current confidence: ${normalizeConfidenceLevel(cell?.confidence) || "low"}
Current value: ${cell?.value || ""}
Current confidence reason: ${cell?.confidenceReason || ""}
${threadHistory ? `Previous thread:\n${threadHistory}\n` : ""}`;
}

async function runMatrixIntentResponse({
  intent,
  uc,
  subject,
  attribute,
  cell,
  challenge,
  threadHistory,
  callAnalyst,
  fetchSource,
  followUpPrompt,
  limits,
}) {
  const baseHeader = renderMatrixPromptHeader({ uc, subject, attribute, cell, threadHistory });

  if (intent === FOLLOW_UP_INTENTS.NOTE) {
    return { skipAnalyst: true };
  }

  if (intent === FOLLOW_UP_INTENTS.QUESTION) {
    const prompt = `${baseHeader}
PM question: "${challenge}"

Answer as a plain-language explanation. Do not change the matrix cell directly in this response.
${FOLLOW_UP_SOURCE_QUALITY_RULES}

Return ONLY JSON:
{
  "response": "<clear explanation, 3-5 sentences, non-defensive>",
  "brief": "<1-2 sentence concise answer>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
  "searchNeeded": <true|false>,
  "searchReason": "<1 sentence>"
}`;
    const raw = await callAnalyst([{ role: "user", content: prompt }], followUpPrompt, limits.question);
    const parsed = safeParseJSON(raw);

    if (!wantsLiveSearch(parsed)) {
      return { parsed, meta: null };
    }

    const reason = searchReasonText(parsed, "Need fresh external evidence for this matrix-cell question.");
    const searchPrompt = `${baseHeader}
PM question: "${challenge}"

Evidence gap: "${reason}"
Run focused live web research and answer with current evidence.
${FOLLOW_UP_SOURCE_QUALITY_RULES}

Return ONLY JSON:
{
  "response": "<clear explanation, 3-5 sentences, non-defensive>",
  "brief": "<1-2 sentence concise answer>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
  "searchNeeded": false,
  "searchReason": "<short note on what was searched>"
}`;
    const data = await callAnalyst(
      [{ role: "user", content: searchPrompt }],
      followUpPrompt,
      Math.max(limits.question, 1800),
      { liveSearch: true, includeMeta: true }
    );
    return { parsed: safeParseJSON(data.text), meta: data.meta || null };
  }

  if (intent === FOLLOW_UP_INTENTS.REFRAME) {
    const prompt = `${baseHeader}
PM reframe request: "${challenge}"

Rewrite explanation style only. Do not change the underlying assessment.

Return ONLY JSON:
{
  "brief": "<2-3 sentence rewritten brief>",
  "response": "<rewritten detailed explanation, 3-6 sentences>",
  "sources": []
}`;
    const raw = await callAnalyst([{ role: "user", content: prompt }], followUpPrompt, limits.reframe);
    return { parsed: safeParseJSON(raw), meta: null };
  }

  if (intent === FOLLOW_UP_INTENTS.ADD_EVIDENCE) {
    const urls = extractUrls(challenge);
    const evidence = await buildEvidenceContext(challenge, urls, fetchSource);
    const prompt = `${baseHeader}
PM evidence submission: "${challenge}"

New evidence content:
${evidence.contextText || "No external source content was retrievable."}

Assess what changes and what does not for this matrix cell.
${FOLLOW_UP_SOURCE_QUALITY_RULES}

Return ONLY JSON:
{
  "value": "<updated cell value or keep current wording>",
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "brief": "<1-2 sentence concise update>",
  "response": "<3-6 sentences explaining impact of this evidence>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}]
}`;
    const raw = await callAnalyst([{ role: "user", content: prompt }], followUpPrompt, limits.addEvidence);
    const parsed = safeParseJSON(raw);
    if (!parsed?.sources?.length && evidence.fetchedSources.length) {
      parsed.sources = evidence.fetchedSources;
    }
    return { parsed, meta: null };
  }

  if (intent === FOLLOW_UP_INTENTS.RE_SEARCH) {
    const prompt = `${baseHeader}
PM requested targeted re-search: "${challenge}"

Run focused live web research for this matrix cell and update only this cell if evidence justifies it.
${FOLLOW_UP_SOURCE_QUALITY_RULES}

Return ONLY JSON:
{
  "value": "<updated cell value>",
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "brief": "<1-2 sentence concise update>",
  "response": "<3-6 sentences with fresh findings>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}]
}`;

    const data = await callAnalyst(
      [{ role: "user", content: prompt }],
      followUpPrompt,
      limits.reSearch,
      { liveSearch: true, includeMeta: true }
    );
    return { parsed: safeParseJSON(data.text), meta: data.meta || null };
  }

  const prompt = `${baseHeader}
PM challenge: "${challenge}"

Respond directly to the challenge for this one matrix cell.
- If valid, concede and update value/confidence.
- If not valid, defend with stronger evidence.
${FOLLOW_UP_SOURCE_QUALITY_RULES}

Return ONLY JSON:
{
  "decision": "<defend|concede>",
  "value": "<updated or defended cell value>",
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "brief": "<1-2 sentence concise update>",
  "response": "<3-6 sentence analytical response>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
  "searchNeeded": <true|false>,
  "searchReason": "<1 sentence>"
}`;
  const raw = await callAnalyst([{ role: "user", content: prompt }], followUpPrompt, limits.challenge);
  const parsed = safeParseJSON(raw);

  if (!wantsLiveSearch(parsed)) {
    return { parsed, meta: null };
  }

  const reason = searchReasonText(parsed, "Need fresh evidence for this matrix-cell challenge.");
  const searchPrompt = `${baseHeader}
PM challenge: "${challenge}"

Initial draft highlighted this evidence gap: "${reason}"
Run focused live web research and update this matrix cell.
${FOLLOW_UP_SOURCE_QUALITY_RULES}

Return ONLY JSON:
{
  "decision": "<defend|concede>",
  "value": "<updated or defended cell value>",
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "brief": "<1-2 sentence concise update>",
  "response": "<3-6 sentence analytical response>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"...","sourceType":"<vendor|press|independent>"}],
  "searchNeeded": false,
  "searchReason": "<short note on what was searched>"
}`;
  const data = await callAnalyst(
    [{ role: "user", content: searchPrompt }],
    followUpPrompt,
    Math.max(limits.challenge, 2400),
    { liveSearch: true, includeMeta: true }
  );
  return { parsed: safeParseJSON(data.text), meta: data.meta || null };
}

function copyState(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function handleFollowUp(input, config, callbacks) {
  const ucId = input?.ucId;
  const dimId = input?.dimId;
  const subjectId = String(input?.subjectId || input?.options?.subjectId || "").trim();
  const attributeId = String(input?.attributeId || input?.options?.attributeId || "").trim();
  const challenge = String(input?.challenge || "");
  const options = input?.options || {};

  if (!ucId) {
    throw new Error("handleFollowUp requires ucId.");
  }
  if (!challenge.trim()) {
    throw new Error("Follow-up challenge cannot be empty.");
  }

  const transport = callbacks?.transport;
  if (!transport?.callAnalyst || !transport?.fetchSource) {
    throw new Error("handleFollowUp requires callbacks.transport with callAnalyst and fetchSource.");
  }
  const analystModelCfg = config?.models?.analyst || {};
  const callAnalyst = (messages, systemPrompt, maxTokens = 5000, options = {}) => {
    const merged = { ...(options || {}) };
    if (!merged.provider && typeof analystModelCfg.provider === "string" && analystModelCfg.provider.trim()) {
      merged.provider = analystModelCfg.provider.trim();
    }
    if (!merged.model && typeof analystModelCfg.model === "string" && analystModelCfg.model.trim()) {
      merged.model = analystModelCfg.model.trim();
    }
    if (!merged.webSearchModel && typeof analystModelCfg.webSearchModel === "string" && analystModelCfg.webSearchModel.trim()) {
      merged.webSearchModel = analystModelCfg.webSearchModel.trim();
    }
    if (!merged.baseUrl && typeof analystModelCfg.baseUrl === "string" && analystModelCfg.baseUrl.trim()) {
      merged.baseUrl = analystModelCfg.baseUrl.trim();
    }
    return transport.callAnalyst(messages, systemPrompt, maxTokens, merged);
  };

  const prompts = {
    followUp: config?.prompts?.followUp || SYS_FOLLOWUP,
  };
  const tokenLimits = {
    ...DEFAULT_LIMITS,
    ...(config?.limits?.tokenLimits || {}),
  };

  let uc = copyState(input?.ucState);
  if (!uc || uc.id !== ucId) {
    throw new Error("handleFollowUp requires ucState for the target use case.");
  }

  const onProgress = typeof callbacks?.onProgress === "function"
    ? callbacks.onProgress
    : () => {};

  const updateUC = (fn, phase = "follow_up") => {
    uc = fn(uc);
    onProgress(phase, copyState(uc));
    return uc;
  };

  const isMatrixMode = String(uc?.outputMode || (uc?.matrix ? "matrix" : "scorecard")).trim().toLowerCase() === "matrix";
  if (isMatrixMode || (subjectId && attributeId)) {
    const matrix = uc?.matrix || {};
    const targetSubjectId = subjectId || String(options?.subjectId || "").trim();
    const targetAttributeId = attributeId || String(options?.attributeId || "").trim();
    if (!targetSubjectId || !targetAttributeId) {
      throw new Error("Matrix follow-up requires subjectId and attributeId.");
    }

    const subjects = Array.isArray(matrix?.subjects) ? matrix.subjects : [];
    const attributes = Array.isArray(matrix?.attributes) ? matrix.attributes : [];
    const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
    const subject = subjects.find((entry) => entry.id === targetSubjectId);
    const attribute = attributes.find((entry) => entry.id === targetAttributeId);
    if (!subject || !attribute) {
      throw new Error(`Matrix target not found for ${targetSubjectId} x ${targetAttributeId}.`);
    }
    const cell = cells.find((entry) => (
      entry?.subjectId === targetSubjectId && entry?.attributeId === targetAttributeId
    ));
    if (!cell) {
      throw new Error(`Matrix cell not found for ${targetSubjectId} x ${targetAttributeId}.`);
    }

    const threadKey = matrixThreadKey(targetSubjectId, targetAttributeId);
    const forcedIntent = normalizeFollowUpIntent(options?.forceIntent);
    const existingThread = uc.followUps?.[threadKey] || [];
    const threadHistory = existingThread
      .map((m) => `${m.role === "pm" ? "PM" : "Analyst"}: ${m.text || m.response || ""}`)
      .join("\n\n");

    const pmId = makeId("fu-pm");
    appendThreadMessage(updateUC, threadKey, {
      id: pmId,
      role: "pm",
      text: challenge,
      intent: forcedIntent || "pending",
      matrixTarget: {
        subjectId: targetSubjectId,
        attributeId: targetAttributeId,
      },
      timestamp: new Date().toISOString(),
    });

    const classification = forcedIntent
      ? {
          intent: forcedIntent,
          rationale: "Intent forced by UI action.",
          urls: extractUrls(challenge),
        }
      : await classifyIntent({
          uc,
          dim: null,
          challenge,
          existingThread,
          callAnalyst,
          maxTokens: tokenLimits.intentClassification,
          contextLabel: `${subject.label} x ${attribute.label}`,
        });

    const intent = classification.intent;
    patchThreadMessage(updateUC, threadKey, pmId, {
      intent,
      intentRationale: classification.rationale,
    });

    if (!intentNeedsAnalystResponse(intent)) {
      return uc;
    }

    const matrixResponse = await runMatrixIntentResponse({
      intent,
      uc,
      subject,
      attribute,
      cell,
      challenge,
      threadHistory,
      callAnalyst,
      fetchSource: transport.fetchSource,
      followUpPrompt: prompts.followUp,
      limits: tokenLimits,
    });

    if (matrixResponse?.skipAnalyst) {
      return uc;
    }

    const parsed = matrixResponse?.parsed || {};
    const meta = matrixResponse?.meta || null;
    const decision = String(parsed?.decision || "").trim().toLowerCase();
    const nextValue = String(parsed?.value || "").trim();
    const nextConfidence = normalizeConfidenceLevel(parsed?.confidence)
      || normalizeConfidenceLevel(cell?.confidence)
      || "medium";
    const nextConfidenceReason = String(parsed?.confidenceReason || "").trim()
      || String(cell?.confidenceReason || "").trim()
      || "Confidence remains constrained by available evidence.";
    const mergedSources = mergeUniqueSources(cell?.sources, parsed?.sources);
    const shouldApplyCellUpdate = [
      FOLLOW_UP_INTENTS.CHALLENGE,
      FOLLOW_UP_INTENTS.ADD_EVIDENCE,
      FOLLOW_UP_INTENTS.RE_SEARCH,
    ].includes(intent);

    if (shouldApplyCellUpdate) {
      updateUC((u) => ({
        ...u,
        matrix: {
          ...(u.matrix || {}),
          cells: (u.matrix?.cells || []).map((entry) => {
            if (entry?.subjectId !== targetSubjectId || entry?.attributeId !== targetAttributeId) return entry;
            return {
              ...entry,
              value: nextValue || entry.value,
              confidence: nextConfidence,
              confidenceReason: nextConfidenceReason,
              sources: mergedSources.length ? mergedSources : normalizeSources(entry.sources),
              contested: false,
              criticNote: String(entry.criticNote || ""),
              analystDecision: decision === "concede" ? "concede" : "defend",
              analystNote: String(parsed?.response || parsed?.brief || "").trim(),
            };
          }),
        },
      }), "follow_up_matrix_cell");
    }

    appendThreadMessage(updateUC, threadKey, {
      id: makeId("fu-analyst"),
      role: "analyst",
      intent,
      matrixTarget: {
        subjectId: targetSubjectId,
        attributeId: targetAttributeId,
      },
      decision: decision === "concede" ? "concede" : "defend",
      response: String(parsed?.response || "").trim() || "No response generated.",
      brief: String(parsed?.brief || "").trim(),
      sources: normalizeSources(parsed?.sources),
      confidence: nextConfidence,
      confidenceReason: nextConfidenceReason,
      cellValue: nextValue || cell.value || "",
      cellUpdateApplied: shouldApplyCellUpdate,
      searchMeta: meta || null,
      timestamp: new Date().toISOString(),
    });

    return uc;
  }

  const dims = config?.dimensions || [];
  const dim = dims.find((d) => d.id === dimId);
  if (!dim) throw new Error(`Dimension not found: ${dimId}`);

  const forcedIntent = normalizeFollowUpIntent(options?.forceIntent);
  const targetArgument = normalizeTargetArgument(options?.targetArgument);
  const effectiveScore = getEffectiveScore(uc, dimId);
  const existingThread = uc.followUps?.[dimId] || [];
  const threadHistory = existingThread
    .map((m) => `${m.role === "pm" ? "PM" : "Analyst"}: ${m.text || m.response || ""}`)
    .join("\n\n");

  const pmId = makeId("fu-pm");
  appendThreadMessage(updateUC, dimId, {
    id: pmId,
    role: "pm",
    text: challenge,
    intent: forcedIntent || "pending",
    targetArgument: targetArgument || null,
    timestamp: new Date().toISOString(),
  });

  const classification = forcedIntent
    ? {
        intent: forcedIntent,
        rationale: "Intent forced by UI action.",
        urls: extractUrls(challenge),
      }
      : await classifyIntent({
        uc,
        dim,
        challenge,
        existingThread,
        callAnalyst,
        maxTokens: tokenLimits.intentClassification,
        contextLabel: dim?.label || "",
      });

  const intent = classification.intent;
  patchThreadMessage(updateUC, dimId, pmId, {
    intent,
    intentRationale: classification.rationale,
  });

  if (!intentNeedsAnalystResponse(intent)) {
    return uc;
  }

  const { parsed, meta } = await runIntentResponse({
    intent,
    uc,
    dim,
    challenge,
    effectiveScore,
    threadHistory,
    targetArgument,
    callAnalyst,
    fetchSource: transport.fetchSource,
    followUpPrompt: prompts.followUp,
    limits: tokenLimits,
  });

  const { normalizedConfidence, normalizedReason } = normalizeConfidence(parsed, uc, dimId);
  const proposedScore = extractProposedScore(parsed, effectiveScore, intentAllowsScoreProposal(intent));
  const hasPendingProposal = proposedScore != null;
  const argumentUpdate = normalizeArgumentUpdate(parsed?.argumentUpdate, targetArgument);

  appendThreadMessage(updateUC, dimId, {
    id: makeId("fu-analyst"),
    role: "analyst",
    intent,
    targetArgument: targetArgument || null,
    response: String(parsed?.response || "").trim() || "No response generated.",
    brief: String(parsed?.brief || "").trim(),
    sources: normalizeSources(parsed?.sources),
    confidence: normalizedConfidence,
    confidenceReason: normalizedReason,
    scoreAdjusted: false,
    newScore: hasPendingProposal ? proposedScore : null,
    scoreProposal: hasPendingProposal
      ? {
          status: "pending",
          previousScore: effectiveScore,
          newScore: proposedScore,
          reason: String(parsed?.proposalReason || "").trim(),
        }
      : null,
    argumentUpdate,
    searchMeta: meta || null,
    timestamp: new Date().toISOString(),
  });

  return uc;
}
