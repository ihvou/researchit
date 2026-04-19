import Spinner from "./Spinner";

const SHOW_PROGRESS_COSTS = String(import.meta.env.VITE_SHOW_PROGRESS_COSTS ?? "true").trim().toLowerCase() !== "false";

const HYBRID_FLOW = [
  {
    key: "submitted",
    phase: "submitted",
    title: "Research submitted",
    detail: "The request is queued and the analysis pipeline started.",
  },
  {
    key: "stage_01_intake",
    phase: "stage_01_intake",
    title: "Stage 01 - Input intake",
    detail: "Validates your request and normalizes inputs before research begins.",
  },
  {
    key: "stage_02_plan",
    phase: "stage_02_plan",
    title: "Stage 02 - Planning",
    detail: "Builds per-dimension research queries, source targets, and gap hypotheses.",
  },
  {
    key: "stage_03a_evidence_memory",
    phase: "stage_03a_evidence_memory",
    title: "Stage 03a - Memory evidence",
    detail: "Collects first-pass evidence from model memory for each dimension (no live web).",
    modes: ["native"],
  },
  {
    key: "stage_03b_evidence_web",
    phase: "stage_03b_evidence_web",
    title: "Stage 03b - Web evidence",
    detail: "Adds cited web evidence to strengthen or correct each dimension.",
    modes: ["native"],
  },
  {
    key: "stage_03c_evidence_deep_assist",
    phase: "stage_03c_evidence_deep_assist",
    title: "Stage 03c - Deep Research ×3 evidence",
    detail: "Runs ChatGPT Deep Research, Claude Research, and Gemini Deep Research in parallel.",
    modes: ["deep-research-x3", "deep-assist"],
  },
  {
    key: "stage_04_merge",
    phase: "stage_04_merge",
    title: "Stage 04 - Evidence merge",
    detail: "Combines evidence drafts into one traceable evidence bundle.",
  },
  {
    key: "stage_05_score_confidence",
    phase: "stage_05_score_confidence",
    title: "Stage 05 - Score + confidence",
    detail: "Applies rubric-based scoring and calibrated confidence per dimension.",
  },
  {
    key: "stage_06_source_verify",
    phase: "stage_06_source_verify",
    title: "Stage 06 - Source verification",
    detail: "Checks cited URLs and whether source content supports the cited claim.",
  },
  {
    key: "stage_07_source_assess",
    phase: "stage_07_source_assess",
    title: "Stage 07 - Source assessment",
    detail: "Applies source-quality labels and confidence caps before critic review.",
  },
  {
    key: "stage_08_recover",
    phase: "stage_08_recover",
    title: "Stage 08 - Targeted recovery",
    detail: "Runs coverage-first recovery passes on weak/low-confidence units.",
  },
  {
    key: "stage_09_rescore",
    phase: "stage_09_rescore",
    title: "Stage 09 - Re-score",
    detail: "Applies recovery patch and updates scores/values/confidence.",
  },
  {
    key: "stage_10_coherence",
    phase: "stage_10_coherence",
    title: "Stage 10 - Coherence",
    detail: "Critic audits cross-unit consistency and contradiction patterns.",
  },
  {
    key: "stage_11_challenge",
    phase: "stage_11_challenge",
    title: "Stage 11 - Challenge",
    detail: "Critic pressure-tests overclaims and confidence calibration.",
  },
  {
    key: "stage_12_counter_case",
    phase: "stage_12_counter_case",
    title: "Stage 12 - Counter-case",
    detail: "Critic gathers disconfirming evidence and missed-risk signals.",
  },
  {
    key: "stage_13_defend",
    phase: "stage_13_defend",
    title: "Stage 13 - Concede / defend",
    detail: "Analyst resolves every critic flag with accept/reject rationale.",
  },
  {
    key: "stage_14_synthesize",
    phase: "stage_14_synthesize",
    title: "Stage 14 - Synthesize",
    detail: "Analyst writes executive synthesis, decision implication, and uncertainty notes.",
  },
  {
    key: "stage_15_finalize",
    phase: "stage_15_finalize",
    title: "Stage 15 - Finalize",
    detail: "Applies quality gates and emits final artifact or terminal outcome.",
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
    key: "stage_01_intake",
    phase: "stage_01_intake",
    title: "Stage 01 - Input intake",
    detail: "Validates your matrix request and normalizes inputs before research begins.",
  },
  {
    key: "stage_01b_subject_discovery",
    phase: "stage_01b_subject_discovery",
    title: "Stage 01b - Subject discovery",
    detail: "Discovers subjects only when you did not provide them.",
  },
  {
    key: "stage_02_plan",
    phase: "stage_02_plan",
    title: "Stage 02 - Planning",
    detail: "Builds attribute-level research queries, source targets, and gap hypotheses.",
  },
  {
    key: "stage_03a_evidence_memory",
    phase: "stage_03a_evidence_memory",
    title: "Stage 03a - Memory evidence",
    detail: "Collects first-pass evidence from model memory for each subject × attribute cell.",
    modes: ["native"],
  },
  {
    key: "stage_03b_evidence_web",
    phase: "stage_03b_evidence_web",
    title: "Stage 03b - Web evidence",
    detail: "Adds cited web evidence for each subject × attribute cell.",
    modes: ["native"],
  },
  {
    key: "stage_03c_evidence_deep_assist",
    phase: "stage_03c_evidence_deep_assist",
    title: "Stage 03c - Deep Research ×3 evidence",
    detail: "Runs three-provider parallel Deep Research evidence collection.",
    modes: ["deep-research-x3", "deep-assist"],
  },
  {
    key: "stage_04_merge",
    phase: "stage_04_merge",
    title: "Stage 04 - Evidence merge",
    detail: "Combines evidence drafts into one per-cell bundle with provenance and agreement signals.",
  },
  {
    key: "stage_05_score_confidence",
    phase: "stage_05_score_confidence",
    title: "Stage 05 - Score + confidence",
    detail: "Converts per-cell evidence into assessed values with calibrated confidence.",
  },
  {
    key: "stage_06_source_verify",
    phase: "stage_06_source_verify",
    title: "Stage 06 - Source verification",
    detail: "Checks cited URLs and whether source content supports the cited claim.",
  },
  {
    key: "stage_07_source_assess",
    phase: "stage_07_source_assess",
    title: "Stage 07 - Source assessment",
    detail: "Applies source-quality labels and confidence caps before critic review.",
  },
  {
    key: "stage_08_recover",
    phase: "stage_08_recover",
    title: "Stage 08 - Targeted recovery",
    detail: "Runs coverage-first cell recovery with bounded same-attribute groups.",
  },
  {
    key: "stage_09_rescore",
    phase: "stage_09_rescore",
    title: "Stage 09 - Re-score",
    detail: "Applies recovery patch to matrix cells and confidence.",
  },
  {
    key: "stage_10_coherence",
    phase: "stage_10_coherence",
    title: "Stage 10 - Coherence",
    detail: "Critic audits cross-row and cross-column coherence and contradictions.",
  },
  {
    key: "stage_11_challenge",
    phase: "stage_11_challenge",
    title: "Stage 11 - Challenge",
    detail: "Critic pressure-tests strongest matrix claims.",
  },
  {
    key: "stage_12_counter_case",
    phase: "stage_12_counter_case",
    title: "Stage 12 - Counter-case",
    detail: "Critic gathers disconfirming evidence and missed-risk signals.",
  },
  {
    key: "stage_13_defend",
    phase: "stage_13_defend",
    title: "Stage 13 - Concede / defend",
    detail: "Analyst resolves critic flags with explicit outcomes.",
  },
  {
    key: "stage_14_synthesize",
    phase: "stage_14_synthesize",
    title: "Stage 14 - Synthesize",
    detail: "Analyst writes executive matrix narrative and decision implication.",
  },
  {
    key: "stage_15_finalize",
    phase: "stage_15_finalize",
    title: "Stage 15 - Finalize",
    detail: "Applies quality gates and emits final artifact or terminal outcome.",
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
  analyst: "stage_03a_evidence_memory",
  analyst_evidence: "stage_03a_evidence_memory",
  analyst_scoring: "stage_05_score_confidence",
  analyst_targeted_query_plan: "stage_08_recover",
  analyst_targeted_search: "stage_08_recover",
  analyst_targeted_rescore: "stage_09_rescore",
  analyst_source_verification: "stage_06_source_verify",
  critic_source_verification: "stage_10_coherence",
  finalizing_consistency: "stage_15_finalize",
  final_source_verification: "stage_15_finalize",
  red_team: "stage_12_counter_case",
  synthesizer: "stage_14_synthesize",
  deep_research_x3_collect: "stage_03c_evidence_deep_assist",
  deep_research_x3_merge: "stage_04_merge",
  deep_assist_collect: "stage_03c_evidence_deep_assist",
  deep_assist_merge: "stage_04_merge",
  stage_01_intake: "submitted",
  stage_01b_subject_discovery: "stage_02_plan",
  stage_02_plan: "stage_02_plan",
  stage_03a_evidence_memory: "stage_03a_evidence_memory",
  stage_03b_evidence_web: "stage_03b_evidence_web",
  stage_03c_evidence_deep_assist: "stage_03c_evidence_deep_assist",
  stage_04_merge: "stage_04_merge",
  stage_05_score_confidence: "stage_05_score_confidence",
  stage_06_source_verify: "stage_06_source_verify",
  stage_07_source_assess: "stage_07_source_assess",
  stage_08_recover: "stage_08_recover",
  stage_09_rescore: "stage_09_rescore",
  stage_10_coherence: "stage_10_coherence",
  stage_11_challenge: "stage_11_challenge",
  stage_12_counter_case: "stage_12_counter_case",
  stage_13_defend: "stage_13_defend",
  stage_14_synthesize: "stage_14_synthesize",
  stage_15_finalize: "complete",
};

const MATRIX_PHASE_ALIASES = {
  matrix_evidence: "stage_03b_evidence_web",
  matrix_deep_research_x3: "stage_03c_evidence_deep_assist",
  matrix_deep_assist: "stage_03c_evidence_deep_assist",
  matrix_red_team: "stage_12_counter_case",
  matrix_plan: "stage_02_plan",
  matrix_baseline: "stage_03a_evidence_memory",
  matrix_web: "stage_03b_evidence_web",
  matrix_reconcile: "stage_04_merge",
  matrix_targeted: "stage_08_recover",
  matrix_critic: "stage_11_challenge",
  matrix_response: "stage_13_defend",
  matrix_consistency: "stage_10_coherence",
  matrix_derived: "stage_09_rescore",
  matrix_synthesis: "stage_14_synthesize",
  matrix_summary: "stage_15_finalize",
  matrix_discover: "stage_01b_subject_discovery",
  stage_01_intake: "submitted",
  stage_01b_subject_discovery: "stage_01b_subject_discovery",
  stage_02_plan: "stage_02_plan",
  stage_03a_evidence_memory: "stage_03a_evidence_memory",
  stage_03b_evidence_web: "stage_03b_evidence_web",
  stage_03c_evidence_deep_assist: "stage_03c_evidence_deep_assist",
  stage_04_merge: "stage_04_merge",
  stage_05_score_confidence: "stage_05_score_confidence",
  stage_06_source_verify: "stage_06_source_verify",
  stage_07_source_assess: "stage_07_source_assess",
  stage_08_recover: "stage_08_recover",
  stage_09_rescore: "stage_09_rescore",
  stage_10_coherence: "stage_10_coherence",
  stage_11_challenge: "stage_11_challenge",
  stage_12_counter_case: "stage_12_counter_case",
  stage_13_defend: "stage_13_defend",
  stage_14_synthesize: "stage_14_synthesize",
  stage_15_finalize: "complete",
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

function skipReasonLabel(reason, diagnostics = {}) {
  const value = String(reason || "").trim();
  if (!value) return "Skipped by runtime guard.";
  if (value === "subjects_provided") {
    const count = Number(diagnostics?.subjectCount || 0);
    return count > 0
      ? `Skipped: subjects already provided (${count}).`
      : "Skipped: subjects already provided.";
  }
  if (value === "scorecard_mode") return "Skipped: scorecard run does not require this stage.";
  if (value === "native_mode") return "Skipped: native evidence mode selected.";
  return `Skipped: ${value.replace(/_/g, " ")}.`;
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

function formatInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.max(0, Math.round(n)));
}

function formatUsd(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `$${n.toFixed(decimals)}`;
}

function formatRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `$${n.toFixed(2)}/1M`;
}

