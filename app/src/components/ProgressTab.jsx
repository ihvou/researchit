import Spinner from "./Spinner";

const HYBRID_FLOW = [
  {
    key: "submitted",
    phase: "submitted",
    title: "Research submitted",
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
    title: "Related research discovery",
    detail: "Generates sharper variants targeting weak dimensions, grounded in the same evidence-first pipeline.",
  },
  {
    key: "complete",
    phase: "complete",
    title: "Final report ready",
    detail: "All dimensions, evidence, and exports are ready.",
  },
];

const MATRIX_FLOW = [
  {
    key: "submitted",
    phase: "submitted",
    title: "Research submitted",
    detail: "The matrix request is queued and execution started.",
  },
  {
    key: "matrix_plan",
    phase: "matrix_plan",
    title: "Matrix planning",
    detail: "Resolves decision question, subject set, and subject × attribute coverage plan.",
  },
  {
    key: "matrix_baseline",
    phase: "matrix_baseline",
    title: "Baseline matrix pass",
    detail: "Builds a memory-only analyst draft for every matrix cell.",
  },
  {
    key: "matrix_web",
    phase: "matrix_web",
    title: "Web matrix pass",
    detail: "Builds a web-assisted draft for every matrix cell with current evidence.",
  },
  {
    key: "matrix_reconcile",
    phase: "matrix_reconcile",
    title: "Matrix reconcile",
    detail: "Merges baseline and web drafts, keeping stronger evidence-backed cells.",
  },
  {
    key: "matrix_targeted",
    phase: "matrix_targeted",
    title: "Targeted low-confidence recovery",
    detail: "Runs focused query plans for low-confidence cells and upgrades confidence where possible.",
  },
  {
    key: "matrix_critic",
    phase: "matrix_critic",
    title: "Critic matrix audit",
    detail: "Flags weak or contradictory cells and adjusts confidence where needed.",
  },
  {
    key: "matrix_response",
    phase: "matrix_response",
    title: "Analyst response to flags",
    detail: "Defends or concedes contested cells with updated evidence.",
  },
  {
    key: "matrix_summary",
    phase: "matrix_summary",
    title: "Editorial summaries",
    detail: "Generates per-subject summaries and cross-matrix observations.",
  },
  {
    key: "matrix_discover",
    phase: "matrix_discover",
    title: "Missing coverage discovery",
    detail: "Suggests missed subjects and attributes for completeness.",
  },
  {
    key: "complete",
    phase: "complete",
    title: "Final matrix ready",
    detail: "All matrix cells and confidence flags are ready.",
  },
];

function phaseRankMap(flow) {
  const map = {};
  flow.forEach((step, idx) => {
    map[step.phase] = idx;
  });
  return map;
}

const SCORECARD_PHASE_ALIASES = {
  analyst: "analyst_baseline",
  analyst_evidence: "analyst_baseline",
  analyst_scoring: "analyst_web",
  analyst_targeted_query_plan: "analyst_targeted",
  analyst_targeted_search: "analyst_targeted",
  analyst_targeted_rescore: "analyst_targeted",
  analyst_source_verification: "analyst_targeted",
  critic_source_verification: "critic",
  finalizing_consistency: "finalizing",
  final_source_verification: "finalizing",
};

const MATRIX_PHASE_ALIASES = {
  matrix_evidence: "matrix_web",
};

function resolveProgressPhase(phase, outputMode) {
  const value = String(phase || "").trim();
  if (!value) return "submitted";
  if (outputMode === "matrix") return MATRIX_PHASE_ALIASES[value] || value;
  return SCORECARD_PHASE_ALIASES[value] || value;
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
  if (state === "done") return "var(--ck-text)";
  if (state === "active") return "var(--ck-text)";
  if (state === "failed") return "var(--ck-text)";
  return "var(--ck-muted-soft)";
}

function stateBackground(state) {
  if (state === "done") return "var(--ck-surface-soft)";
  if (state === "active") return "var(--ck-surface-soft)";
  if (state === "failed") return "var(--ck-surface-soft)";
  return "var(--ck-surface-soft)";
}

export default function ProgressTab({ uc, outputMode = "scorecard" }) {
  const flow = outputMode === "matrix" ? MATRIX_FLOW : HYBRID_FLOW;
  const rank = phaseRankMap(flow);
  const resolvedPhase = resolveProgressPhase(uc.phase, outputMode);
  const currentIdx = rank[resolvedPhase] ?? 0;

  return (
    <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "14px 16px", width: "100%", maxWidth: "100%", minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.9, marginBottom: 8 }}>
        Research Progress
      </div>
      <p style={{ fontSize: 12, color: "var(--ck-muted)", margin: "0 0 12px", lineHeight: 1.55 }}>
        {outputMode === "matrix"
          ? "Live view of the matrix pipeline: planning, baseline/web reconcile, targeted low-confidence recovery, critic audit, and analyst resolution."
          : "Live view of the pipeline under the hood: baseline evidence pass, web evidence pass, reconcile, targeted low-confidence re-check, critic audit, and final score update."}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {flow.map((step, idx) => {
          const state = getStepState(step, idx, currentIdx, uc);
          const isActive = state === "active";
          return (
            <div
              key={step.key}
              style={{
                display: "grid",
                gridTemplateColumns: "18px minmax(0,1fr) auto",
                alignItems: "flex-start",
                gap: 10,
                padding: "9px 10px",
                borderRadius: 2,
                border: `1px solid ${isActive ? "var(--ck-line-strong)" : "var(--ck-line)"}`,
                background: "var(--ck-surface-soft)",
              }}>
              {isActive ? (
                <div style={{ marginTop: 2, display: "grid", placeItems: "center" }}>
                  <Spinner size={10} color="var(--ck-text)" />
                </div>
              ) : (
                <input type="checkbox" checked={state === "done"} readOnly style={{ marginTop: 2, accentColor: "var(--ck-accent)" }} />
              )}
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
                  borderRadius: 2,
                  padding: "2px 7px",
                  whiteSpace: "nowrap",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                }}>
                {isActive ? <Spinner size={9} color="var(--ck-text)" /> : null}
                {stateLabel(state)}
              </span>
            </div>
          );
        })}
      </div>

      {outputMode !== "matrix" && (
        <div style={{
          marginTop: 12,
          padding: "10px 12px",
          borderRadius: 2,
          border: "1px solid var(--ck-line)",
          background: "var(--ck-surface-soft)",
        }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--ck-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.7 }}>
            Challenge Loop
          </div>
          <div style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.5 }}>
            In <strong>Debate & Challenges</strong>, send follow-up facts, questions, or objections on any dimension.
            The Analyst LLM responds in-thread and may propose score updates; you explicitly accept or dismiss each proposal.
          </div>
        </div>
      )}

      {uc.status === "error" && (
        <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 2, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", color: "var(--ck-text)", fontSize: 12 }}>
          Analysis stopped: {uc.errorMsg || "Unexpected error."}
        </div>
      )}
    </div>
  );
}
