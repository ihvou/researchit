import { callAnalystAPI } from "../lib/api";
import { safeParseJSON } from "../lib/json";
import { SYS_FOLLOWUP } from "../prompts/system";
import { getEffectiveScore } from "../lib/scoring";
import { buildDimRubricReminder } from "../lib/rubric";
import { normalizeConfidenceLevel } from "../lib/confidence";

export async function handleFollowUp(ucId, dimId, challenge, dims, ucRef, updateUC) {
  const uc = ucRef.current.find(u => u.id === ucId);
  const dim = dims.find(d => d.id === dimId);
  const effScore = getEffectiveScore(uc, dimId);
  const dimData = uc.dimScores?.[dimId];
  const existingThread = uc.followUps?.[dimId] || [];

  const threadHistory = existingThread
    .map(m => m.role === "pm" ? `PM: ${m.text}` : `Analyst: ${m.response || m.text}`)
    .join("\n\n");

  const prompt = `Dimension being challenged: "${dim?.label}"
Use case: "${uc.attributes?.title || uc.rawInput}"
Current effective score: ${effScore}/5

Your original brief analysis: ${dimData?.brief || ""}
Your full analysis: ${dimData?.full || ""}

${threadHistory ? `Previous exchanges in this thread:\n${threadHistory}\n\n` : ""}PM's new challenge: "${challenge}"

Rubric reminder for this dimension:
${buildDimRubricReminder(dim, { wordCap: 16 })}

Respond directly to the challenge. If valid, concede with a revised score AND clear reasoning. If not valid, defend with NEW evidence not previously cited (repeating prior evidence is not a valid defense).
Also include a neutral plain-language brief:
- 2-3 short sentences.
- Explain why this score is justified (why it is not lower).
- Explain what still limits it from a higher score.
- Use natural wording; DO NOT use template phrases like "Above 0 because" or "Below 5 because".
- Keep it understandable for non-domain readers; avoid unexplained jargon/acronyms.
- Do not invert rubric direction (higher score is better).
Also update confidence for this dimension:
- High: named deployments with verifiable metrics and strong market familiarity.
- Medium: deployments exist but evidence is sparse, self-reported, or moving fast.
- Low: fewer than two verifiable deployments, underrepresented vertical, or heavy extrapolation.
Do not mention the critic and do not use first-person phrasing.

Return ONLY this JSON:
{
  "confidence": "<high|medium|low>",
  "confidenceReason": "<1 sentence explaining confidence level>",
  "brief": "<2-3 plain-language sentences, max 65 words, explain why this score is justified and what prevents a higher score>",
  "response": "<3-5 sentences \u2014 direct, substantive, analytical>",
  "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}],
  "scoreAdjusted": <true if you are revising the score, false otherwise>,
  "newScore": <null if no revision, or integer 1-5 if revised>
}`;

  const result = await callAnalystAPI([{ role: "user", content: prompt }], SYS_FOLLOWUP, 2000);
  const parsed = safeParseJSON(result);
  const currentConfidence = normalizeConfidenceLevel(
    uc.followUps?.[dimId]?.slice(-1)?.[0]?.confidence
    || uc.finalScores?.dimensions?.[dimId]?.confidence
    || uc.dimScores?.[dimId]?.confidence
  );
  const normalizedConfidence = normalizeConfidenceLevel(parsed?.confidence) || currentConfidence || "medium";
  const normalizedReason = typeof parsed?.confidenceReason === "string" && parsed.confidenceReason.trim()
    ? parsed.confidenceReason.trim()
    : normalizedConfidence === "high"
      ? "Strong named evidence remains available after this challenge."
      : normalizedConfidence === "medium"
        ? "Evidence exists but still has partial verification gaps."
        : "Confidence remains limited because verification is still sparse.";

  updateUC(ucId, u => ({
    ...u,
    followUps: {
      ...u.followUps,
      [dimId]: [...(u.followUps?.[dimId] || []), {
        role: "analyst",
        ...parsed,
        confidence: normalizedConfidence,
        confidenceReason: normalizedReason,
      }],
    },
  }));
}
