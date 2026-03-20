import { useState } from "react";
import Spinner from "./Spinner";
import OverviewTab from "./OverviewTab";
import DimensionsTab from "./DimensionsTab";
import DebateTab from "./DebateTab";

const PHASE_LABELS = {
  analyst: "\ud83d\udd0d Analyst researching\u2026",
  critic: "\ud83e\uddd0 Critic reviewing\u2026",
  finalizing: "\u2696\ufe0f Analyst responding\u2026",
};

export default function ExpandedRow({ uc, dims, fuInputs, onFuInputChange, fuLoading, onFollowUp }) {
  const [tab, setTab] = useState("overview");

  return (
    <div style={{ borderTop: "2px solid #5b21b633" }}>
      <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #1e2a3a", background: "#0f1420", padding: "0 16px" }}>
        {[
          { id: "overview", label: "\ud83d\udccb Overview" },
          { id: "dimensions", label: "\ud83d\udcca Dimensions" },
          { id: "debate", label: "\ud83d\udcac Debate & Challenges" },
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
                <Spinner size={10} /> {PHASE_LABELS[uc.phase] || "Processing\u2026"}
              </span>
            : <span style={{ color: "#2d3748" }}>
                Analyst: Claude Sonnet 4.6 \u00b7 Critic: OpenAI o3 \u00b7 Sources are training-based \u2014 verify before use
              </span>}
        </div>
      </div>

      <div style={{ padding: 16, background: "#080b14" }}>
        {uc.status === "error" && (
          <div style={{ background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 8, padding: "10px 14px", color: "#fca5a5", fontSize: 13, marginBottom: 14 }}>
            {"\u26a0\ufe0f"} {uc.errorMsg}
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
