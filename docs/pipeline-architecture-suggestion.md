# Pipeline Architecture (Actor-Symmetric)

Aligns all runs (Scorecard / Matrix, Native / Deep Assist) to one canonical stage sequence and three LLM actors.

## Why this refactor now

The current pipeline evolved through incremental fixes and now has structural drift: divergent flow logic between scorecard and matrix paths, inconsistent Native vs Deep Assist stage shapes, and repeated reliability failures under real workloads (token overflows, parse failures, web stalls, budget starvation). That drift increases implementation risk, slows debugging, and makes quality behavior harder to reason about.

The refactor goal is to replace ad hoc branching with one canonical stage architecture that is easier to maintain, easier to test, and safer to operate under strict quality guarantees.

This spec is intentionally anchored to [quality-bar.md](./quality-bar.md): implementation decisions must prioritize decision-grade output quality, completeness, accuracy, and auditable evidence over convenience behavior.

---

## Actor policy

| Actor | Responsibility | Default model family |
|-------|---------------|---------------------|
| `Analyst` | Plans research; collects, merges, scores, and re-scores evidence; recovers low-confidence gaps; defends against Critic flags; produces final summary | OpenAI (strongest route for high-impact steps; mini route for merge/summary) |
| `Critic` | Checks cross-unit consistency and coherence; challenges overclaims; finds counter-evidence via web search | Anthropic Claude |
| `Synthesizer` | Independent executive read after the full Analyst+Critic cycle; produces decision implication and dissent note; uses a **different model family from the Analyst's primary reasoning path** (OpenAI) for independence. Gemini use in Stages 03b and 08 by the Analyst is retrieval-tool use only — it does not produce scored assessments or defend conclusions. The Synthesizer uses Gemini as a reasoning actor, which is the distinct usage that establishes independence. | Gemini (third model family; independent from the OpenAI primary reasoning chain) |

Deterministic engine steps (input validation, source verification, quality assessment, routing, gate enforcement) are **not** LLM actors.

---

## Canonical Pipeline

