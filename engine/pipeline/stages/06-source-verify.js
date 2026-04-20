import { clean, ensureArray } from "./common.js";
import { REASON_CODES } from "../contracts/reason-codes.js";
import { hostFromUrl, inferSourceType } from "../../lib/sources/source-type.js";

export const STAGE_ID = "stage_06_source_verify";
export const STAGE_TITLE = "Source Verification";

const PAYWALL_HOST_SNIPPETS = [
  "forbes.com",
  "wsj.com",
  "ft.com",
  "nytimes.com",
  "economist.com",
  "bloomberg.com",
  "substack.com",
  "gartner.com",
  "forrester.com",
  "klasresearch.com",
  "pitchbook.com",
  "cbinsights.com",
];

const INFRASTRUCTURE_FETCH_PATTERNS = [
  "fetch_failed",
  "timeout",
  "timed out",
  "aborted",
  "paywall",
  "captcha",
  "cloudflare",
  "rate limit",
  "rate_limit",
  "forbidden",
  "blocked",
  "challenge",
  "403",
  "429",
];

const DNS_FAILURE_PATTERNS = [
  "enotfound",
  "eai_again",
  "nxdomain",
  "dns",
  "host not found",
];

function verifySourceInContent(source = {}, payload = {}) {
  const text = clean(payload?.text).toLowerCase();
  const quote = clean(source?.quote).toLowerCase();
  const name = clean(source?.name).toLowerCase();
  if (!text) return "fetch_failed";
  if (quote && text.includes(quote)) return "verified_in_page";
  if (name && text.includes(name)) return "name_only_in_page";
  return "not_found_in_page";
}

function isGroundingRedirectUrl(url = "") {
  const value = clean(url).toLowerCase();
  return value.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")
    || value.includes("grounding-api-redirect");
}

function statusCodeFromPayload(payload = {}) {
  const direct = Number(payload?.responseStatus || payload?.status || payload?.sourceFetchStatus);
  if (Number.isFinite(direct) && direct >= 100) return direct;
  const match = String(payload?.sourceFetchStatus || "").match(/\b([1-5]\d{2})\b/);
  return match ? Number(match[1]) : 0;
}

function isNotFoundStatus(status = 0) {
  return status === 404 || status === 410;
}

function isBlockedStatus(status = 0) {
  return status === 401 || status === 402 || status === 403 || status === 407 || status === 429;
}

function isInfrastructureStatus(status = 0) {
  return isBlockedStatus(status)
    || status === 408
    || status === 425
    || status === 500
    || status === 502
    || status === 503
    || status === 504;
}

function looksLikePaywallHost(host = "") {
  if (!host) return false;
  return PAYWALL_HOST_SNIPPETS.some((snippet) => host.includes(snippet));
}

function looksInfrastructureFetchStatus(value = "") {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return false;
  return INFRASTRUCTURE_FETCH_PATTERNS.some((token) => normalized.includes(token));
}

function looksDnsFailure(value = "") {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return false;
  return DNS_FAILURE_PATTERNS.some((token) => normalized.includes(token));
}

function classifyTier(sourceType = "") {
  if (sourceType === "analyst") return "analyst";
  if (sourceType === "vendor" || sourceType === "press_release" || sourceType === "marketing") {
    return "existence";
  }
  return "strict";
}

async function fetchWithCache(url, fetchSource, cache = new Map(), options = {}) {
  const key = `${options?.resolveOnly ? "resolve" : "full"}|${url}`;
  if (cache.has(key)) return cache.get(key);
  const pending = (async () => {
    try {
      return await fetchSource(url, {
        timeoutMs: options?.timeoutMs || 12000,
        retry: { maxRetries: 0 },
        resolveOnly: options?.resolveOnly === true,
      });
    } catch (err) {
      return {
        error: err,
        sourceFetchError: true,
        sourceFetchStatus: clean(err?.sourceFetchStatus || err?.status || err?.code || "fetch_failed"),
        responseStatus: Number(err?.status || 0),
        resolvedUrl: clean(err?.resolvedUrl || ""),
        reachable: false,
      };
    }
  })();
  cache.set(key, pending);
  return pending;
}

