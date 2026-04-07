import { useEffect, useState } from "react";
import Spinner from "./Spinner";
import DimensionsTab from "./DimensionsTab";
import DebateTab from "./DebateTab";
import DiscoverTab from "./DiscoverTab";
import ProgressTab from "./ProgressTab";

const PHASE_LABELS = {
  analyst: "Analyst researching...",
  analyst_baseline: "Analyst baseline pass...",
  analyst_web: "Analyst web pass...",
  analyst_reconcile: "Analyst reconcile pass...",
  analyst_targeted: "Targeted low-confidence search...",
  critic: "Critic reviewing...",
  finalizing: "Analyst responding...",
  discover: "Discovering related research...",
};

export default function ExpandedRow({
  uc,
  dims,
  fuInputs,
  onFuInputChange,
  fuLoading,
  onFollowUp,
  onDiscardArgument,
  onResolveFollowUpProposal,
  onAnalyzeRelated,
  globalAnalyzing = false,
}) {
  const [tab, setTab] = useState("dimensions");

  useEffect(() => {
    setTab("dimensions");
  }, [uc.id]);

  useEffect(() => {
    if (uc.status === "complete") {
      setTab("dimensions");
    }
  }, [uc.status]);

  return (
    <div style={{ borderTop: "2px solid var(--ck-line-strong)", maxWidth: "100%", overflowX: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--ck-line)", background: "var(--ck-surface-soft)", padding: "0 16px", flexWrap: "wrap", rowGap: 4 }}>
        {[
          { id: "dimensions", label: "Dimensions" },
          { id: "debate", label: "Debate & Challenges" },
          { id: "discover", label: "Discover" },
          { id: "progress", label: "Progress" },
        ].map(t => (
          <button
            key={t.id}
            onClick={e => { e.stopPropagation(); setTab(t.id); }}
            style={{
              background: "none",
              border: "none",
              borderBottom: tab === t.id ? "2px solid var(--ck-accent)" : "2px solid transparent",
              color: tab === t.id ? "var(--ck-text)" : "var(--ck-muted)",
              padding: "9px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}>
            {t.label}
          </button>
        ))}
        <div style={{ marginLeft: "auto", fontSize: 10, padding: "6px 0", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
          {uc.status === "analyzing"
            ? <span style={{ color: "var(--ck-text)", display: "flex", alignItems: "center", gap: 6 }}>
                <Spinner size={10} /> {PHASE_LABELS[uc.phase] || "Processing..."}
              </span>
            : null}
        </div>
      </div>
      {uc.status !== "analyzing" && (
        <div style={{ padding: "7px 16px", borderBottom: "1px solid var(--ck-line)", background: "var(--ck-surface-soft)", minWidth: 0 }}>
          <div style={{ color: "var(--ck-muted)", fontSize: 11, lineHeight: 1.5, overflowWrap: "anywhere" }}>
            Analyst LLM + Critic LLM pipeline | Sources combine model memory and live web evidence
            {uc.analysisMeta?.lowConfidenceInitialCount > 0 && uc.status === "complete" && (
              <span style={{ marginLeft: 6, color: "var(--ck-text)" }}>
                | Low-confidence cycle: {uc.analysisMeta.lowConfidenceInitialCount} scanned, {uc.analysisMeta.lowConfidenceUpgradedCount || 0} upgraded, {uc.analysisMeta.lowConfidenceValidatedLowCount || 0} validated low
              </span>
            )}
            {uc.analysisMeta?.discoverCandidatesCount != null && uc.status === "complete" && (
              <span style={{ marginLeft: 6, color: "var(--ck-text)" }}>
                | Discover: {uc.analysisMeta.discoverCandidatesCount} candidates
              </span>
            )}
          </div>
        </div>
      )}

      <div style={{ padding: 16, background: "var(--ck-bg)" }}>
        {uc.status === "error" && (
          <div style={{ background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "10px 14px", color: "var(--ck-text)", fontSize: 13, marginBottom: 14 }}>
            Warning: {uc.errorMsg}
          </div>
        )}
        {tab === "dimensions" && <DimensionsTab uc={uc} dims={dims} />}
        {tab === "debate" && (
          <DebateTab
            uc={uc} dims={dims}
            fuInputs={fuInputs} onFuInputChange={onFuInputChange}
            fuLoading={fuLoading} onFollowUp={onFollowUp}
            onDiscardArgument={onDiscardArgument}
            onResolveFollowUpProposal={onResolveFollowUpProposal}
          />
        )}
        {tab === "discover" && (
          <DiscoverTab
            uc={uc}
            dims={dims}
            onAnalyzeRelated={(candidate) => onAnalyzeRelated?.(candidate)}
            globalAnalyzing={globalAnalyzing}
          />
        )}
        {tab === "progress" && <ProgressTab uc={uc} />}
      </div>
    </div>
  );
}
