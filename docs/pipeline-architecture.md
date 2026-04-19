# Pipeline Architecture (Canonical)

This document describes the live ResearchIt pipeline architecture after the canonical refactor.

The goal is a single, understandable execution model across scorecard and matrix research runs, with shared quality behavior and auditable outputs.

Quality policy is defined in [quality-bar.md](./quality-bar.md). If any tradeoff conflicts with quality, `quality-bar.md` wins.

---

## Design Goals

- One canonical stage sequence for all run types (scorecard, matrix; native, deep-assist).
- Two reasoning actors: `Analyst` and `Critic`. Deterministic engine steps are not actors.
- Strict, non-negotiable model routing per stage — no dynamic provider picking, no failover.
- Shared scorecard/matrix behavior after evidence collection.
- Explicit failure semantics: recover-or-fail, never silent degradation.
- Stage-level observability aligned with the Progress tab in UI.

---

## Actor Model

| Actor | Responsibility |
|-------|---------------|
| `Analyst` | Plans research; collects, merges, scores, and re-scores evidence; recovers low-confidence gaps; defends against Critic flags; writes the final executive synthesis. The Analyst uses different models for different steps — OpenAI for reasoning-heavy steps, Gemini for web retrieval and final synthesis — but is always the same conceptual actor: the person responsible for the research output. |
| `Critic` | Independently audits the Analyst's work: coherence check, overclaim challenge, counter-case search. Uses Claude throughout for model-family separation from the Analyst's primary reasoning chain. |
| `engine` | Deterministic steps: input normalization, source fetch/verification, quality assessment, gate enforcement. No LLM calls. |

There is no separate "Synthesizer" actor. Stage 14 (executive synthesis) is an Analyst step. It uses Gemini as its model to bring a fresh model-family perspective after the OpenAI-heavy scoring and defense chain — the same reason Gemini is used for web evidence (03b) and recovery search (08). The independence is in the model selection, not in a fictional third role.

---

## Model Routing (per stage, non-negotiable)

Every stage has an exact provider and model declaration. The pipeline does not pick the first available provider, does not fall through to env-var defaults, and does not failover. If the declared route is unreachable, the run fails with `route_mismatch_preflight` before any token spend.

| Stage | Provider | Model | Notes |
|-------|----------|-------|-------|
| 01b Subject Discovery | Gemini | gemini-2.5-pro | web-grounded; matrix + auto-discover only |
| 02 Research Planning | OpenAI | gpt-5.4 | pure reasoning, no web |
| 03a Evidence — Memory | OpenAI | gpt-5.4 | no web search |
| 03b Evidence — Web | Gemini | gemini-2.5-pro | web search enabled |
| 03c Evidence — Deep Assist | OpenAI + Anthropic + Gemini | gpt-5.4 · claude-sonnet-4 · gemini-2.5-pro | parallel; all three required |
| 04 Evidence Merge | OpenAI | gpt-5.4-mini | merge + deterministic rules |
| 05 Score + Confidence | OpenAI | gpt-5.4 | rubric-based scoring |
| 06 Source Verification | engine | — | deterministic; no LLM |
| 07 Source Assessment | engine | — | deterministic; no LLM |
| 08 Targeted Recovery — search | Gemini | gemini-2.5-pro | web search for retrieval |
| 08 Targeted Recovery — re-assess | OpenAI | gpt-5.4 | scoring recovered evidence |
| 09 Re-score + Re-confidence | OpenAI | gpt-5.4 | |
| 10 Consistency + Coherence | Anthropic | claude-sonnet-4 | |
| 11 Challenge Overclaims | Anthropic | claude-sonnet-4 | |
| 12 Counter-case + Missed Risks | Anthropic | claude-sonnet-4 | web search enabled |
| 13 Concede / Defend | OpenAI | gpt-5.4 | |
| 14 Synthesize | Gemini | gemini-2.5-pro | Analyst using Gemini for model-family variety after OpenAI reasoning chain |
| 15 Finalize — summary | OpenAI | gpt-5.4-mini | |
| 15 Finalize — gates | engine | — | deterministic |

**Stage 03c carve-out:** 03c is the only stage where multiple providers are used simultaneously under the Analyst actor. Preflight for 03c must verify all three configured providers are present and reachable — not match the single-provider pattern. Absence of any configured deep-assist provider fails `route_mismatch_preflight`. No provider may be silently skipped.

