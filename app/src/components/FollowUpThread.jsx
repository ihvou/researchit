import { useState } from "react";
import { intentDisplayLabel, pmIntentLabel } from "@researchit/engine";
import Spinner from "./Spinner";
import SourcesList from "./SourcesList";
import ChevronIcon from "./ChevronIcon";

function proposalTone(status) {
  if (status === "accepted") {
    return { bg: "var(--ck-surface-soft)", border: "var(--ck-line-strong)", text: "var(--ck-text)", label: "Accepted" };
  }
  if (status === "dismissed") {
    return { bg: "var(--ck-surface-soft)", border: "var(--ck-line)", text: "var(--ck-muted)", label: "Dismissed" };
  }
  return { bg: "var(--ck-surface-soft)", border: "var(--ck-line)", text: "var(--ck-text)", label: "Pending PM decision" };
}

function argumentUpdateText(msg) {
  const update = msg?.argumentUpdate;
  if (!update?.id || !update?.action) return "";
  const scope = update.group === "limiting" ? "Limiting factor" : "Supporting evidence";
  if (update.action === "discard") {
    return `${scope} ${update.id} discarded${update.reason ? ` - ${update.reason}` : ""}`;
  }
  if (update.action === "modify") {
    return `${scope} ${update.id} updated${update.reason ? ` - ${update.reason}` : ""}`;
  }
  if (update.action === "keep") {
    return `${scope} ${update.id} retained${update.reason ? ` - ${update.reason}` : ""}`;
  }
  return "";
}

export default function FollowUpThread({
  thread,
  inputVal,
  onInputChange,
  onSubmit,
  onResolveProposal,
  loading,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasMessages = thread?.length > 0;
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px dashed var(--ck-line-strong)" }}>
      {hasMessages && (
        <div style={{ marginBottom: 8 }}>
          <button
            onClick={() => setCollapsed(v => !v)}
            style={{ background: "none", border: "none", color: "var(--ck-muted)", fontSize: 11, padding: "0 0 6px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <ChevronIcon direction={collapsed ? "right" : "down"} size={11} />
            {collapsed
              ? `${thread.length} follow-up message${thread.length > 1 ? "s" : ""} - expand`
              : "Follow-up thread"}
          </button>
          {!collapsed && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {thread.map((msg, i) => {
                const isPM = msg.role === "pm";
                return (
                  <div key={i} style={{
                    background: isPM ? "var(--ck-surface-soft)" : "var(--ck-surface-soft)",
                    border: `1px solid ${isPM ? "var(--ck-line)" : "var(--ck-line)"}`,
                    borderRadius: 2, padding: "8px 12px",
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, color: isPM ? "var(--ck-text)" : "var(--ck-muted)" }}>
                      {isPM ? pmIntentLabel(msg.intent) : `Analyst - ${intentDisplayLabel(msg.intent)}`}
                      {!isPM && msg.scoreAdjusted && msg.newScore != null && (
                        <span style={{ color: "var(--ck-muted)", marginLeft: 8, fontWeight: 700 }}>
                          - Score now {msg.newScore}/5
                        </span>
                      )}
                    </div>
                    <p style={{ fontSize: 12, color: isPM ? "var(--ck-blue-ink)" : "var(--ck-muted)", margin: "0 0 4px", lineHeight: 1.65 }}>
                      {msg.text || msg.response}
                    </p>
                    {!isPM && msg.scoreProposal?.newScore != null && (
                      <div style={{
                        margin: "6px 0 6px",
                        border: `1px solid ${proposalTone(msg.scoreProposal.status).border}`,
                        background: proposalTone(msg.scoreProposal.status).bg,
                        borderRadius: 2,
                        padding: "7px 9px",
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: proposalTone(msg.scoreProposal.status).text, marginBottom: 3 }}>
                          Score proposal - {proposalTone(msg.scoreProposal.status).label}
                        </div>
                        <div style={{ fontSize: 12, color: proposalTone(msg.scoreProposal.status).text, marginBottom: msg.scoreProposal.status === "pending" ? 6 : 0 }}>
                          {msg.scoreProposal.previousScore}/5 {"->"} {msg.scoreProposal.newScore}/5
                          {msg.scoreProposal.reason ? ` | ${msg.scoreProposal.reason}` : ""}
                        </div>
                        {msg.scoreProposal.status === "pending" && (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              onClick={() => onResolveProposal?.(msg.id, "accept")}
                              style={{
                                border: "1px solid var(--ck-line)",
                                background: "var(--ck-surface-soft)",
                                color: "var(--ck-muted)",
                                borderRadius: 2,
                                fontSize: 11,
                                fontWeight: 700,
                                padding: "4px 8px",
                                cursor: "pointer",
                              }}>
                              Accept score update
                            </button>
                            <button
                              type="button"
                              onClick={() => onResolveProposal?.(msg.id, "dismiss")}
                              style={{
                                border: "1px solid var(--ck-line)",
                                background: "var(--ck-surface-soft)",
                                color: "var(--ck-muted)",
                                borderRadius: 2,
                                fontSize: 11,
                                fontWeight: 700,
                                padding: "4px 8px",
                                cursor: "pointer",
                              }}>
                              Dismiss proposal
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {!isPM && argumentUpdateText(msg) && (
                      <div style={{ margin: "4px 0 2px", fontSize: 10, color: "var(--ck-text)", fontWeight: 700 }}>
                        {argumentUpdateText(msg)}
                      </div>
                    )}
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
          placeholder={'Type naturally: challenge, question, reframe request, note, evidence URL/text, or re-search request. (Cmd/Ctrl+Enter to send)'}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && inputVal?.trim() && !loading) onSubmit();
          }}
          style={{
            flex: 1, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line-strong)", borderRadius: 2,
            color: "var(--ck-text)", padding: "7px 10px", fontSize: 11, resize: "none",
            minHeight: 50, lineHeight: 1.5, outline: "none", fontFamily: "inherit",
          }}
        />
        <button
          onClick={onSubmit}
          disabled={!inputVal?.trim() || loading}
          style={{
            background: inputVal?.trim() && !loading ? "var(--ck-accent)" : "var(--ck-surface-soft)",
            border: "none",
            color: inputVal?.trim() && !loading ? "var(--ck-accent-ink)" : "var(--ck-muted)",
            padding: "8px 14px", borderRadius: 2, fontSize: 12, fontWeight: 600,
            flexShrink: 0, display: "flex", alignItems: "center", gap: 5,
          }}>
          {loading ? <><Spinner size={10} color="var(--ck-text)" /><span style={{ color: "var(--ck-text)" }}>...</span></> : "Send"}
        </button>
      </div>
    </div>
  );
}
