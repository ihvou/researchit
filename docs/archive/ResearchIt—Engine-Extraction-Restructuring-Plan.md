# ResearchIt — Engine Extraction & Restructuring Plan

## Idea

Turn the AI Use Case Prioritizer into **ResearchIt** — a general-purpose, config-driven AI research engine with a clean product shell on top. The engine scores any set of dimensions against any input, runs a multi-phase LLM debate, and produces structured research results. The product shell (researchit.app) is one consumer of the engine. Other products can use the same engine with different dimension configs, prompts, and branding.

## Goals

1. **Clean engine boundary** — the engine package has zero UI dependencies, zero product-specific language, and zero knowledge of React, Vercel, or any hosting platform.
2. **Config-driven research** — dimensions, prompts, model selection, feature flags (discovery on/off), and token limits are all passed in via a `ResearchConfig` object. The engine ships sensible defaults but imposes nothing.
3. **BYOK-ready** — the engine accepts an API transport function, not API keys. The product shell decides how to call LLMs (serverless proxy, direct client call, etc.).
4. **Multiple dimension sets** — different ResearchConfig objects can define entirely different scoring rubrics. The engine doesn't care what the dimensions are.
5. **Publishable engine** — the engine directory can be extracted to its own npm package or public repo at any point with no code changes.

---

## Current State Summary

```
researchit/                          (imported from ai-use-case-prioritizer)
├── api/                             Vercel serverless routes (analyst, critic, fetch-source)
├── src/
│   ├── main.jsx, App.jsx           React app shell
│   ├── components/                  16 UI components (pure, zero API calls)
│   ├── hooks/
│   │   ├── useAnalysis.js           Core pipeline (~2700 lines, pure async, no React imports)
│   │   └── useFollowUp.js           Follow-up handler (~620 lines, pure async)
│   ├── lib/
│   │   ├── api.js                   callAnalystAPI/callCriticAPI (fetch to /api/*)
│   │   ├── scoring.js               Score math + color helpers
│   │   ├── confidence.js            Normalization + UI color helpers
│   │   ├── rubric.js                Rubric formatting (has hardcoded polarity hints)
│   │   ├── json.js                  safeParseJSON + rubric markdown builder
│   │   ├── arguments.js             Argument shape normalization
│   │   ├── dimensionView.js         Dimension data aggregation
│   │   ├── followUpIntent.js        Intent classification
│   │   ├── researchBrief.js         Research brief (hardcoded dim ID switches)
│   │   ├── debug.js                 Debug event logging + browser download
│   │   └── export.js                JSON/HTML/PDF/CSV export (~1600 lines)
│   ├── constants/dimensions.js      DEFAULT_DIMS (11 dims, hardcoded)
│   └── prompts/system.js            4 system prompts (product-specific language)
├── ai-use-case-prioritizer.jsx      Legacy monolith (unused, delete)
├── package.json                     react, react-dom, html-to-image, jszip
└── .env                             Contains exposed API keys (rotate)
```

**Key facts:**
- `useAnalysis.js` and `useFollowUp.js` are NOT React hooks — they export pure async functions with zero React imports. State mutations go through an `updateUC(id, fn)` callback.
- All LLM calls route through `src/lib/api.js` → `fetch("/api/*")` → serverless functions.
- No circular dependencies. Dependency tree is fully acyclic.
- No npm LLM SDK dependencies — all API calls are raw `fetch()`.
- Components are pure UI — zero API calls, all data via props.
- api/analyst.js and api/critic.js are near-identical with hardcoded model names (`gpt-5.4-mini`, `gpt-5.4`) and OpenAI endpoints.

---

## Target Structure

