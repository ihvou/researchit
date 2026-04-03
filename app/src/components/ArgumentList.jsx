import SourcesList from "./SourcesList";

function groupTone(group) {
  if (group === "limiting") {
    return {
      bg: "var(--ck-surface-soft)",
      line: "var(--ck-line)",
      heading: "var(--ck-muted)",
      title: "Limiting Factors",
      empty: "No limiting factors captured.",
      code: "LIM",
    };
  }
  return {
    bg: "var(--ck-surface-soft)",
    line: "var(--ck-line)",
    heading: "var(--ck-muted)",
    title: "Supporting Evidence",
    empty: "No supporting evidence captured.",
    code: "SUP",
  };
}

export default function ArgumentList({
  group = "supporting",
  argumentsList = [],
  onChallenge,
  onDiscard,
  actionDisabled = false,
}) {
  const tone = groupTone(group);
  return (
    <div style={{ border: `1px solid ${tone.line}`, background: tone.bg, borderRadius: 2, padding: "8px 10px" }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: tone.heading, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.7 }}>
        <span className="mono" style={{ marginRight: 5 }}>{tone.code}</span>
        {tone.title}
      </div>
      {!argumentsList?.length ? (
        <div style={{ fontSize: 11, color: "var(--ck-muted)" }}>{tone.empty}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {argumentsList.map((arg) => {
            const discarded = arg?.status === "discarded";
            return (
              <div
                key={arg.id}
                style={{
                  background: "var(--ck-surface)",
                  border: "1px solid var(--ck-line)",
                  borderRadius: 2,
                  padding: "7px 9px",
                  opacity: discarded ? 0.7 : 1,
                }}>
                <div style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ck-text)",
                  textDecoration: discarded ? "line-through" : "none",
                  lineHeight: 1.45,
                }}>
                  {arg.claim}
                </div>
                {arg.detail && (
                  <div style={{
                    fontSize: 11,
                    color: "var(--ck-muted)",
                    marginTop: 2,
                    lineHeight: 1.55,
                    textDecoration: discarded ? "line-through" : "none",
                  }}>
                    {arg.detail}
                  </div>
                )}
                {discarded && (
                  <div style={{ marginTop: 4, fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, lineHeight: 1.4 }}>
                    Discarded by {arg.discardedBy || "reviewer"}{arg.discardReason ? ` - ${arg.discardReason}` : ""}
                  </div>
                )}
                {arg.sources?.length > 0 && <SourcesList sources={arg.sources} />}
                {(onChallenge || onDiscard) && (
                  <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {onChallenge && !discarded && (
                      <button
                        type="button"
                        onClick={() => onChallenge(arg)}
                        disabled={actionDisabled}
                        style={{
                          border: "1px solid var(--ck-line)",
                          background: "var(--ck-surface-soft)",
                          color: "var(--ck-text)",
                          borderRadius: 2,
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "3px 8px",
                          cursor: actionDisabled ? "not-allowed" : "pointer",
                        }}>
                        Challenge argument
                      </button>
                    )}
                    {onDiscard && !discarded && (
                      <button
                        type="button"
                        onClick={() => onDiscard(arg)}
                        disabled={actionDisabled}
                        style={{
                          border: "1px solid var(--ck-line)",
                          background: "var(--ck-surface-soft)",
                          color: "var(--ck-muted)",
                          borderRadius: 2,
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "3px 8px",
                          cursor: actionDisabled ? "not-allowed" : "pointer",
                        }}>
                        Discard
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