function outcome(verificationStatus, citationStatus, extra = {}) {
  return {
    verificationStatus,
    citationStatus,
    checked: extra.checked !== false,
    resolvedUrl: clean(extra?.resolvedUrl),
    sourceType: clean(extra?.sourceType),
    responseStatus: Number(extra?.responseStatus || 0),
    sourceFetchStatus: clean(extra?.sourceFetchStatus),
    reachable: extra?.reachable === true,
  };
}

async function verifyStrict(source = {}, fetchSource, cache) {
  const url = clean(source?.url);
  const payload = await fetchWithCache(url, fetchSource, cache, { resolveOnly: false, timeoutMs: 12000 });
  const status = statusCodeFromPayload(payload);
  const fetchStatus = clean(payload?.sourceFetchStatus);

  if (payload?.sourceFetchError || payload?.error) {
    if (isNotFoundStatus(status)) {
      return outcome("not_found_url", "not_found", {
        resolvedUrl: payload?.resolvedUrl,
        responseStatus: status,
        sourceFetchStatus: fetchStatus,
        reachable: payload?.reachable,
      });
    }
    return outcome("fetch_failed", "unverifiable", {
      resolvedUrl: payload?.resolvedUrl,
      responseStatus: status,
      sourceFetchStatus: fetchStatus,
      reachable: payload?.reachable,
    });
  }

  const contentStatus = verifySourceInContent(source, payload);
  if (contentStatus === "verified_in_page") {
    return outcome(contentStatus, "verified", {
      resolvedUrl: payload?.resolvedUrl || payload?.url,
      responseStatus: status,
      sourceFetchStatus: fetchStatus,
      reachable: payload?.reachable,
    });
  }
  if (contentStatus === "name_only_in_page") {
    return outcome(contentStatus, "verified", {
      resolvedUrl: payload?.resolvedUrl || payload?.url,
      responseStatus: status,
      sourceFetchStatus: fetchStatus,
      reachable: payload?.reachable,
    });
  }
  return outcome(contentStatus, "not_found", {
    resolvedUrl: payload?.resolvedUrl || payload?.url,
    responseStatus: status,
    sourceFetchStatus: fetchStatus,
    reachable: payload?.reachable,
  });
}

async function verifyExistence(source = {}, fetchSource, cache) {
  const url = clean(source?.url);
  const payload = await fetchWithCache(url, fetchSource, cache, { resolveOnly: true, timeoutMs: 9000 });
  const status = statusCodeFromPayload(payload);
  const fetchStatus = clean(payload?.sourceFetchStatus);
  const reachable = payload?.reachable === true || (status >= 200 && status < 300);
  if (reachable) {
    return outcome("exists_url", "verified", {
      resolvedUrl: payload?.resolvedUrl || payload?.url,
      responseStatus: status,
      sourceFetchStatus: fetchStatus,
      reachable,
    });
  }
  if (isNotFoundStatus(status)) {
    return outcome("not_found_url", "not_found", {
      resolvedUrl: payload?.resolvedUrl || payload?.url,
      responseStatus: status,
      sourceFetchStatus: fetchStatus,
      reachable,
    });
  }
  return outcome("unverifiable", "unverifiable", {
    resolvedUrl: payload?.resolvedUrl || payload?.url,
    responseStatus: status,
    sourceFetchStatus: fetchStatus,
    reachable,
  });
}

async function verifyAnalyst(source = {}, fetchSource, cache) {
  const url = clean(source?.url);
  const probe = await fetchWithCache(url, fetchSource, cache, { resolveOnly: true, timeoutMs: 9000 });
  const probeStatus = statusCodeFromPayload(probe);
  const probeFetchStatus = clean(probe?.sourceFetchStatus);
  const reachable = probe?.reachable === true || (probeStatus >= 200 && probeStatus < 300);
  if (!reachable) {
    if (isNotFoundStatus(probeStatus)) {
      return outcome("not_found_url", "not_found", {
        resolvedUrl: probe?.resolvedUrl || probe?.url,
        responseStatus: probeStatus,
        sourceFetchStatus: probeFetchStatus,
        reachable,
      });
    }
    return outcome("paywalled", "unverifiable", {
      resolvedUrl: probe?.resolvedUrl || probe?.url,
      responseStatus: probeStatus,
      sourceFetchStatus: probeFetchStatus,
      reachable,
    });
  }

  const strict = await verifyStrict(source, fetchSource, cache);
  if (strict.verificationStatus === "fetch_failed") {
    return outcome("paywalled", "unverifiable", {
      resolvedUrl: strict?.resolvedUrl,
      responseStatus: strict?.responseStatus,
      sourceFetchStatus: strict?.sourceFetchStatus,
      reachable: strict?.reachable,
    });
  }
  return strict;
}

