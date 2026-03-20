export function getEffectiveScore(uc, dimId) {
  const fuAdjusted = (uc.followUps?.[dimId] || [])
    .filter(f => f.role === "analyst" && f.scoreAdjusted && f.newScore != null);
  const lastAdj = fuAdjusted.length ? fuAdjusted[fuAdjusted.length - 1].newScore : null;
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

export function dimScoreColor(v) {
  if (v >= 4.5) return "#10b981";
  if (v >= 3.5) return "#22c55e";
  if (v >= 2.5) return "#f59e0b";
  if (v >= 1.5) return "#f97316";
  return "#ef4444";
}

export function totalScoreColor(t) {
  const n = parseFloat(t);
  if (n >= 80) return "#10b981";
  if (n >= 65) return "#22c55e";
  if (n >= 50) return "#f59e0b";
  if (n >= 35) return "#f97316";
  return "#ef4444";
}
