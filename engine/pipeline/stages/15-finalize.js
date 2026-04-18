import { clean } from "./common.js";
import { evaluateDecisionGate } from "../../lib/guards/decision-gate.js";
import { evaluateCoverageGate } from "../../lib/guards/coverage-gate.js";
import { REASON_CODES, normalizeReasonCodes } from "../contracts/reason-codes.js";

export const STAGE_ID = "stage_15_finalize";
export const STAGE_TITLE = "Finalize";

function qualityGradeFromGate({ strictQuality = true, decisionPassed = true, coverageFailed = false }) {
  if (strictQuality) {
    return decisionPassed && !coverageFailed ? "decision-grade" : "failed";
  }
  if (coverageFailed) return "failed";
  return decisionPassed ? "decision-grade" : "degraded";
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const strictQuality = !!state?.strictQuality;

  const decisionGateConfig = state?.outputType === "matrix"
    ? (runtime?.config?.limits?.matrixDecisionGradeGate || {})
    : (runtime?.config?.limits?.decisionGradeGate || runtime?.config?.limits?.matrixDecisionGradeGate || {});
  const decision = evaluateDecisionGate(state, decisionGateConfig);
  const coverage = evaluateCoverageGate(state, {
    hardAbortCoverageFloor: runtime?.config?.quality?.hardAbortCoverageFloor ?? 0.3,
  });

  const mustAbortInAnyMode = coverage.failed;
  const mustAbortStrict = strictQuality && !decision.passed;
  const shouldAbort = mustAbortInAnyMode || mustAbortStrict;

  let runReasonCodes = normalizeReasonCodes([
    ...(decision.reasonCodes || []),
    ...(coverage.reasonCodes || []),
  ]);

  if (shouldAbort && strictQuality) {
    runReasonCodes = normalizeReasonCodes([
      ...runReasonCodes,
      REASON_CODES.RUN_ABORTED_STRICT_QUALITY,
    ]);
  }

  if (!strictQuality && !shouldAbort && !decision.passed) {
    runReasonCodes = normalizeReasonCodes([
      ...runReasonCodes,
      REASON_CODES.RUN_COMPLETED_DEGRADED,
    ]);
  }

  const qualityGrade = qualityGradeFromGate({
    strictQuality,
    decisionPassed: decision.passed,
    coverageFailed: coverage.failed,
  });

  const status = shouldAbort ? "error" : "complete";
  const errorMsg = shouldAbort
    ? (coverage.failed
      ? "Run aborted: coverage below hard-abort floor."
      : "Run aborted: strict decision-grade gate failed.")
    : null;

  return {
    stageStatus: shouldAbort ? "failed" : (qualityGrade === "degraded" ? "recovered" : "ok"),
    reasonCodes: runReasonCodes,
    statePatch: {
      ui: {
        phase: STAGE_ID,
        status,
        errorMsg,
      },
      quality: {
        qualityGrade,
        reasonCodes: runReasonCodes,
        coverage: decision.coverage,
      },
      decisionGate: decision.gate,
      decisionGateResult: decision,
      decisionGradePassed: !!decision.passed,
      decisionGradeFailureReason: !decision.passed
        ? clean(errorMsg || "Decision-grade gate failed.")
        : "",
    },
    diagnostics: {
      decisionGate: decision,
      coverageGate: coverage,
      strictQuality,
      shouldAbort,
      qualityGrade,
    },
  };
}
