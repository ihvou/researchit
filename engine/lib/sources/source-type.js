function clean(value) {
  return String(value || "").trim();
}

const SOURCE_TYPE_ALIASES = new Map([
  ["gov", "government"],
  ["government", "government"],
  ["public_registry", "government"],
  ["regulator", "government"],
  ["research", "research"],
  ["academic", "research"],
  ["journal", "research"],
  ["paper", "research"],
  ["study", "research"],
  ["press", "press_release"],
  ["press_release", "press_release"],
  ["press-release", "press_release"],
  ["news", "news"],
  ["media", "news"],
  ["analyst", "analyst"],
  ["analysis", "analyst"],
  ["independent", "independent"],
  ["registry", "registry"],
  ["vendor", "vendor"],
  ["company", "vendor"],
  ["official", "vendor"],
  ["marketing", "marketing"],
  ["sponsored", "marketing"],
]);

const RESEARCH_HOST_SNIPPETS = [
  "ncbi.nlm.nih.gov",
  "nature.com",
  "thelancet.com",
  "jamanetwork.com",
  "bmj.com",
  "nejm.org",
  "sciencedirect.com",
  "arxiv.org",
  "doi.org",
];

const NEWS_HOST_SNIPPETS = [
  "reuters.com",
  "bloomberg.com",
  "ft.com",
  "nytimes.com",
  "wsj.com",
  "statnews.com",
  "beckershospitalreview.com",
];

const ANALYST_HOST_SNIPPETS = [
  "gartner.com",
  "forrester.com",
  "klasresearch.com",
  "cbinsights.com",
  "pitchbook.com",
];

const PRESS_RELEASE_HOST_SNIPPETS = [
  "businesswire.com",
  "prnewswire.com",
  "globenewswire.com",
];

function hostContainsAny(host = "", snippets = []) {
  return snippets.some((snippet) => host.includes(snippet));
}

export function normalizeSourceType(value = "") {
  const type = clean(value).toLowerCase();
  if (!type) return "";
  return SOURCE_TYPE_ALIASES.get(type) || type;
}

export function hostFromUrl(value = "") {
  const raw = clean(value);
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function inferSourceType(source = {}) {
  const explicit = normalizeSourceType(source?.sourceType);
  if (explicit) return explicit;
  const host = hostFromUrl(source?.url);
  if (!host) return "";
  if (host.endsWith(".gov")) return "government";
  if (hostContainsAny(host, RESEARCH_HOST_SNIPPETS)) return "research";
  if (hostContainsAny(host, NEWS_HOST_SNIPPETS)) return "news";
  if (hostContainsAny(host, ANALYST_HOST_SNIPPETS)) return "analyst";
  if (hostContainsAny(host, PRESS_RELEASE_HOST_SNIPPETS)) return "press_release";
  return "";
}

export function isIndependentSource(source = {}) {
  const type = inferSourceType(source);
  return type === "independent"
    || type === "research"
    || type === "news"
    || type === "analyst"
    || type === "government"
    || type === "registry";
}

export function sourceRequiresStrictCitationCheck(source = {}) {
  const type = inferSourceType(source);
  return type === "independent"
    || type === "research"
    || type === "news"
    || type === "government"
    || type === "registry";
}
