export default function SourcesList({ sources }) {
  if (!sources?.length) return null;
  return (
    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "3px 0" }}>
      <span style={{ fontSize: 10, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.7, marginRight: 6, flexShrink: 0 }}>
        Sources:
      </span>
      {sources.map((s, i) => (
        <span key={i} style={{
          display: "inline-flex", alignItems: "baseline", gap: 4,
          background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)",
          borderRadius: 2, padding: "2px 8px", fontSize: 11, marginRight: 5, marginBottom: 3,
        }}>
          {s.url
            ? <a href={s.url} target="_blank" rel="noopener noreferrer"
                style={{ color: "var(--ck-text)", textDecoration: "none" }}
                onMouseOver={e => e.target.style.textDecoration = "underline"}
                onMouseOut={e => e.target.style.textDecoration = "none"}>
                {s.name}
              </a>
            : <span style={{ color: "var(--ck-text)" }}>{s.name}</span>}
          {s.quote && <span style={{ color: "var(--ck-muted)" }}>- {s.quote}</span>}
        </span>
      ))}
    </div>
  );
}