```
researchit/
├── engine/                              THE ENGINE PACKAGE
│   ├── package.json                     { "name": "@researchit/engine", "type": "module" }
│   ├── index.js                         Barrel export
│   │
│   ├── pipeline/
│   │   ├── analysis.js                  runAnalysis(input, config, callbacks)
│   │   └── followUp.js                  handleFollowUp(input, config, callbacks)
│   │
│   ├── providers/
│   │   └── openai.js                    OpenAI provider adapter (message building,
│   │                                    response parsing, web search, fallback chain)
│   │
│   ├── lib/
│   │   ├── transport.js                 Transport-agnostic API gateway (accepts callFn)
│   │   ├── json.js                      safeParseJSON, JSON repair
│   │   ├── scoring.js                   getEffectiveScore, calcWeightedScore (no colors)
│   │   ├── confidence.js                normalizeConfidenceLevel only
│   │   ├── rubric.js                    Rubric calibration (polarity from dim config)
│   │   ├── arguments.js                 Argument normalization & thread application
│   │   ├── dimensionView.js             Dimension data aggregation across phases
│   │   ├── followUpIntent.js            Intent constants & classification helpers
│   │   ├── researchBrief.js             Research brief (data-driven from dim config)
│   │   ├── serialize.js                 JSON export schema assembly + import validation
│   │   └── debug.js                     Debug event creation (no download/buffer)
│   │
│   ├── prompts/
│   │   └── defaults.js                  Default system prompts (generic, overridable)
│   │
│   └── configs/
│       └── ai-use-case-dims.js          The 11 AI-use-case dimensions (shipped default)
│
├── app/                                 PRODUCT SHELL (researchit.app)
│   ├── package.json                     { dependencies: { react, react-dom, html-to-image, jszip } }
│   ├── vite.config.js
│   ├── vercel.json
│   ├── index.html
│   │
│   ├── api/                             Vercel serverless (thin wrappers)
│   │   ├── analyst.js                   Reads OPENAI_API_KEY, calls engine provider
│   │   ├── critic.js                    Same
│   │   └── fetch-source.js              URL fetcher
│   │
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── index.css
│       ├── components/                  All 16 UI components (unchanged)
│       │   └── ...
│       └── lib/                         Product-only utilities
│           ├── scoringUI.js             dimScoreColor(), totalScoreColor()
│           ├── confidenceUI.js          confidenceTone(), confidenceTitle()
│           ├── export.js                HTML/PDF/image/CSV rendering & DOM downloads
│           └── debugUI.js               Download helpers, in-memory session buffer
│
├── configs/                             RESEARCH TYPE CONFIGS
│   └── ai-use-case-prioritizer.js       ResearchConfig for the current product
│
├── README.md
└── TASKS.md
```

---

## ResearchConfig Shape

```javascript
{
  id: "ai-use-case-prioritizer",
  name: "AI Use Case Prioritizer",
  engineVersion: "1.0.0",

  dimensions: [{
    id: "roi",
    label: "ROI Magnitude",
    weight: 18,
    enabled: true,
    brief: "Scale of verifiable financial impact...",
    fullDef: "IMPORTANT: Thresholds reflect...",
    polarityHint: "Higher score = larger, more verifiable financial impact.",
    researchHints: {
      whereToLook: ["Industry analyst reports", "Earnings calls"],
      queryTemplates: ["${vertical} AI ROI case study"]
    }
  }, ...],

  relatedDiscovery: true,

  prompts: {                            // Optional — engine has generic defaults
    analyst: "You are a senior AI research analyst...",
    critic: "You are a skeptical research reviewer...",
    analystResponse: "...",
    followUp: "..."
  },

  models: {
    analyst: { provider: "openai", model: "gpt-5.4-mini" },
    critic: { provider: "openai", model: "gpt-5.4" }
  },

  limits: {
    maxSourcesPerDim: 14,
    discoveryMaxCandidates: 5,
    tokenLimits: {
      phase1Evidence: 8000,
      phase1Scoring: 6000,
      critic: 6000,
      phase3Response: 4000,
      followUpQuestion: 1400,
      followUpChallenge: 2100,
      intentClassification: 450
    }
  }
}
```

---

## Transformation Steps

### Step 1: Scaffold & delete legacy
**Risk: Low**

- Create `engine/`, `engine/lib/`, `engine/pipeline/`, `engine/providers/`, `engine/prompts/`, `engine/configs/`
- Create `app/` and move all product files into it (src/, api/, index.html, vite.config.js, vercel.json)
- Delete `ai-use-case-prioritizer.jsx` (legacy monolith, unused)
- Delete or rotate `.env` with exposed API keys
- Update `app/vite.config.js` paths if needed
- **Verify:** app still builds and runs from `app/` directory

### Step 2: Move pure libs to engine
**Risk: Low**

Move these files as-is (zero changes needed):

| From | To |
|------|----|
| `src/lib/json.js` | `engine/lib/json.js` |
| `src/lib/arguments.js` | `engine/lib/arguments.js` |
| `src/lib/followUpIntent.js` | `engine/lib/followUpIntent.js` |
| `src/lib/dimensionView.js` | `engine/lib/dimensionView.js` |

Update all import paths in `app/src/` to point to `../../engine/lib/...`.

- **Verify:** app builds, analysis runs, follow-up works

### Step 3: Split mixed files
**Risk: Low**

**3a. confidence.js**
- `engine/lib/confidence.js` — `normalizeConfidenceLevel()` only
- `app/src/lib/confidenceUI.js` — `confidenceTone()`, `confidenceTitle()`, imports normalizer from engine

**3b. scoring.js**
- `engine/lib/scoring.js` — `getEffectiveScore()`, `calcWeightedScore()`, `getLatestAcceptedFollowUpAdjustment()`
- `app/src/lib/scoringUI.js` — `dimScoreColor()`, `totalScoreColor()`

