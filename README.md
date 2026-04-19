# ResearchIt

ResearchIt is a config-driven research engine and product shell built for decision-grade analysis.

Instead of a single fluent response, each run produces structured outputs with:
- explicit evidence and confidence per unit,
- critic challenges and analyst responses,
- source verification signals,
- quality gate outcomes and reason codes,
- reproducible artifacts for audit/export.

Quality objective and release priority are defined in [docs/quality-bar.md](docs/quality-bar.md).

## Monorepo Layout

```txt
researchit/
  app/      # Product shell (React + Vite + API routes)
  engine/   # Reusable analysis engine (@researchit/engine)
  configs/  # ResearchConfig definitions
  docs/     # Architecture and quality docs
```

## Current Architecture (v2 Canonical Pipeline)

Research runs now execute through one canonical orchestrator for both scorecard and matrix modes:
- `engine/pipeline/orchestrator.js`
- stage modules under `engine/pipeline/stages/*`
- state/contract mapping under `engine/pipeline/contracts/*`

Entry points:
- `runAnalysis()` in `engine/pipeline/analysis.js`
- `runMatrixAnalysis()` in `engine/pipeline/matrix.js`
- `resolveMatrixResearchInput()` in `engine/pipeline/matrix.js`

Follow-up workflow remains in `engine/pipeline/followUp.js`.

## Actor Model and Routing Policy

The pipeline uses three actor roles:
- `Analyst`: planning, scoring, recovery, and defend/concede
- `Critic`: coherence checks, overclaim challenge, counter-case
- `Synthesizer`: independent executive synthesis

Default model policy in `configs/research-configurations.js`:
- Analyst reasoning: OpenAI (`gpt-5.4`)
- Critic reasoning: Anthropic (`claude-sonnet-4-20250514`)
- Retrieval-heavy Analyst stages: Gemini (`gemini-2.5-pro`)
- Synthesizer: Gemini (`gemini-2.5-pro`)

Route preflight is enforced before paid calls in `engine/lib/routing/route-preflight.js`.

## Canonical Stage Sequence

All run types share this stage order:

1. `stage_01_intake`
2. `stage_01b_subject_discovery` (matrix optional)
3. `stage_02_plan`
4. `stage_03a_evidence_memory` (native)
5. `stage_03b_evidence_web` (native)
6. `stage_03c_evidence_deep_assist` (deep-assist)
7. `stage_04_merge`
8. `stage_05_score_confidence`
9. `stage_06_source_verify`
10. `stage_07_source_assess`
11. `stage_08_recover`
12. `stage_09_rescore`
13. `stage_10_coherence`
14. `stage_11_challenge`
15. `stage_12_counter_case`
16. `stage_13_defend`
17. `stage_14_synthesize`
18. `stage_15_finalize`

Native vs deep-assist differs only inside Stage 03 (03a/03b vs 03c); downstream stages are shared.

For the full stage contract and policy details, see [docs/pipeline-architecture-suggestion.md](docs/pipeline-architecture-suggestion.md).

## Scorecard and Matrix Parity

Both output modes now use the same critic/analyst cycle and debate structure:
- critic flags include typed severity/category,
- analyst responses include disposition + mitigation notes where needed,
- matrix and scorecard both surface critic-vs-analyst exchanges in UI.

## Quality Gates and Outcomes

Stage 15 applies deterministic coverage + decision gates:
- strict mode: failing gate conditions abort the run (`run_aborted_strict_quality`)
- non-strict mode: recoverable failures can complete as degraded (`run_completed_degraded`)
- hard-abort coverage floor failure aborts in both modes

Reason codes are defined in `engine/pipeline/contracts/reason-codes.js`.

## Legacy Adapter Boundary

`engine/lib/legacy-adapter.js` exists only for import/read compatibility of legacy artifacts.

Rules:
- pipeline stage modules must not import it,
- no back-porting new stage logic into legacy format,
- remove it at migration sunset (`LEGACY_ADAPTER_SUNSET`).

## Public Engine API

`engine/index.js` exports:
- `runAnalysis`
- `runMatrixAnalysis`
- `resolveMatrixResearchInput`
- `handleFollowUp`
- `createTransport`

## App Integration

The app consumes the engine package (`"@researchit/engine": "file:../engine"`) and provides transport functions that call API routes:
- `/api/analyst`
- `/api/critic`
- `/api/synthesizer`
- `/api/fetch-source`

UI pipeline/progress rendering lives in:
- `app/src/components/ProgressTab.jsx`
- `app/src/components/ExpandedRow.jsx`

Matrix debate rendering lives in:
- `app/src/components/MatrixDebateTab.jsx`

## Configuration

Research behavior is configured by `ResearchConfig` objects in:
- `configs/research-configurations.js`

Config controls:
- output mode (`scorecard` or `matrix`),
- dimensions/attributes and matrix subject rules,
- prompts per actor,
- model routing,
- limits/gates (coverage, decision-grade, recovery budgets, token budgets).

## Local Development

Prerequisites:
- Node.js 20+
- npm

Install app deps:

```bash
cd app
npm install
```

Run dev server:

```bash
cd app
npm run dev
```

Build app:

```bash
npm run build
```

Run engine tests:

```bash
npm run test:engine
```

## Environment Variables (Minimum)

Create `app/.env.local`.

Minimum for OpenAI-only experimentation:

```bash
OPENAI_API_KEY=sk-...
```

Recommended for canonical multi-provider routing:

```bash
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...

RESEARCHIT_ANALYST_MODEL=gpt-5.4
RESEARCHIT_CRITIC_MODEL=claude-sonnet-4-20250514
RESEARCHIT_SYNTHESIZER_MODEL=gemini-2.5-pro
```

Provider/model/base URL resolution precedence remains:
1. role-specific `RESEARCHIT_*`
2. global `RESEARCHIT_*`
3. `OPENAI_*` aliases
4. `ResearchConfig.models.*`
5. built-in defaults

## Architecture Reference

Primary architecture contract:
- [docs/architecture.md](docs/architecture.md)

Quality policy:
- [docs/quality-bar.md](docs/quality-bar.md)

Pipeline spec and stage-level details:
- [docs/pipeline-architecture-suggestion.md](docs/pipeline-architecture-suggestion.md)
