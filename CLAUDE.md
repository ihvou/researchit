# ResearchIt — Claude Code Cheatsheet

Config-driven AI research engine. Turns questions into weighted scorecards or comparison matrices with evidence, confidence, critic debate, and source verification.

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
  src/App.jsx               # Main app state, run orchestration (~600 lines)
  src/hooks/useAnalysis.js  # Wires engine pipelines to React state
  src/components/           # UI tabs and widgets
  src/lib/export.js         # HTML + Markdown + PDF export (~2000 lines)
engine/                     # @researchit/engine — no React, no browser APIs
  pipeline/analysis.js      # Scorecard pipeline (~5500 lines) — THE largest file
  pipeline/matrix.js        # Matrix pipeline (~4700 lines) — second largest
  pipeline/followUp.js      # Follow-up threads
  lib/transport.js          # Retry/timeout wrapper, dependency-injected LLM calls
  providers/openai.js       # Base OpenAI adapter
  prompts/defaults.js       # System prompts
configs/
  research-configurations.js  # All ResearchConfig definitions + shared model config
```

## Key Architecture

- **Two output modes**: Scorecard (per-dimension scores) and Matrix (subject × attribute grid)
- **Two evidence modes**: "Verified Research" (native hybrid) and "Deep Research ×3" (3 external providers cross-validated)
- **Transport is injected**: engine never calls APIs directly; `app/api/` routes resolve providers
- **Provider routing**: providerConfig.js resolves role → provider → model via env vars with fallback chain
- **ACTIVE_RUNTIME global** in analysis.js — mutable state, unsafe for concurrent runs (flagged as ENG-02)

For full architecture see `docs/architecture.md`; for high-level pipeline overview see `README.md` § Analysis Pipeline.

### Scorecard Pipeline (analysis.js → `runAnalysisLegacy`)

1. **Query Strategist** — infer niche, aliases, per-dimension query seeds + counterfactual seeds
2. **Analyst Phase 1** — evidence collection with web search, produces per-dimension scores/confidence/sources
3. **Targeted Recovery** — low-confidence dimensions get: query plan → search harvest → rescore (sequential per dim)
4. **Source Verification** — fetch URLs, check quotes in page, assign verificationStatus, apply confidence penalties
5. **Critic** — independent audit with live search, flags disagreements, proposes score changes
6. **Reconciler (Phase 3)** — analyst responds to critic flags, updates scores with justification
7. **Consistency & Coherence** — cross-dimension score consistency check + coherence audit
8. **Final Source Verification** — re-verify after reconciliation
9. **Red Team (RQ-02)** — adversarial stress test via Critic model, appends threats/missed risks per dimension
10. **Synthesizer (RQ-09)** — independent executive narrative via different model, produces decisionImplication + dissent
11. **Discovery** — suggests related research threads

Deep Research ×3 inserts after step 2: three providers run in parallel → merge best per dimension → DA-02 recovery loop for weak dimensions → then continues from step 4.

### Matrix Pipeline (matrix.js → `runMatrixAnalysis`)

1. **Subject Discovery** (optional) — auto-discover comparison subjects if not provided
2. **Query Strategist** — niche/alias hints + per-cell query seeds + counterfactual seeds
3. **Analyst Pass** — populate all cells with evidence, scores, confidence via web search
4. **Targeted Recovery** — low-confidence cells get: query plan → search harvest → rescore (sequential per cell)
5. **Cell Source Verification** — same as scorecard but per-cell
6. **Critic** — audits matrix cells, flags issues
7. **Analyst Response** — resolves critic flags per cell
8. **Consistency Audit** — cross-subject consistency check
9. **Derived Attributes** — computed columns (e.g., composite scores)
10. **Red Team** — adversarial counter-cases per cell via Critic model
11. **Synthesizer** — executive synthesis: decision answer, threats, whitespace, implications
12. **Coverage SLA** — validates minimum source/evidence thresholds
13. **Discovery** — suggests additional subjects/attributes

Deep Research ×3 inserts after step 5: three providers run in parallel → merge/reconcile → DA-02 recovery for conflicting cells → re-verify sources → then continues from step 6.

## Model Configuration

Default roles (in configs/research-configurations.js):
- **Analyst**: OpenAI gpt-5.4-mini
- **Critic**: Anthropic claude-sonnet-4-20250514
- **Retrieval**: Gemini gemini-2.5-flash
- **Deep Research ×3 providers**: ChatGPT (gpt-5.4), Claude (claude-sonnet-4), Gemini (gemini-2.5-pro)

Provider/model resolved via env vars: `RESEARCHIT_{ROLE}_{PROVIDER}_MODEL`, falling back through a chain. See providerConfig.js.

## Code Conventions

- `cleanString()` in analysis.js, `cleanText()` in matrix.js — same function, different names (ENG-01 tech debt)
- Normalize everything: confidence levels, source lists, arguments, scores — defensive throughout
- Every LLM response is parsed with `parseWithDiagnostics` / `extractJson` + fallback handling
- `analysisMeta` object tracks all diagnostics, counters, and provenance for the run
- Source verification: fetch URL → check quote in page → assign verificationStatus → derive displayStatus (UX-02)

## Known Tech Debt (see TASKS.md)

- **ENG-01**: ~600+ lines duplicated between analysis.js and matrix.js (growing with each feature)
- **ENG-02**: ACTIVE_RUNTIME global mutable state in analysis.js
- **ENG-03–05**: Provider options, source verification, analysisMeta alignment gaps

## Key Docs

- `README.md` — Project vision, repository structure, and pipeline overview
- `TASKS.md` — Active task backlog with priorities
- `docs/architecture.md` — System architecture overview
- `docs/pipeline-architecture.md` — Detailed pipeline flow diagrams with request/response shapes
- `docs/benchmark-manual-v1.md` — Manual benchmark protocol
- `docs/ui-kit.md` — UI component conventions
