# ResearchIt — Architecture

This document captures the architectural principles and module boundaries of the ResearchIt monorepo. All future changes should respect these constraints.

---

## Core Idea

ResearchIt is a **config-driven AI research engine** with a product shell on top. The engine scores any set of weighted dimensions against any input using a multi-phase LLM pipeline (analyst → critic → response), producing structured, auditable research results. The product shell is one consumer; other products can use the same engine with different configs.

---

## Module Boundaries

```
researchit/
  engine/          @researchit/engine — reusable research logic
  app/             Product shell — React UI + Vercel serverless API
  configs/         ResearchConfig instances consumed by products
```

### engine/ — The Engine Package

**Owns:** research behavior and core contracts.

**Constraints:**
- Zero React dependency. Zero browser-only API usage.
- Zero product-specific language in prompts or logic.
- No knowledge of Vercel, hosting, or deployment.
- No hardcoded dimension IDs — all dimension-specific behavior reads from config.
- Dependency-injected transport for all LLM and source-fetch calls.
- Can be extracted to a standalone npm package with no code changes.

**Internal structure:**
| Directory | Contents |
|-----------|----------|
| `pipeline/` | `analysis.js` (8-phase analysis), `followUp.js` (intent-classified follow-up) |
| `providers/` | `openai.js` — provider adapter (message building, response parsing, web search, fallback chain) |
| `lib/` | Pure utility modules: transport, scoring, confidence, rubric, arguments, dimensionView, followUpIntent, researchBrief, serialize, debug, json |
| `prompts/` | `defaults.js` — generic default system prompts (overridable via ResearchConfig) |
| `configs/` | `researchit-dimensions.js` — shipped default dimension set |

**Barrel export:** `engine/index.js` is the public API surface. Internal file paths are not part of the contract.

**Key function signatures:**
```js
runAnalysis(input, config, callbacks)
// input:     { description, id, origin?, options?: { evidenceMode?, deepAssist?, ... } }
// config:    ResearchConfig object
// callbacks: { transport, onProgress, onDebugSession? }

handleFollowUp(input, config, callbacks)
// input:     { ucId, dimId?, subjectId?, attributeId?, challenge, ucState, options? }
// config:    ResearchConfig object
// callbacks: { transport, onProgress }

resolveMatrixResearchInput(input, config, callbacks, options)
// input:     { description, options?.matrixSubjects?[] }
// options:   { requireConfirmation?: boolean }
// returns:   resolved subjects + decision question (+ discovery metadata when used)
```

### app/ — Product Shell

**Owns:** user experience, deployment, and API-key management.

**Constraints:**
- Imports engine only via `@researchit/engine` (resolved as `file:../engine`).
- All LLM calls go through the engine's transport abstraction — app provides the `callFn` implementation.
- `analyst.js` / `critic.js` are thin wrappers around engine's `callOpenAI`; `providerConfig.js` and `fetch-source.js` handle host-only concerns.
- UI components never call APIs directly; data fetching/orchestration stays in hooks and lib adapters.

**Internal structure:**
| Directory | Contents |
|-----------|----------|
| `api/` | Vercel serverless routes: `analyst.js`, `critic.js`, `fetch-source.js`, `providerConfig.js` |
| `src/components/` | React UI components (tabs, pills, badges, lists, threads) |
| `src/hooks/` | `useAnalysis.js`, `useFollowUp.js` — orchestration hooks that wire engine to React state |
| `src/lib/` | Product-only utilities: `export.js` (HTML/PDF/ZIP), `scoringUI.js`, `confidenceUI.js`, `debugUI.js`, `api.js` (transport implementation), `seo.js` (meta tag management), `routes.js` (URL ↔ config resolution) |
| `scripts/` | Build-time scripts: `prerender-meta.js` (stamps route-specific SEO tags into static HTML) |

### configs/ — Research Configurations

**Owns:** concrete ResearchConfig objects that define what a specific product researches.

**Constraints:**
- Each config is a self-contained JS module exporting a ResearchConfig.
- Configs may import engine defaults (dimensions, prompts) and override selectively.
- Product shell imports configs; engine never imports from this directory.

---

## Data Flow

