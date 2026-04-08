# Spec: Static Prerendering for SEO and Direct URL Access

## Problem

1. **Direct URLs return 404.** `vercel.json` enumerates rewrite rules per slug. Any slug not explicitly listed, or any edge case in the pattern, causes Vercel to return a real 404 before the SPA can handle routing.

2. **Search engines see empty HTML.** Every page serves the same `index.html` with generic meta tags and `<div id="root"></div>`. Route-specific `<title>`, `<meta description>`, `<link rel="canonical">`, and JSON-LD are injected by JavaScript after load. Googlebot executes JS but with delayed indexing, lower crawl priority, and no guarantees on dynamic meta tag pickup.

Both problems have the same root cause: there is no route-aware HTML on the server side.

## Solution

Generate a static HTML file per known route at **build time**. Each file contains the correct meta tags and an empty `<div id="root"></div>`. The SPA bundle loads and hydrates normally — the app looks and behaves identically to today.

## Routes to Prerender

All routes are derivable from `configs/research-configurations.js` at build time.

| Route | Source |
|-------|--------|
| `/index.html` | Homepage — `buildHomeSeoMeta()` |
| `/{slug}/index.html` | One per config — `buildResearchSeoMeta(config)` |

Slugs come from `URL_SLUG_BY_CONFIG` in the config file (11 configs currently):
`startup-validation`, `market-entry`, `competitive-landscape`, `build-vs-buy`, `investment-m-a-screening`, `product-expansion`, `market-sizing`, `icp-customer-persona`, `competitors-comparison`, `gtm-strategy`, `gtm-channels-comparison`

Total: **12 HTML files** (1 homepage + 11 config pages).

## What Each Prerendered File Contains

Take the current `app/index.html` as the template. For each route, replace:

- `<title>` with the route-specific title
- `<meta name="description">` with the route-specific description
- `<meta name="keywords">` with the route-specific keywords
- `<meta name="robots">` with `index,follow`
- All `<meta property="og:*">` tags with route-specific values
- All `<meta name="twitter:*">` tags with route-specific values
- `<link rel="canonical">` with the route's canonical URL
- Inject a `<script type="application/ld+json">` block with route-specific JSON-LD

The `<body>` stays identical: `<div id="root"></div>` + the Vite script tag. No component prerendering — just meta tags.

## Implementation

### Approach: Vite Post-Build Script

Rather than a prerender plugin (which renders full React components), use a simple **post-build Node script** that:

1. Reads the built `app/dist/index.html` as a template
2. Imports the config and SEO modules
3. For each route, generates a modified HTML file with the correct `<head>` tags
4. Writes to `app/dist/{slug}/index.html`

This avoids any React SSR complexity. The script runs after `vite build` and only manipulates HTML strings.

### File: `app/scripts/prerender-meta.js`

```
Input:  app/dist/index.html (Vite build output)
        configs/research-configurations.js (route list + metadata)
        app/src/lib/seo.js (meta tag builders)

Output: app/dist/index.html (homepage meta tags replaced)
        app/dist/{slug}/index.html (one per config, with config-specific meta tags)
```

### Build Command Change

```json
// current
"buildCommand": "cd app && npm run build"

// new (in app/package.json scripts)
"build": "vite build && node scripts/prerender-meta.js"
```

No change to `vercel.json` build command — it already runs `npm run build`.

### vercel.json Simplification

Replace all explicit slug rewrites with a single catch-all. Prerendered files are served directly by Vercel's static file server (e.g. `/startup-validation/` serves `/startup-validation/index.html`). The catch-all handles any non-file, non-API path for SPA fallback:

```json
{
  "framework": "vite",
  "installCommand": "cd app && npm install",
  "buildCommand": "cd app && npm run build",
  "outputDirectory": "app/dist",
  "rewrites": [
    {
      "source": "/((?!api/|assets/|.*\\..*).*)",
      "destination": "/index.html"
    }
  ]
}
```

Vercel serves static files first. If `/startup-validation/index.html` exists in the output, a request to `/startup-validation/` gets that file directly — no rewrite needed. The catch-all only fires for paths that don't match a static file (unknown slugs, deep paths, etc.), falling back to the homepage `index.html` where the SPA router shows a 404.

## What Changes in the App

### Nothing in components, hooks, or state logic.

The `seo.js` module stays. It still runs client-side to update meta tags on SPA navigation (e.g., user clicks from homepage to a research config). The prerendered HTML covers the **first page load** for search engines and direct URL access. The client-side `applySeoMeta()` covers **subsequent navigations** within the SPA.

### `app/src/lib/seo.js` — Extract Meta Builders for Node

The `buildHomeSeoMeta()` and `buildResearchSeoMeta(config)` functions currently work in both browser and Node (they already guard `typeof window`). The prerender script imports and calls them directly. No changes needed to these functions.

### `configs/research-configurations.js` — No Changes

The script imports configs to get the slug list and metadata. The config file is already pure ESM with no browser dependencies.

## What the User Sees

**Identical to today.** The prerendered HTML has no visible content beyond what `index.html` already shows (the `<div id="root">` is empty until React hydrates). The only difference:

- Page loads slightly faster (browser can start painting the title bar and begin preconnects while JS loads)
- Direct URL access works on every hosting provider, not just Vercel with specific rewrites
- Search engines see correct meta tags on first crawl

## What Search Engines See

Before (every page):
```html
<title>Research it | Evidence-First Strategic Research</title>
<meta name="description" content="Research it helps founders...">
<link rel="canonical" href="https://researchit.app/">
```

After (`/startup-validation/`):
```html
<title>Startup Validation Research | Research it</title>
<meta name="description" content="This type of research is anchored in Jobs to Be Done...">
<link rel="canonical" href="https://researchit.app/startup-validation/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage",...}</script>
```

## Verification

1. `npm run build` produces `dist/index.html` + `dist/{slug}/index.html` for all 11 slugs
2. Each file has correct `<title>`, `<meta>`, `<link rel="canonical">`, and JSON-LD
3. `npx vercel dev` serves `/startup-validation/` with the prerendered HTML (check view-source)
4. SPA hydrates and behaves normally after load
5. SPA navigation between configs still updates meta tags via `applySeoMeta()`
6. Unknown paths fall through to the catch-all rewrite → SPA router → 404 page

## Files Created or Modified

| File | Action |
|------|--------|
| `app/scripts/prerender-meta.js` | **Create** — post-build script |
| `app/package.json` | **Modify** — update build script to chain prerender |
| `vercel.json` | **Modify** — simplify rewrites to single catch-all |

No changes to any component, hook, lib, config, or engine file.
