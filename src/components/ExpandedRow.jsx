import { useState } from "react";
import Spinner from "./Spinner";
import OverviewTab from "./OverviewTab";
import DimensionsTab from "./DimensionsTab";
import DebateTab from "./DebateTab";

const PHASE_LABELS = {
  analyst: "Analyst researching...",
  critic: "Critic reviewing...",
  finalizing: "Analyst responding...",
};

export default function ExpandedRow({ uc, dims, fuInputs, onFuInputChange, fuLoading, onFollowUp }) {
  const [tab, setTab] = useState("overview");

  return (
    <div style={{ borderTop: "2px solid #5b21b633" }}>
      <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #1e2a3a", background: "#0f1420", padding: "0 16px" }}>
        {[
          { id: "overview", label: "Overview" },
          { id: "dimensions", label: "Dimensions" },
          { id: "debate", label: "Debate & Challenges" },
        ].map(t => (
          <button
            key={t.id}
            onClick={e => { e.stopPropagation(); setTab(t.id); }}
            style={{
              background: "none",
              border: "none",
              borderBottom: tab === t.id ? "2px solid #a855f7" : "2px solid transparent",
              color: tab === t.id ? "#a855f7" : "#4b5563",
              padding: "9px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}>
            {t.label}
          </button>
        ))}
        <div style={{ marginLeft: "auto", fontSize: 10, padding: "0 8px" }}>
          {uc.status === "analyzing"
            ? <span style={{ color: "#a855f7", display: "flex", alignItems: "center", gap: 6 }}>
                <Spinner size={10} /> {PHASE_LABELS[uc.phase] || "Processing..."}
              </span>
            : <span style={{ color: "#2d3748" }}>
                Analyst: OpenAI GPT-5.4 mini | Critic: OpenAI GPT-5.4 | Sources may include model memory and live web - verify before use
                {uc.analysisMeta?.liveSearchRequested && (
                  <span style={{ marginLeft: 6, color: "#60a5fa" }}>
                    | Live search {uc.analysisMeta?.liveSearchUsed ? `on (${uc.analysisMeta?.webSearchCalls || 0} calls)` : "fallback"}
                  </span>
                )}
              </span>}
        </div>
      </div>

      <div style={{ padding: 16, background: "#080b14" }}>
        {uc.status === "error" && (
          <div style={{ background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: "10px 14px", color: "#fca5a5", fontSize: 13, marginBottom: 14 }}>
            Warning: {uc.errorMsg}
          </div>
        )}
        {tab === "overview" && <OverviewTab uc={uc} dims={dims} />}
        {tab === "dimensions" && <DimensionsTab uc={uc} dims={dims} />}
        {tab === "debate" && (
          <DebateTab
            uc={uc} dims={dims}
            fuInputs={fuInputs} onFuInputChange={onFuInputChange}
            fuLoading={fuLoading} onFollowUp={onFollowUp}
          />
        )}
      </div>
    </div>
  );
}