```mermaid
flowchart TD
    classDef analyst fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    classDef critic  fill:#fce7f3,stroke:#db2777,color:#831843
    classDef synth   fill:#ecfdf5,stroke:#059669,color:#065f46
    classDef engine  fill:#f3f4f6,stroke:#6b7280,color:#111827

    INTAKE{{"#01 INPUT INTAKE\nActor: engine\nValidate and normalize input to stable schema\nIn: raw user input, config, setup fields\nOut: NormalizedRequest"}}
    DISCROUTER{"matrix +\nauto-discover\nsubjects?"}
    SUBJDISC["#01b SUBJECT DISCOVERY (optional)\nActor: Analyst | Model: gemini-2.5-pro (web)\nDiscover, deduplicate, and canonicalize comparison subjects\nIn: NormalizedRequest\nOut: NormalizedRequest + canonical subjects list"]
    PLAN["#02 RESEARCH PLANNING\nActor: Analyst | Model: openai:gpt-5.4\nDefine scope, per-unit query plan, counterfactual probes\nIn: NormalizedRequest\nOut: ResearchPlan"]
    EVROUTER{"evidence\nmode?"}
    MEM_NATIVE["#03a EVIDENCE - MEMORY (native)\nActor: Analyst | Model: openai:gpt-5.4 (no web)\nMemory-grounded draft evidence for all units\nIn: NormalizedRequest, ResearchPlan\nOut: MemoryEvidenceDraft"]
    WEB_NATIVE["#03b EVIDENCE - WEB (native)\nActor: Analyst | Model: gemini-2.5-pro (web)\nCited web evidence; patches and extends memory draft\nIn: NormalizedRequest, ResearchPlan, MemoryEvidenceDraft\nOut: WebEvidenceDraft"]
    EVID_DA["#03c EVIDENCE - DEEP ASSIST\nActor: Analyst | Model: gpt-5.4 + claude-sonnet-4 + gemini-2.5-pro (parallel)\nFull evidence packets from three providers in parallel\nIn: NormalizedRequest, ResearchPlan\nOut: DeepAssistProviderDrafts"]
    MERGE["#04 EVIDENCE MERGE\nActor: Analyst | Model: openai:gpt-5.4-mini + deterministic rules\nBuild unified evidence bundle; record provider agreement per unit\nIn: MemoryEvidenceDraft + WebEvidenceDraft OR DeepAssistProviderDrafts\nOut: EvidenceBundle"]
    SCORE_CONF["#05 SCORE + CONFIDENCE\nActor: Analyst | Model: openai:gpt-5.4\nScore all units; assign calibrated confidence with explicit reasons\nIn: EvidenceBundle, rubric / attribute definitions\nOut: AssessedStateV1"]
    VERIFY{{"#06 SOURCE VERIFICATION\nActor: engine\nFetch each URL; check quote / name presence in page content\nIn: AssessedStateV1 sources\nOut: VerifiedStateV1"}}
    ASSESS{{"#07 SOURCE ASSESSMENT\nActor: engine\nApply quality caps and confidence penalties from verification results\nIn: VerifiedStateV1, quality policy\nOut: QualityAdjustedStateV1"}}
    RECOVER["#08 TARGETED RECOVERY\nActor: Analyst | Model: gemini-2.5-pro (search) + openai:gpt-5.4 (re-assess)\nRecover zero-evidence and low-confidence units; coverage-first allocation\nIn: QualityAdjustedStateV1, ResearchPlan\nOut: RecoveredEvidencePatch"]
    RESCORE["#09 RE-SCORE + RE-CONFIDENCE\nActor: Analyst | Model: openai:gpt-5.4\nUpdate scores, values, and confidence from recovery patch\nIn: QualityAdjustedStateV1, RecoveredEvidencePatch\nOut: AssessedStateV2"]
    COHERENCE["#10 CONSISTENCY + COHERENCE\nActor: Critic | Model: claude-sonnet-4\nDetect cross-unit contradictions and logic breaks\nIn: AssessedStateV2\nOut: CoherenceFindings"]
    CHALLENGE["#11 CHALLENGE OVERCLAIMS\nActor: Critic | Model: claude-sonnet-4\nPressure-test strongest claims and overconfident assessments\nIn: AssessedStateV2, CoherenceFindings\nOut: CriticFlags"]
    COUNTER["#12 COUNTER-CASE + MISSED RISKS\nActor: Critic | Model: claude-sonnet-4 (web)\nSearch for disconfirming evidence and unmodeled risks\nIn: AssessedStateV2, CriticFlags\nOut: CriticCounterPack"]
    DEFEND["#13 CONCEDE / DEFEND\nActor: Analyst | Model: openai:gpt-5.4\nResolve every critic flag; accept or reject with updated evidence\nIn: AssessedStateV2, CriticFlags, CriticCounterPack\nOut: ResolvedState"]
    SYNTHESIZE["#14 SYNTHESIZE\nActor: Synthesizer | Model: gemini-2.5-pro\nIndependent executive narrative, decision implication, dissent note\nIn: ResolvedState + compact critic outcome summary (no raw critic chain)\nOut: SynthesisArtifact"]
    FINAL{{"#15 FINALIZE\nActor: Analyst summary (openai:gpt-5.4-mini) + engine gates\nLock final artifact; enforce decision-grade gate; emit reason codes\nIn: ResolvedState, SynthesisArtifact, quality gate config\nOut: FinalResearchArtifact OR abort(reasonCode)"}}

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

    class PLAN,MEM_NATIVE,WEB_NATIVE,SUBJDISC,EVID_DA,MERGE,SCORE_CONF,RECOVER,RESCORE,DEFEND analyst
    class COHERENCE,CHALLENGE,COUNTER critic
    class SYNTHESIZE synth
    class INTAKE,VERIFY,ASSESS,FINAL engine
```

---

## Scorecard vs Matrix adaptation (within the same stages)

- **Stage 01b** — Scorecard: skipped. Matrix: optional; run only when subjects are not provided by the user.
- **Stage 05 output** — Scorecard: per-dimension scores. Matrix: per-cell values / scores across subjects × attributes.
- **Stage 08 recovery target unit** — Scorecard: dimension. Matrix: cell (or bounded cell-group when quality-equivalent).
- **Stage 10 consistency scope** — Scorecard: cross-dimension coherence. Matrix: cross-row / cross-column logic and comparability.

---

## Model selection principles (quality-bar aligned)

- High-impact reasoning steps (planning, scoring, defending) use the strongest OpenAI route configured for the environment.
- Merge and final summary use a cheaper OpenAI route only where quality impact is proven negligible.
- Analyst web evidence collection and targeted recovery search route through Gemini.
- Critic challenge, coherence, and counter-case web search route through Claude.
- Synthesizer routes through Gemini to ensure model-family independence from the Analyst's **primary reasoning path** (OpenAI). Gemini use by the Analyst in evidence collection and recovery is retrieval-tool use only and does not compromise this independence.
- **No silent degraded fallback in strict quality mode.** Failures stop with explicit reason codes and a debug bundle.
- Pin model snapshot IDs for deterministic reproducibility; use approved latest aliases for best-current quality.

---

## Refactor scope and success criteria

1. One canonical stage graph for all run types (Scorecard / Matrix, Native / Deep Assist).
2. Three reasoning actors: `Analyst`, `Critic`, `Synthesizer`.
3. Native and Deep Assist differ only inside evidence collection; both converge to identical downstream stages.
4. No silent quality degradation in strict mode: unrecoverable failures must abort with explicit reason code and downloadable debug bundle.
5. Architecture and behavior are aligned with [quality-bar.md](./quality-bar.md).