**3c. debug.js**
- `engine/lib/debug.js` — `createAnalysisDebugSession()`, `appendAnalysisDebugEvent()` (pure event structs)
- `app/src/lib/debugUI.js` — `downloadAnalysisDebugSession()`, `downloadDebugLogsBundle()`, in-memory buffer

Update all imports in `app/src/`.

- **Verify:** app builds, debug log download works, confidence badges render, scores calculate

### Step 4: Split export.js
**Risk: Medium**

- `engine/lib/serialize.js` — JSON export data assembly (`buildExportPayload()`), import validation & parsing (`importUseCasesFromJsonText()`), JSON schema version constants
- `app/src/lib/export.js` — HTML/PDF/image/CSV rendering, DOM download triggers, `dataUrlToBlob()`. Imports data assembly from engine.

This file is ~1600 lines so the cut line needs care. The engine half is the data shape logic; the product half is everything that touches DOM, `html-to-image`, `jszip`, or triggers a browser download.

- **Verify:** JSON export/import works, HTML/PDF export works

### Step 5: Move configs & make prompts generic
**Risk: Low**

- Move `src/constants/dimensions.js` → `engine/configs/ai-use-case-dims.js`
- Move `src/prompts/system.js` → `engine/prompts/defaults.js`
- Rewrite prompt text to be generic (remove "outsourcing company that delivers CUSTOM AI solutions" language). Product shell can override via ResearchConfig.prompts.
- Create `configs/ai-use-case-prioritizer.js` at repo root as the product's ResearchConfig, importing dims from engine default.

- **Verify:** app builds, prompts used in analysis are correct

### Step 6: Make rubric.js and researchBrief.js data-driven
**Risk: Medium**

**6a. rubric.js**
- Move to `engine/lib/rubric.js`
- Replace hardcoded `POLARITY_HINTS` object (keyed by dim ID) with `dim.polarityHint` field read from config
- `getPolarityHint(dimId)` → `getPolarityHint(dim)` (accepts dim object, not just ID)
- Add `polarityHint` field to each dimension in `engine/configs/ai-use-case-dims.js`

**6b. researchBrief.js**
- Move to `engine/lib/researchBrief.js`
- Replace hardcoded `whereToLookByDimension(dimId)` switch statement with `dim.researchHints.whereToLook`
- Replace hardcoded `suggestedQueries()` patterns with `dim.researchHints.queryTemplates`
- Add `researchHints` field to each dimension in config

- **Verify:** polarity hints render in rubric toggles, research briefs generate for low-confidence dims

### Step 7: Extract LLM provider from API routes
**Risk: Medium**

`api/analyst.js` and `api/critic.js` are near-identical (~247 lines each). They contain:
- Message formatting for OpenAI Chat Completions & Responses API
- Response text extraction
- Web search tool call counting
- Fallback chain: Chat Completions → Responses text-only → Responses with web search

Extract shared logic into `engine/providers/openai.js`:
```javascript
export function buildChatMessages(messages, systemPrompt) { ... }
export function extractResponsesText(output) { ... }
export function countWebSearchCalls(output) { ... }
export async function callOpenAI({ apiKey, model, messages, systemPrompt, maxTokens, liveSearch, baseUrl }) { ... }
```

Serverless routes in `app/api/` become thin wrappers:
```javascript
import { callOpenAI } from '../../engine/providers/openai.js';
export default async function handler(req, res) {
  const { messages, systemPrompt, maxTokens, liveSearch } = req.body;
  const result = await callOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: "gpt-5.4-mini",  // from config later
    messages, systemPrompt, maxTokens, liveSearch
  });
  res.json(result);
}
```

- **Verify:** full analysis runs, web search works, fallback chain triggers on API errors

### Step 8: Abstract API transport
**Risk: Medium**

Current `src/lib/api.js` hardcodes `fetch("/api/analyst")` and `fetch("/api/critic")`.

Create `engine/lib/transport.js`:
```javascript
export function createTransport(callFn) {
  return {
    callAnalyst: (messages, systemPrompt, maxTokens, options) =>
      callFn("analyst", { messages, systemPrompt, maxTokens, ...options }),
    callCritic: (messages, systemPrompt, maxTokens, options) =>
      callFn("critic", { messages, systemPrompt, maxTokens, ...options }),
  };
}
```

Product shell provides the implementation:
```javascript
const transport = createTransport((role, payload) =>
  fetch(`/api/${role}`, { method: "POST", body: JSON.stringify(payload), ... }).then(r => r.json())
);
```

The engine's pipeline functions accept `transport` instead of importing `callAnalystAPI` directly.

- **Verify:** analysis runs end-to-end through the new transport layer

