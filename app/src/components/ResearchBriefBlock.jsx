export default function ResearchBriefBlock({ brief, compact = false }) {
  if (!brief) return null;
  const missingEvidence = String(brief.missingEvidence || "").trim();
  const whereToLook = Array.isArray(brief.whereToLook) ? brief.whereToLook.filter(Boolean) : [];
  const suggestedQueries = Array.isArray(brief.suggestedQueries) ? brief.suggestedQueries.filter(Boolean) : [];
  const textSize = compact ? 10 : 11;

  return (
    <div style={{ border: "1px solid var(--ck-line)", background: "var(--ck-surface-soft)", borderRadius: 2, padding: compact ? "7px 8px" : "8px 10px" }}>
      <div style={{ fontSize: compact ? 10 : 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 5 }}>
        Research Brief (Low Confidence)
      </div>
      {missingEvidence && (
        <div style={{ fontSize: textSize, color: "var(--ck-muted)", lineHeight: 1.45, marginBottom: 6 }}>
          <strong>Missing evidence:</strong> {missingEvidence}
        </div>
      )}
      {!!whereToLook.length && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: textSize, fontWeight: 700, color: "var(--ck-muted)", marginBottom: 3 }}>Where to look</div>
          <ul style={{ margin: 0, paddingLeft: 16, display: "grid", gap: 2 }}>
            {whereToLook.map((item, idx) => (
              <li key={idx} style={{ fontSize: textSize, color: "var(--ck-muted)", lineHeight: 1.4 }}>
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!suggestedQueries.length && (
        <div>
          <div style={{ fontSize: textSize, fontWeight: 700, color: "var(--ck-muted)", marginBottom: 3 }}>Suggested queries</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {suggestedQueries.map((q, idx) => (
              <span
                key={idx}
                style={{
                  border: "1px solid var(--ck-line)",
                  background: "var(--ck-surface-soft)",
                  borderRadius: 2,
                  padding: "2px 8px",
                  fontSize: textSize,
                  color: "var(--ck-muted)",
                  lineHeight: 1.3,
                }}>
                {q}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

