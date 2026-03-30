import { getEffectiveScore } from "./scoring";
import { normalizeConfidenceLevel } from "./confidence";
import { ensureDimensionArgumentShape, applyThreadArgumentUpdates } from "./arguments";
import { getResearchBriefForLowConfidence } from "./researchBrief";

function mergeSources(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    for (const source of list || []) {
      if (!source || (!source.name && !source.url && !source.quote)) continue;
      const key = `${source.name || ""}|${source.url || ""}|${source.quote || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(source);
    }
  }
  return merged;
}

export function getLatestAnalystFollowUp(thread = []) {
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    if (thread[i]?.role === "analyst") return thread[i];
  }
  return null;
}

function normalizeBriefText(brief, score) {
  if (!brief) return "";
  const raw = String(brief).trim();
  if (!raw) return "";

  const templateMatch = raw.match(/^above\s+0\s+because\s+(.+?)[;,.]\s*below\s+5\s+because\s+(.+)$/i);
  if (!templateMatch) return raw;

  const supports = templateMatch[1].trim().replace(/[.;\s]+$/g, "");
  const limits = templateMatch[2].trim().replace(/[.;\s]+$/g, "");
  const n = Number(score);
  const scoreLabel = Number.isFinite(n) ? `${n}/5` : "this score";

  return `Score ${scoreLabel} is supported because ${supports}. It is not higher because ${limits}.`;
}

export function getDimensionView(uc, dimId, options = {}) {
  const dimLabel = options?.dimLabel || "";
  const initial = uc.dimScores?.[dimId] || null;
  const debate = uc.finalScores?.dimensions?.[dimId] || null;
  const thread = uc.followUps?.[dimId] || [];
  const followUp = getLatestAnalystFollowUp(thread);
  const effectiveScore = getEffectiveScore(uc, dimId);

  const stage = followUp ? "follow_up" : debate ? "debate" : initial ? "initial" : "none";
  const stageLabel = stage === "follow_up"
    ? "Updated after follow-up"
    : stage === "debate"
      ? "Updated after debate"
      : "Initial assessment";

  const combinedFull = [
    initial?.full ? `Initial analysis:\n${initial.full}` : "",
    debate?.response ? `Debate update:\n${debate.response}` : "",
    followUp?.response ? `Follow-up update:\n${followUp.response}` : "",
  ].filter(Boolean).join("\n\n");

  const briefSourceText = followUp?.brief || debate?.brief || initial?.brief || "";
  const sources = mergeSources(followUp?.sources, debate?.sources, initial?.sources);
  const confidence = normalizeConfidenceLevel(
    followUp?.confidence || debate?.confidence || initial?.confidence
  );
  const confidenceReason = followUp?.confidenceReason
    || debate?.confidenceReason
    || initial?.confidenceReason
    || "";
  const researchBrief = getResearchBriefForLowConfidence({
    confidence,
    existingBrief: followUp?.researchBrief || debate?.researchBrief || initial?.researchBrief,
    dimId,
    dimLabel,
    attributes: uc?.attributes || {},
    missingEvidence: followUp?.missingEvidence || debate?.missingEvidence || initial?.missingEvidence || "",
    confidenceReason,
    risks: followUp?.risks || debate?.risks || initial?.risks || "",
    sources,
  });

  const baseArgumentDim = followUp?.arguments || debate || initial || {};
  const baseArguments = ensureDimensionArgumentShape(baseArgumentDim, dimId);
  const appliedArguments = applyThreadArgumentUpdates(baseArguments, thread);

  return {
    initial,
    debate,
    followUp,
    stage,
    stageLabel,
    effectiveScore,
    brief: normalizeBriefText(briefSourceText, effectiveScore),
    full: combinedFull || initial?.full || "",
    risks: initial?.risks || "",
    sources,
    confidence,
    confidenceReason,
    researchBrief,
    arguments: appliedArguments,
    supportingArguments: appliedArguments.supporting,
    limitingArguments: appliedArguments.limiting,
  };
}

export function formatSourcesForCell(sources = []) {
  return (sources || [])
    .map((s) => {
      const name = s?.name || "Unknown source";
      const url = s?.url ? ` (${s.url})` : "";
      const quote = s?.quote ? ` - ${s.quote}` : "";
      return `${name}${url}${quote}`;
    })
    .join(" | ");
}
