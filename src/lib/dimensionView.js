import { getEffectiveScore } from "./scoring";

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

function shorten(text, max = 220) {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

export function getLatestAnalystFollowUp(thread = []) {
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    if (thread[i]?.role === "analyst") return thread[i];
  }
  return null;
}

export function getDimensionView(uc, dimId) {
  const initial = uc.dimScores?.[dimId] || null;
  const debate = uc.finalScores?.dimensions?.[dimId] || null;
  const thread = uc.followUps?.[dimId] || [];
  const followUp = getLatestAnalystFollowUp(thread);

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

  const briefSourceText = followUp?.response || debate?.response || initial?.brief || "";
  const sources = mergeSources(followUp?.sources, debate?.sources, initial?.sources);

  return {
    initial,
    debate,
    followUp,
    stage,
    stageLabel,
    effectiveScore: getEffectiveScore(uc, dimId),
    brief: shorten(briefSourceText),
    full: combinedFull || initial?.full || "",
    risks: initial?.risks || "",
    sources,
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