### Step 9: Move pipeline files to engine
**Risk: High** (largest step — useAnalysis.js is 2700 lines)

**9a. useAnalysis.js → engine/pipeline/analysis.js**
- Rename `runAnalysis(desc, dims, updateUC, id, options)` to `runAnalysis(input, config, callbacks)`
  - `input`: `{ description: string, id: string, origin?: object }`
  - `config`: `ResearchConfig` object (dimensions, prompts, limits, etc.)
  - `callbacks`: `{ onProgress: (phase, partialState) => void, onDebugEvent?: (event) => void, transport: Transport }`
- Replace all `updateUC(id, fn)` calls with `callbacks.onProgress(phase, partialState)` — the product shell maps this to its React state
- Replace `callAnalystAPI` / `callCriticAPI` imports with `callbacks.transport.callAnalyst` / `.callCritic`
- Replace hardcoded token limits with `config.limits.tokenLimits.*`
- Replace hardcoded discovery toggle with `config.relatedDiscovery`
- Replace system prompt imports with `config.prompts.analyst` / `.critic` / etc., falling back to engine defaults
- Replace dimension-specific logic (polarity, research hints) with reads from `config.dimensions[].polarityHint` / `.researchHints`

**9b. useFollowUp.js → engine/pipeline/followUp.js**
- Same callback pattern: `handleFollowUp(input, config, callbacks)`
  - `input`: `{ ucId, dimId, challenge, ucState, options? }`
  - Removes `ucRef` (pass current UC state directly instead of a ref)
- Replace `fetch("/api/fetch-source")` with transport call
- Replace system prompt import with config

- **Verify:** full analysis flow works — all 4 phases complete, follow-up challenges work, discovery generates candidates

### Step 10: Introduce ResearchConfig formally
**Risk: Medium**

- Create `configs/ai-use-case-prioritizer.js` that constructs a full ResearchConfig:
  - Imports `DEFAULT_DIMS` from `engine/configs/ai-use-case-dims.js`
  - Sets product-specific prompts, model choices, limits
  - Exports the config object
- Update `app/src/App.jsx` to import the config and pass it to engine functions
- Engine barrel export (`engine/index.js`) exports: `runAnalysis`, `handleFollowUp`, `createTransport`, all lib utilities, default dims, default prompts

- **Verify:** app works identically to before restructuring

### Step 11: Create engine package.json & barrel export
**Risk: Low**

- `engine/package.json`: `{ "name": "@researchit/engine", "version": "1.0.0", "type": "module", "main": "index.js" }`
- `engine/index.js`: re-exports all public API:
  ```javascript
  export { runAnalysis } from './pipeline/analysis.js'
  export { handleFollowUp } from './pipeline/followUp.js'
  export { createTransport } from './lib/transport.js'
  export { callOpenAI } from './providers/openai.js'
  export { DEFAULT_DIMS } from './configs/ai-use-case-dims.js'
  // ... all lib exports
  ```
- Update `app/package.json` to depend on engine: `"@researchit/engine": "file:../engine"`
- Update all imports in `app/src/` to use `@researchit/engine` where appropriate

- **Verify:** `npm install` resolves, app builds and runs

### Step 12: Cleanup
**Risk: Low**

- Remove any dead imports, unused files
- Ensure `.env.local.example` is in `app/` with correct variable names
- Update README.md to reflect new structure
- Update TASKS.md if needed

---

## Verification Plan

After each step, verify:
1. `npm run dev` starts without errors (from `app/` directory)
2. Submit a use case → all 4 phases complete (analyst → critic → response → discovery)
3. Follow-up challenge on a dimension → analyst responds with sources
4. Export JSON → re-import → state restored correctly
5. HTML/PDF export renders

Full end-to-end test after Step 11:
- Fresh `npm install` in `app/`
- Full analysis run
- Follow-up challenge with web search trigger (RA-17 adaptive flow)
- JSON export/import round-trip
- Verify `engine/` has zero dependencies on `app/`, `react`, or any browser API

---

## Decision Points

1. **updateUC replacement pattern** — Plan uses `onProgress(phase, partialState)` callback. Alternative: async generator. Callback is simpler to integrate with React setState.

2. **Engine package format** — Plan uses ESM only (`"type": "module"`). Both Vite and modern Node support this.

3. **Transport abstraction** — Plan uses dependency injection (pass `callFn` at init). Alternative: class-based provider pattern. DI is simpler for now.

4. **Serverless routes stay in product shell** — Engine is library-only, never a server. Routes are product infrastructure.

5. **Dimension config format** — Plan keeps JS (importable, supports comments). Can add JSON schema for validation later.

6. **System prompt ownership** — Engine ships generic defaults. Product overrides via `ResearchConfig.prompts`.
