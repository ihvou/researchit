export const REASON_CODES = {
  ROUTE_MISMATCH_PREFLIGHT: "route_mismatch_preflight",
  MISSING_REQUIRED_INPUT: "missing_required_input",
  INVALID_CONFIG_SCHEMA: "invalid_config_schema",

  PROMPT_TOKEN_OVER_BUDGET: "prompt_token_over_budget",
  PROMPT_COMPACTION_APPLIED: "prompt_compaction_applied",
  PROMPT_COMPACTION_EXHAUSTED: "prompt_compaction_exhausted",

  STAGE_TIMEOUT: "stage_timeout",
  RETRY_EXHAUSTED: "retry_exhausted",
  RATE_LIMIT_BACKOFF_EXHAUSTED: "rate_limit_backoff_exhausted",

  RESPONSE_PARSE_FAILED: "response_parse_failed",
  RESPONSE_SCHEMA_INVALID: "response_schema_invalid",
  PARTIAL_PAYLOAD_REJECTED: "partial_payload_rejected",

  COVERAGE_CATASTROPHIC: "coverage_catastrophic",
  DECISION_GATE_FAILED: "decision_gate_failed",
  CRITICAL_UNITS_UNRESOLVED: "critical_units_unresolved",
  RECONCILE_REJECTED_NO_LIFT: "reconcile_rejected_no_lift",
  RECOVERY_BUDGET_STARVED: "recovery_budget_starved",

  SOURCE_VERIFICATION_FAILED: "source_verification_failed",
  SOURCE_QUALITY_CAPPED: "source_quality_capped",

  RUN_ABORTED_STRICT_QUALITY: "run_aborted_strict_quality",
  RUN_COMPLETED_DEGRADED: "run_completed_degraded",
};

export function isReasonCode(value) {
  if (!value) return false;
  return Object.values(REASON_CODES).includes(String(value));
}

export function normalizeReasonCodes(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))];
}