**Implementation requirement:** Stage model declarations must be sourced from this table, not resolved dynamically at runtime via provider preference ordering. The `resolveProviderOrder` / "pick first provider with a valid key" pattern must not be used for any pipeline stage call. Route enforcement happens at `route-preflight.js` before the first paid call.

---

## Canonical Pipeline Diagram

```mermaid
flowchart TD
    classDef analyst fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    classDef critic  fill:#fce7f3,stroke:#db2777,color:#831843
    classDef engine  fill:#f3f4f6,stroke:#6b7280,color:#111827

    INTAKE{{"#01 INPUT INTAKE\nActor: engine\nValidate and normalize request input\nOut: NormalizedRequest"}}
    DISCROUTER{"matrix +\nauto-discover\nsubjects?"}
    SUBJDISC["#01b SUBJECT DISCOVERY (optional)\nActor: Analyst | Model: gemini-2.5-pro (web)\nDiscover and canonicalize matrix subjects\nOut: canonical subject set"]
    PLAN["#02 RESEARCH PLANNING\nActor: Analyst | Model: openai:gpt-5.4\nDefine per-unit scope and research plan\nOut: ResearchPlan"]
    EVROUTER{"evidence\nmode?"}
    MEM_NATIVE["#03a EVIDENCE - MEMORY (native)\nActor: Analyst | Model: openai:gpt-5.4 (no web)\nMemory-grounded initial evidence"]
    WEB_NATIVE["#03b EVIDENCE - WEB (native)\nActor: Analyst | Model: gemini-2.5-pro (web)\nWeb-cited evidence to patch/extend memory draft"]
    EVID_DA["#03c EVIDENCE - DEEP ASSIST\nActor: Analyst | Model: gpt-5.4 + claude-sonnet-4 + gemini-2.5-pro (parallel)\nParallel provider evidence drafts"]
    MERGE["#04 EVIDENCE MERGE\nActor: Analyst | Model: openai:gpt-5.4-mini\nUnify evidence and preserve provenance"]
    SCORE_CONF["#05 SCORE + CONFIDENCE\nActor: Analyst | Model: openai:gpt-5.4\nAssess units against rubric; assign confidence with rationale"]
    VERIFY{{"#06 SOURCE VERIFICATION\nActor: engine\nFetch and verify cited sources"}}
    ASSESS{{"#07 SOURCE ASSESSMENT\nActor: engine\nApply source-quality adjustments"}}
    RECOVER["#08 TARGETED RECOVERY\nActor: Analyst | Model: gemini-2.5-pro (search) + openai:gpt-5.4 (re-assess)\nRecover weak/low-confidence coverage"]
    RESCORE["#09 RE-SCORE + RE-CONFIDENCE\nActor: Analyst | Model: openai:gpt-5.4\nUpdate assessments after recovery"]
    COHERENCE["#10 CONSISTENCY + COHERENCE\nActor: Critic | Model: claude-sonnet-4\nFind cross-unit contradictions"]
    CHALLENGE["#11 CHALLENGE OVERCLAIMS\nActor: Critic | Model: claude-sonnet-4\nPressure-test strongest claims"]
    COUNTER["#12 COUNTER-CASE + MISSED RISKS\nActor: Critic | Model: claude-sonnet-4 (web)\nSearch disconfirming evidence"]
    DEFEND["#13 CONCEDE / DEFEND\nActor: Analyst | Model: openai:gpt-5.4\nResolve every critic flag"]
    SYNTHESIZE["#14 SYNTHESIZE\nActor: Analyst | Model: gemini-2.5-pro\nExecutive narrative, decision implication, dissent note"]
    FINAL{{"#15 FINALIZE\nActor: engine + Analyst (openai:gpt-5.4-mini for summary)\nApply quality gates, emit terminal outcome"}}

    INTAKE --> DISCROUTER
    DISCROUTER -->|yes| SUBJDISC --> PLAN
    DISCROUTER -->|no| PLAN
    PLAN --> EVROUTER
    EVROUTER -->|native| MEM_NATIVE --> WEB_NATIVE --> MERGE
    EVROUTER -->|deep-assist| EVID_DA --> MERGE
    MERGE --> SCORE_CONF --> VERIFY --> ASSESS
    ASSESS --> RECOVER --> RESCORE
    RESCORE --> COHERENCE --> CHALLENGE --> COUNTER --> DEFEND
    DEFEND --> SYNTHESIZE --> FINAL

    class PLAN,MEM_NATIVE,WEB_NATIVE,SUBJDISC,EVID_DA,MERGE,SCORE_CONF,RECOVER,RESCORE,DEFEND,SYNTHESIZE analyst
    class COHERENCE,CHALLENGE,COUNTER critic
    class INTAKE,VERIFY,ASSESS,FINAL engine
```

