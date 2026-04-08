/**
 * Post-build script: stamps route-specific <head> tags into index.html copies.
 *
 * Input:  dist/index.html  (Vite build output)
 *         configs/research-configurations.js  (route list + metadata)
 *
 * Output: dist/index.html  (homepage meta replaced)
 *         dist/{slug}/index.html  (one per config)
 *
 * Run: node scripts/prerender-meta.js
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "..", "dist");
const TEMPLATE_PATH = resolve(DIST, "index.html");

const SITE_NAME = "Research it";
const SITE_URL = "https://researchit.app";
const DEFAULT_DESCRIPTION =
  "Research it helps founders, executives, and analysts run evidence-first strategic research with analyst-plus-critic validation.";
const DEFAULT_KEYWORDS = [
  "strategic research tool",
  "market analysis",
  "startup validation",
  "competitive landscape",
  "evidence-based decision making",
  "researchit",
].join(", ");

// ---------------------------------------------------------------------------
// Import configs (pure ESM, no browser deps)
// ---------------------------------------------------------------------------

const { RESEARCH_CONFIGS } = await import("../../configs/research-configurations.js");

// ---------------------------------------------------------------------------
// Meta builders (mirrors app/src/lib/seo.js but pure-Node, no DOM)
// ---------------------------------------------------------------------------

function summarizeMethodology(text, maxLength = 230) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const first = raw.split(/(?<=[.!?])\s+/)[0] || raw;
  return first.length <= maxLength ? first : `${first.slice(0, maxLength - 1).trimEnd()}...`;
}

function getSlug(config) {
  return String(config?.slug || config?.id || "").trim().toLowerCase();
}

function buildHomeMeta() {
  const title = "Research it | Evidence-First Strategic Research for Decision Teams";
  const description =
    "Run startup validation, market-entry, competitive, GTM, and investment research with structured evidence, confidence, and critic challenge in one workspace.";
  const canonical = `${SITE_URL}/`;
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
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
  };
}

function buildResearchMeta(config) {
  const label = String(config?.tabLabel || config?.name || "Research").trim() || "Research";
  const methodology = summarizeMethodology(config?.methodology, 230);
  const description = methodology
    ? `${methodology} Use Research it to pressure-test this decision with evidence and a critic pass.`
    : `Run ${label} research in Research it with evidence-backed scoring and analyst/critic review.`;
  const slug = getSlug(config);
  const canonical = `${SITE_URL}/${slug}/`;
  const title = `${label} Research | Research it`;
  const aboutSource =
    Array.isArray(config?.dimensions) && config.dimensions.length
      ? config.dimensions
      : Array.isArray(config?.attributes)
        ? config.attributes
        : [];
  const aboutItems = aboutSource
    .map((item) => String(item?.label || "").trim())
    .filter(Boolean)
    .slice(0, 12);

  return {
    title,
    description,
    keywords: `${DEFAULT_KEYWORDS}, ${label.toLowerCase()}, ${slug}`,
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
      isPartOf: { "@type": "WebSite", name: SITE_NAME, url: `${SITE_URL}/` },
      about: aboutItems,
    },
  };
}

// ---------------------------------------------------------------------------
// HTML manipulation
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function replaceMeta(html, selector, content) {
  // selector like: name="description" or property="og:title"
  const re = new RegExp(`(<meta\\s[^>]*${selector}[^>]*content=")[^"]*(")`,"i");
  if (re.test(html)) {
    return html.replace(re, `$1${escapeHtml(content)}$2`);
  }
  // Insert before </head> if missing
  const tag = selector.startsWith("property=")
    ? `<meta ${selector} content="${escapeHtml(content)}" />`
    : `<meta ${selector} content="${escapeHtml(content)}" />`
  return html.replace("</head>", `    ${tag}\n  </head>`);
}

function applyMeta(template, meta) {
  let html = template;

  // Title
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(meta.title)}</title>`);

  // Standard meta
  html = replaceMeta(html, 'name="description"', meta.description);
  html = replaceMeta(html, 'name="keywords"', meta.keywords);
  html = replaceMeta(html, 'name="robots"', meta.robots);

  // Open Graph
  html = replaceMeta(html, 'property="og:site_name"', SITE_NAME);
  html = replaceMeta(html, 'property="og:type"', meta.ogType);
  html = replaceMeta(html, 'property="og:title"', meta.title);
  html = replaceMeta(html, 'property="og:description"', meta.description);
  html = replaceMeta(html, 'property="og:url"', meta.canonical);

  // Twitter
  html = replaceMeta(html, 'name="twitter:card"', meta.twitterCard);
  html = replaceMeta(html, 'name="twitter:title"', meta.title);
  html = replaceMeta(html, 'name="twitter:description"', meta.description);

  // Canonical
  html = html.replace(
    /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/,
    `<link rel="canonical" href="${escapeHtml(meta.canonical)}" />`
  );

  // JSON-LD
  if (meta.jsonLd) {
    const jsonLdTag = `<script type="application/ld+json">${JSON.stringify(meta.jsonLd)}</script>`;
    if (html.includes('application/ld+json')) {
      html = html.replace(/<script\s+type="application\/ld\+json">[^<]*<\/script>/, jsonLdTag);
    } else {
      html = html.replace("</head>", `    ${jsonLdTag}\n  </head>`);
    }
  }

  return html;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const template = readFileSync(TEMPLATE_PATH, "utf-8");

// 1. Homepage
const homeMeta = buildHomeMeta();
const homeHtml = applyMeta(template, homeMeta);
writeFileSync(TEMPLATE_PATH, homeHtml, "utf-8");
console.log(`  /index.html  →  ${homeMeta.title}`);

// 2. Per-config pages
let count = 0;
for (const config of RESEARCH_CONFIGS) {
  const slug = getSlug(config);
  if (!slug) continue;

  const meta = buildResearchMeta(config);
  const html = applyMeta(template, meta);

  const dir = resolve(DIST, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "index.html"), html, "utf-8");
  count++;
  console.log(`  /${slug}/index.html  →  ${meta.title}`);
}

console.log(`\nPrerendered ${count + 1} pages (1 homepage + ${count} configs).`);
