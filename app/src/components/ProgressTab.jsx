const HYBRID_FLOW = [
  {
    key: "submitted",
    phase: "submitted",
    title: "Use case submitted",
    detail: "The request is queued and the analysis pipeline started.",
  },
  {
    key: "analyst_baseline",
    phase: "analyst_baseline",
    title: "Analyst LLM baseline pass",
    detail: "Enumerates evidence first, then applies rubric scoring from that evidence (memory-only pass).",
  },
  {
    key: "analyst_web",
    phase: "analyst_web",
    title: "Web-search LLM pass",
    detail: "Enumerates live web evidence, then applies rubric scoring from the enumerated evidence.",
  },
  {
    key: "analyst_reconcile",
    phase: "analyst_reconcile",
    title: "Reliability reconcile",
    detail: "Compares baseline and web drafts, then keeps the strongest evidence-backed points.",
  },
  {
    key: "analyst_targeted",
    phase: "analyst_targeted",
    title: "Targeted low-confidence cycle",
    detail: "For low-confidence dimensions, generates precise queries, runs focused web search, and re-checks confidence.",
  },
  {
    key: "critic",
    phase: "critic",
    title: "Critic LLM review",
    detail: "A skeptical model audits analyst claims against current web evidence and challenges weak assumptions.",
  },
  {
    key: "finalizing",
    phase: "finalizing",
    title: "Analyst LLM final response",
    detail: "Resolves critique, updates score cards, and prepares final per-dimension rationale.",
  },
  {
    key: "discover",
    phase: "discover",
    title: "Related use case discovery",
    detail: "Generates sharper variants targeting weak dimensions, grounded in the same evidence-first pipeline.",
  },
  {
    key: "complete",
    phase: "complete",
    title: "Final report ready",
    detail: "All dimensions, evidence, and exports are ready.",
  },
];

function phaseRankMap(flow) {
  const map = {};
  flow.forEach((step, idx) => {
    map[step.phase] = idx;
  });
  return map;
}

function getStepState(step, idx, currentIdx, uc) {
  if (step.phase === "submitted") return "done";
  if (step.phase === "complete") {
    return uc.status === "complete" ? "done" : "pending";
  }
  if (currentIdx > idx) return "done";
  if (currentIdx === idx && uc.status === "analyzing") return "active";
  if (uc.status === "error" && currentIdx <= idx) return "failed";
  return "pending";
}

function stateLabel(state) {
  if (state === "done") return "Done";
  if (state === "active") return "In progress";
  if (state === "failed") return "Blocked";
  return "Pending";
}

function stateColor(state) {
  if (state === "done") return "#12805c";
  if (state === "active") return "var(--ck-blue)";
  if (state === "failed") return "#b42318";
  return "var(--ck-muted-soft)";
}

function stateBackground(state) {
  if (state === "done") return "#e8f8f1";
  if (state === "active") return "#e8ecff";
  if (state === "failed") return "#fff0ee";
  return "#f2f5ff";
}

export default function ProgressTab({ uc }) {
  const flow = HYBRID_FLOW;
  const rank = phaseRankMap(flow);
  const currentIdx = rank[uc.phase] ?? 0;

  return (
    <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 12, padding: "14px 16px", width: "100%", maxWidth: "100%", minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-blue)", textTransform: "uppercase", letterSpacing: 0.9, marginBottom: 8 }}>
        Research Progress
      </div>
      <p style={{ fontSize: 12, color: "var(--ck-muted)", margin: "0 0 12px", lineHeight: 1.55 }}>
        Live view of the pipeline under the hood: baseline evidence pass, web evidence pass, reconcile, targeted low-confidence re-check, critic audit, and final score update.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {flow.map((step, idx) => {
          const state = getStepState(step, idx, currentIdx, uc);
          return (
            <div
              key={step.key}
              style={{
                display: "grid",
                gridTemplateColumns: "18px minmax(0,1fr) auto",
                alignItems: "flex-start",
                gap: 10,
                padding: "9px 10px",
                borderRadius: 8,
                border: "1px solid var(--ck-line)",
                background: "var(--ck-surface-soft)",
              }}>
              <input type="checkbox" checked={state === "done"} readOnly style={{ marginTop: 2, accentColor: "var(--ck-blue)" }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ck-text)", marginBottom: 2 }}>{step.title}</div>
                <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45 }}>{step.detail}</div>
              </div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: stateColor(state),
                  background: stateBackground(state),
                  border: "1px solid var(--ck-line)",
                  borderRadius: 999,
                  padding: "2px 7px",
                  whiteSpace: "nowrap",
                }}>
                {stateLabel(state)}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid #b8e8d0",
        background: "#ebf8f0",
      }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#0f7a55", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.7 }}>
          💬 Interactive Challenge Loop
        </div>
        <div style={{ fontSize: 12, color: "#17583f", lineHeight: 1.5 }}>
          In <strong>Debate & Challenges</strong>, send follow-up facts, questions, or objections on any dimension.
          The Analyst LLM responds in-thread and may propose score updates; you explicitly accept or dismiss each proposal.
        </div>
      </div>

      {uc.status === "error" && (
        <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "#fff0ee", border: "1px solid #f2c7be", color: "#b42318", fontSize: 12 }}>
          Analysis stopped: {uc.errorMsg || "Unexpected error."}
        </div>
      )}
    </div>
  );
}