---

## Real-run failure findings this spec must address

Observed from real debug runs and postmortems, not hypothetical risks.

| Finding | Observed symptom | Required design response |
|---------|-----------------|--------------------------|
| Token overflow in late critic phases | Critic prompt exceeded context (~200k+ tokens) | Prompt compaction before call; hard token preflight; split/condense strategy; bounded retries |
| Parse failure in matrix web passes | Web chunk returned malformed/truncated JSON | Parse-retry policy: reduced chunk scope and lower verbosity before fail |
| Long-running web step stalls | Single matrix web step took 40+ minutes | Per-stage hard timeout + adaptive chunk splitting + bounded retry |
| Fixed recovery budget starvation | Large matrix had far more weak cells than budget (84 weak vs 36 budget) | Size-aware adaptive budgets with per-attribute/cell coverage floor |
| Duplicate discovered subjects | Semantic duplicates consumed budget and diluted evidence | Canonicalization + dedup merge before scoring/recovery (Stage 01b) |
| Reconcile no-op accepted | Reconcile applied with near-zero useful changes | Reconcile acceptance gate with minimum lift metrics |
| Route/model drift risk | Wrong provider/model path consumed tokens with low trust | Strict actor-route preflight and hard stop on mismatch |
| "Finished but hollow" outputs | Run completed with low decision usefulness | Early catastrophic coverage gate + hard abort criteria |

---

## Canonical runtime contracts

### Global run state

Every stage receives and returns a shared state envelope:

```ts
type RunState = {
  runId:       string;
  mode:        "native" | "deep-assist";
  outputType:  "scorecard" | "matrix";
  request:     NormalizedRequest;
  plan:        ResearchPlan | null;
  evidence:    EvidenceBundle | null;
  assessment:  AssessmentState | null;
  critique:    CriticState | null;
  synthesis:   SynthesisArtifact | null;
  quality:     QualityState;
  diagnostics: DiagnosticsState;
};
```

### Stage IO contract

Every stage emits:

- `stageStatus: "ok" | "recovered" | "failed"`
- `reasonCodes: string[]` — machine-readable, from the reason code catalog
- `metrics` — duration, request counts, token estimates/actuals, retry count
- `statePatch` — additive patch to `RunState`

---

## Stage behavior specification

### Stage 01 — Input Intake  _(engine)_
- Validate required fields for the selected config.
- Normalize user framing into structured fields used by all downstream prompts.
- Fail immediately (`missing_required_input`) if required inputs are absent.

### Stage 01b — Subject Discovery  _(Analyst, matrix + auto-discover only)_
- Discover candidate subjects via web search.
- Canonicalize: resolve aliases, rebrand, and acquisition relationships.
- Merge semantic duplicates into canonical subject IDs; preserve alias provenance in diagnostics.
- Output enriches `NormalizedRequest.matrix.subjects` before planning.

### Stage 02 — Research Planning  _(Analyst)_
- Produce scoped queries and counterfactual probes for every unit.
- **Unit granularity is fixed:** for scorecard, one plan entry per dimension; for matrix, one plan entry per **attribute** (shared across all subjects). Cell-level planning (`subjectId × attributeId`) is not used at this stage — it would create O(subjects × attributes) plan entries and is reserved for targeted recovery (Stage 08).
- If plan quality is insufficient, retry once with a stricter schema enforcement prompt.
- Fail (`critical_units_unresolved`) if any unit has no plan entries after retry.

### Stage 03 — Evidence Collection  _(Analyst)_
- **Native path:** memory pass (Stage 03a) then web pass (Stage 03b).
  - Matrix web pass: adaptive chunking is mandatory; chunk size halves on timeout/parse/token failure.
- **Deep Assist path:** parallel provider collection (Stage 03c); providers run concurrently with heartbeat monitoring.
- Both paths must output the same `EvidenceBundle` schema before merge.

### Stage 04 — Evidence Merge  _(Analyst + deterministic rules)_
- Merge by evidence quality, confidence, and provider agreement.
- Preserve full provenance: `provider`, `step`, `source` per claim.
- Apply reconcile acceptance gate: if the merged result provides no meaningful lift over the best prior draft (no confidence improvement, no source coverage improvement, no contradiction reduction), reject and retain best prior draft.

### Stage 05 — Score + Confidence  _(Analyst)_
- Score / assess all units against rubric or attribute definitions.
- Assign calibrated confidence levels with explicit reasons in the same call.
- Schema-validate output; retry once with reduced scope on schema failure.

