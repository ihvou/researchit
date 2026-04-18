# Pipeline Architecture Suggestion (Actor-Symmetric)

This proposal aligns all runs (Scorecard/Matrix, Native/Deep Assist) to one stage sequence and two LLM actors.

## Actor policy

- `Analyst`: plans research, collects evidence, merges evidence, scores/assesses, recovers low-confidence gaps, and defends against Critic flags.
- `Critic`: challenges weak claims, finds counter-evidence, and pressure-tests decision robustness.
- Deterministic engine steps (verification, source assessment, routing, gates/finalization) are not additional actors.

## Canonical Pipeline (applies to all flows)

```mermaid
flowchart TD
    INTAKE["PROCESS: Input Intake\nGOAL: normalize request into stable schema\nACTOR: deterministic engine\nMODEL: N/A\nINPUT: raw user input + selected type + setup fields\nREQUEST: N/A\nRESPONSE: N/A\nOUTPUT: normalizedRequest"]

    PLAN["PROCESS: Research Planning\nGOAL: define scope, query plan, counterfactual probes\nACTOR: Analyst\nMODEL: gemini-2.5-flash (planning default)\nINPUT: normalizedRequest + research config\nREQUEST: one structured planning call\nRESPONSE: plan JSON (queries, source targets, risk probes)\nOUTPUT: researchPlan"]

    ROUTER{"PROCESS: Evidence Mode Routing\nGOAL: choose Native or Deep Assist collection\nACTOR: deterministic engine\nMODEL: N/A\nINPUT: normalizedRequest.evidenceMode\nREQUEST: N/A\nRESPONSE: N/A\nOUTPUT: selectedCollectionPath"}

    MEM_NATIVE["PROCESS: Evidence Collection (Memory, Native)\nGOAL: create memory-grounded draft evidence\nACTOR: Analyst\nMODEL: openai:gpt-5.4 (or strongest OpenAI available)\nINPUT: normalizedRequest + researchPlan\nREQUEST: structured evidence call (no web search)\nRESPONSE: draft evidence objects\nOUTPUT: memoryEvidenceDraft"]

    WEB_NATIVE["PROCESS: Evidence Collection (Web, Native)\nGOAL: gather cited web evidence for uncovered/weak claims\nACTOR: Analyst\nMODEL: gemini-2.5-pro (web default)\nINPUT: normalizedRequest + researchPlan + memoryEvidenceDraft\nREQUEST: structured web-search evidence call\nRESPONSE: cited findings with source metadata\nOUTPUT: webEvidenceDraft"]

    EVID_DA["PROCESS: Evidence Collection (Deep Assist)\nGOAL: gather full evidence packets (memory + web) from multiple providers\nACTOR: Analyst\nMODEL: openai:gpt-5.4 + claude-sonnet-4 + gemini-2.5-pro\nINPUT: normalizedRequest + researchPlan\nREQUEST: parallel deep-research style calls with provider-side web research\nRESPONSE: per-provider evidence drafts with citations/confidence\nOUTPUT: deepAssistEvidenceProviders"]

    MERGE["PROCESS: Evidence Merge\nGOAL: build one unified evidence bundle\nACTOR: Analyst\nMODEL: openai:gpt-5.4-mini (or stronger if quality requires)\nINPUT: native drafts OR deep-assist provider drafts\nREQUEST: merge/adjudication call and deterministic merge policy\nRESPONSE: merged evidence + agreement signals\nOUTPUT: evidenceBundleV1"]

    SCORE["PROCESS: Scoring / Assessment (if applicable)\nGOAL: map evidence to rubric scores or matrix values\nACTOR: Analyst\nMODEL: openai:gpt-5.4\nINPUT: evidenceBundleV1 + rubric/attribute definitions\nREQUEST: structured scoring call\nRESPONSE: scored dimensions or matrix cells\nOUTPUT: scoredStateV1"]

    CONF["PROCESS: Confidence Assessment\nGOAL: assign calibrated confidence with reasons\nACTOR: Analyst\nMODEL: openai:gpt-5.4-mini\nINPUT: scoredStateV1 + evidence quality indicators\nREQUEST: confidence calibration call\nRESPONSE: confidence levels + confidence reasons\nOUTPUT: assessedStateV1"]

    VERIFY["PROCESS: Source Verification\nGOAL: verify URLs/quotes and set verification status\nACTOR: deterministic engine\nMODEL: N/A\nINPUT: assessedStateV1 sources\nREQUEST: HTTP fetch + quote/name matching\nRESPONSE: fetch/match results per source\nOUTPUT: verifiedStateV1"]

    ASSESS["PROCESS: Source Assessment\nGOAL: apply quality caps/penalties from verification results\nACTOR: deterministic engine\nMODEL: N/A\nINPUT: verifiedStateV1 + quality policy\nREQUEST: N/A\nRESPONSE: N/A\nOUTPUT: qualityAdjustedStateV1"]

    COHERENCE["PROCESS: Consistency + Coherence Check\nGOAL: detect cross-item contradictions and logic breaks\nACTOR: Critic\nMODEL: claude-sonnet-4-0 (recommended alias)\nINPUT: qualityAdjustedStateV1\nREQUEST: structured consistency/coherence review call\nRESPONSE: contradiction flags + suggested corrections\nOUTPUT: coherenceFindings"]

    RECOVER["PROCESS: Extra Evidence for Low Confidence\nGOAL: recover low-confidence or sparse-evidence areas\nACTOR: Analyst\nMODEL: gemini-2.5-pro (search) + openai:gpt-5.4 (re-assess)\nINPUT: qualityAdjustedStateV1 + coherenceFindings + researchPlan\nREQUEST: targeted plan + web search + focused reassessment\nRESPONSE: incremental evidence patches\nOUTPUT: recoveredEvidencePatch"]

    RESCORE["PROCESS: Re-score + Confidence Re-assessment\nGOAL: update scores/values/confidence after recovery\nACTOR: Analyst\nMODEL: openai:gpt-5.4\nINPUT: qualityAdjustedStateV1 + recoveredEvidencePatch\nREQUEST: structured update call\nRESPONSE: updated scoring + confidence\nOUTPUT: assessedStateV2"]

    CHALLENGE["PROCESS: Challenge Overclaims + Weak Evidence\nGOAL: pressure-test strongest claims and overconfidence\nACTOR: Critic\nMODEL: claude-sonnet-4-0 (recommended alias)\nINPUT: assessedStateV2\nREQUEST: structured challenge/audit call\nRESPONSE: critic flags with rationale\nOUTPUT: criticFlags"]

    COUNTER["PROCESS: Counter-case + Missed Risks (Web)\nGOAL: find disconfirming evidence and unmodeled risks\nACTOR: Critic\nMODEL: claude-sonnet-4-0 (web enabled)\nINPUT: assessedStateV2 + criticFlags\nREQUEST: targeted web-search counter-case call\nRESPONSE: counter-evidence + missed-risk findings\nOUTPUT: criticCounterPack"]

    DEFEND["PROCESS: Concede / Defend with Updated Evidence\nGOAL: resolve critic objections explicitly\nACTOR: Analyst\nMODEL: openai:gpt-5.4\nINPUT: assessedStateV2 + criticFlags + criticCounterPack\nREQUEST: structured concede/defend adjudication call\nRESPONSE: accepted/rejected flags + revised reasoning\nOUTPUT: resolvedState"]

    FINAL["PROCESS: Final Confidence + Final Scores/Values\nGOAL: lock final output and decision-grade status\nACTOR: Analyst + deterministic engine\nMODEL: openai:gpt-5.4-mini (summary) + deterministic gates\nINPUT: resolvedState + quality gates\nREQUEST: final summarization call + deterministic checks\nRESPONSE: final narrative + decision implications\nOUTPUT: finalResearchArtifact"]

    INTAKE --> PLAN --> ROUTER
    ROUTER -->|Native| MEM_NATIVE --> WEB_NATIVE --> MERGE
    ROUTER -->|Deep Assist| EVID_DA --> MERGE
    MERGE --> SCORE --> CONF --> VERIFY --> ASSESS --> COHERENCE --> RECOVER --> RESCORE --> CHALLENGE --> COUNTER --> DEFEND --> FINAL
```

## Scorecard vs Matrix adaptation (within the same stages)

- Stage `6` output:
  - Scorecard: per-dimension scores.
  - Matrix: per-cell values/scores across subjects × attributes.
- Stage `10` consistency:
  - Scorecard: cross-dimension coherence.
  - Matrix: cross-row/cross-column logic and comparability.
- Stage `11` recovery target unit:
  - Scorecard: dimension.
  - Matrix: cell (or bounded cell-group when quality-equivalent).

## Model selection principles (quality-bar aligned)

- High-impact reasoning steps use stronger models.
- Planning/merge/calibration can use cheaper models only when quality is not materially reduced.
- Analyst web collection routes through Gemini.
- Critic challenge and counter-case web search route through Claude by default.
- No silent degraded fallback in strict quality mode; failures should stop with explicit diagnostics.
- For deterministic reproducibility, pin snapshots; for best-current quality, use approved latest aliases.
