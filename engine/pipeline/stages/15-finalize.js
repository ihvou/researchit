import { clean, ensureArray } from "./common.js";
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

function getAssessmentUnits(state = {}) {
  if (clean(state?.outputType).toLowerCase() === "matrix") {
    return ensureArray(state?.resolved?.assessment?.matrix?.cells || state?.assessment?.matrix?.cells);
  }
  const byId = state?.resolved?.assessment?.scorecard?.byId && typeof state.resolved.assessment.scorecard.byId === "object"
    ? state.resolved.assessment.scorecard.byId
    : (state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
      ? state.assessment.scorecard.byId
      : {});
  return Object.values(byId);
}

function reasonCodeCount(state = {}, code = "") {
  if (!code) return 0;
  const target = clean(code);
  return ensureArray(state?.diagnostics?.stages).reduce((count, stage) => {
    const matches = ensureArray(stage?.reasonCodes).filter((reason) => clean(reason) === target).length;
    return count + matches;
  }, 0);
}

function lowConfidenceNoGroundingCount(state = {}) {
  return getAssessmentUnits(state).filter((unit) => {
    if (clean(unit?.confidence).toLowerCase() !== "low") return false;
    const sources = ensureArray(unit?.sources);
    if (!sources.length) return true;
    const grounded = sources.some((source) => source?.groundedByProvider === true);
    return !grounded;
  }).length;
}

function highFabricationSignalCount(state = {}) {
  return getAssessmentUnits(state).filter((unit) => clean(unit?.fabricationSignal).toLowerCase() === "high").length;
}

function summarizeFailureCauses(state = {}, decision = {}, coverage = {}) {
  if (decision?.passed && !coverage?.failed) return [];

  const checks = decision?.checks || {};
  const citationCoverage = decision?.summary?.citationCoverage || {};
  const coercionCount = reasonCodeCount(state, REASON_CODES.CONFIDENCE_SCALE_COERCED);
  const lowConfidenceGap = lowConfidenceNoGroundingCount(state);
  const highFabricationCells = highFabricationSignalCount(state);

  const causes = [];
  const pushCause = (type, detail) => {
    if (causes.some((item) => item?.type === type)) return;
    causes.push({ type, detail: clean(detail) });
  };

  if (!checks.fabrication || Number(citationCoverage?.fabricated || 0) > 0 || highFabricationCells > 0) {
    pushCause(
      "fabrication",
      `fabricated sources=${Number(citationCoverage?.fabricated || 0)}, high-fabrication cells=${highFabricationCells}`
    );
  }

  if (!checks.citationCoverage && Number(citationCoverage?.unreachableInfrastructure || 0) > 0) {
    pushCause(
      "infrastructure_noise",
      `unreachable infrastructure sources=${Number(citationCoverage?.unreachableInfrastructure || 0)}`
    );
  }

  if (coercionCount > 0 && (!checks.confidence || !decision?.passed)) {
    pushCause(
      "pipeline_coercion",
      `confidence coercions detected=${coercionCount}`
    );
  }

  if (coverage?.failed || !checks.confidence || !checks.sourceSufficiency) {
    pushCause(
      "data_gap",
      `low-confidence units without grounded evidence=${lowConfidenceGap}`
    );
  }

  if (!causes.length) {
    pushCause("data_gap", "decision-grade checks failed without a stronger classified signal.");
  }

  return causes;
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
  const failureCauses = summarizeFailureCauses(state, decision, coverage);

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
  if (strictQuality) {
    runReasonCodes = normalizeReasonCodes(
      runReasonCodes.filter((code) => code !== REASON_CODES.RUN_COMPLETED_DEGRADED)
    );
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
        failureCauses,
      },
      decisionGate: decision.gate,
      decisionGateResult: {
        ...decision,
        failureCauses,
      },
      decisionGradePassed: !!decision.passed,
      decisionGradeFailureReason: !decision.passed
        ? clean(errorMsg || "Decision-grade gate failed.")
        : "",
    },
    diagnostics: {
      decisionGate: {
        ...decision,
        failureCauses,
      },
      coverageGate: coverage,
      strictQuality,
      shouldAbort,
      qualityGrade,
      failureCauses,
    },
  };
}
