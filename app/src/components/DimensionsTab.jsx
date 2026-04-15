import { getDimensionView } from "@researchit/engine";
import ScorePill from "./ScorePill";
import DimRubricToggle from "./DimRubricToggle";
import EvidenceBlock from "./EvidenceBlock";
import ConfidenceBadge from "./ConfidenceBadge";
import ArgumentList from "./ArgumentList";
import ResearchBriefBlock from "./ResearchBriefBlock";

function cleanText(value) {
  return String(value || "").trim();
}

function severityTone(value) {
  const severity = cleanText(value).toLowerCase();
  if (severity === "high") return "#7b2a2a";
  if (severity === "medium") return "#7a611a";
  return "#4b4b48";
}

export default function DimensionsTab({ uc, dims }) {
  const dimensionList = Array.isArray(dims) ? dims : [];
  const redTeam = uc?.finalScores?.redTeam || {};
  const sourceUniverse = uc?.analysisMeta?.sourceUniverse || {};
  const sourceUniverseTotal = Number(sourceUniverse?.total || 0);
  const redTeamDimensions = redTeam?.dimensions && typeof redTeam.dimensions === "object" ? redTeam.dimensions : {};
  const redTeamRows = dimensionList
    .map((dim) => ({
      dim,
      entry: redTeamDimensions?.[dim.id] || null,
    }))
    .filter(({ entry }) => cleanText(entry?.threat) || cleanText(entry?.missedRisk));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {(cleanText(redTeam?.redTeamVerdict) || redTeamRows.length) ? (
        <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 12px", display: "grid", gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
            Red Team
          </div>
          {cleanText(redTeam?.redTeamVerdict) ? (
            <div style={{ fontSize: 12, color: "var(--ck-text)", lineHeight: 1.6 }}>
              {redTeam.redTeamVerdict}
            </div>
          ) : null}
          {redTeamRows.length ? (
            <div style={{ display: "grid", gap: 6 }}>
              {redTeamRows.map(({ dim, entry }) => (
                <div key={`red-team-${dim.id}`} style={{ border: "1px solid var(--ck-line)", background: "var(--ck-surface-soft)", borderRadius: 2, padding: "7px 9px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 3 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-text)" }}>{dim.label}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: severityTone(entry?.severityIfWrong), border: "1px solid var(--ck-line)", padding: "1px 5px" }}>
                      {cleanText(entry?.severityIfWrong) || "medium"}
                    </span>
                  </div>
                  {cleanText(entry?.threat) ? (
                    <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
                      <strong style={{ color: "var(--ck-text)" }}>Threat:</strong> {entry.threat}
                    </div>
                  ) : null}
                  {cleanText(entry?.missedRisk) ? (
                    <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
                      <strong style={{ color: "var(--ck-text)" }}>Missed risk:</strong> {entry.missedRisk}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {sourceUniverseTotal > 0 ? (
        <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 12px", display: "grid", gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
            Source Universe
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
            <span>Cited {Number(sourceUniverse?.cited || 0)}</span>
            <span>Corroborating {Number(sourceUniverse?.corroborating || 0)}</span>
            <span>Unverified {Number(sourceUniverse?.unverified || 0)}</span>
            <span>Excluded marketing {Number(sourceUniverse?.excludedMarketing || 0)}</span>
            <span>Excluded stale {Number(sourceUniverse?.excludedStale || 0)}</span>
            <span>Total {sourceUniverseTotal}</span>
          </div>
        </div>
      ) : null}
      {dimensionList.map((d) => {
        const view = getDimensionView(uc, d.id, { dimLabel: d.label, dim: d });
        const initData = view.initial;
        const revised = view.effectiveScore != null && initData?.score != null && view.effectiveScore !== initData.score;

        if (!initData) {
          return (
            <div key={d.id} style={{ background: "var(--ck-surface-soft)", borderRadius: 2, padding: "10px 14px", opacity: 0.35, border: "1px solid var(--ck-line)" }}>
              <span style={{ color: "var(--ck-muted)", fontSize: 12 }}>{d.label}</span>
            </div>
          );
        }
        return (
          <div key={d.id} style={{ background: "var(--ck-surface)", borderRadius: 2, padding: "14px 16px", border: `1px solid ${d.enabled ? "var(--ck-line-strong)" : "var(--ck-line)"}`, opacity: d.enabled ? 1 : 0.6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ fontWeight: 700, color: "var(--ck-text)", fontSize: 13 }}>{d.label}</span>
              <ConfidenceBadge level={view.confidence} reason={view.confidenceReason} />
              {!d.enabled && (
                <span style={{ fontSize: 10, color: "var(--ck-muted)", background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", padding: "1px 6px", borderRadius: 2 }}>excluded from score</span>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center" }}>
                {revised && (
                  <>
                    <ScorePill score={initData.score} />
                    <span style={{ color: "var(--ck-muted)", fontSize: 11 }}>-&gt;</span>
                  </>
                )}
                {view.effectiveScore != null && <ScorePill score={view.effectiveScore} revised={revised} />}
                {revised && <span style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700 }}>REVISED</span>}
                {view.stage !== "initial" && (
                  <span style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700 }}>{view.stageLabel.toUpperCase()}</span>
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
              sourceUniverse={sourceUniverse}
              showSourceUniverse={false}
            />
          </div>
        );
      })}
    </div>
  );
}
