# ResearchIt

ResearchIt is a config-driven AI research engine plus a product shell.

The core idea is simple: most AI tools generate fluent reports, but strategic decisions need auditable structure. ResearchIt turns a question into:
- weighted per-dimension scores,
- evidence and confidence per dimension,
- explicit analyst-vs-critic disagreement,
- follow-up challenge threads,
- exportable, reproducible artifacts.

## Idea

ResearchIt is built for decisions like:
- Should we build this AI product?
- Should we buy vs build?
- Which opportunity should we prioritize first?
- Which variant is stronger after pressure-testing assumptions?

The product is intentionally opinionated about process, not outcomes:
- Evidence first, then scoring.
- Critique is required, not optional.
- Score changes are explicit and reviewable.
- Configuration is first-class so the same engine can power different research types.

## Repository Architecture

This repo is a monorepo with three top-level concerns.

```txt
researchit/
  app/                                # Deployable product shell (React + Vite + Vercel API routes)
  engine/                             # Reusable research engine package (@researchit/engine)
  configs/                            # ResearchConfig instances used by products
```

### app/
`app/` owns user experience and deployment concerns:
- React UI and tabs (`app/src/components/*`)
- client state wiring (`app/src/App.jsx`)
- exports and browser-side helpers (`app/src/lib/*`)
- serverless endpoints (`app/api/*`)

It consumes the engine package via `"@researchit/engine": "file:../engine"`.

### engine/
`engine/` owns research behavior and core contracts:
- pipelines (`engine/pipeline/analysis.js`, `engine/pipeline/followUp.js`)
- provider adapter (`engine/providers/openai.js`)
- transport abstraction (`engine/lib/transport.js`)
- scoring, rubric, confidence, serialization, debug primitives (`engine/lib/*`)
- default dimensions and prompts (`engine/configs/*`, `engine/prompts/*`)

Engine design constraints:
- no React dependency
- no browser-only APIs in core logic
- dependency-injected transport for LLM/source calls

### configs/
`configs/` contains concrete `ResearchConfig` objects (for this product: `configs/ai-use-case-prioritizer.js`).

### Architecture Diagram

```mermaid
flowchart LR
  U["PM / Founder"] --> UI["App UI (app/src)"]
  UI --> H["UI Hooks (useAnalysis/useFollowUp)"]
  H --> E["Engine Pipelines (@researchit/engine)"]
  C["ResearchConfig (configs/*.js)"] --> E
  E --> T["Transport (engine/lib/transport.js)"]
  T --> A["Serverless API (app/api/*)"]
  A --> P["OpenAI Provider Adapter (engine/providers/openai.js)"]
  P --> O["OpenAI APIs (Responses + Chat Completions)"]
  T --> F["Source Fetch Route (/api/fetch-source)"]
  E --> D["Progress + Debug Events"]
  D --> UI
```

## Analysis Pipeline

Current pipeline (quality-first):
1. Analyst baseline pass (memory-only)
2. Analyst web pass (live-search assisted)
3. Reconcile pass (merge evidence, re-score)
4. Targeted low-confidence cycle (query plan -> web harvest -> re-score)
5. Critic audit pass
6. Analyst final response pass
7. Consistency check pass
8. Discovery generation + candidate pre-validation

Follow-up pipeline classifies PM intent (`challenge`, `question`, `reframe`, `add_evidence`, `note`, `re_search`) and executes intent-specific logic with explicit score proposals.

## Configuration

Research behavior is configured through a `ResearchConfig` object.

Primary config in this repo:
- `configs/ai-use-case-prioritizer.js`

Default dimensions live in:
- `engine/configs/ai-use-case-dims.js`

Default system prompts live in:
- `engine/prompts/defaults.js`

### ResearchConfig shape

```js
{
  id: "ai-use-case-prioritizer",
  name: "AI Use Case Prioritizer",
  engineVersion: "1.0.0",

  dimensions: [
    {
      id: "roi",
      label: "ROI Magnitude",
      weight: 18,
      enabled: true,
      brief: "...",
      fullDef: "...",
      polarityHint: "Higher score means ...",
      researchHints: {
        whereToLook: ["..."],
        queryTemplates: ["${vertical} ..."]
      }
    }
  ],

  relatedDiscovery: true,

  prompts: {
    analyst: "...",
    critic: "...",
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
      phase1Evidence: 10000,
      phase1Scoring: 12000,
      critic: 6000,
      phase3Response: 6000,
      followUpQuestion: 1400,
      followUpChallenge: 2100,
      intentClassification: 450
    }
  }
}
```

## Local Development

### Prerequisites
- Node.js 20+
- npm
- Vercel CLI (optional but recommended for local serverless parity)

### Environment
Create:
- `app/.env.local`

Required variable:
```bash
OPENAI_API_KEY=sk-...
```

### Install
From repo root:
```bash
cd app
npm install
```

### Run
Using Vercel dev runtime:
```bash
cd app
npx vercel dev
```

Open:
- `http://localhost:3000`

### Build
From repo root:
```bash
npm run build
```

(or `cd app && npm run build`)

## Deployment (Vercel)

This repo deploys from root with root-level `vercel.json` that builds `app/`:
- install command: `cd app && npm install`
- build command: `cd app && npm run build`
- output directory: `app/dist`

Root-level API entrypoints (`/api/analyst`, `/api/critic`, `/api/fetch-source`) re-export handlers from `app/api/*`.

If deployment settings in Vercel override these commands, reset them so repo `vercel.json` takes effect.

## Contribution Flow

### 1) Pick scope
Open an issue (or use an existing one) describing:
- problem statement
- expected behavior
- affected area (`engine`, `app`, or `config`)

### 2) Branch
Create a branch from `main`.
Use small focused changes. Avoid mixing refactor + feature + style-only edits in one PR.

### 3) Implement
Recommended boundaries:
- Engine logic changes in `engine/*`
- Product/UI changes in `app/*`
- Domain behavior changes in `configs/*`

### 4) Validate locally
Minimum checks before PR:
```bash
cd app
npm run build
```

If touching runtime behavior, run at least one end-to-end analysis and one follow-up flow in local dev.

### 5) Submit PR
Include:
- what changed
- why it changed
- risk/regression notes
- screenshots/GIFs for UI changes
- migration notes if config/contracts changed

## Security Notes

- Never commit real API keys.
- Keep `.env.local` local only.
- If a key was exposed, rotate immediately.

## License

No license file is currently defined in this repository.
Add one before publishing broader external contributions.