function initialCounters() {
  return {
    checked: 0,
    verified: 0,
    notFound: 0,
    fetchFailed: 0,
    invalidUrl: 0,
    partial: 0,
    nameOnly: 0,
    paywalled: 0,
    unverifiable: 0,
    existsOnly: 0,
    verificationTierCounts: {
      verified: 0,
      unreachableInfrastructure: 0,
      unreachableStale: 0,
      fabricated: 0,
      unverifiable: 0,
    },
    verifiedTier: 0,
    unreachableInfrastructure: 0,
    unreachableStale: 0,
    fabricated: 0,
    unverifiableTier: 0,
  };
}

function applyTierCounter(counters = {}, verificationTier = "") {
  const tier = clean(verificationTier).toLowerCase();
  if (tier === "verified") {
    counters.verificationTierCounts.verified += 1;
    counters.verifiedTier += 1;
    return;
  }
  if (tier === "unreachable_infrastructure") {
    counters.verificationTierCounts.unreachableInfrastructure += 1;
    counters.unreachableInfrastructure += 1;
    return;
  }
  if (tier === "unreachable_stale") {
    counters.verificationTierCounts.unreachableStale += 1;
    counters.unreachableStale += 1;
    return;
  }
  if (tier === "fabricated") {
    counters.verificationTierCounts.fabricated += 1;
    counters.fabricated += 1;
    return;
  }
  counters.verificationTierCounts.unverifiable += 1;
  counters.unverifiableTier += 1;
}

function deriveVerificationTier(source = {}, verdict = {}) {
  const sourceType = inferSourceType(source);
  const host = hostFromUrl(source?.url);
  const status = Number(verdict?.responseStatus || 0);
  const fetchStatus = clean(verdict?.sourceFetchStatus).toLowerCase();
  const verificationStatus = clean(verdict?.verificationStatus).toLowerCase();
  const groundedSetAvailable = source?.groundedSetAvailable === true;
  const groundedByProvider = source?.groundedByProvider === true;
  const absentFromGroundedSet = groundedSetAvailable && !!clean(source?.url) && !groundedByProvider;

  if (absentFromGroundedSet) return "fabricated";

  if (verificationStatus === "verified_in_page" || verificationStatus === "name_only_in_page" || verificationStatus === "exists_url") {
    return "verified";
  }

  if (verificationStatus === "invalid_url") return "fabricated";
  if (verificationStatus === "paywalled") return "unreachable_infrastructure";

  if (verificationStatus === "not_found_url") {
    if (status === 410) return "unreachable_stale";
    if (status === 404) {
      if (groundedByProvider) return "unreachable_stale";
      if (sourceType === "vendor" || sourceType === "press_release" || sourceType === "marketing") {
        return "fabricated";
      }
      return "fabricated";
    }
    return "unreachable_stale";
  }

  if (verificationStatus === "fetch_failed" || verificationStatus === "unverifiable") {
    if (isInfrastructureStatus(status) || looksInfrastructureFetchStatus(fetchStatus) || looksLikePaywallHost(host)) {
      return "unreachable_infrastructure";
    }
    if (looksDnsFailure(fetchStatus)) return "fabricated";
    return "unverifiable";
  }

  if (verificationStatus === "not_found_in_page") {
    return "unverifiable";
  }

  return "unverifiable";
}

