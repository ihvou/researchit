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

function normalizeSourceType(value = "") {
  const type = clean(value).toLowerCase();
  if (!type) return "";
  if (["gov", "government", "public_registry", "regulator"].includes(type)) return "government";
  if (["research", "academic", "journal", "paper", "study"].includes(type)) return "research";
  if (["press", "press_release", "press-release"].includes(type)) return "press_release";
  if (["news", "media"].includes(type)) return "news";
  if (["analyst", "analysis"].includes(type)) return "analyst";
  if (["independent"].includes(type)) return "independent";
  if (["registry"].includes(type)) return "registry";
  if (["vendor", "company", "official"].includes(type)) return "vendor";
  if (["marketing", "sponsored"].includes(type)) return "marketing";
  return type;
}

function hostFromUrl(value = "") {
  const raw = clean(value);
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isGroundingRedirectUrl(url = "") {
  const value = clean(url).toLowerCase();
  return value.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")
    || value.includes("grounding-api-redirect");
}

function inferSourceType(source = {}) {
  const explicit = normalizeSourceType(source?.sourceType);
  if (explicit) return explicit;
  const host = hostFromUrl(source?.url);
  if (!host) return "";
  if (host.endsWith(".gov")) return "government";
  if (
    host.includes("ncbi.nlm.nih.gov")
    || host.includes("nature.com")
    || host.includes("thelancet.com")
    || host.includes("jamanetwork.com")
    || host.includes("bmj.com")
    || host.includes("nejm.org")
    || host.includes("sciencedirect.com")
    || host.includes("arxiv.org")
    || host.includes("doi.org")
  ) return "research";
  if (
    host.includes("reuters.com")
    || host.includes("bloomberg.com")
    || host.includes("ft.com")
    || host.includes("nytimes.com")
    || host.includes("wsj.com")
    || host.includes("statnews.com")
    || host.includes("beckershospitalreview.com")
  ) return "news";
  if (
    host.includes("gartner.com")
    || host.includes("forrester.com")
    || host.includes("klasresearch.com")
    || host.includes("cbinsights.com")
    || host.includes("pitchbook.com")
  ) return "analyst";
  if (
    host.includes("businesswire.com")
    || host.includes("prnewswire.com")
    || host.includes("globenewswire.com")
  ) return "press_release";
  return "";
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
        sourceFetchStatus: clean(err?.sourceFetchStatus || err?.status || "fetch_failed"),
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
  };
}

async function verifyStrict(source = {}, fetchSource, cache) {
  const url = clean(source?.url);
  const payload = await fetchWithCache(url, fetchSource, cache, { resolveOnly: false, timeoutMs: 12000 });
  const status = statusCodeFromPayload(payload);
  if (payload?.sourceFetchError || payload?.error) {
    if (isNotFoundStatus(status)) return outcome("not_found_url", "not_found", { resolvedUrl: payload?.resolvedUrl });
    return outcome("fetch_failed", "unverifiable", { resolvedUrl: payload?.resolvedUrl });
  }

  const contentStatus = verifySourceInContent(source, payload);
  if (contentStatus === "verified_in_page") return outcome(contentStatus, "verified", { resolvedUrl: payload?.resolvedUrl || payload?.url });
  if (contentStatus === "name_only_in_page") return outcome(contentStatus, "verified", { resolvedUrl: payload?.resolvedUrl || payload?.url });
  return outcome(contentStatus, "not_found", { resolvedUrl: payload?.resolvedUrl || payload?.url });
}

async function verifyExistence(source = {}, fetchSource, cache) {
  const url = clean(source?.url);
  const payload = await fetchWithCache(url, fetchSource, cache, { resolveOnly: true, timeoutMs: 9000 });
  const status = statusCodeFromPayload(payload);
  const reachable = payload?.reachable === true || (status >= 200 && status < 300);
  if (reachable) return outcome("exists_url", "verified", { resolvedUrl: payload?.resolvedUrl || payload?.url });
  if (isNotFoundStatus(status)) return outcome("not_found_url", "not_found", { resolvedUrl: payload?.resolvedUrl || payload?.url });
  return outcome("unverifiable", "unverifiable", { resolvedUrl: payload?.resolvedUrl || payload?.url });
}

async function verifyAnalyst(source = {}, fetchSource, cache) {
  const url = clean(source?.url);
  const probe = await fetchWithCache(url, fetchSource, cache, { resolveOnly: true, timeoutMs: 9000 });
  const probeStatus = statusCodeFromPayload(probe);
  const reachable = probe?.reachable === true || (probeStatus >= 200 && probeStatus < 300);
  if (!reachable) {
    if (isNotFoundStatus(probeStatus)) return outcome("not_found_url", "not_found", { resolvedUrl: probe?.resolvedUrl || probe?.url });
    if (isBlockedStatus(probeStatus)) return outcome("paywalled", "unverifiable", { resolvedUrl: probe?.resolvedUrl || probe?.url });
    return outcome("paywalled", "unverifiable", { resolvedUrl: probe?.resolvedUrl || probe?.url });
  }

  const strict = await verifyStrict(source, fetchSource, cache);
  if (strict.verificationStatus === "fetch_failed") {
    return outcome("paywalled", "unverifiable", { resolvedUrl: strict?.resolvedUrl });
  }
  return strict;
}

function initialCounters() {
  const counters = {
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
  };
  return counters;
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
      counters.invalidUrl += 1;
      continue;
    }

    if (isGroundingRedirectUrl(url)) {
      const probe = await fetchWithCache(url, fetchSource, cache, { resolveOnly: true, timeoutMs: 9000 });
      const resolved = clean(probe?.resolvedUrl || probe?.url || "");
      if (resolved && !isGroundingRedirectUrl(resolved)) {
        source.url = resolved;
        url = resolved;
        if (!clean(source?.sourceType)) {
          const inferredResolvedType = inferSourceType(source);
          if (inferredResolvedType) source.sourceType = inferredResolvedType;
        }
      } else {
        source.verificationStatus = "unverifiable";
        source.citationStatus = "unverifiable";
        counters.checked += 1;
        counters.unverifiable += 1;
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
    if (verdict.checked) counters.checked += 1;

    if (verdict.verificationStatus === "fetch_failed") {
      counters.fetchFailed += 1;
      continue;
    }
    if (verdict.verificationStatus === "invalid_url") {
      counters.invalidUrl += 1;
      continue;
    }
    if (verdict.verificationStatus === "paywalled") {
      counters.paywalled += 1;
      counters.unverifiable += 1;
      continue;
    }
    if (verdict.verificationStatus === "unverifiable") {
      counters.unverifiable += 1;
      continue;
    }
    if (verdict.verificationStatus === "exists_url") {
      counters.existsOnly += 1;
      counters.verified += 1;
      continue;
    }
    if (verdict.verificationStatus === "verified_in_page") {
      counters.verified += 1;
      continue;
    }
    if (verdict.verificationStatus === "name_only_in_page") {
      counters.nameOnly += 1;
      counters.partial += 1;
      counters.verified += 1;
      continue;
    }
    counters.notFound += 1;
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
