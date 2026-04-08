import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESEARCH_CONFIGS } from "../../configs/research-configurations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const SITE_URL = (process.env.RESEARCHIT_PUBLIC_URL || "https://researchit.app").replace(/\/+$/, "");
const SITE_NAME = "Research it";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateAtWord(text, maxLength) {
  const raw = String(text || "").trim();
  if (!raw || raw.length <= maxLength) return raw;
  const sliced = raw.slice(0, Math.max(0, maxLength - 1));
  const compact = sliced.replace(/\s+\S*$/, "").trim();
  return `${(compact || sliced.trimEnd())}...`;
}

function firstSentence(text, maxLength = 260) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const first = raw.split(/(?<=[.!?])\s+/)[0] || raw;
  return truncateAtWord(first, maxLength);
}

function configTitle(config) {
  return String(config?.tabLabel || config?.name || "Research").trim() || "Research";
}

function modeLabel(config) {
  return String(config?.outputMode || "").trim().toLowerCase() === "matrix" ? "Matrix" : "Scorecard";
}

function configItems(config) {
  if (String(config?.outputMode || "").trim().toLowerCase() === "matrix") {
    return Array.isArray(config?.attributes) ? config.attributes : [];
  }
  return Array.isArray(config?.dimensions) ? config.dimensions : [];
}

