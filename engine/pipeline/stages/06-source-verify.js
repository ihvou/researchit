import { clean, ensureArray } from "./common.js";
import { REASON_CODES } from "../contracts/reason-codes.js";

export const STAGE_ID = "stage_06_source_verify";
export const STAGE_TITLE = "Source Verification";

function verifySourceInContent(source = {}, payload = {}) {
  const text = clean(payload?.text).toLowerCase();
  const quote = clean(source?.quote).toLowerCase();
  const name = clean(source?.name).toLowerCase();
  if (!text) return "fetch_failed";
  if (quote && text.includes(quote)) return "verified_in_page";
  if (name && text.includes(name)) return "name_only_in_page";
  return "not_found_in_page";
}

async function verifySourcesForUnit(unit = {}, fetchSource) {
  const sources = ensureArray(unit?.sources);
  const cache = new Map();
  const counters = {
    checked: 0,
    verified: 0,
    notFound: 0,
    fetchFailed: 0,
    invalidUrl: 0,
    partial: 0,
    nameOnly: 0,
  };

  for (const source of sources) {
    const url = clean(source?.url);
    if (!url || !/^https?:\/\//i.test(url)) {
      source.verificationStatus = "invalid_url";
      counters.invalidUrl += 1;
      continue;
    }
    counters.checked += 1;

    let payload = cache.get(url);
    if (!payload) {
      try {
        payload = await fetchSource(url, { timeoutMs: 12000, retry: { maxRetries: 0 } });
      } catch (err) {
        payload = {
          error: err,
          sourceFetchError: true,
          sourceFetchStatus: "fetch_failed",
        };
      }
      cache.set(url, payload);
    }

    if (payload?.sourceFetchError || payload?.error) {
      source.verificationStatus = "fetch_failed";
      counters.fetchFailed += 1;
      continue;
    }

    const status = verifySourceInContent(source, payload);
    source.verificationStatus = status;
    if (status === "verified_in_page") counters.verified += 1;
    else if (status === "name_only_in_page") {
      counters.nameOnly += 1;
      counters.partial += 1;
    } else counters.notFound += 1;
  }

  return counters;
}

function applyToAssessment(assessment = {}, handler) {
  if (assessment?.matrix?.cells) {
    const cells = ensureArray(assessment.matrix.cells);
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

function aggregateCounters(counters = []) {
  return counters.reduce((acc, item) => {
    Object.keys(acc).forEach((key) => {
      acc[key] += Number(item?.[key] || 0);
    });
    return acc;
  }, {
    checked: 0,
    verified: 0,
    notFound: 0,
    fetchFailed: 0,
    invalidUrl: 0,
    partial: 0,
    nameOnly: 0,
  });
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

  const result = await applyToAssessment(state?.assessment || {}, (unit) => verifySourcesForUnit(unit, fetchSource));
  const counters = aggregateCounters(result.counters);

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