async function verifySourcesForUnit(unit = {}, fetchSource, cache = new Map()) {
  const sources = ensureArray(unit?.sources);
  const counters = initialCounters();

  for (const source of sources) {
    let url = clean(source?.url);
    const sourceType = inferSourceType(source);
    if (sourceType && !clean(source?.sourceType)) source.sourceType = sourceType;

    if (!url || !/^https?:\/\//i.test(url)) {
      source.verificationStatus = "invalid_url";
      source.citationStatus = "not_found";
      source.verificationTier = "fabricated";
      counters.invalidUrl += 1;
      applyTierCounter(counters, source.verificationTier);
      continue;
    }

    if (isGroundingRedirectUrl(url)) {
      const probe = await fetchWithCache(url, fetchSource, cache, { resolveOnly: true, timeoutMs: 9000 });
      const resolved = clean(probe?.resolvedUrl || probe?.url || "");
      if (resolved && !isGroundingRedirectUrl(resolved)) {
        source.url = resolved;
        url = resolved;
      } else {
        source.verificationStatus = "unverifiable";
        source.citationStatus = "unverifiable";
        source.verificationTier = "unreachable_infrastructure";
        counters.checked += 1;
        counters.unverifiable += 1;
        applyTierCounter(counters, source.verificationTier);
        continue;
      }
    }

    const tier = classifyTier(sourceType);
    const verdict = tier === "existence"
      ? await verifyExistence(source, fetchSource, cache)
      : (tier === "analyst"
        ? await verifyAnalyst(source, fetchSource, cache)
        : await verifyStrict(source, fetchSource, cache));

    source.verificationStatus = verdict.verificationStatus;
    source.citationStatus = verdict.citationStatus;
    if (verdict.resolvedUrl && /^https?:\/\//i.test(verdict.resolvedUrl)) {
      source.url = verdict.resolvedUrl;
    }
    source.verificationTier = deriveVerificationTier(source, verdict);
    if (verdict.checked) counters.checked += 1;

    if (verdict.verificationStatus === "fetch_failed") {
      counters.fetchFailed += 1;
      applyTierCounter(counters, source.verificationTier);
      continue;
    }
    if (verdict.verificationStatus === "invalid_url") {
      counters.invalidUrl += 1;
      applyTierCounter(counters, source.verificationTier);
      continue;
    }
    if (verdict.verificationStatus === "paywalled") {
      counters.paywalled += 1;
      counters.unverifiable += 1;
      applyTierCounter(counters, source.verificationTier);
      continue;
    }
    if (verdict.verificationStatus === "unverifiable") {
      counters.unverifiable += 1;
      applyTierCounter(counters, source.verificationTier);
      continue;
    }
    if (verdict.verificationStatus === "exists_url") {
      counters.existsOnly += 1;
      counters.verified += 1;
      applyTierCounter(counters, source.verificationTier);
      continue;
    }
    if (verdict.verificationStatus === "verified_in_page") {
      counters.verified += 1;
      applyTierCounter(counters, source.verificationTier);
      continue;
    }
    if (verdict.verificationStatus === "name_only_in_page") {
      counters.nameOnly += 1;
      counters.partial += 1;
      counters.verified += 1;
      applyTierCounter(counters, source.verificationTier);
      continue;
    }

    counters.notFound += 1;
    applyTierCounter(counters, source.verificationTier);
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
      if (key === "verificationTierCounts") {
        acc.verificationTierCounts.verified += Number(item?.verificationTierCounts?.verified || 0);
        acc.verificationTierCounts.unreachableInfrastructure += Number(item?.verificationTierCounts?.unreachableInfrastructure || 0);
        acc.verificationTierCounts.unreachableStale += Number(item?.verificationTierCounts?.unreachableStale || 0);
        acc.verificationTierCounts.fabricated += Number(item?.verificationTierCounts?.fabricated || 0);
        acc.verificationTierCounts.unverifiable += Number(item?.verificationTierCounts?.unverifiable || 0);
        return;
      }
      acc[key] += Number(item?.[key] || 0);
    });
    return acc;
  }, {
    ...initialCounters(),
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

  const cache = new Map();
  const result = await applyToAssessment(
    state?.assessment || {},
    (unit) => verifySourcesForUnit(unit, fetchSource, cache)
  );
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
