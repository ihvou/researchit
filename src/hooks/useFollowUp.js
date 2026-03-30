import { callAnalystAPI } from "../lib/api";
import { safeParseJSON } from "../lib/json";
import { SYS_FOLLOWUP } from "../prompts/system";
import { getEffectiveScore } from "../lib/scoring";
import { buildDimRubricReminder } from "../lib/rubric";
import { normalizeConfidenceLevel } from "../lib/confidence";
import { getDimensionView } from "../lib/dimensionView";
import {
  FOLLOW_UP_INTENTS,
  normalizeFollowUpIntent,
  fallbackIntentFromText,
  extractUrls,
  intentAllowsScoreProposal,
  intentNeedsAnalystResponse,
} from "../lib/followUpIntent";

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

function makeId(prefix = "fu") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSources(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((s) => s && (s.name || s.url || s.quote))
    .map((s) => ({
      name: String(s.name || "").trim(),
      quote: String(s.quote || "").trim().slice(0, 180),
      url: String(s.url || "").trim(),
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

function appendThreadMessage(updateUC, ucId, dimId, message) {
  updateUC(ucId, (u) => ({
    ...u,
    followUps: {
      ...u.followUps,
      [dimId]: [...(u.followUps?.[dimId] || []), message],
    },
  }));
}

function patchThreadMessage(updateUC, ucId, dimId, messageId, patch) {
  updateUC(ucId, (u) => ({
    ...u,
    followUps: {
      ...u.followUps,
      [dimId]: (u.followUps?.[dimId] || []).map((msg) => (
        msg?.id === messageId ? { ...msg, ...patch } : msg
      )),
    },
  }));
}

async function classifyIntent({ uc, dim, challenge, existingThread }) {
  const fallback = fallbackIntentFromText(challenge);
  const prior = existingThread
    .slice(-4)
    .map((m) => `${m.role === "pm" ? "PM" : "Analyst"}: ${m.text || m.response || ""}`)
    .join("\n");

  const prompt = `Use case: "${uc.attributes?.title || uc.rawInput}"
Dimension: "${dim?.label || "Unknown"}"
Message: "${challenge}"
${prior ? `Recent thread context:\n${prior}\n` : ""}

Classify intent.`;

  try {
    const raw = await callAnalystAPI([{ role: "user", content: prompt }], SYS_FOLLOWUP_INTENT, 450);
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

async function fetchSourceSnapshot(url) {
  const res = await fetch("/api/fetch-source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = await res.json();
  if (!res.ok || data?.error) {
    throw new Error(data?.error || `Could not fetch ${url}`);
  }
  return data;
}

async function buildEvidenceContext(challenge, urls) {
  const normalizedUrls = urls.slice(0, 3);
  const fetched = [];

  for (const url of normalizedUrls) {
    try {
      const snap = await fetchSourceSnapshot(url);
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
}) {
  const baseHeader = renderPromptHeader({ uc, dim, effectiveScore, threadHistory });
  const analysisMode = uc.analysisMeta?.analysisMode || "standard";
  const liveSearchAllowed = analysisMode !== "standard";

  if (intent === FOLLOW_UP_INTENTS.NOTE) {
    return { skipAnalyst: true };
  }

  if (intent === FOLLOW_UP_INTENTS.QUESTION) {
    const prompt = `${baseHeader}
PM question: "${challenge}"

Answer as a plain-language explanation. No score revision proposal.
Return ONLY JSON:
{
  "response": "<clear explanation, 3-5 sentences, non-defensive>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"..."}]
}`;
    const raw = await callAnalystAPI([{ role: "user", content: prompt }], SYS_FOLLOWUP, 1400);
    return { parsed: safeParseJSON(raw), meta: null };
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
    const raw = await callAnalystAPI([{ role: "user", content: prompt }], SYS_FOLLOWUP, 1600);
    return { parsed: safeParseJSON(raw), meta: null };
  }

  if (intent === FOLLOW_UP_INTENTS.ADD_EVIDENCE) {
    const urls = extractUrls(challenge);
    const evidence = await buildEvidenceContext(challenge, urls);
    const prompt = `${baseHeader}
PM evidence submission: "${challenge}"

New evidence content (fetched server-side and/or pasted):
${evidence.contextText || "No external source content was retrievable."}

Assess what changes and what does not. Propose a score revision only if evidence justifies it.
Rubric reminder:
${buildDimRubricReminder(dim, { wordCap: 16 })}

Return ONLY JSON:
{
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "brief": "<2-3 sentences for non-domain reader>",
  "response": "<3-6 sentences explaining impact of this evidence>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"..."}],
  "proposedScore": <null or integer 1-5>,
  "proposalReason": "<1-2 sentences>"
}`;
    const raw = await callAnalystAPI([{ role: "user", content: prompt }], SYS_FOLLOWUP, 2200);
    const parsed = safeParseJSON(raw);
    if (!parsed?.sources?.length && evidence.fetchedSources.length) {
      parsed.sources = evidence.fetchedSources;
    }
    return { parsed, meta: null };
  }

  if (intent === FOLLOW_UP_INTENTS.RE_SEARCH) {
    if (!liveSearchAllowed) {
      return {
        parsed: {
          response: "Re-search needs live web mode. This use case is in Standard mode, so I cannot run a fresh web pass here. Re-run in Live Search or Hybrid mode, then ask re-search again for this dimension.",
          sources: [],
          proposedScore: null,
          confidence: normalizeConfidenceLevel(
            uc.finalScores?.dimensions?.[dim?.id]?.confidence || uc.dimScores?.[dim?.id]?.confidence || "medium"
          ),
          confidenceReason: uc.finalScores?.dimensions?.[dim?.id]?.confidenceReason || uc.dimScores?.[dim?.id]?.confidenceReason || "",
        },
        meta: {
          liveSearchRequested: true,
          liveSearchUsed: false,
          webSearchCalls: 0,
          liveSearchFallbackReason: "Analysis mode is standard.",
        },
      };
    }

    const dimView = getDimensionView(uc, dim?.id, { dimLabel: dim?.label || "" });
    const gapHint = dimView?.researchBrief?.missingEvidence
      || uc.finalScores?.dimensions?.[dim?.id]?.confidenceReason
      || uc.dimScores?.[dim?.id]?.confidenceReason
      || uc.dimScores?.[dim?.id]?.risks
      || "Evidence for this dimension appears incomplete.";
    const queryHints = Array.isArray(dimView?.researchBrief?.suggestedQueries)
      ? dimView.researchBrief.suggestedQueries.slice(0, 4)
      : [];
    const queryHintBlock = queryHints.length
      ? `Suggested targeted queries:
${queryHints.map((q, idx) => `${idx + 1}. ${q}`).join("\n")}

`
      : "";

    const prompt = `${baseHeader}
PM requested targeted re-search: "${challenge}"

Evidence gap hint:
${gapHint}
${queryHintBlock}

Run a focused live web search for this dimension's weakest evidence points.
Use fresh external sources, then re-evaluate this dimension only.
Rubric reminder:
${buildDimRubricReminder(dim, { wordCap: 16 })}

Return ONLY JSON:
{
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence>",
  "brief": "<2-3 sentence summary>",
  "response": "<3-6 sentences with fresh findings>",
  "sources": [{"name":"...","quote":"<max 15 words>","url":"..."}],
  "proposedScore": <null or integer 1-5>,
  "proposalReason": "<1-2 sentences>"
}`;

    const data = await callAnalystAPI(
      [{ role: "user", content: prompt }],
      SYS_FOLLOWUP,
      2400,
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
  "sources": [{"name":"...","quote":"<max 15 words>","url":"..."}],
  "argumentUpdate": {
    "id": "<argument id or empty>",
    "group": "<supporting|limiting>",
    "action": "<keep|discard|modify|none>",
    "updatedClaim": "<required if modify>",
    "updatedDetail": "<required if modify>",
    "sources": [{"name":"...","quote":"<max 15 words>","url":"..."}],
    "reason": "<1 sentence why keep/modify/discard>"
  },
  "proposedScore": <null or integer 1-5>,
  "proposalReason": "<1-2 sentences>"
}`;
  const raw = await callAnalystAPI([{ role: "user", content: prompt }], SYS_FOLLOWUP, 2100);
  return { parsed: safeParseJSON(raw), meta: null };
}

export async function handleFollowUp(ucId, dimId, challenge, dims, ucRef, updateUC, options = {}) {
  const uc = ucRef.current.find((u) => u.id === ucId);
  const dim = dims.find((d) => d.id === dimId);
  const forcedIntent = normalizeFollowUpIntent(options?.forceIntent);
  const targetArgument = normalizeTargetArgument(options?.targetArgument);
  const effectiveScore = getEffectiveScore(uc, dimId);
  const existingThread = uc.followUps?.[dimId] || [];
  const threadHistory = existingThread
    .map((m) => `${m.role === "pm" ? "PM" : "Analyst"}: ${m.text || m.response || ""}`)
    .join("\n\n");

  const pmId = makeId("fu-pm");
  appendThreadMessage(updateUC, ucId, dimId, {
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
    : await classifyIntent({ uc, dim, challenge, existingThread });
  const intent = classification.intent;
  patchThreadMessage(updateUC, ucId, dimId, pmId, {
    intent,
    intentRationale: classification.rationale,
  });

  if (!intentNeedsAnalystResponse(intent)) return;

  const { parsed, meta } = await runIntentResponse({
    intent,
    uc,
    dim,
    challenge,
    effectiveScore,
    threadHistory,
    targetArgument,
  });

  const { normalizedConfidence, normalizedReason } = normalizeConfidence(parsed, uc, dimId);
  const proposedScore = extractProposedScore(parsed, effectiveScore, intentAllowsScoreProposal(intent));
  const hasPendingProposal = proposedScore != null;
  const argumentUpdate = normalizeArgumentUpdate(parsed?.argumentUpdate, targetArgument);

  appendThreadMessage(updateUC, ucId, dimId, {
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
}
