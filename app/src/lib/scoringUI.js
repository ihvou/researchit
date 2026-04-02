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
