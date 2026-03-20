import ScorePill from "./ScorePill";
import TotalPill from "./TotalPill";
import { getEffectiveScore, calcWeightedScore } from "../lib/scoring";

export default function OverviewTab({ uc, dims }) {
  const a = uc.attributes;
  const score = calcWeightedScore(uc, dims);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 14 }}>
      <div style={{ background: "#0f1520", borderRadius: 10, padding: "14px 16px", border: "1px solid #1e2a3a" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#a855f7", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
          Use Case Attributes
        </div>
        {a ? (
          <>
            {[
              ["Vertical", a.vertical],
              ["Buyer", a.buyerPersona],
              ["AI Type", a.aiSolutionType],
              ["Timeline", a.typicalTimeline],
              ["Delivery Model", a.deliveryModel],
            ].map(([k, v]) => v && (
              <div key={k} style={{ display: "flex", gap: 10, marginBottom: 8, alignItems: "flex-start" }}>
                <span style={{ color: "#4b5563", fontSize: 11, minWidth: 80, paddingTop: 1, flexShrink: 0 }}>{k}</span>
                <span style={{ color: "#cbd5e1", fontSize: 12, fontWeight: 500, lineHeight: 1.4 }}>{v}</span>
              </div>
            ))}
            {a.expandedDescription && (
              <p style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.65, margin: "12px 0 0", borderTop: "1px solid #1e2a3a", paddingTop: 12 }}>
                {a.expandedDescription}
              </p>
            )}
          </>
        ) : (
          <span style={{ color: "#374151", fontSize: 12 }}>Analyzing\u2026</span>
        )}
      </div>

      <div style={{ background: "#0f1520", borderRadius: 10, padding: "14px 16px", border: "1px solid #1e2a3a" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#a855f7", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
          Score Summary
        </div>
        {dims.map(d => {
          const sc = getEffectiveScore(uc, d.id);
          const initScore = uc.dimScores?.[d.id]?.score;
          const finalScore = uc.finalScores?.dimensions?.[d.id]?.finalScore;
          const revised = finalScore != null && initScore != null && finalScore !== initScore;
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8, opacity: d.enabled ? 1 : 0.35 }}>
              <div style={{ minWidth: 52 }}>
                {sc != null
                  ? <ScorePill score={sc} revised={revised} />
                  : <span style={{ color: "#2d3748", fontSize: 12 }}>\u2013</span>}
              </div>
              <div>
                <div style={{ fontSize: 12, color: d.enabled ? "#e2e8f0" : "#4b5563", fontWeight: 600, lineHeight: 1.3 }}>
                  {d.label}
                  <span style={{ color: "#374151", fontWeight: 400, fontSize: 10, marginLeft: 4 }}>{d.weight}%</span>
                  {!d.enabled && <span style={{ color: "#374151", fontSize: 10, marginLeft: 4 }}>(excluded)</span>}
                </div>
                {uc.dimScores?.[d.id]?.brief && (
                  <div style={{ fontSize: 11, color: "#4b5563", marginTop: 1, lineHeight: 1.4 }}>
                    {uc.dimScores[d.id].brief}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {uc.finalScores?.conclusion && (
          <div style={{ marginTop: 12, padding: "10px 12px", background: "#0a0d17", borderRadius: 8, fontSize: 12, color: "#94a3b8", borderLeft: "3px solid #7c3aed", lineHeight: 1.7 }}>
            {uc.finalScores.conclusion}
          </div>
        )}
        {score && (
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: "#4b5563" }}>Weighted score:</span>
            <TotalPill score={score} />
          </div>
        )}
      </div>
    </div>
  );
}
