import { REASON_CODES } from "../contracts/reason-codes.js";
import {
  aggregateVerificationCounters,
  verifySourcesForUnit,
} from "../../lib/sources/verify-source.js";

export const STAGE_ID = "stage_06_source_verify";
export const STAGE_TITLE = "Source Verification";

function applyToAssessment(assessment = {}, handler) {
  if (assessment?.matrix?.cells) {
    const cells = Array.isArray(assessment.matrix.cells) ? assessment.matrix.cells : [];
    return Promise.all(cells.map((cell) => handler(cell))).then((counters) => ({
      assessment: {
        matrix: { cells },
      },
      counters,
    }));
  }

  const byId = assessment?.scorecard?.byId && typeof assessment.scorecard.byId === "object"
    ? assessment.scorecard.byId
    : {};
  const units = Object.values(byId);
  return Promise.all(units.map((unit) => handler(unit))).then((counters) => ({
    assessment: {
      scorecard: { byId },
    },
    counters,
  }));
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const fetchSource = runtime?.transport?.fetchSource;
  if (typeof fetchSource !== "function") {
    return {
      stageStatus: "recovered",
      reasonCodes: [REASON_CODES.SOURCE_VERIFICATION_FAILED],
      statePatch: {
        ui: { phase: STAGE_ID },
      },
      diagnostics: {
        skipped: true,
        reason: "fetch_source_transport_unavailable",
      },
    };
  }

  const cache = new Map();
  const result = await applyToAssessment(
    state?.assessment || {},
    (unit) => verifySourcesForUnit(unit, { fetchSource, cache })
  );
  const counters = aggregateVerificationCounters(result.counters);

  return {
    stageStatus: "ok",
    reasonCodes: [],
    statePatch: {
      ui: { phase: STAGE_ID },
      assessment: result.assessment,
      quality: {
        sourceVerification: counters,
      },
    },
    diagnostics: {
      counters,
    },
  };
}

