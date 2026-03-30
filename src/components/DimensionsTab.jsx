import ScorePill from "./ScorePill";
import DimRubricToggle from "./DimRubricToggle";
import EvidenceBlock from "./EvidenceBlock";
import ConfidenceBadge from "./ConfidenceBadge";
import ArgumentList from "./ArgumentList";
import ResearchBriefBlock from "./ResearchBriefBlock";
import { getDimensionView } from "../lib/dimensionView";

export default function DimensionsTab({ uc, dims }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {dims.map(d => {
        const view = getDimensionView(uc, d.id, { dimLabel: d.label });
        const initData = view.initial;
        const revised = view.effectiveScore != null && initData?.score != null && view.effectiveScore !== initData.score;

        if (!initData) {
          return (
            <div key={d.id} style={{ background: "var(--ck-surface-soft)", borderRadius: 8, padding: "10px 14px", opacity: 0.35, border: "1px solid var(--ck-line)" }}>
              <span style={{ color: "var(--ck-muted)", fontSize: 12 }}>{d.label}</span>
            </div>
          );
        }
        return (
          <div key={d.id} style={{ background: "var(--ck-surface)", borderRadius: 10, padding: "14px 16px", border: `1px solid ${d.enabled ? "var(--ck-line-strong)" : "var(--ck-line)"}`, opacity: d.enabled ? 1 : 0.6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ fontWeight: 700, color: "var(--ck-text)", fontSize: 13 }}>{d.label}</span>
              <ConfidenceBadge level={view.confidence} reason={view.confidenceReason} />
              {!d.enabled && (
                <span style={{ fontSize: 10, color: "var(--ck-muted)", background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", padding: "1px 6px", borderRadius: 4 }}>excluded from score</span>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center" }}>
                {revised && (
                  <>
                    <ScorePill score={initData.score} />
                    <span style={{ color: "var(--ck-muted)", fontSize: 11 }}>-&gt;</span>
                  </>
                )}
                {view.effectiveScore != null && <ScorePill score={view.effectiveScore} revised={revised} />}
                {revised && <span style={{ fontSize: 10, color: "#12805c", fontWeight: 700 }}>REVISED</span>}
                {view.stage !== "initial" && (
                  <span style={{ fontSize: 10, color: "var(--ck-blue)", fontWeight: 700 }}>{view.stageLabel.toUpperCase()}</span>
                )}
              </div>
            </div>
            <DimRubricToggle dim={d} />
            <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
              <ArgumentList group="supporting" argumentsList={view.supportingArguments} />
              <ArgumentList group="limiting" argumentsList={view.limitingArguments} />
              {view.confidence === "low" && <ResearchBriefBlock brief={view.researchBrief} />}
            </div>
            <EvidenceBlock
              brief={view.brief}
              full={view.full}
              sources={view.sources}
              risks={view.risks}
            />
          </div>
        );
      })}
    </div>
  );
}