function metadataDescription(config) {
  const method = firstSentence(config?.methodology, 150);
  const items = configItems(config)
    .map((item) => String(item?.label || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  const itemPart = items.length
    ? ` Covers ${items.join(", ")}${items.length === 3 ? ", and more." : "."}`
    : "";
  if (method) return `${configTitle(config)} research in ${SITE_NAME}. ${method}${itemPart}`;
  return `Run ${configTitle(config)} research in ${SITE_NAME} with evidence-backed scoring and critic challenge.${itemPart}`;
}

function pageDescription(config) {
  const short = metadataDescription(config);
  return `${short} Use the interactive workspace for deep analysis and exportable outputs.`;
}

function buildJsonLd(config, canonical, description) {
  const about = configItems(config)
    .map((item) => String(item?.label || "").trim())
    .filter(Boolean)
    .slice(0, 16);
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${configTitle(config)} Research | ${SITE_NAME}`,
    description,
    url: canonical,
    isPartOf: {
      "@type": "WebSite",
      name: SITE_NAME,
      url: `${SITE_URL}/`,
    },
    about,
  });
}

function buildResearchPage(config, allConfigs) {
  const title = `${configTitle(config)} Research | ${SITE_NAME}`;
  const description = metadataDescription(config);
  const canonical = `${SITE_URL}/${config.slug}/`;
  const workspacePath = `/workspace/${config.slug}/`;
  const methodology = String(config?.methodology || "").trim();
  const items = configItems(config);
  const sources = Array.isArray(config?.methodologySources) ? config.methodologySources : [];
  const navLinks = allConfigs
    .map((entry) => {
      const isActive = entry.id === config.id;
      return `<a class="top-nav-link${isActive ? " active" : ""}" href="/${escapeHtml(entry.slug)}/">${escapeHtml(configTitle(entry))}</a>`;
    })
    .join("");
  const itemCards = items
    .map((item) => `
      <article class="dim-card">
        <h3>${escapeHtml(item?.label || "Dimension")}</h3>
        <p>${escapeHtml(item?.brief || "No description provided.")}</p>
      </article>
    `)
    .join("");
  const sourceLinks = sources.length
    ? `
      <section>
        <h2>Methodology Sources</h2>
        <ul class="source-list">
          ${sources
            .map((source) => {
              const label = escapeHtml(source?.label || "Source");
              const url = escapeHtml(source?.url || "");
              return `<li><a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a></li>`;
            })
            .join("")}
        </ul>
      </section>
    `
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="index,follow" />
    <meta name="keywords" content="research it, ${escapeHtml(config.slug)}, strategic research, ${escapeHtml(modeLabel(config).toLowerCase())}" />
    <meta property="og:site_name" content="${SITE_NAME}" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <script type="application/ld+json">${buildJsonLd(config, canonical, description)}</script>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
        background: #f4f4f4;
        color: #121212;
        line-height: 1.45;
      }
      a { color: #121212; }
      .shell { max-width: 1220px; margin: 0 auto; padding: 20px 20px 48px; }
      .top {
        display: flex;
        gap: 14px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        margin-bottom: 22px;
      }
      .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }
      .logo {
        width: 40px;
        height: 40px;
        border: 1px solid #1f1f1f;
        display: grid;
        place-items: center;
        background: #fff;
        position: relative;
        font-weight: 700;
      }
      .logo small {
        position: absolute;
        top: 2px;
        left: 3px;
        font-size: 9px;
        font-weight: 600;
      }
      .logo span { font-size: 20px; line-height: 1; }
      .brand strong { font-size: 30px; letter-spacing: -0.02em; }
      .top-nav {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        white-space: nowrap;
        padding-bottom: 2px;
        max-width: 100%;
      }
      .top-nav-link {
        border: 1px solid #c9c9c9;
        background: #fff;
        text-decoration: none;
        padding: 7px 11px;
        font-size: 13px;
      }
      .top-nav-link.active { border-color: #1b1b1b; font-weight: 600; }
      .hero {
        border: 1px solid #cfcfcf;
        background: #fff;
        padding: 20px;
      }
      .hero h1 {
        margin: 0 0 8px;
        font-size: clamp(30px, 4.2vw, 54px);
        letter-spacing: -0.02em;
      }
      .hero p { margin: 0; max-width: 1000px; color: #323232; font-size: 18px; }
      .meta {
        display: inline-flex;
        margin-top: 14px;
        border: 1px solid #1f1f1f;
        background: #fff;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        padding: 6px 9px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
      }
      .btn {
        text-decoration: none;
        border: 1px solid #191919;
        padding: 10px 14px;
        font-size: 14px;
      }
      .btn.primary { background: #101010; color: #fff; }
      .btn.ghost { background: #fff; color: #101010; }
      .content-grid {
        margin-top: 16px;
        display: grid;
        gap: 16px;
      }
      .section {
        border: 1px solid #d3d3d3;
        background: #fff;
        padding: 16px;
      }
      .section h2 {
        margin: 0 0 10px;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }
      .section p { margin: 0; color: #303030; }
      .dim-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .dim-card {
        border: 1px solid #d5d5d5;
        background: #fff;
        padding: 12px;
      }
      .dim-card h3 {
        margin: 0 0 6px;
        font-size: 18px;
      }
      .dim-card p {
        margin: 0;
        color: #3b3b3b;
      }
      .source-list {
        margin: 0;
        padding-left: 18px;
      }
      .source-list li { margin: 6px 0; }
      @media (max-width: 760px) {
        .shell { padding: 14px 12px 34px; }
        .brand strong { font-size: 24px; }
        .hero p { font-size: 16px; }
        .actions { width: 100%; }
        .btn { flex: 1 1 auto; text-align: center; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="top">
        <a class="brand" href="/">
          <div class="logo"><small>75</small><span>Re</span></div>
          <strong>${SITE_NAME}</strong>
        </a>
        <nav class="top-nav" aria-label="Researches available">
          ${navLinks}
        </nav>
      </header>
      <main>
        <section class="hero">
          <h1>${escapeHtml(configTitle(config))}</h1>
          <p>${escapeHtml(pageDescription(config))}</p>
          <span class="meta">${escapeHtml(modeLabel(config))} research</span>
          <div class="actions">
            <a class="btn primary" href="${escapeHtml(workspacePath)}">Open Interactive Workspace</a>
            <a class="btn ghost" href="/">Back to Home</a>
          </div>
        </section>
        <div class="content-grid">
          <section class="section">
            <h2>Methodology / Description</h2>
            <p>${escapeHtml(methodology || "No methodology details available yet.")}</p>
          </section>
          <section class="section">
            <h2>${String(config?.outputMode || "").toLowerCase() === "matrix" ? "Comparison Attributes" : "Dimensions"}</h2>
            <div class="dim-grid">
              ${itemCards}
            </div>
          </section>
          ${sourceLinks}
        </div>
      </main>
    </div>
  </body>
</html>`;
}

function buildSitemapXml(configs) {
  const urls = [
    { loc: `${SITE_URL}/`, changefreq: "weekly", priority: "1.0" },
    ...configs.map((config) => ({
      loc: `${SITE_URL}/${config.slug}/`,
      changefreq: "weekly",
      priority: "0.8",
    })),
  ];
  const body = urls
    .map((item) => `
  <url>
    <loc>${item.loc}</loc>
    <changefreq>${item.changefreq}</changefreq>
    <priority>${item.priority}</priority>
  </url>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}
</urlset>
`;
}

function buildLlmsTxt(configs) {
  const lines = [
    "# Research it",
    "",
    "Research it is a strategic research application for founders, executives, and analysts.",
    "It runs evidence-first research workflows with analyst generation plus critic challenge.",
    "",
    "## Primary URL",
    `- ${SITE_URL}/`,
    "",
    "## Key Research URLs",
    ...configs.map((config) => `- ${SITE_URL}/${config.slug}/`),
    "",
    "## Product Summary",
    "- Hybrid architecture: static research pages for indexing + interactive workspace for execution.",
    "- Supports scorecard and matrix research modes.",
    "- Uses configurable research dimensions/attributes per research type.",
    "- Produces auditable research outputs with confidence and source grounding.",
    "- Supports export artifacts (JSON, and scorecard exports like HTML/PDF/images).",
    "",
    "## Workspace",
    `- ${SITE_URL}/workspace/`,
  ];
  return `${lines.join("\n")}\n`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function generate() {
  await ensureDir(PUBLIC_DIR);
  for (const config of RESEARCH_CONFIGS) {
    const slugDir = path.join(PUBLIC_DIR, config.slug);
    await ensureDir(slugDir);
    const pagePath = path.join(slugDir, "index.html");
    await fs.writeFile(pagePath, buildResearchPage(config, RESEARCH_CONFIGS), "utf8");
  }
  await fs.writeFile(path.join(PUBLIC_DIR, "sitemap.xml"), buildSitemapXml(RESEARCH_CONFIGS), "utf8");
  await fs.writeFile(path.join(PUBLIC_DIR, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`, "utf8");
  await fs.writeFile(path.join(PUBLIC_DIR, "llms.txt"), buildLlmsTxt(RESEARCH_CONFIGS), "utf8");
}

generate().catch((error) => {
  console.error("Failed to generate static research pages:", error);
  process.exit(1);
});