### Stages 06–07 — Source Verification + Assessment  _(engine)_
- **06:** HTTP fetch each source URL; check quote / name presence in page content; assign `verificationStatus`.
- **07:** Apply quality caps and confidence penalties from verification results per quality policy.
- Both stages are deterministic; no LLM calls.

### Stages 08–09 — Targeted Recovery + Re-score  _(Analyst)_
- **08 — Recovery:** Coverage-first allocation (see Deterministic Algorithm B). Prioritize zero-evidence units and critical attributes before pressure-based allocation. Gemini web search for retrieval; OpenAI re-assessment.
  - **Unit granularity for matrix recovery is cell-level** (`subjectId × attributeId`). Each recovery slot targets one specific cell. Bounded cell-groups are only allowed when cells share the same attribute and sequential recovery would exceed the timeout budget; in that case group size `MUST NOT exceed 2` and cells must be from the same attribute.
- **09 — Re-score:** Update scores, values, and confidence from the recovery patch in a structured update call.

### Stages 10–12 — Critic cycle  _(Critic)_
- **10 — Coherence:** Review `AssessedStateV2` for cross-unit contradictions and logic breaks. Runs on recovered data.
- **11 — Challenge:** Adversarial pressure-test of strongest claims and overconfident assessments; uses Stage 10 findings as input.
- **12 — Counter-case:** Targeted web search for disconfirming evidence and unmodeled risks, scoped to Stage 11 flags.
- Critic flags must be explicit, traceable, and include rationale.

### Stage 13 — Concede / Defend  _(Analyst)_
- Respond to every critic flag: accept or reject with updated evidence and explicit reasoning.
- Response must map flag-by-flag via `CriticFlagOutcome`; no bulk dismissals without rationale (`disposition: "rejected_with_evidence"` requires explicit evidence citation).
- For every unresolved `severity=high` flag, a `mitigationNote` is required; the gate will fail if this field is absent.

### Stage 14 — Synthesize  _(Synthesizer)_
- Produce an independent executive narrative using a different model family than the Analyst chain.
- Output: `executiveSummary`, `decisionImplication`, `dissent` (where the analysis may understate uncertainty).
- Input includes `ResolvedState` plus a compact critic outcome summary to strengthen executive risk framing.
- The compact summary `MUST` exclude raw critic chain-of-thought and long intermediate critic text.
- Allowed compact summary fields:
  - critic flag counts by severity / category
  - unresolved vs resolved flag counts
  - top 3 critic concerns (short labels only)
  - whether counter-case evidence changed any final units
- This preserves synthesizer independence while retaining material critique signal.

### Stage 15 — Finalize  _(Analyst summary + engine gates)_
- Apply the decision-grade gate (see Decision-Grade Gate Formulas).
- If gates pass: emit `FinalResearchArtifact`.
- If any gate fails in strict mode: abort with `run_aborted_strict_quality` + specific failure reason codes.
- Emit downloadable debug bundle regardless of outcome.

---

## Routing and model policy (enforced)

### Actor-level guarantees

| Actor | Step type | Model route |
|-------|-----------|-------------|
| Analyst | Planning, scoring, defending | Strongest OpenAI route in environment |
| Analyst | Web evidence collection, recovery search | Gemini-2.5-pro |
| Analyst | Merge, final summary | Cheaper OpenAI route (e.g. gpt-5.4-mini) |
| Critic | Coherence, challenge, counter-case | Claude route (claude-sonnet-4 or alias) |
| Critic | Counter-case web search | Claude route with web enabled |
| Synthesizer | Executive narrative | Gemini-2.5-pro (distinct model family for independence) |

### Strict route preflight

Before any paid request:

1. Resolve effective provider/model per stage from config.
2. Compare against expected actor policy above.
3. If mismatch: fail immediately with `route_mismatch_preflight` before any LLM calls.

**Stage 03c carve-out (Deep Assist only):** Stage 03c is the sole exception to the single-provider Analyst policy. It intentionally uses three providers in parallel (OpenAI, Anthropic, Gemini) under the Analyst actor. The preflight for Stage 03c `MUST` verify that all three configured deep-assist providers are present and reachable — not that the route matches the single-provider Analyst default. Absence of any configured deep-assist provider `MUST` fail with `route_mismatch_preflight` before any call. No provider may be silently skipped.

---

## Token, timeout, retry, and budget policy

### Token policy

For every LLM stage:
1. Estimate prompt token count before submission.
2. If over stage budget: compact context, then retry.
3. If still over budget after compaction: split scope, then retry.
4. If all strategies exhausted: fail with `prompt_compaction_exhausted`.

### Timeout policy

Per-stage hard timeout with bounded retries:
1. On timeout: reduce scope / chunk size, retry.
2. On second timeout: also reduce verbosity target, retry.
3. On third timeout: fail with `retry_exhausted`.