function buildStageRecordMap(uc = {}) {
  const map = new Map();
  const stages = Array.isArray(uc?.diagnostics?.stages) ? uc.diagnostics.stages : [];
  stages.forEach((entry) => {
    const id = String(entry?.stage || "").trim();
    if (!id) return;
    map.set(id, entry);
  });
  return map;
}

function stageCostSummary(record = null) {
  if (!record || typeof record !== "object") return null;
  const cost = record?.cost && typeof record.cost === "object" ? record.cost : null;
  const tokens = record?.tokens && typeof record.tokens === "object" ? record.tokens : null;
  const inputTokens = Number(cost?.inputTokens ?? tokens?.inputTokens);
  const outputTokens = Number(cost?.outputTokens ?? tokens?.outputTokens);
  const totalTokens = Number(cost?.totalTokens ?? tokens?.totalTokens);
  const estimatedCostUsd = Number(cost?.estimatedCostUsd);

  const singlePrice = Number(cost?.inputRatePer1MUsd);
  const singlePriceOut = Number(cost?.outputRatePer1MUsd);
  const blendedPrice = Number(cost?.blendedRatePer1MUsd);
  const priceLabel = Number.isFinite(singlePrice) && Number.isFinite(singlePriceOut)
    ? `${formatRate(singlePrice)} in | ${formatRate(singlePriceOut)} out`
    : (Number.isFinite(blendedPrice) ? `~${formatRate(blendedPrice)}` : "-");

  return {
    tokensLabel: Number.isFinite(totalTokens)
      ? `${formatInteger(totalTokens)} (${formatInteger(inputTokens)} in / ${formatInteger(outputTokens)} out)`
      : "-",
    priceLabel,
    costLabel: Number.isFinite(estimatedCostUsd) ? formatUsd(estimatedCostUsd) : "-",
  };
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

  const synthesisApplied = meta.synthesisCallMade != null ? meta.synthesisCallMade : meta.synthesizerCallMade;
  const synthesisModel = meta.synthesisModel || meta.synthesizerModel;
  if (synthesisApplied != null) {
    rows.push({
      label: "Executive synthesis",
      value: synthesisApplied ? "Applied" : "Not applied",
      detail: String(synthesisModel || "model not recorded"),
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
  const rawEMode = String(uc?.analysisMeta?.evidenceMode || "native").trim().toLowerCase();
  const evidenceMode = (rawEMode === "deep-research-x3" || rawEMode === "deep-assist")
    ? "deep-research-x3"
    : "native";
  const flow = flowByEvidenceMode(outputMode === "matrix" ? MATRIX_FLOW : HYBRID_FLOW, evidenceMode);
  const rank = phaseRankMap(flow);
  const resolvedPhase = resolveProgressPhase(uc.phase, outputMode);
  const currentIdx = rank[resolvedPhase] ?? 0;
  const stageRecords = buildStageRecordMap(uc);

  return (
    <div style={{ background: "var(--ck-surface)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "14px 16px", width: "100%", maxWidth: "100%", minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.9, marginBottom: 8 }}>
        Research Progress
      </div>
      <p style={{ fontSize: 12, color: "var(--ck-muted)", margin: "0 0 12px", lineHeight: 1.55 }}>
        {outputMode === "matrix"
          ? (evidenceMode === "deep-research-x3"
            ? "Live view of the canonical matrix pipeline: intake, planning, Deep Research ×3 collection, shared QA gates, critic cycle, defend, synthesis, and finalize."
            : "Live view of the canonical matrix pipeline: intake, planning, memory/web evidence, shared QA gates, critic cycle, defend, synthesis, and finalize.")
          : (evidenceMode === "deep-research-x3"
            ? "Live view of the canonical scorecard pipeline: intake, planning, Deep Research ×3 evidence, shared QA gates, critic cycle, defend, synthesis, and finalize."
            : "Live view of the canonical scorecard pipeline: intake, planning, memory/web evidence, shared QA gates, critic cycle, defend, synthesis, and finalize.")}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {flow.map((step, idx) => {
          const baseState = getStepState(step, idx, currentIdx, uc);
          const state = baseState;
          const isActive = state === "active";
          const stageRecord = stageRecords.get(step.phase) || null;
          const skipped = !!stageRecord?.diagnostics?.skipped;
          const showActiveSpinner = isActive && !skipped;
          const skipReason = skipped
            ? skipReasonLabel(stageRecord?.diagnostics?.reason, stageRecord?.diagnostics || {})
            : "";
          const shouldShowCost = SHOW_PROGRESS_COSTS && String(step.phase || "").startsWith("stage_");
          const costSummary = shouldShowCost
            ? (stageCostSummary(stageRecord) || { tokensLabel: "-", priceLabel: "-", costLabel: "-" })
            : null;
          const badgeStateLabel = skipped ? "Skipped" : stateLabel(state);
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
              {showActiveSpinner ? (
                <div style={{ marginTop: 2, display: "grid", placeItems: "center" }}>
                  <Spinner size={10} color="var(--ck-text)" />
                </div>
              ) : (
                <input type="checkbox" checked={state === "done" || skipped} readOnly style={{ marginTop: 2, accentColor: "var(--ck-accent)" }} />
              )}
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ck-text)", marginBottom: 2 }}>{step.title}</div>
                <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45 }}>{step.detail}</div>
                {skipReason ? (
                  <div style={{ fontSize: 10, color: "var(--ck-muted-soft)", marginTop: 4, lineHeight: 1.35 }}>
                    {skipReason}
                  </div>
                ) : null}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
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
                  {showActiveSpinner ? <Spinner size={9} color="var(--ck-text)" /> : null}
                  {badgeStateLabel}
                </span>
                {costSummary ? (
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--ck-muted)",
                      textAlign: "right",
                      lineHeight: 1.35,
                      width: "min(48vw, 520px)",
                      whiteSpace: "normal",
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                    }}>
                    Tokens: {costSummary.tokensLabel} | Price: {costSummary.priceLabel} | Cost: {costSummary.costLabel}
                  </div>
                ) : null}
              </div>
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
