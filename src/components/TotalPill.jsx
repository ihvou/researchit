import { totalScoreColor } from "../lib/scoring";

export default function TotalPill({ score }) {
  const c = totalScoreColor(score);
  const n = parseFloat(score);
  const tier = n >= 80 ? "T3" : n >= 65 ? "T2" : n >= 50 ? "T1" : "--";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      background: c + "1a", border: `1.5px solid ${c}88`,
      color: c, padding: "3px 10px", borderRadius: 8, fontWeight: 800, fontSize: 13,
    }}>
      <span style={{ fontFamily: "monospace" }}>{score}</span>
      <span style={{ fontSize: 10, letterSpacing: 1 }}>{tier}</span>
    </span>
  );
}