Strict mode: no silent continuation after retry exhaustion.

### Budget policy

- Recovery budget scales by matrix size / weak-cell volume; no fixed constants.
- Mandatory coverage floor per attribute/dimension before pressure-based allocation.
- Chunk sizes for matrix passes: adaptive (`maxSubjectsPerChunk` halves on failure; minimum 1).
- Token budgets in the table below are **per-chunk**, not per full pass.

---

## Stage budgets and operational defaults

| Stage | Output type | Timeout | Retry max | Token budget | Notes |
|-------|-------------|---------|-----------|-------------|-------|
| 01b Subject Discovery | matrix | 60s | 1 | 4k | web-grounded; Gemini |
| 02 Planning | both | 45s | 1 | 4k | must cover all dimensions / attributes |
| 03a Memory evidence | scorecard | 75s | 1 | 8k | split by dimension if needed |
| 03a Memory evidence | matrix | 90s | 2 | 10k per chunk | adaptive chunking |
| 03b Web evidence | scorecard | 90s | 2 | 10k | Gemini web route |
| 03b Web evidence | matrix | 120s | 2 | 12k per chunk | adaptive chunking mandatory |
| 03c Deep Assist | both | 20m | 0 | provider-managed | monitor heartbeat / progress |
| 04 Merge | both | 45s | 1 | 6k | deterministic + LLM hybrid |
| 05 Score + Confidence | both | 60s | 1 | 8k | schema-validated; confidence reasons required |
| 06 Source Verification | both | 60s | 0 | n/a | deterministic; per-URL fetch |
| 07 Source Assessment | both | 15s | 0 | n/a | deterministic |
| 08 Targeted Recovery | both | 90s | 2 | 8k per unit/group | coverage-first allocation |
| 09 Re-score | both | 60s | 1 | 6k | structured update call |
| 10 Coherence | both | 75s | 1 | 8k | Critic route |
| 11 Challenge | both | 75s | 1 | 8k | Critic route |
| 12 Counter-case | both | 90s | 1 | 8k | Critic web-enabled route |
| 13 Defend | both | 75s | 1 | 8k | flag-by-flag resolution |
| 14 Synthesize | both | 60s | 1 | 6k | Gemini; independent read |
| 15 Finalize | both | 45s | 1 | 4k | summary + deterministic gate |

---

## Retry and fallback matrix (strict quality mode)

No provider/model failover in strict mode. All retries use the same route.

| Failure class | First retry | Second retry | Terminal behavior |
|---------------|------------|--------------|-------------------|
| Timeout | smaller scope | smaller scope + reduced verbosity | `retry_exhausted` |
| Parse failure | schema-repair prompt | smaller scope | `response_parse_failed` |
| Token overflow | compact prompt | split scope + compact | `prompt_compaction_exhausted` |
| Rate limit | bounded backoff | bounded backoff | `rate_limit_backoff_exhausted` |
| Missing required units | targeted fill pass | targeted fill pass (higher priority) | `critical_units_unresolved` |

---

## Deterministic algorithms (required)

### A — Adaptive matrix chunking

1. Start from `matrix.chunkSizeStart` (default: 4 subjects).
2. On any timeout / parse failure / token overflow:
   - halve chunk size: `max(1, floor(size / 2))`
   - reduce response verbosity target
   - retry
3. Record every chunk-size decision in stage diagnostics.

### B — Coverage-first recovery allocation

1. Compute pressure per unit:
   - contradiction flag: +5
   - low confidence: +4
   - zero evidence: +4
   - sparse sources: +2
   - stale-heavy evidence: +2
2. Reserve mandatory floor: at least one recovery slot per uncovered critical attribute / dimension, regardless of pressure score.
3. Allocate remaining budget slots by pressure descending.
4. If no net coverage lift on pass 1: allow one bounded pass 2.

### C — Reconcile acceptance gate

Reject the merged result if **all** of the following are true:
- confidence lift < configured threshold
- low-confidence count not reduced
- source coverage not improved
- contradiction count not reduced

Fallback: retain best prior draft and continue to scoring.

### D — Provider agreement scoring (Deep Assist)

Per unit / cell:
- `agree`: semantic overlap ≥ `T_high`
- `partial`: `T_low ≤ overlap < T_high`
- `contradict`: overlap `< T_low`

Thresholds are config-controlled and logged per run.

---

## Decision-grade gate formulas (required)

Applied at Stage 15. Both scorecard and matrix use the same checks (matrix applies per-cell equivalents).

