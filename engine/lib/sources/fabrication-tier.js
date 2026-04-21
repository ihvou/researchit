function clean(value) {
  return String(value || "").trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeContradiction(value = "") {
  const lower = clean(value).toLowerCase();
  if (!lower) return "unchecked";
  if (lower === "true" || lower === "false" || lower === "unchecked") return lower;
  return "unchecked";
}

function isInfrastructureStatus(status = 0) {
  return status === 401
    || status === 402
    || status === 403
    || status === 407
    || status === 408
    || status === 425
    || status === 429
    || status === 500
    || status === 502
    || status === 503
    || status === 504;
}

export function classifyFabricationTier({
  groundedByProvider = false,
  httpStatus = 0,
  sourceFetchStatus = "",
  contentContradicts = "unchecked",
  domain = "",
  subjectDomain = "",
} = {}) {
  const status = toNumber(httpStatus, 0);
  const fetchStatus = clean(sourceFetchStatus).toLowerCase();
  const contradiction = normalizeContradiction(contentContradicts);
  const normalizedDomain = clean(domain).toLowerCase();
  const normalizedSubjectDomain = clean(subjectDomain).toLowerCase();
  const onSubjectDomain = !!normalizedDomain
    && !!normalizedSubjectDomain
    && normalizedDomain === normalizedSubjectDomain;

  if (status >= 200 && status < 400 && groundedByProvider === true) return "verified";
  if (isInfrastructureStatus(status)) return "unreachable_infrastructure";
  if (
    fetchStatus.includes("fetch_failed")
    || fetchStatus.includes("timeout")
    || fetchStatus.includes("timed out")
    || fetchStatus.includes("aborted")
    || fetchStatus.includes("rate limit")
    || fetchStatus.includes("rate_limit")
    || fetchStatus.includes("forbidden")
    || fetchStatus.includes("blocked")
    || fetchStatus.includes("paywall")
    || fetchStatus.includes("captcha")
    || fetchStatus.includes("cloudflare")
  ) {
    return "unreachable_infrastructure";
  }
  if (status === 404 || status === 410) {
    if (groundedByProvider === true) return "unreachable_stale";
    if (onSubjectDomain || contradiction === "true") return "fabricated";
    return "unverifiable";
  }
  if (status >= 200 && status < 400 && groundedByProvider === false) {
    if (contradiction === "true") return "fabricated";
    return "unverifiable";
  }
  if (
    (fetchStatus.includes("dns") || fetchStatus.includes("enotfound") || fetchStatus.includes("nxdomain"))
    && groundedByProvider !== true
  ) {
    return "fabricated";
  }
  return "unverifiable";
}
