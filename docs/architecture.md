# ResearchIt Architecture

This document is the architecture contract for the monorepo after the canonical pipeline refactor.

If architecture tradeoffs conflict with quality, [quality-bar.md](./quality-bar.md) wins.

## 1. Scope and Boundaries

Repository structure:

```txt
researchit/
  engine/   # reusable package: @researchit/engine
  app/      # product shell: UI + API routes
  configs/  # ResearchConfig definitions
  docs/     # architecture and policy docs
```

Boundary rules:
- `engine/` must not depend on `app/` or browser/React APIs.
- `app/` may depend on `@researchit/engine` but should not copy pipeline logic.
- `configs/` define behavior; engine consumes them but does not import app code.

## 2. Engine Runtime Model

The engine now runs one canonical orchestrator:
- `engine/pipeline/orchestrator.js`

Public entry points:
- `runAnalysis()` (`engine/pipeline/analysis.js`)
- `runMatrixAnalysis()` (`engine/pipeline/matrix.js`)
- `resolveMatrixResearchInput()` (`engine/pipeline/matrix.js`)
- `handleFollowUp()` (`engine/pipeline/followUp.js`)

### Actor Roles

- `Analyst`: plan, gather, merge, score, recover, defend
- `Critic`: coherence checks, overclaim challenge, counter-case
- deterministic engine steps: input validation, verification, assessment, gate enforcement

### Routing Guarantees

Route preflight is enforced in `engine/lib/routing/route-preflight.js` before paid calls.

Expected default routing:
- Analyst reasoning stages: OpenAI
- Analyst retrieval-heavy stages (subject discovery/web/recovery/synthesis): Gemini
- Critic stages: Anthropic

Deep Research ×3 carve-out:
- Stage `03c` requires all configured Deep Research providers (OpenAI o3 + Anthropic claude-sonnet-4 + Gemini gemini-2.5-pro) and fails preflight if any required lane is missing.

## 3. Canonical Stage Sequence

The canonical sequence is shared by scorecard and matrix runs.

| Stage ID | Purpose | Actor |
|---|---|---|
| `stage_01_intake` | Validate + normalize request | engine |
| `stage_01b_subject_discovery` | Optional matrix subject discovery/canonicalization | Analyst |
| `stage_02_plan` | Query and unit planning | Analyst |
| `stage_03a_evidence_memory` | Native memory draft evidence | Analyst |
| `stage_03b_evidence_web` | Native web-grounded evidence | Analyst |
| `stage_03c_evidence_deep_assist` | Deep Research ×3 provider evidence lanes | Analyst |
| `stage_04_merge` | Merge evidence into unified bundle | engine |
| `stage_05_score_confidence` | Unit/cell assessment + confidence calibration (rubric anchors for scorecard) | Analyst |
| `stage_06_source_verify` | URL fetch/verification checks | engine |
| `stage_07_source_assess` | Source-quality caps/penalties | engine |
| `stage_08_recover` | Targeted low-confidence/coverage recovery | Analyst |
| `stage_09_rescore` | Re-score after recovery | Analyst |
| `stage_10_coherence` | Cross-unit coherence audit | Critic |
| `stage_11_challenge` | Overclaim challenge flags | Critic |
| `stage_12_counter_case` | Disconfirming evidence + risks | Critic |
| `stage_13_defend` | Analyst concede/defend per critic flag | Analyst |
| `stage_14_synthesize` | Executive synthesis artifact | Analyst |
| `stage_15_finalize` | Coverage + decision gates, final status | engine (+ analyst summary route) |

Mode differences:
- Research Team mode (`native`) runs `03a + 03b`
- Deep Research ×3 mode (`deep-research-x3`) runs `03c`
- all downstream stages are identical

## 4. Contracts and State

Core run state and output shaping are in:
- `engine/pipeline/contracts/run-state.js`
- `engine/pipeline/contracts/reason-codes.js`

Key state properties:
- `mode`: `native` or `deep-research-x3`
- `outputType`: `scorecard` or `matrix`
- `strictQuality`: strict gate behavior
- `quality.reasonCodes`: normalized machine codes
- `diagnostics`: stage logs, IO snippets, progress timeline, routing records

Reason code examples:
- `route_mismatch_preflight`
- `response_parse_failed`
- `coverage_catastrophic`
- `decision_gate_failed`
- `run_aborted_strict_quality`
- `run_completed_degraded`

## 5. Quality and Finalization Behavior

Stage `15` enforces deterministic gates using:
- `engine/lib/guards/coverage-gate.js`
- `engine/lib/guards/decision-gate.js`

Completion semantics:
- strict mode: failed decision gate aborts
- non-strict mode: decision gate failure may complete degraded
- catastrophic coverage floor failure aborts in both strict and non-strict modes

Source verification and quality assessment occur before recovery/critic cycle:
- Stage `06`: fetch + text match checks
- Stage `07`: confidence/quality adjustments

## 6. Matrix and Scorecard Debate Parity

Both output modes expose critic-vs-analyst exchange artifacts from shared contracts:
- critic flags include `severity` + `category`
- analyst outcomes include `disposition`, `analystNote`, optional `mitigationNote`

Matrix per-cell debate materialization is normalized in `run-state.js` and rendered in:
- `app/src/components/MatrixDebateTab.jsx`

Scorecard and matrix both use:
- `phase: initial`
- `phase: critique`
- `phase: response`

## 7. Legacy Adapter Rule

`engine/lib/legacy-adapter.js` is migration-only.

Constraints:
- production stage modules must not import it,
- it is for read/import compatibility only,
- no new behavior should be implemented through legacy mapping,
- delete once migration sunset is reached (`LEGACY_ADAPTER_SUNSET`).

## 8. App Integration Contract

The app provides transport callbacks consumed by engine:
- `callAnalyst`
- `callCritic`
- `fetchSource` (for source verification)

API routes in `app/api/`:
- `analyst.js`
- `critic.js`
- `fetch-source.js`

UI pipeline tracking uses canonical stage IDs in:
- `app/src/components/ProgressTab.jsx`
- `app/src/components/ExpandedRow.jsx`

## 9. Invariants (Must Stay True)

1. `engine/` has no imports from `app/`.
2. External I/O in engine flows through injected transport, not direct `fetch()` in pipeline logic.
3. Stage execution remains canonical and centralized in `orchestrator.js`.
4. Route preflight remains mandatory before paid model calls.
5. Strict-vs-degraded semantics stay explicit and reason-coded (no silent downgrade).
6. Matrix and scorecard both preserve explicit critic/analyst debate traceability.
7. Legacy adapter remains outside production stage execution.

## 10. Related Documents

- Quality objective: [quality-bar.md](./quality-bar.md)
- Canonical stage architecture and progress-step breakdown: [pipeline-architecture.md](./pipeline-architecture.md)
