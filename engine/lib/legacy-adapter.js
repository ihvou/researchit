/**
 * @legacy
 * Legacy artifact adapter used only during import/read flows.
 * This file must never be imported from production stage execution logic.
 */

export const LEGACY_ADAPTER_SUNSET = "2027-01-01";

function clean(value) {
  return String(value || "").trim();
}

function normalizeSeverity(value) {
  const v = clean(value).toLowerCase();
  if (v === "high" || v === "medium" || v === "low") return v;
  return "medium";
}

function normalizeCategory(value) {
  const allowed = new Set([
    "overclaim",
    "missing_evidence",
    "contradiction",
    "stale_source",
    "missed_risk",
    "other",
  ]);
  const category = clean(value).toLowerCase();
  return allowed.has(category) ? category : "other";
}

function mapLegacyPhaseToStage(phase = "") {
  const key = clean(phase).toLowerCase();
  const map = {
    analyst_baseline: "stage_03a_evidence_memory",
    analyst_web: "stage_03b_evidence_web",
    analyst_reconcile: "stage_04_merge",
    analyst_targeted: "stage_08_recover",
    critic: "stage_11_challenge",
    finalizing: "stage_15_finalize",
    red_team: "stage_12_counter_case",
    synthesizer: "stage_14_synthesize",
    matrix_plan: "stage_02_plan",
    matrix_baseline: "stage_03a_evidence_memory",
    matrix_web: "stage_03b_evidence_web",
    matrix_reconcile: "stage_04_merge",
    matrix_targeted: "stage_08_recover",
    matrix_critic: "stage_11_challenge",
    matrix_response: "stage_13_defend",
    matrix_synthesis: "stage_14_synthesize",
    matrix_summary: "stage_15_finalize",
  };
  return map[key] || key;
}

export function adaptLegacyArtifact(artifact = {}) {
  if (!artifact || typeof artifact !== "object") return artifact;
  const out = JSON.parse(JSON.stringify(artifact));

  if (Array.isArray(out?.diagnostics?.progress)) {
    out.diagnostics.progress = out.diagnostics.progress.map((entry) => ({
      ...entry,
      stageId: mapLegacyPhaseToStage(entry?.stageId || entry?.phase),
    }));
  }

  if (Array.isArray(out?.critique?.flags)) {
    out.critique.flags = out.critique.flags.map((flag, idx) => ({
      ...flag,
      severity: normalizeSeverity(flag?.severity),
      category: normalizeCategory(flag?.category),
      id: clean(flag?.id) || `legacy-flag-${idx + 1}`,
    }));
  }

  if (Array.isArray(out?.resolved?.flagOutcomes)) {
    out.resolved.flagOutcomes = out.resolved.flagOutcomes.map((outcome, idx) => ({
      ...outcome,
      flagId: clean(outcome?.flagId) || clean(outcome?.flag?.id) || `legacy-outcome-${idx + 1}`,
      flag: {
        ...outcome?.flag,
        severity: normalizeSeverity(outcome?.flag?.severity),
        category: normalizeCategory(outcome?.flag?.category),
      },
    }));
  }

  return out;
}
