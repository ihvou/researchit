import { confidenceTone, confidenceTitle, normalizeConfidenceLevel } from "../lib/confidence";

export default function ConfidenceBadge({ level, reason, compact = false }) {
  const normalized = normalizeConfidenceLevel(level);
  if (!normalized) return null;
  const tone = confidenceTone(normalized);
  const label = compact ? tone.short : `${tone.short} confidence`;

  return (
    <span
      title={confidenceTitle(normalized, reason)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: compact ? 10 : 11,
        fontWeight: 700,
        color: tone.ink,
        background: tone.bg,
        border: `1px solid ${tone.line}`,
        borderRadius: 999,
        padding: compact ? "1px 6px" : "2px 7px",
        lineHeight: 1.2,
        whiteSpace: "nowrap",
      }}>
      <span aria-hidden="true" style={{ fontSize: compact ? 10 : 11, lineHeight: 1 }}>
        {tone.icon}
      </span>
      <span>{label}</span>
    </span>
  );
}