1. **Coverage:** `coveredUnits / totalUnits >= minCoverageRatio`
2. **Confidence:** `lowConfidenceUnits / totalUnits <= maxLowConfidenceRatio`
3. **Source sufficiency:** each critical unit has `>= minSourcesPerCriticalUnit` sources, of which `>= minIndependentSourcesPerCriticalUnit` are independent
4. **Critic resolution:** `ResolvedState.flagOutcomes.filter(o => !o.resolved).length <= maxUnresolvedCriticFlags`
5. **High-severity coverage:** `ResolvedState.unresolvedHighSeverityCount === 0 OR every unresolved high-severity outcome has a non-empty mitigationNote`

Any failure in strict mode → abort with `run_aborted_strict_quality`.

---

## Quality gates and abort criteria

### Strict mode (`strictQuality: true`)

`run_completed_degraded` is **never emitted** in strict mode. The only terminal states are:
- `run_completed` — all decision-grade gates passed
- `run_aborted_strict_quality` — any gate failed or any abort condition was met

Abort conditions (strict mode only):
- unrecoverable parse failures
- catastrophic post-recovery coverage shortfall
- unresolved critical evidence minimums
- route/model preflight mismatch
- token/timeout retry exhaustion on a required stage

Expected UX behavior on abort:
- show failure popup with primary `reasonCode` and a plain-language explanation
- offer `Download Debug Log` action immediately
- preserve full run state and diagnostics for troubleshooting

### Non-strict mode (`strictQuality: false`)

`run_completed_degraded` is emitted when the run completes but one or more decision-grade gates fail. The output artifact `MUST` be labeled `qualityGrade: "degraded"` and the UI `MUST` surface a prominent degraded-quality notice with the failing reason codes.

However, even in non-strict mode, the following conditions `MUST` still abort (consistent with quality-bar.md hard-abort policy):
- route/model preflight mismatch (correctness guarantee, not quality)
- unrecoverable parse failure with no recoverable state
- total coverage below the hard-abort floor (e.g., `coveredUnits / totalUnits < hardAbortCoverageFloor`, a lower threshold than the decision-grade gate)

The distinction: non-strict mode tolerates a degraded-but-meaningful artifact; it does not tolerate a meaningless or architecturally broken one.

---

## Diagnostics and debug bundle contract

Debug bundle must support both reliability debugging and output-quality analysis.

Required sections:

| Section | Contents |
|---------|----------|
| `run` | run id, mode, outputType, config id/version, timestamps |
| `routing` | resolved provider/model per stage including aliases/snapshots |
| `stages[]` | stage name, status, reason codes, duration, retry count, token estimates + provider-reported usage, timeout and chunking decisions |
| `io` | prompt metadata, compaction metadata, raw model response text (redacted for PII/secrets only), parse errors and repair attempts |
| `quality` | coverage metrics, source verification stats, critic flags, gate outcomes |
| `cost` | estimated per-stage, per-provider/model spend and run totals |

---

## Progress / UI contract

- Progress events map 1:1 to canonical stage ids (e.g. `stage_08_recover`).
- Each event includes: stage id, title, status, started/ended time, retry count, reason codes.
- On failure:
  - show failure popup with top reason code and brief explanation
  - include `Download Debug Log` action
- No legacy phase names that imply the old architecture.

---

## Backward compatibility and migration

1. Preserve old export/import JSON via a **strictly isolated** adapter module: `engine/lib/legacy-adapter.js`.
2. Store `artifactVersion` and `pipelineVersion` in every artifact.
3. Migration transforms performed by the adapter:
   - legacy phase names → canonical stage ids
   - legacy evidence fields → canonical `SourceRef / ArgumentRef`
   - legacy flags → `CriticFlag` (with inferred `severity: "medium"` and `category: "other"` for flags that predate the typed schema)

**Adapter scope constraints (`MUST` be enforced):**
- The adapter is called only at artifact **read / import time**, never from stage execution logic.
- Production pipeline stages `MUST NOT` import from `legacy-adapter.js`; any such import is a build-time error.
- The adapter carries a `@legacy` JSDoc tag and `LEGACY_ADAPTER_SUNSET` constant; when all stored artifacts have been migrated (verified by a migration script), the adapter file is deleted — not retained as a convenience utility.
- New fields added to canonical types are not back-ported into the adapter; the adapter only transforms old shapes into canonical ones, never the reverse.

---

## Detailed data contracts (canonical)

