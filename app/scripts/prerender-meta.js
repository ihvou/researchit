/**
 * Post-build script: stamps route-specific <head> tags into index.html copies.
 *
 * Input:  dist/index.html  (Vite build output)
 *         configs/research-configurations.js  (route list + metadata)
 *         src/lib/seo.js  (shared SEO builders)
 *
 * Output: dist/index.html  (homepage meta replaced)
 *         dist/{slug}/index.html  (one per config)
 *
 * Run: node scripts/prerender-meta.js
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHomeSeoMeta, buildResearchSeoMeta } from "../src/lib/seo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "..", "dist");
const TEMPLATE_PATH = resolve(DIST, "index.html");
const FALLBACK_SITE_NAME = "Research it";

// ---------------------------------------------------------------------------
// Import configs (pure ESM, no browser deps)
// ---------------------------------------------------------------------------

const { RESEARCH_CONFIGS } = await import("../../configs/research-configurations.js");

function getSlug(config) {
  return String(config?.slug || config?.id || "").trim().toLowerCase();
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

function applyMeta(template, meta, siteName) {
  let html = template;

  // Title
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(meta.title)}</title>`);

  // Standard meta
  html = replaceMeta(html, 'name="description"', meta.description);
  html = replaceMeta(html, 'name="keywords"', meta.keywords);
  html = replaceMeta(html, 'name="robots"', meta.robots);

  // Open Graph
  html = replaceMeta(html, 'property="og:site_name"', siteName);
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
const homeMeta = buildHomeSeoMeta();
const siteName = String(homeMeta?.jsonLd?.name || FALLBACK_SITE_NAME).trim() || FALLBACK_SITE_NAME;
const homeHtml = applyMeta(template, homeMeta, siteName);
writeFileSync(TEMPLATE_PATH, homeHtml, "utf-8");
console.log(`  /index.html  →  ${homeMeta.title}`);

// 2. Per-config pages
let count = 0;
for (const config of RESEARCH_CONFIGS) {
  const slug = getSlug(config);
  if (!slug) continue;

  const meta = buildResearchSeoMeta(config);
  const html = applyMeta(template, meta, siteName);

  const dir = resolve(DIST, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "index.html"), html, "utf-8");
  count++;
  console.log(`  /${slug}/index.html  →  ${meta.title}`);
}

console.log(`\nPrerendered ${count + 1} pages (1 homepage + ${count} configs).`);