```
User input + ResearchConfig
  ↓
App hooks (useAnalysis / useFollowUp)
  ↓
Engine pipelines (runAnalysis / handleFollowUp)
  ↓ uses
Transport (dependency-injected callFn)
  ↓
App's callFn → fetch("/api/analyst" | "/api/critic" | "/api/fetch-source")
  ↓
Serverless route (`analyst` / `critic`) → engine's callOpenAI() → OpenAI API
  ↓
Results flow back through callbacks.onProgress → React state → UI
```

---

## Analysis Pipeline

### Scorecard (8 phases, evidence-mode aware)
1. **Phase 1 evidence collection**
   - Native: analyst baseline + analyst web pass + reconcile
   - Deep Assist: multi-provider deep collection + merge + provider agreement synthesis
2. **Targeted low-confidence cycle** — query plan → web harvest → re-score for weak dimensions
5. **Critic audit** — independent critical review of all findings
6. **Analyst final response** — address critic challenges with evidence
7. **Consistency check** — cross-dimension coherence validation + decision/confidence/polarity post-guards
8. **Discovery generation** — related opportunities + candidate pre-validation

### Matrix (evidence-mode aware)
1. **Plan/input resolution** — resolve decision question and matrix subjects
2. **Phase 1 evidence collection**
   - Native: baseline matrix pass + web matrix pass + reconcile
   - Deep Assist: multi-provider matrix collection + merge + provider agreement synthesis
5. **Targeted low-confidence recovery** — focused query plan/harvest/rescore per weak cell
6. **Critic matrix audit** — flag weak/contradictory cells
7. **Analyst response** — defend or concede each contested cell
8. **Summary** — finalize matrix outputs (executive synthesis + optional discovery suggestions)

### Source verification
After source-producing passes, cited URLs are checked via `fetchSource`. Sources are tagged `verified_in_page`, `not_found_in_page`, or `fetch_failed`. Confidence can be downgraded when verification coverage is weak.

### Run diagnostics surface
Pipelines emit reliability/quality diagnostics into `analysisMeta` (e.g., source verification totals, reconcile health/retry outcomes, critic flag-rate signals, coverage SLA status, stale-evidence ratio, provider contribution, and post-guard adjustment counts). App UI and exports consume this metadata to show run quality state.

### Degraded-complete semantics
Quality gates no longer hard-abort the entire run for recoverable failures. Pipelines can complete with:
- `analysisMeta.qualityGrade = "standard"` — quality thresholds met
- `analysisMeta.qualityGrade = "degraded"` — partial output is returned with explicit `degradedReasons[]`

This keeps output inspectable while preserving honest quality signaling.

## Follow-Up Pipeline

Classifies user intent into one of 6 types, then executes intent-specific logic:
- `challenge` — dispute findings, require counter-evidence
- `question` — clarifying question
- `reframe` — reinterpret the problem
- `add_evidence` — incorporate new sources
- `note` — comment (no re-analysis)
- `re_search` — re-run a specific dimension with web search

Supports both:
- scorecard threads (`dimId`)
- matrix cell threads (`subjectId` + `attributeId`)

---

## ResearchConfig Contract

```js
{
  id,                    // unique string
  name,                  // human-readable name
  tabLabel,              // UI tab label
  outputMode,            // "scorecard" | "matrix"
  shortDescription,      // concise discovery/homepage copy
  methodology,           // methodology notes shown in UI (supports inline links)
  engineVersion,         // semver

  inputSpec: { label, placeholder, description },
  framingFields: [{ id, label, description }],

  // scorecard mode
  dimensions: [{
    id, label, weight, enabled,
    brief, fullDef,
    polarityHint,                          // read by engine rubric
    researchHints: { whereToLook, queryTemplates }  // read by engine brief
  }],

  // matrix mode
  matrixLayout,         // "subjects-as-rows" | "subjects-as-columns" | "auto" (UI default hint)
  subjects: { label, inputPrompt, examples, minCount, maxCount },
  attributes: [{ id, label, brief, derived? }],

  relatedDiscovery,      // boolean — enables phase 8

  prompts: {             // optional overrides; engine has generic defaults
    analyst, critic, analystResponse, followUp
  },

  models: {
    analyst: { provider, model, webSearchModel?, baseUrl? },
    critic:  { provider, model, webSearchModel?, baseUrl? }
  },

  deepAssist: {
    defaults: { providers, minProviders, maxWaitMs, maxRetries },
    providers: {
      [providerId]: {
        analyst: { provider, model, webSearchModel?, baseUrl? }
      }
    }
  },

  limits: {
    maxSourcesPerDim,
    discoveryMaxCandidates,
    matrixCoverageSLA: {
      minSourcesPerCell, minSubjectEvidenceCoverage, maxUnresolvedCellsRatio, maxUnresolvedCells?
    },
    criticFlagMonitoring: {
      minAuditedCells, minFlagRate, highLowConfidenceRate
    },
    tokenLimits: { phase1Evidence, phase1Scoring, critic, phase3Response,
                   followUpQuestion, followUpChallenge, intentClassification }
  }
}
```