```ts
type EvidenceMode = "native" | "deep-assist";
type OutputType   = "scorecard" | "matrix";
type StageStatus  = "ok" | "recovered" | "failed";
type Confidence   = "high" | "medium" | "low";

type NormalizedRequest = {
  outputType:       OutputType;
  evidenceMode:     EvidenceMode;
  researchConfigId: string;
  titleHint?:       string;
  objective:        string;
  decisionQuestion?: string;
  scopeContext?:    string;
  roleContext?:     string;
  scorecard?: {
    dimensions: Array<{ id: string; label: string; weight: number; rubric: string; brief: string }>;
  };
  matrix?: {
    subjects:   Array<{ id: string; label: string; aliases?: string[] }>;
    attributes: Array<{ id: string; label: string; brief: string; derived?: boolean }>;
  };
};

type ResearchPlan = {
  niche?:   string;
  aliases?: string[];
  units: Array<{
    unitId:               string; // dimensionId (scorecard) OR attributeId (matrix — always attribute-level, never cellKey)
    supportingQueries:    string[];
    counterfactualQueries: string[];
    sourceTargets:        string[];
    gapHypothesis?:       string;
  }>;
};

type SourceRef = {
  name:               string;
  url?:               string;
  quote?:             string;
  sourceType?:        string;
  provider?:          string;
  verificationStatus?: "verified_in_page" | "name_only_in_page" | "not_found_in_page" | "fetch_failed" | "invalid_url";
  displayStatus?:     "cited" | "corroborating" | "excluded_marketing" | "excluded_stale" | "unverified";
  publishedYear?:     number | null;
};

type ArgumentRef = {
  id:      string;
  claim:   string;
  detail?: string;
  side:    "supporting" | "limiting";
  sources: SourceRef[];
};

type ScorecardUnit = {
  id:               string;
  score:            number;
  confidence:       Confidence;
  confidenceReason: string;
  brief:            string;
  full:             string;
  sources:          SourceRef[];
  arguments:        { supporting: ArgumentRef[]; limiting: ArgumentRef[] };
  risks?:           string;
  missingEvidence?: string;
  providerAgreement?: "agree" | "partial" | "contradict";
};

type MatrixCell = {
  subjectId:        string;
  attributeId:      string;
  value:            string;
  confidence:       Confidence;
  confidenceReason: string;
  full?:            string;
  sources:          SourceRef[];
  arguments:        { supporting: ArgumentRef[]; limiting: ArgumentRef[] };
  risks?:           string;
  providerAgreement?: "agree" | "partial" | "contradict";
};

type EvidenceBundle = {
  scorecard?:            { dimensions: ScorecardUnit[] };
  matrix?:               { cells: MatrixCell[] };
  providerContributions?: Array<{ provider: string; success: boolean; durationMs: number }>;
};

type CriticFlag = {
  unitKey:            string;      // dimensionId  OR  subjectId::attributeId
  flagged:            boolean;
  severity:           "high" | "medium" | "low"; // required; drives gate formula #5
  category:           "overclaim" | "missing_evidence" | "contradiction" | "stale_source" | "missed_risk" | "other";
  note:               string;
  suggestedScore?:    number;
  suggestedValue?:    string;
  suggestedConfidence?: Confidence;
  sources?:           SourceRef[];
};

type CriticFlagOutcome = {
  flagId:      string;             // stable id assigned by Critic at flag creation
  flag:        CriticFlag;
  resolved:    boolean;
  disposition: "accepted" | "rejected_with_evidence"; // bulk dismissal without rationale is not allowed
  analystNote: string;             // required; must reference flag.unitKey and explain accept/reject
  mitigationNote?: string;         // required when flag.severity === "high" and resolved === false
};

type ResolvedState = {
  assessment:   AssessedStateV2;   // final scored state after critic cycle
  flagOutcomes: CriticFlagOutcome[];
  unresolvedHighSeverityCount: number; // derived; used directly by gate formula #5
};

type SynthesisArtifact = {
  executiveSummary:    string;
  decisionImplication: string;
  dissent:             string; // where the analysis may understate uncertainty
};

type QualityState = {
  strictQuality:  boolean;
  qualityGrade:   "decision-grade" | "degraded" | "failed";
  reasonCodes:    string[];
  coverage: {
    totalUnits:         number;
    coveredUnits:       number;
    lowConfidenceUnits: number;
    zeroEvidenceUnits:  number;
  };
  sourceUniverse: {
    cited:             number;
    corroborating:     number;
    unverified:        number;
    excludedMarketing: number;
    excludedStale:     number;
  };
};

type StageRecord = {
  stage:       string;
  status:      StageStatus;
  startedAt:   string;
  endedAt:     string;
  reasonCodes: string[];
  retries:     number;
  durationMs:  number;
  modelRoute?: { actor: "analyst" | "critic" | "synthesizer"; provider: string; model: string; liveSearch?: boolean };
  tokens?:     { estimatedInput?: number; providerInput?: number; providerOutput?: number; cachedInput?: number };
};
```

---

## Reason code catalog

All stage failures and recoveries must emit stable, machine-readable reason codes.

