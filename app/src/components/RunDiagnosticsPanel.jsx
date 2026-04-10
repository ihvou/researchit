import { diagnosticRows } from "./ProgressTab";

function badgeTone(value = "") {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("degraded") || normalized.includes("fail") || normalized.includes("blocked")) {
    return { border: "var(--ck-line-strong)", color: "var(--ck-text)" };
  }
  if (normalized.includes("warn") || normalized.includes("limited")) {
    return { border: "var(--ck-line)", color: "var(--ck-text)" };
  }
  return { border: "var(--ck-line)", color: "var(--ck-muted)" };
}

export default function RunDiagnosticsPanel({ uc, outputMode = "scorecard" }) {
  const rows = diagnosticRows(uc, outputMode);
  if (!rows.length) return null;

  return (
    <div style={{ border: "1px solid var(--ck-line)", background: "var(--ck-surface-soft)", padding: "10px 12px", marginBottom: 14 }}>
      <div style={{ fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--ck-muted)", marginBottom: 8 }}>
        Diagnostics
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
        {rows.map((row, idx) => {
          const tone = badgeTone(row?.value);
          return (
            <div key={`${row?.label || "diag"}-${idx}`} style={{ border: `1px solid ${tone.border}`, background: "var(--ck-bg)", padding: "8px 9px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <span style={{ fontSize: 11, color: "var(--ck-muted)" }}>{row?.label || "Diagnostic"}</span>
                <span style={{ fontSize: 11, color: tone.color }}>{row?.value || "-"}</span>
              </div>
              {row?.detail ? (
                <div style={{ marginTop: 4, fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
                  {row.detail}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