---

## Routing, SEO & Static Prerendering

The app is a client-side SPA. Routing is handled by a custom router (`ResearchitRoot.jsx`) that reads `window.location.pathname` and resolves it to a config via `lib/routes.js`. No React Router dependency.

**URL structure:**
- `/` — homepage (landing page)
- `/{slug}/` — research workspace for a specific config (e.g. `/startup-validation/`)
- `/workspace`, `/research/{slug}` — legacy paths, redirected client-side

**Static prerendering:** At build time, `app/scripts/prerender-meta.js` runs after `vite build`. It uses shared builders from `src/lib/seo.js`, generates route-specific `<title>`, `<meta>`, `<link rel="canonical">`, and JSON-LD, and writes one `index.html` per route into `dist/{slug}/index.html`. Canonical base URL is configurable via `RESEARCHIT_PUBLIC_URL` (fallback: `https://researchit.app`). Vercel serves these static files directly — no rewrite needed for known slugs.

A single catch-all rewrite in `vercel.json` handles unknown paths, falling back to `dist/index.html` where the SPA router renders a 404.

**Client-side SEO updates:** `lib/seo.js` updates meta tags dynamically on in-app navigation (e.g., user switches configs). The prerendered HTML covers the first page load for search engines and direct URL access; the client-side `applySeoMeta()` covers subsequent navigations within the SPA.

**Adding a new route:** Add the config to `configs/research-configurations.js` with a `slug` entry. The prerender script and router pick it up automatically — no changes to `vercel.json` or routing code needed.

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transport | Dependency injection (`createTransport(callFn)`) | Engine stays host-agnostic; testable without real API calls |
| Package format | ESM only (`"type": "module"`) | Vite and modern Node both support it |
| State updates | `onProgress(phase, partialState)` callback | Simpler React integration than async generators |
| Prompt ownership | Engine ships generic defaults; product overrides via config | Engine stays product-agnostic |
| Serverless routes | Stay in product shell, not engine | Engine is library-only, never a server |
| Dimension config | JS modules (not JSON) | Importable, supports comments, can reference engine defaults |
| SEO prerendering | Build-time meta injection, not SSR | All routes are known at build time; avoids server runtime complexity |

---

## Provider Resolution

API key, model, and base URL are resolved at request time with this precedence:
1. Role-specific `RESEARCHIT_*` env vars (e.g. `RESEARCHIT_ANALYST_MODEL`)
2. Global `RESEARCHIT_*` env vars
3. OpenAI-prefixed env aliases (e.g. `OPENAI_MODEL`)
4. `ResearchConfig.models.*` values
5. Built-in defaults

Key is server-side only. BYOK UI is planned but not yet implemented.

---

## What Must Stay True

These invariants must hold across all future changes:

1. **`engine/` has zero imports from `app/` or `configs/`.** Dependency flows one way: app → engine, configs → engine defaults.
2. **Engine never calls `fetch()`, DOM APIs, or React APIs.** All external I/O goes through injected transport.
3. **Engine never references specific dimension IDs.** All dimension-specific behavior reads from the config object's dimension fields.
4. **Prompts in `engine/prompts/defaults.js` contain no product-specific language.** Products customize via `ResearchConfig.prompts`.
5. **UI components never call APIs directly.** Data fetching/orchestration stays in hooks and app lib adapters.
6. **LLM routes stay thin.** Business logic lives in engine; non-LLM API handlers are limited to host concerns (provider/env resolution and source fetch sanitization).
