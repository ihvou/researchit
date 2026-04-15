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
    modes: ["native"],
  },
  {
    key: "analyst_web",
    phase: "analyst_web",
    title: "Web-search LLM pass",
    detail: "Enumerates live web evidence, then applies rubric scoring from the enumerated evidence.",
    modes: ["native"],
  },
  {
    key: "analyst_reconcile",
    phase: "analyst_reconcile",
    title: "Reliability reconcile",
    detail: "Compares baseline and web drafts, then keeps the strongest evidence-backed points.",
    modes: ["native"],
  },
  {
    key: "deep_assist_collect",
    phase: "deep_assist_collect",
    title: "Deep Assist provider collection",
    detail: "Runs independent Deep Assist evidence passes (ChatGPT / Claude / Gemini profile adapters).",
    modes: ["deep-assist"],
  },
  {
    key: "deep_assist_merge",
    phase: "deep_assist_merge",
    title: "Deep Assist merge",
    detail: "Merges provider evidence, computes agreement/disagreement, and carries conflicts into targeted recovery.",
    modes: ["deep-assist"],
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
    key: "red_team",
    phase: "red_team",
    title: "Red Team stress test",
    detail: "Builds strongest counter-case and appends explicit risk pressure against current conclusion.",
  },
  {
    key: "synthesizer",
    phase: "synthesizer",
    title: "Independent synthesis",
    detail: "Generates executive narrative from structured signals, confidence, and red-team findings.",
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
    key: "matrix_deep_assist",
    phase: "matrix_deep_assist",
    title: "Deep Assist matrix enrichment",
    detail: "Merges provider-level matrix passes and records per-cell agreement signals.",
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
    key: "matrix_consistency",
    phase: "matrix_consistency",
    title: "Cross-subject consistency audit",
    detail: "Detects and downgrades contradictory cells across subjects within the same attribute.",
  },
  {
    key: "matrix_derived",
    phase: "matrix_derived",
    title: "Derived attributes",
    detail: "Computes derived columns only after evidence, critic, and consistency checks finish.",
  },
  {
    key: "matrix_red_team",
    phase: "matrix_red_team",
    title: "Red Team stress test",
    detail: "Constructs strongest matrix counter-case and appends per-cell risk pressure.",
  },
  {
    key: "matrix_synthesis",
    phase: "matrix_synthesis",
    title: "Executive synthesis",
    detail: "Builds decision-grade summary with threats, whitespace, risks, and uncertainty notes.",
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
  red_team: "red_team",
  synthesizer: "synthesizer",
  deep_assist_collect: "deep_assist_collect",
  deep_assist_merge: "deep_assist_merge",
};

const MATRIX_PHASE_ALIASES = {
  matrix_evidence: "matrix_web",
  matrix_deep_assist: "matrix_deep_assist",
  matrix_red_team: "matrix_red_team",
};

function resolveProgressPhase(phase, outputMode) {
  const value = String(phase || "").trim();
  if (!value) return "submitted";
  if (outputMode === "matrix") return MATRIX_PHASE_ALIASES[value] || value;
  return SCORECARD_PHASE_ALIASES[value] || value;
}

