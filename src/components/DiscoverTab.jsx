function dimensionLabelMap(dims = []) {
  const map = new Map();
  dims.forEach((d) => map.set(d.id, d.label));
  return map;
}

function improveLabels(candidate, dimMap) {
  const ids = candidate?.expectedImprovedDimensions || [];
  return ids.map((id) => ({
    id,
    label: dimMap.get(id) || id,
  }));
}

export default function DiscoverTab({ uc, dims, onAnalyzeRelated, globalAnalyzing = false }) {
  const dimMap = dimensionLabelMap(dims);
  const candidates = uc.discover?.candidates || [];
  const hasError = !!uc.discover?.error;

  if (uc.status === "analyzing" && uc.phase !== "discover") {
    return (
      <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 10, padding: "12px 14px" }}>
        <div style={{ fontSize: 12, color: "var(--ck-muted)" }}>
          Related use case discovery starts after the main analysis and debate are complete.
        </div>
      </div>
    );
  }

  if (uc.status === "analyzing" && uc.phase === "discover") {
    return (
      <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 10, padding: "12px 14px" }}>
        <div style={{ fontSize: 12, color: "var(--ck-text)", fontWeight: 700, marginBottom: 4 }}>
          Discovering targeted related use cases...
        </div>
        <div style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.5 }}>
          Generating narrower variants designed to improve the weakest scoring dimensions.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 10, padding: "10px 12px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-blue)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>
          Related Use Case Discovery
        </div>
        <div style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.5 }}>
          These candidates are generated to improve weak dimensions from the completed analysis.
          Click <strong>Analyse →</strong> to run a full scoring cycle for any candidate.
        </div>
      </div>

      {!candidates.length && !hasError && (
        <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 10, padding: "12px 14px", fontSize: 12, color: "var(--ck-muted)" }}>
          No related candidates were generated for this use case.
        </div>
      )}

      {hasError && (
        <div style={{ background: "#fff0ee", border: "1px solid #f2c7be", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#b42318", lineHeight: 1.5 }}>
          Discovery pass failed: {uc.discover.error}
        </div>
      )}

      {candidates.map((candidate, idx) => {
        const improved = improveLabels(candidate, dimMap);
        return (
          <div key={`${candidate.title}-${idx}`} style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ck-text)", marginBottom: 5 }}>
                  {candidate.title}
                </div>
                <div style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.6 }}>
                  {candidate.rationale}
                </div>
                {candidate.analysisInput && (
                  <div style={{ fontSize: 11, color: "var(--ck-muted-soft)", lineHeight: 1.5, marginTop: 6 }}>
                    Prompt seed: {candidate.analysisInput}
                  </div>
                )}
                {!!improved.length && (
                  <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {improved.map((item) => (
                      <span
                        key={item.id}
                        title={item.id}
                        style={{
                          fontSize: 10,
                          color: "var(--ck-blue)",
                          background: "var(--ck-blue-soft)",
                          border: "1px solid #c5ceff",
                          borderRadius: 999,
                          padding: "2px 8px",
                          fontWeight: 700,
                        }}>
                        {item.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={globalAnalyzing}
                onClick={() => onAnalyzeRelated(candidate)}
                style={{
                  background: "var(--ck-blue)",
                  border: "none",
                  color: "#fff",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  padding: "7px 11px",
                  cursor: globalAnalyzing ? "not-allowed" : "pointer",
                  opacity: globalAnalyzing ? 0.55 : 1,
                  whiteSpace: "nowrap",
                }}>
                Analyse →
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
