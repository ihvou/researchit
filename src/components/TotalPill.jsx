import { totalScoreColor } from "../lib/scoring";

export default function TotalPill({ score }) {
  const c = totalScoreColor(score);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      background: c + "1a", border: `1.5px solid ${c}88`,
      color: c, padding: "3px 10px", borderRadius: 8, fontWeight: 800, fontSize: 13,
    }}>
      <span style={{ fontFamily: "monospace" }}>{score}</span>
    </span>
  );
}
