import { getResearchPath, getConfigSlug } from "./routes";

const SITE_NAME = "Researchit";
const DEFAULT_DESCRIPTION = "Researchit helps founders, executives, and analysts run evidence-first strategic research with analyst-plus-critic validation.";
const DEFAULT_KEYWORDS = [
  "strategic research tool",
  "market analysis",
  "startup validation",
  "competitive landscape",
  "evidence-based decision making",
  "researchit",
].join(", ");

function summarizeMethodology(text, maxLength = 220) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const firstSentence = raw.split(/(?<=[.!?])\s+/)[0] || raw;
  if (firstSentence.length <= maxLength) return firstSentence;
  return `${firstSentence.slice(0, maxLength - 1).trimEnd()}...`;
}

function toAbsoluteUrl(pathname = "/") {
  if (typeof window === "undefined") return `https://researchit.app${pathname}`;
  return new URL(pathname, window.location.origin).toString();
}

function upsertMeta(selector, attrs, content) {
  if (typeof document === "undefined") return;
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement("meta");
    Object.entries(attrs).forEach(([key, value]) => {
      el.setAttribute(key, value);
    });
    document.head.appendChild(el);
  }
  el.setAttribute("content", content || "");
}

function upsertCanonical(url) {
  if (typeof document === "undefined") return;
  let link = document.head.querySelector("link[rel='canonical']");
  if (!link) {
    link = document.createElement("link");
    link.setAttribute("rel", "canonical");
    document.head.appendChild(link);
  }
  link.setAttribute("href", url);
}

function upsertJsonLd(jsonLd) {
  if (typeof document === "undefined") return;
  const scriptId = "researchit-jsonld";
  let script = document.getElementById(scriptId);
  if (!script) {
    script = document.createElement("script");
    script.setAttribute("id", scriptId);
    script.setAttribute("type", "application/ld+json");
    document.head.appendChild(script);
  }
  script.textContent = JSON.stringify(jsonLd);
}

export function applySeoMeta(meta) {
  const title = String(meta?.title || SITE_NAME).trim() || SITE_NAME;
  const description = String(meta?.description || DEFAULT_DESCRIPTION).trim() || DEFAULT_DESCRIPTION;
  const keywords = String(meta?.keywords || DEFAULT_KEYWORDS).trim() || DEFAULT_KEYWORDS;
  const canonical = String(meta?.canonical || toAbsoluteUrl("/")).trim() || toAbsoluteUrl("/");
  const robots = String(meta?.robots || "index,follow").trim() || "index,follow";
  const ogType = String(meta?.ogType || "website").trim() || "website";
  const twitterCard = String(meta?.twitterCard || "summary").trim() || "summary";

  if (typeof document !== "undefined") {
    document.title = title;
  }

  upsertMeta("meta[name='description']", { name: "description" }, description);
  upsertMeta("meta[name='keywords']", { name: "keywords" }, keywords);
  upsertMeta("meta[name='robots']", { name: "robots" }, robots);
  upsertMeta("meta[property='og:site_name']", { property: "og:site_name" }, SITE_NAME);
  upsertMeta("meta[property='og:type']", { property: "og:type" }, ogType);
  upsertMeta("meta[property='og:title']", { property: "og:title" }, title);
  upsertMeta("meta[property='og:description']", { property: "og:description" }, description);
  upsertMeta("meta[property='og:url']", { property: "og:url" }, canonical);
  upsertMeta("meta[name='twitter:card']", { name: "twitter:card" }, twitterCard);
  upsertMeta("meta[name='twitter:title']", { name: "twitter:title" }, title);
  upsertMeta("meta[name='twitter:description']", { name: "twitter:description" }, description);
  upsertCanonical(canonical);

  if (meta?.jsonLd) {
    upsertJsonLd(meta.jsonLd);
  }
}

export function buildHomeSeoMeta() {
  const title = "Researchit | Evidence-First Strategic Research for Decision Teams";
  const description = "Run startup validation, market-entry, competitive, GTM, and investment research with structured evidence, confidence, and critic challenge in one workspace.";
  const canonical = toAbsoluteUrl("/");
  return {
    title,
    description,
    keywords: `${DEFAULT_KEYWORDS}, strategy, founders, executives, analysts`,
    canonical,
    robots: "index,follow",
    ogType: "website",
    twitterCard: "summary_large_image",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: SITE_NAME,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description,
      url: canonical,
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    },
  };
}

export function buildResearchSeoMeta(config) {
  const label = String(config?.tabLabel || config?.name || "Research").trim() || "Research";
  const methodology = summarizeMethodology(config?.methodology, 230);
  const description = methodology
    ? `${methodology} Use Researchit to pressure-test this decision with evidence and a critic pass.`
    : `Run ${label} research in Researchit with evidence-backed scoring and analyst/critic review.`;
  const path = getResearchPath(config);
  const canonical = toAbsoluteUrl(path);
  const title = `${label} Research | Researchit`;
  const aboutSource = Array.isArray(config?.dimensions) && config.dimensions.length
    ? config.dimensions
    : (Array.isArray(config?.attributes) ? config.attributes : []);
  const aboutItems = aboutSource
    .map((item) => String(item?.label || "").trim())
    .filter(Boolean)
    .slice(0, 12);

  return {
    title,
    description,
    keywords: `${DEFAULT_KEYWORDS}, ${label.toLowerCase()}, ${getConfigSlug(config)}`,
    canonical,
    robots: "index,follow",
    ogType: "article",
    twitterCard: "summary",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: title,
      url: canonical,
      description,
      isPartOf: {
        "@type": "WebSite",
        name: SITE_NAME,
        url: toAbsoluteUrl("/"),
      },
      about: aboutItems,
    },
  };
}

export function buildNotFoundSeoMeta(pathname = "/") {
  const canonical = toAbsoluteUrl(pathname);
  return {
    title: "Page Not Found | Researchit",
    description: "The requested Researchit page could not be found.",
    canonical,
    robots: "noindex,nofollow",
    ogType: "website",
    twitterCard: "summary",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: "Page Not Found",
      url: canonical,
      description: "The requested Researchit page could not be found.",
    },
  };
}
