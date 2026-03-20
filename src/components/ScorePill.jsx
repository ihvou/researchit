import { dimScoreColor } from "../lib/scoring";

export default function ScorePill({ score, revised = false }) {
  const c = dimScoreColor(score);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      background: c + "22", border: `1.5px solid ${c}55`,
      color: c, padding: "2px 8px", borderRadius: 6,
      fontWeight: 700, fontSize: 12, fontFamily: "monospace", whiteSpace: "nowrap",
    }}>
      {score}/5{revised && <span style={{ fontSize: 8, opacity: 0.8, marginLeft: 1 }}>*</span>}
    </span>
  );
}