---

## Stage Breakdown (UI-Aligned)

This breakdown and wording is the source-of-truth reference for Progress tab stage titles and goals.

| Stage | Progress Title | Goal |
|---|---|---|
| `stage_01_intake` | Stage 01 - Input intake | Validate and normalize request input into canonical run state. |
| `stage_01b_subject_discovery` | Stage 01b - Subject discovery | Discover and deduplicate subjects when matrix subjects are not provided. |
| `stage_02_plan` | Stage 02 - Planning | Build scoped research plan and coverage intent per unit. |
| `stage_03a_evidence_memory` | Stage 03a - Memory evidence | Produce memory-grounded first-pass evidence. |
| `stage_03b_evidence_web` | Stage 03b - Web evidence | Add cited web evidence and patch memory gaps. |
| `stage_03c_evidence_deep_assist` | Stage 03c - Deep Assist evidence | Run parallel provider evidence collection for deep-assist mode. |
| `stage_04_merge` | Stage 04 - Evidence merge | Merge evidence drafts into one provenance-preserving bundle. |
| `stage_05_score_confidence` | Stage 05 - Score + confidence | Assess each unit against rubric and assign confidence with explicit rationale. |
| `stage_06_source_verify` | Stage 06 - Source verification | Deterministically verify source fetchability and citation matches. |
| `stage_07_source_assess` | Stage 07 - Source assessment | Apply source-quality adjustments before recovery/critic cycle. |
| `stage_08_recover` | Stage 08 - Targeted recovery | Prioritize and recover weak or low-confidence coverage. |
| `stage_09_rescore` | Stage 09 - Re-score | Recompute assessments after recovery evidence is applied. |
| `stage_10_coherence` | Stage 10 - Coherence | Audit cross-unit consistency and contradictions. |
| `stage_11_challenge` | Stage 11 - Challenge | Flag potential overclaims and confidence miscalibration. |
| `stage_12_counter_case` | Stage 12 - Counter-case | Gather disconfirming evidence and missed-risk signals. |
| `stage_13_defend` | Stage 13 - Concede / defend | Resolve critic flags with explicit analyst outcomes. |
| `stage_14_synthesize` | Stage 14 - Synthesize | Write executive narrative, decision implication, and uncertainty note. |
| `stage_15_finalize` | Stage 15 - Finalize | Enforce gates and emit final artifact or terminal failure. |

---

## Scorecard vs Matrix

Both modes use the same stage graph.

- Stage 01b runs only for matrix + auto-discover (subjects not pre-provided). The orchestrator skips it entirely; the stage is not invoked.
- Native evidence mode uses `03a + 03b`; deep-assist mode uses `03c`.
- After Stage 04, scorecard and matrix share the same quality, critic, defend, synthesize, and finalize flow.
- Planning (Stage 02) is attribute-level for matrix (one plan entry per attribute, not per cell).
- Recovery (Stage 08) is cell-level for matrix; bounded cell-groups max 2 cells, same attribute only.

---

## Quality and Termination Behavior

**Strict mode (`strictQuality: true`):**
- `run_completed_degraded` is never emitted. Terminal states are `run_completed` or `run_aborted_strict_quality`.
- Any quality gate failure or abort condition causes immediate termination with reason codes and debug bundle.

**Non-strict mode (`strictQuality: false`):**
- `run_completed_degraded` is emitted when gates fail but the run produces a meaningful artifact.
- Output is labeled `qualityGrade: "degraded"` and the UI surfaces a prominent notice with failing reason codes.
- Hard-abort conditions apply in both modes: route/model preflight mismatch, unrecoverable parse failure, coverage below the hard-abort floor.

---

## Observability and UI Contract

- Pipeline progress is tracked by canonical stage IDs.
- Progress tab reflects this stage sequence and stage goals (see Stage Breakdown table).
- Diagnostics include stage-level status, exact model route used, retries, token usage, and estimated cost.
- On abort: show failure popup with primary reason code and plain-language explanation; offer Download Debug Log immediately.

---

## Related Documents

- [quality-bar.md](./quality-bar.md)
- [architecture.md](./architecture.md)
