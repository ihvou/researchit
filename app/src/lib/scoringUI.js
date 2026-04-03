export function dimScoreColor(v) {
  if (v >= 4.5) return "#111111";
  if (v >= 3.5) return "#2f2f2f";
  if (v >= 2.5) return "#4d4d4d";
  if (v >= 1.5) return "#6b6b6b";
  return "#858585";
}

export function totalScoreColor(t) {
  const n = parseFloat(t);
  if (n >= 80) return "#111111";
  if (n >= 65) return "#2f2f2f";
  if (n >= 50) return "#4d4d4d";
  if (n >= 35) return "#6b6b6b";
  return "#858585";
}
