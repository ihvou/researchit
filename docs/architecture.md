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
// input:     { description, id, origin? }
// config:    ResearchConfig object
// callbacks: { transport, onProgress, onDebugSession? }

handleFollowUp(input, config, callbacks)
// input:     { ucId, dimId, challenge, ucState, options? }
// config:    ResearchConfig object
// callbacks: { transport, onProgress }
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
| `src/lib/` | Product-only utilities: `export.js` (HTML/PDF/ZIP), `scoringUI.js`, `confidenceUI.js`, `debugUI.js`, `api.js` (transport implementation) |

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

## Analysis Pipeline (8 Phases)

1. **Analyst baseline** — memory-only initial scoring across all dimensions
2. **Analyst web pass** — live-search-assisted evidence gathering
3. **Reconcile** — merge evidence from both passes, re-score
4. **Targeted low-confidence cycle** — query plan → web harvest → re-score for weak dimensions
5. **Critic audit** — independent critical review of all findings
6. **Analyst final response** — address critic challenges with evidence
7. **Consistency check** — cross-dimension coherence validation
8. **Discovery generation** — related opportunities + candidate pre-validation

## Follow-Up Pipeline

Classifies user intent into one of 6 types, then executes intent-specific logic:
- `challenge` — dispute findings, require counter-evidence
- `question` — clarifying question
- `reframe` — reinterpret the problem
- `add_evidence` — incorporate new sources
- `note` — comment (no re-analysis)
- `re_search` — re-run a specific dimension with web search

---

## ResearchConfig Contract

```js
{
  id,                    // unique string
  name,                  // human-readable name
  tabLabel,              // UI tab label
  outputMode,            // "scorecard" | "matrix"
  methodology,           // methodology notes shown in UI
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

  limits: {
    maxSourcesPerDim,
    discoveryMaxCandidates,
    tokenLimits: { phase1Evidence, phase1Scoring, critic, phase3Response,
                   followUpQuestion, followUpChallenge, intentClassification }
  }
}
```

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