| Category | Codes |
|----------|-------|
| Routing / setup | `route_mismatch_preflight` · `missing_required_input` · `invalid_config_schema` |
| Token / prompt | `prompt_token_over_budget` · `prompt_compaction_applied` · `prompt_compaction_exhausted` |
| Time / retries | `stage_timeout` · `retry_exhausted` · `rate_limit_backoff_exhausted` |
| Parse / schema | `response_parse_failed` · `response_schema_invalid` · `partial_payload_rejected` |
| Coverage / quality | `coverage_catastrophic` · `decision_gate_failed` · `critical_units_unresolved` · `reconcile_rejected_no_lift` · `recovery_budget_starved` |
| Source quality | `source_verification_failed` · `source_quality_capped` |
| Run outcome | `run_aborted_strict_quality` · `run_completed_degraded` |

---

## Normative implementation requirements

- `MUST` — required for compliance with this spec.
- `SHOULD` — strongly recommended unless a documented exception exists.
- `MAY` — optional implementation detail.

Core requirements:

1. Pipeline behavior `MUST` be stage-driven, not prompt-chain-driven.
2. Native and Deep Assist `MUST` converge to identical post-merge stages.
3. Actor routing `MUST` pass strict preflight before the first paid request.
4. Strict mode `MUST` abort on unrecoverable quality-risk states.
5. Debug bundles `MUST` include enough raw IO and metadata to replay downstream logic offline.

---

## Code architecture target

```
engine/
  pipeline/
    orchestrator.js          # shared stage runner for scorecard + matrix
    stages/
      01-intake.js
      01b-subject-discovery.js
      02-plan.js
      03a-evidence-memory.js
      03b-evidence-web.js
      03c-evidence-deep-assist.js
      04-merge.js
      05-score-confidence.js
      06-source-verify.js
      07-source-assess.js
      08-recover.js
      09-rescore.js
      10-coherence.js
      11-challenge.js
      12-counter.js
      13-defend.js
      14-synthesize.js
      15-finalize.js
    contracts/
      run-state.js            # RunState, NormalizedRequest, EvidenceBundle, etc.
      reason-codes.js         # exported constants for all reason codes
  lib/
    guards/
      token-preflight.js
      timeout-retry.js
      coverage-gate.js
      decision-gate.js
    diagnostics/
      stage-logger.js
      debug-bundle.js
    routing/
      actor-resolver.js       # strict actor → provider/model resolution
      route-preflight.js      # preflight check before first spend
```

Shared utilities `MUST` be centralized here. Importing from `stages/` into other `stages/` is not allowed; shared logic belongs in `lib/`.

---

## Refactor rollout plan

### Phase 1 — Contracts
Introduce canonical `RunState`, stage IO schema, and reason code constants. No behavior change.

### Phase 2 — Orchestrator spine
Build shared orchestrator executing current logic through thin adapters. Both scorecard and matrix run through the same orchestrator.

### Phase 3 — Evidence collection unification
Implement Native / Deep Assist convergence into one `EvidenceBundle` contract.

### Phase 4 — Guardrails hardening
Add token preflight, timeout split-retry, adaptive chunking, coverage-first recovery, and strict abort.

### Phase 5 — Quality and diagnostics completeness
Enforce full diagnostics contract; verify downloadable debug bundles; add Synthesize stage.

### Phase 6 — Cutover
Replace old per-pipeline branching with stage modules. Remove dead paths. Requires replay tests to pass before merge.

---

## Test strategy (required before cutover)

**Unit tests**
- Stage IO contracts and `statePatch` correctness
- Reason code emission per failure class
- Route preflight behavior (match / mismatch)
- Token preflight, timeout split, adaptive chunk-size decisions
- Coverage-first recovery allocation (algorithm B)
- Decision-grade gate formulas

**Replay tests** _(zero real provider calls)_
- Run with captured response fixtures from existing debug bundles
- Validate deterministic downstream behavior, gate outcomes, and debug bundle shape

**Integration tests** _(one of each, with expected gate assertions)_
- Scorecard — native
- Matrix — native
- Scorecard — deep-assist
- Matrix — deep-assist

---

## Refactor completion checklist

- [ ] Canonical stage orchestrator exists and is shared by scorecard and matrix
- [ ] Stage 01b (subject discovery) is implemented and conditional on matrix + auto-discover
- [ ] Native and Deep Assist converge at identical post-merge stages
- [ ] Strict route preflight blocks mismatched actor/model routes
- [ ] Token / timeout / parse guardrails with bounded retries are enforced
- [ ] Coverage-first recovery allocator is active and tested
- [ ] Synthesize stage (Stage 14) uses a distinct model family from the Analyst chain
- [ ] Decision-grade gates are enforced for both scorecard and matrix
- [ ] Debug bundle contract includes raw stage IO + model usage + reason codes
- [ ] UI progress and failure popup consume canonical stage diagnostics
- [ ] Replay tests pass using captured debug fixtures without real provider calls