function flowByEvidenceMode(flow = [], evidenceMode = "native") {
  return flow.filter((step) => {
    if (!Array.isArray(step?.modes) || !step.modes.length) return true;
    return step.modes.includes(evidenceMode);
  });
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

function percent(value, decimals = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(decimals)}%`;
}

export function diagnosticRows(uc, outputMode = "scorecard") {
  const meta = uc?.analysisMeta || {};
  const rows = [];

  if (meta?.qualityGrade === "degraded") {
    const reasons = Array.isArray(meta?.degradedReasons) ? meta.degradedReasons : [];
    rows.push({
      label: "Quality grade",
      value: "Degraded",
      detail: reasons.length
        ? reasons.map((entry) => entry?.detail || entry?.code).filter(Boolean).join(" | ")
        : "Quality guard triggered one or more degraded-complete reasons.",
    });
  } else {
    rows.push({
      label: "Quality grade",
      value: "Standard",
      detail: "Run completed without degraded-quality guard triggers.",
    });
  }

  const checked = Number(meta.sourceVerificationChecked || 0);
  const verified = Number(meta.sourceVerificationVerified || 0);
  const notFound = Number(meta.sourceVerificationNotFound || 0);
  const failed = Number(meta.sourceVerificationFetchFailed || 0);
  const invalidUrl = Number(meta.sourceVerificationInvalidUrl || 0);
  const partial = Number(meta.sourceVerificationPartialMatch || 0);
  const nameOnly = Number(meta.sourceVerificationNameOnly || 0);
  if (checked > 0) {
    rows.push({
      label: "Source verification",
      value: `${verified}/${checked} verified (${percent(checked ? verified / checked : 0)})`,
      detail: `${notFound} not found, ${failed} fetch failures, ${invalidUrl} invalid URL, ${partial + nameOnly} partial/name-only matches`,
    });
  } else if (meta.sourceVerificationSkippedReason) {
    rows.push({
      label: "Source verification",
      value: "Skipped",
      detail: String(meta.sourceVerificationSkippedReason),
    });
  }

  const analystCalls = Number(meta.webSearchCalls || 0);
  const criticCalls = Number(meta.criticWebSearchCalls || 0);
  const discoveryCalls = Number(meta.discoveryWebSearchCalls || 0);
  const targetedCalls = Number(meta.lowConfidenceTargetedWebSearchCalls || 0);
  rows.push({
    label: "Web search usage",
    value: `${analystCalls + criticCalls + discoveryCalls + targetedCalls} calls`,
    detail: `analyst ${analystCalls}, critic ${criticCalls}, targeted ${targetedCalls}, discovery ${discoveryCalls}`,
  });

  const staleRatio = Number(meta.staleEvidenceRatio);
  if (Number.isFinite(staleRatio)) {
    rows.push({
      label: "Stale evidence ratio",
      value: percent(staleRatio, 1),
      detail: outputMode === "matrix"
        ? `${Number(meta.staleEvidenceObservedCells || 0)} cells assessed for freshness`
        : `${Number(meta.staleEvidenceObservedDimensions || 0)} dimensions assessed for freshness`,
    });
  }

  const providerBreakdown = [];
  const pushProviderRows = (items = []) => {
    (Array.isArray(items) ? items : []).forEach((entry) => {
      const name = String(entry?.label || entry?.provider || entry?.providerId || "").trim();
      if (!name) return;
      const calls = Number(entry?.webSearchCalls || 0);
      const status = String(entry?.status || "").trim();
      providerBreakdown.push(`${name}${status ? ` (${status})` : ""}: ${calls}`);
    });
  };
  pushProviderRows(meta?.providerContributions?.deepAssist);
  pushProviderRows(meta?.providerContributions?.native);
  if (providerBreakdown.length) {
    rows.push({
      label: "Provider contribution",
      value: `${providerBreakdown.length} channels`,
      detail: providerBreakdown.join(" | "),
    });
  }

  const sourceUniverse = meta?.sourceUniverse && typeof meta.sourceUniverse === "object"
    ? meta.sourceUniverse
    : null;
  if (sourceUniverse && Number(sourceUniverse.total || 0) > 0) {
    rows.push({
      label: "Source universe",
      value: `${Number(sourceUniverse.total || 0)} sources`,
      detail: `cited ${Number(sourceUniverse.cited || 0)}, corroborating ${Number(sourceUniverse.corroborating || 0)}, unverified ${Number(sourceUniverse.unverified || 0)}, excluded marketing ${Number(sourceUniverse.excludedMarketing || 0)}, excluded stale ${Number(sourceUniverse.excludedStale || 0)}`,
    });
  }

  if (meta.redTeamCallMade != null) {
    rows.push({
      label: "Red Team",
      value: meta.redTeamCallMade ? "Applied" : "Not applied",
      detail: `High severity findings: ${Number(meta.redTeamHighSeverityCount || 0)}`,
    });
  }

  if (meta.synthesizerCallMade != null) {
    rows.push({
      label: "Synthesizer",
      value: meta.synthesizerCallMade ? "Applied" : "Not applied",
      detail: String(meta.synthesizerModel || "model not recorded"),
    });
  }

  const budgetUnits = Number(meta.lowConfidenceBudgetUnits || meta.lowConfidenceBudgetCells || 0);
  const budgetUsed = Number(meta.lowConfidenceBudgetUsed || 0);
  if (budgetUnits > 0) {
    rows.push({
      label: "Targeted budget",
      value: `${budgetUsed}/${budgetUnits}`,
      detail: `Dropped by budget: ${Number(meta.lowConfidenceDroppedByBudget || 0)} | Strategy: ${String(meta.lowConfidenceBudgetStrategy || "adaptive")} | Round-robin: ${meta.lowConfidenceRoundRobinApplied ? "enabled" : "off"}`,
    });
  }

  if (meta.targetedRetrievalNiche || (Array.isArray(meta.targetedRetrievalAliases) && meta.targetedRetrievalAliases.length)) {
    rows.push({
      label: "Niche strategist",
      value: String(meta.targetedRetrievalNiche || "detected"),
      detail: Array.isArray(meta.targetedRetrievalAliases) && meta.targetedRetrievalAliases.length
        ? `Aliases: ${meta.targetedRetrievalAliases.join(", ")}`
        : "No alias expansions returned",
    });
  }

  if (outputMode === "matrix") {
    const coverage = uc?.matrix?.coverage || {};
    if (meta?.decisionGradeGate?.enabled) {
      rows.push({
        label: "Decision grade",
        value: meta.decisionGradePassed ? "Passed" : "Not passed",
        detail: meta.decisionGradePassed
          ? "All decision-grade checks passed."
          : String(meta.decisionGradeFailureReason || "Decision-grade requirements were not met."),
      });
    }
    const criticFlags = Number(meta.criticFlagsRaised || 0);
    const criticAudited = Number(meta.criticCellsAudited || coverage.totalCells || 0);
    const flagRate = Number(meta.criticFlagRate || 0);
    rows.push({
      label: "Critic coverage",
      value: `${criticFlags}/${criticAudited} flags (${percent(flagRate)})`,
      detail: meta.criticFlagRateAlert ? String(meta.criticFlagRateAlert) : "Flag rate monitor active",
    });

    const slaPassed = !!meta.matrixCoverageSLAPassed;
    const slaDiag = meta.matrixCoverageSLA || {};
    rows.push({
      label: "Coverage SLA",
      value: slaPassed ? "Passed" : "Not passed",
      detail: slaPassed
        ? `unresolved ${Number(slaDiag.unresolvedCells || 0)}/${Number(slaDiag.totalCells || coverage.totalCells || 0)}`
        : String(meta.matrixCoverageSLAFailureReason || "Coverage threshold not met."),
    });

    if (meta.matrixHybridStats) {
      const stats = meta.matrixHybridStats;
      rows.push({
        label: "Reconcile deltas",
        value: `vs baseline ${Number(stats.changedFromBaseline || 0)}, vs web ${Number(stats.changedFromWeb || 0)}`,
        detail: `${Number(stats.totalCells || 0)} total cells`,
      });
    }

    if (meta.matrixReconcileRetryTriggered) {
      rows.push({
        label: "Reconcile quality retry",
        value: meta.matrixReconcileRetryUsed ? "Applied" : "Attempted (kept initial)",
        detail: String(meta.matrixReconcileRetryReason || "Quality guard triggered a targeted reconcile retry."),
      });
    }
  } else {
    const hybrid = meta.hybridStats || {};
    if (hybrid && Object.keys(hybrid).length) {
      rows.push({
        label: "Hybrid reconcile",
        value: `vs baseline ${Number(hybrid.changedFromBaseline || 0)}, vs web ${Number(hybrid.changedFromWeb || 0)}`,
        detail: `weighted baseline ${hybrid.baselineWeightedScore ?? "-"}%, web ${hybrid.webWeightedScore ?? "-"}%, final ${hybrid.reconciledWeightedScore ?? "-"}%`,
      });
    }

    if (meta.hybridReconcileRetryTriggered) {
      rows.push({
        label: "Reconcile quality retry",
        value: meta.hybridReconcileRetryUsed ? "Applied" : "Attempted (kept initial)",
        detail: String(meta.hybridReconcileRetryReason || "Quality guard triggered a targeted reconcile retry."),
      });
    }

    const lowInitial = Number(meta.lowConfidenceInitialCount || 0);
    const upgraded = Number(meta.lowConfidenceUpgradedCount || 0);
    const validatedLow = Number(meta.lowConfidenceValidatedLowCount || 0);
    const cycleFailures = Number(meta.lowConfidenceCycleFailures || 0);
    rows.push({
      label: "Low-confidence cycle",
      value: `${lowInitial} scanned, ${upgraded} upgraded`,
      detail: `${validatedLow} validated low, ${cycleFailures} failures`,
    });

    const decisionAdjustments = Number(meta.phase3DecisionGuardAdjustments || 0);
    const confidenceAdjustments = Number(meta.phase3ConfidenceGuardAdjustments || 0);
    const polarityAdjustments = Number(meta.phase3PolarityGuardAdjustments || 0);
    rows.push({
      label: "Final guard adjustments",
      value: `${decisionAdjustments + confidenceAdjustments + polarityAdjustments} total`,
      detail: `decision ${decisionAdjustments}, confidence ${confidenceAdjustments}, polarity ${polarityAdjustments}`,
    });
  }

  return rows;
}

export default function ProgressTab({ uc, outputMode = "scorecard" }) {
  const evidenceMode = String(uc?.analysisMeta?.evidenceMode || "native").trim().toLowerCase() === "deep-assist"
    ? "deep-assist"
    : "native";
  const flow = flowByEvidenceMode(outputMode === "matrix" ? MATRIX_FLOW : HYBRID_FLOW, evidenceMode);
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
          ? (evidenceMode === "deep-assist"
            ? "Live view of matrix flow: native evidence passes, Deep Assist provider merge, targeted recovery, critic audit, consistency checks, and executive synthesis."
            : "Live view of the matrix pipeline: planning, baseline/web reconcile, targeted low-confidence recovery, critic audit, and analyst resolution.")
          : (evidenceMode === "deep-assist"
            ? "Live view of Deep Assist flow: multi-provider evidence collection, agreement merge, targeted recovery, critic audit, and final score update."
            : "Live view of the pipeline under the hood: baseline evidence pass, web evidence pass, reconcile, targeted low-confidence re-check, critic audit, and final score update.")}
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
          {outputMode === "matrix"
            ? (
              <>
                In <strong>Debate & Challenges</strong>, challenge any matrix cell directly in its thread.
                The Analyst responds with evidence updates and confidence adjustments for that exact subject-attribute cell.
              </>
            )
            : (
              <>
                In <strong>Debate & Challenges</strong>, send follow-up facts, questions, or objections on any dimension.
                The Analyst LLM responds in-thread and may propose score updates; you explicitly accept or dismiss each proposal.
              </>
            )}
        </div>
      </div>

      {uc.status === "error" && (
        <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 2, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", color: "var(--ck-text)", fontSize: 12 }}>
          Analysis stopped: {uc.errorMsg || "Unexpected error."}
        </div>
      )}
    </div>
  );
}
