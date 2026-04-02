export function getLatestAcceptedFollowUpAdjustment(thread = []) {
  const accepted = (thread || [])
    .filter((msg) => {
      if (msg?.role !== "analyst") return false;
      const proposalScore = msg?.scoreProposal?.newScore;
      const proposalAccepted = msg?.scoreProposal?.status === "accepted" && proposalScore != null;
      const legacyApplied = !msg?.scoreProposal && msg?.scoreAdjusted && msg?.newScore != null;
      return proposalAccepted || legacyApplied;
    });

  if (!accepted.length) return null;
  const last = accepted[accepted.length - 1];
  return {
    score: last?.scoreProposal?.newScore ?? last?.newScore ?? null,
    message: last,
  };
}

export function getEffectiveScore(uc, dimId) {
  const applied = getLatestAcceptedFollowUpAdjustment(uc.followUps?.[dimId] || []);
  const lastAdj = applied?.score ?? null;
  return lastAdj
    ?? uc.finalScores?.dimensions?.[dimId]?.finalScore
    ?? uc.dimScores?.[dimId]?.score
    ?? null;
}

export function calcWeightedScore(uc, dims) {
  if (!uc.dimScores) return null;
  const active = dims.filter(d => d.enabled);
  if (!active.length) return null;
  let wSum = 0, wTotal = 0;
  active.forEach(d => {
    const sc = getEffectiveScore(uc, d.id);
    if (sc != null) { wSum += sc * d.weight; wTotal += d.weight; }
  });
  return wTotal ? ((wSum / wTotal / 5) * 100).toFixed(1) : null;
}
