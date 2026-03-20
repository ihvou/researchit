import { useState } from "react";
import Spinner from "./Spinner";
import SourcesList from "./SourcesList";

export default function FollowUpThread({ thread, inputVal, onInputChange, onSubmit, loading }) {
  const [collapsed, setCollapsed] = useState(false);
  const hasMessages = thread?.length > 0;
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px dashed #1a2535" }}>
      {hasMessages && (
        <div style={{ marginBottom: 8 }}>
          <button
            onClick={() => setCollapsed(v => !v)}
            style={{ background: "none", border: "none", color: "#4b5563", fontSize: 11, padding: "0 0 6px", cursor: "pointer" }}>
            {collapsed
              ? `> ${thread.length} follow-up message${thread.length > 1 ? "s" : ""} - expand`
              : "v Follow-up thread"}
          </button>
          {!collapsed && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {thread.map((msg, i) => {
                const isPM = msg.role === "pm";
                return (
                  <div key={i} style={{
                    background: isPM ? "#0c1828" : "#0a1812",
                    border: `1px solid ${isPM ? "#1a3455" : "#163020"}`,
                    borderRadius: 8, padding: "8px 12px",
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, color: isPM ? "#93c5fd" : "#86efac" }}>
                      {isPM ? "Your Challenge" : "Analyst Response"}
                      {!isPM && msg.scoreAdjusted && msg.newScore != null &&
                        <span style={{ color: "#fbbf24", marginLeft: 8, fontWeight: 400 }}>
                          - Score revised to {msg.newScore}/5
                        </span>}
                    </div>
                    <p style={{ fontSize: 12, color: isPM ? "#bfdbfe" : "#bbf7d0", margin: "0 0 4px", lineHeight: 1.65 }}>
                      {msg.text || msg.response}
                    </p>
                    {!isPM && msg.sources?.length > 0 && <SourcesList sources={msg.sources} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
        <textarea
          value={inputVal}
          onChange={e => onInputChange(e.target.value)}
          placeholder={'Challenge this score... e.g. "Salesforce already does this - does that change the score?" (Cmd/Ctrl+Enter to send)'}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && inputVal?.trim() && !loading) onSubmit();
          }}
          style={{
            flex: 1, background: "#07090f", border: "1px solid #1e2535", borderRadius: 7,
            color: "#e2e8f0", padding: "7px 10px", fontSize: 11, resize: "none",
            minHeight: 50, lineHeight: 1.5, outline: "none", fontFamily: "inherit",
          }}
        />
        <button
          onClick={onSubmit}
          disabled={!inputVal?.trim() || loading}
          style={{
            background: inputVal?.trim() && !loading ? "#7c3aed" : "#101420",
            border: "none",
            color: inputVal?.trim() && !loading ? "#fff" : "#2d3748",
            padding: "8px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600,
            flexShrink: 0, display: "flex", alignItems: "center", gap: 5,
          }}>
          {loading ? <><Spinner size={10} color="#a855f7" /><span style={{ color: "#a855f7" }}>...</span></> : "Send ->"}
        </button>
      </div>
    </div>
  );
}
