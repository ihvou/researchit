# ResearchIt — Claude Code Cheatsheet

Config-driven AI research engine. Turns questions into weighted scorecards or comparison matrices with evidence, confidence, critic debate, and source verification.

Quality goal: beat individual mainstream LLM outputs on quality, completeness, accuracy, and decision-readiness for high-stakes decisions.

## Commands

```bash
cd app && npm run dev     # Start dev server (Vite + Vercel API routes)
cd app && npm run build   # Production build
```

No test suite yet. Verify changes by running the dev server and executing a research run.

## Monorepo Layout

```
app/                        # React + Vite + Vercel serverless routes
  api/                      # API routes: analyst.js, critic.js, providerConfig.js, providerCalls.js
  src/App.jsx               # Main app state, run orchestration
  src/hooks/useAnalysis.js  # Wires engine pipelines to React state
  src/components/           # UI tabs and widgets
  src/lib/export.js         # HTML + Markdown + PDF export (~2000 lines)
engine/                     # @researchit/engine — no React, no browser APIs
  pipeline/orchestrator.js  # Canonical 15-stage pipeline entry point (scorecard + matrix)
  pipeline/stages/          # One file per stage: 01-intake through 15-finalize + common.js
  pipeline/contracts/       # reason-codes.js, run-state.js
  pipeline/analysis.js      # Legacy scorecard adapter (still used for followUp)
  pipeline/matrix.js        # Legacy matrix adapter
  pipeline/followUp.js      # Follow-up threads
  lib/transport.js          # Retry/timeout wrapper, dependency-injected LLM calls
  lib/routing/              # actor-resolver.js, route-preflight.js — strict model routing
  lib/guards/               # timeout-retry.js, decision-gate.js, coverage-gate.js, token-preflight.js
  lib/diagnostics/          # stage-logger.js, debug-bundle.js, cost-estimator.js
  providers/openai.js       # Base OpenAI adapter
  prompts/defaults.js       # System prompts (SYS_ANALYST, SYS_CRITIC, SYS_RED_TEAM, etc.)
configs/
  research-configurations.js  # All ResearchConfig definitions + shared model config
```

## Key Architecture

- **Two output modes**: Scorecard (per-dimension scores) and Matrix (subject × attribute grid)
- **Two evidence modes**: "Research Team" (`native` — memory + web hybrid, critic debate, recovery) and "Deep Research ×3" (`deep-research-x3` — ChatGPT Deep Research + Claude Research + Gemini Deep Research in parallel, then merged)
- **Transport is injected**: engine never calls APIs directly; `app/api/` routes resolve providers
- **Strict routing**: `actor-resolver.js` + `route-preflight.js` enforce exact role→provider→model resolution; no automatic failover — a mismatched or missing route fails with `route_mismatch_preflight` before any token spend
- **Canonical 15-stage orchestrator**: both scorecard and matrix run the same stage graph in `orchestrator.js`; legacy `analysis.js` / `matrix.js` are adapters only

For full architecture see `docs/architecture.md`; for the canonical stage graph and routing policy see `docs/pipeline-architecture.md`.

### Canonical Pipeline (orchestrator.js)

Both scorecard and matrix run through the same 15 stages:

| Stage | Title | Actor / Model |
|-------|-------|---------------|
| 01 | Input Intake | engine |
| 01b | Subject Discovery *(matrix + auto-discover only)* | Analyst / gemini-2.5-pro |
| 02 | Research Planning | Analyst / gpt-5.4 |
| 03a | Memory Evidence *(native mode)* | Analyst / gpt-5.4 |
| 03b | Web Evidence *(native mode)* | Analyst / gemini-2.5-pro |
| 03c | Deep Research ×3 *(deep-research-x3 mode)* | Analyst / o3 + claude-sonnet-4 + gemini-2.5-pro |
| 04 | Evidence Merge | engine |
| 05 | Score + Confidence | Analyst / gpt-5.4 (scorecard) · engine (matrix) |
| 06 | Source Verification | engine |
| 07 | Source Assessment | engine |
| 08 | Targeted Recovery | Analyst / gemini-2.5-pro (search) + gpt-5.4 (re-assess) |
| 09 | Re-score | Analyst / gpt-5.4 |
| 10 | Coherence | Critic / claude-sonnet-4 |
| 11 | Challenge Overclaims | Critic / claude-sonnet-4 |
| 12 | Counter-case | Critic / claude-sonnet-4 |
| 13 | Concede / Defend | Analyst / gpt-5.4 |
| 14 | Synthesize | Analyst / gemini-2.5-pro |
| 15 | Finalize | engine + Analyst / gpt-5.4-mini |

Deep Research ×3 mode replaces stages 03a+03b with 03c (three providers in parallel). Stage 04 merge is the convergence point for both modes. Stage 01b runs only for matrix + auto-discover; all other stages run for every run type.

## Model Configuration

Default roles (in `configs/research-configurations.js`):
- **Analyst**: OpenAI `gpt-5.4` (planning, scoring, defend, rescore) + Gemini `gemini-2.5-pro` (web evidence, recovery search, synthesis)
- **Critic**: Anthropic `claude-sonnet-4`
- **Deep Research ×3**: ChatGPT (`o3` + `web_search_preview` via Responses API), Claude (`claude-sonnet-4` + `web_search`, max 20 uses), Gemini (`gemini-2.5-pro` + `google_search` + unlimited thinking budget)

Provider/model resolved via env vars: `RESEARCHIT_{ROLE}_{PROVIDER}_MODEL`, using strict precedence order. See `providerConfig.js`.

## Code Conventions

- All shared stage helpers (`clean`, `ensureArray`, `normalizeSources`, `callActorJson`, etc.) live in `pipeline/stages/common.js`
- Normalize everything: confidence levels, source lists, arguments, scores — defensive throughout
- Every LLM response is parsed with `parseWithDiagnostics` / `extractJson` + retry-or-fail guardrail handling
- `callActorJson()` in `common.js` wraps transport + retry + parse-repair; `maxRetries: 1` enables parse-repair (injects "return strict JSON only" on parse failure); `maxRetries: 0` disables it — always use `1` unless explicitly justified
- **Confidence is model-expressed only**: stage 06 assigns `verificationStatus` / `citationStatus` per source; it does **not** touch confidence. `confidenceSource` is always `"model"`. URL reachability ≠ factual accuracy
- Stage budgets (`timeoutMs`, `tokenBudget`, `retryMax`) are set in `orchestrator.js` `STAGE_BUDGETS` and always override stage-level fallbacks
- Stage diagnostics tracked via `stage-logger.js`; orchestrator writes a "running" placeholder before each stage executes so hanging stages appear in debug bundles

## Known Tech Debt (see TASKS.md)

- **ENG-05**: `analysisMeta` initialized in three places (App.jsx, engine `createInitialState`, `runMatrixAnalysis`) with different field sets — needs centralization in engine only
- **ENG-08**: source universe normalization logic duplicated across `SourcesList.jsx`, `DimensionsTab.jsx`, and `export.js`

## Key Docs

- `README.md` — Project vision, repository structure, and pipeline overview
- `TASKS.md` — Active task backlog with priorities
- `docs/architecture.md` — System architecture overview
- `docs/quality-bar.md` — Non-negotiable quality objective and no-silent-failure policy
- `docs/pipeline-architecture.md` — Canonical stage graph, actor model, routing policy (source of truth for pipeline)
- `docs/benchmark-manual-v1.md` — Manual benchmark protocol
- `docs/ui-kit.md` — UI component conventions
