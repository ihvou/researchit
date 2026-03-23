import ScorePill from "./ScorePill";
import TotalPill from "./TotalPill";
import ConfidenceBadge from "./ConfidenceBadge";
import { calcWeightedScore } from "../lib/scoring";
import { getDimensionView } from "../lib/dimensionView";

export default function OverviewTab({ uc, dims }) {
  const a = uc.attributes;
  const score = calcWeightedScore(uc, dims);
  const lowConfidence = dims
    .map((d) => ({ dim: d, view: getDimensionView(uc, d.id) }))
    .filter((item) => item.view.confidence === "low");

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14 }}>
      <div style={{ background: "var(--ck-surface)", borderRadius: 10, padding: "14px 16px", border: "1px solid var(--ck-line)" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-blue)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
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
                <span style={{ color: "var(--ck-muted)", fontSize: 11, minWidth: 80, paddingTop: 1, flexShrink: 0 }}>{k}</span>
                <span style={{ color: "var(--ck-text)", fontSize: 12, fontWeight: 500, lineHeight: 1.4 }}>{v}</span>
              </div>
            ))}
            {a.expandedDescription && (
              <p style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.65, margin: "12px 0 0", borderTop: "1px solid var(--ck-line)", paddingTop: 12 }}>
                {a.expandedDescription}
              </p>
            )}
          </>
        ) : (
          <span style={{ color: "var(--ck-muted)", fontSize: 12 }}>Analyzing...</span>
        )}
      </div>

      <div style={{ background: "var(--ck-surface)", borderRadius: 10, padding: "14px 16px", border: "1px solid var(--ck-line)" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-blue)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
          Score Summary
        </div>
        {!!lowConfidence.length && (
          <div style={{ marginBottom: 10, padding: "7px 10px", borderRadius: 8, border: "1px solid #f5d7a3", background: "#fff6e8" }}>
            <div style={{ fontSize: 11, color: "#935f00", fontWeight: 700, marginBottom: 2 }}>
              Low-confidence dimensions flagged: {lowConfidence.length}
            </div>
            <div style={{ fontSize: 11, color: "#7a4a00", lineHeight: 1.45 }}>
              Hover each confidence badge for the reason. These are the best candidates for a quick manual verification pass.
            </div>
          </div>
        )}
        {dims.map(d => {
          const view = getDimensionView(uc, d.id);
          const initScore = view.initial?.score;
          const revised = view.effectiveScore != null && initScore != null && view.effectiveScore !== initScore;
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8, opacity: d.enabled ? 1 : 0.35 }}>
              <div style={{ minWidth: 52 }}>
                {view.effectiveScore != null
                  ? <ScorePill score={view.effectiveScore} revised={revised} />
                  : <span style={{ color: "var(--ck-muted)", fontSize: 12 }}>-</span>}
              </div>
              <div>
                <div style={{ fontSize: 12, color: d.enabled ? "var(--ck-text)" : "var(--ck-muted)", fontWeight: 600, lineHeight: 1.3 }}>
                  {d.label}
                  <span style={{ color: "var(--ck-muted)", fontWeight: 400, fontSize: 10, marginLeft: 4 }}>{d.weight}%</span>
                  {!d.enabled && <span style={{ color: "var(--ck-muted)", fontSize: 10, marginLeft: 4 }}>(excluded)</span>}
                </div>
                <div style={{ marginTop: 2 }}>
                  <ConfidenceBadge level={view.confidence} reason={view.confidenceReason} compact={true} />
                </div>
                {view.brief && (
                  <div style={{ fontSize: 11, color: "var(--ck-muted)", marginTop: 1, lineHeight: 1.4 }}>
                    {view.brief}
                  </div>
                )}
                {view.stage !== "initial" && (
                  <div style={{ fontSize: 10, color: "var(--ck-blue)", marginTop: 1 }}>{view.stageLabel}</div>
                )}
              </div>
            </div>
          );
        })}
        {uc.finalScores?.conclusion && (
          <div style={{ marginTop: 12, padding: "10px 12px", background: "var(--ck-surface-soft)", borderRadius: 8, fontSize: 12, color: "var(--ck-muted)", borderLeft: "3px solid var(--ck-blue)", lineHeight: 1.7 }}>
            {uc.finalScores.conclusion}
          </div>
        )}
        {score && (
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: "var(--ck-muted)" }}>Weighted score:</span>
            <TotalPill score={score} />
          </div>
        )}
      </div>
    </div>
  );
}
