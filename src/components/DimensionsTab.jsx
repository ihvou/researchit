import ScorePill from "./ScorePill";
import DimRubricToggle from "./DimRubricToggle";
import EvidenceBlock from "./EvidenceBlock";
import { getEffectiveScore } from "../lib/scoring";

export default function DimensionsTab({ uc, dims }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {dims.map(d => {
        const initData = uc.dimScores?.[d.id];
        const finalData = uc.finalScores?.dimensions?.[d.id];
        const effScore = getEffectiveScore(uc, d.id);
        const revised = finalData?.finalScore != null && initData?.score != null && finalData.finalScore !== initData.score;

        if (!initData) {
          return (
            <div key={d.id} style={{ background: "#0f1520", borderRadius: 8, padding: "10px 14px", opacity: 0.25, border: "1px solid #141820" }}>
              <span style={{ color: "#4b5563", fontSize: 12 }}>{d.label}</span>
            </div>
          );
        }
        return (
          <div key={d.id} style={{ background: "#0f1520", borderRadius: 10, padding: "14px 16px", border: `1px solid ${d.enabled ? "#1e2a3a" : "#141820"}`, opacity: d.enabled ? 1 : 0.5 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ fontWeight: 700, color: "#e2e8f0", fontSize: 13 }}>{d.label}</span>
              {!d.enabled && (
                <span style={{ fontSize: 10, color: "#374151", background: "#0a0d17", padding: "1px 6px", borderRadius: 4 }}>excluded from score</span>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center" }}>
                {revised && (
                  <>
                    <ScorePill score={initData.score} />
                    <span style={{ color: "#374151", fontSize: 11 }}>\u2192</span>
                  </>
                )}
                {effScore != null && <ScorePill score={effScore} revised={revised} />}
                {revised && <span style={{ fontSize: 10, color: "#10b981", fontWeight: 700 }}>REVISED</span>}
              </div>
            </div>
            <DimRubricToggle dim={d} />
            <EvidenceBlock
              brief={initData.brief}
              full={initData.full}
              sources={initData.sources}
              risks={initData.risks}
            />
          </div>
        );
      })}
    </div>
  );
}
