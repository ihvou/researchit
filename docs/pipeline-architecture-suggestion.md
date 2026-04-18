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
| `Synthesizer` | Independent executive read after the full Analyst+Critic cycle; produces decision implication and dissent note; deliberately uses a **different model family** from the Analyst chain for independence | Gemini (third model family) |

Deterministic engine steps (input validation, source verification, quality assessment, routing, gate enforcement) are **not** LLM actors.

---

## Canonical Pipeline

```mermaid
flowchart TD
    classDef analyst  fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    classDef critic   fill:#fce7f3,stroke:#db2777,color:#831843
    classDef synth    fill:#ecfdf5,stroke:#059669,color:#065f46
    classDef engine   fill:#f3f4f6,stroke:#6b7280,color:#111827

    INTAKE{{"#01 · INPUT INTAKE
    Actor: engine (deterministic)
    ─────────────────────────────────────
    Validate and normalize input to stable schema
    In:  raw user input · config · setup fields
    Out: NormalizedRequest"}}

    DISCROUTER{"matrix +\nauto-discover\nsubjects?"}

    SUBJDISC["#01b · SUBJECT DISCOVERY  ⬡ optional
    Actor: Analyst · Model: gemini-2.5-pro (web)
    ─────────────────────────────────────
    Discover, deduplicate, and canonicalize comparison subjects
    In:  NormalizedRequest
    Out: NormalizedRequest + canonical subjects list"]

    PLAN["#02 · RESEARCH PLANNING
    Actor: Analyst · Model: openai:gpt-5.4
    ─────────────────────────────────────
    Define scope, per-unit query plan, counterfactual probes
    In:  NormalizedRequest
    Out: ResearchPlan"]

    EVROUTER{"evidence\nmode?"}

    MEM_NATIVE["#03a · EVIDENCE — MEMORY  (native path)
    Actor: Analyst · Model: openai:gpt-5.4  (no web)
    ─────────────────────────────────────
    Memory-grounded draft evidence for all units
    In:  NormalizedRequest · ResearchPlan
    Out: MemoryEvidenceDraft"]

    WEB_NATIVE["#03b · EVIDENCE — WEB  (native path)
    Actor: Analyst · Model: gemini-2.5-pro  (web)
    ─────────────────────────────────────
    Cited web evidence; patches and extends memory draft
    In:  NormalizedRequest · ResearchPlan · MemoryEvidenceDraft
    Out: WebEvidenceDraft"]

    EVID_DA["#03c · EVIDENCE — DEEP ASSIST  (deep-assist path)
    Actor: Analyst · Model: gpt-5.4 + claude-sonnet-4 + gemini-2.5-pro  (parallel)
    ─────────────────────────────────────
    Full evidence packets (memory + web) from three providers in parallel
    In:  NormalizedRequest · ResearchPlan
    Out: DeepAssistProviderDrafts"]

    MERGE["#04 · EVIDENCE MERGE
    Actor: Analyst · Model: openai:gpt-5.4-mini + deterministic rules
    ─────────────────────────────────────
    Build unified evidence bundle; record provider agreement per unit
    In:  MemoryEvidenceDraft + WebEvidenceDraft  OR  DeepAssistProviderDrafts
    Out: EvidenceBundle"]

    SCORE_CONF["#05 · SCORE + CONFIDENCE
    Actor: Analyst · Model: openai:gpt-5.4
    ─────────────────────────────────────
    Score/assess all units; assign calibrated confidence with explicit reasons
    In:  EvidenceBundle · rubric / attribute definitions
    Out: AssessedStateV1"]

    VERIFY{{"#06 · SOURCE VERIFICATION
    Actor: engine (deterministic)
    ─────────────────────────────────────
    Fetch each URL; check quote / name presence in page content
    In:  AssessedStateV1 sources
    Out: VerifiedStateV1"}}

    ASSESS{{"#07 · SOURCE ASSESSMENT
    Actor: engine (deterministic)
    ─────────────────────────────────────
    Apply quality caps and confidence penalties from verification results
    In:  VerifiedStateV1 · quality policy
    Out: QualityAdjustedStateV1"}}

    RECOVER["#08 · TARGETED RECOVERY
    Actor: Analyst · Model: gemini-2.5-pro (search) + openai:gpt-5.4 (re-assess)
    ─────────────────────────────────────
    Recover zero-evidence and low-confidence units; coverage-first allocation
    In:  QualityAdjustedStateV1 · ResearchPlan
    Out: RecoveredEvidencePatch"]

    RESCORE["#09 · RE-SCORE + RE-CONFIDENCE
    Actor: Analyst · Model: openai:gpt-5.4
    ─────────────────────────────────────
    Update scores, values, and confidence from recovery patch
    In:  QualityAdjustedStateV1 · RecoveredEvidencePatch
    Out: AssessedStateV2"]

    COHERENCE["#10 · CONSISTENCY + COHERENCE
    Actor: Critic · Model: claude-sonnet-4
    ─────────────────────────────────────
    Detect cross-unit contradictions and logic breaks
    In:  AssessedStateV2
    Out: CoherenceFindings"]

    CHALLENGE["#11 · CHALLENGE OVERCLAIMS
    Actor: Critic · Model: claude-sonnet-4
    ─────────────────────────────────────
    Pressure-test strongest claims and overconfident assessments
    In:  AssessedStateV2 · CoherenceFindings
    Out: CriticFlags"]

    COUNTER["#12 · COUNTER-CASE + MISSED RISKS
    Actor: Critic · Model: claude-sonnet-4  (web)
    ─────────────────────────────────────
    Search for disconfirming evidence and unmodeled risks
    In:  AssessedStateV2 · CriticFlags
    Out: CriticCounterPack"]

    DEFEND["#13 · CONCEDE / DEFEND
    Actor: Analyst · Model: openai:gpt-5.4
    ─────────────────────────────────────
    Resolve every critic flag; accept or reject with updated evidence
    In:  AssessedStateV2 · CriticFlags · CriticCounterPack
    Out: ResolvedState"]

    SYNTHESIZE["#14 · SYNTHESIZE
    Actor: Synthesizer · Model: gemini-2.5-pro
    ─────────────────────────────────────
    Independent executive narrative, decision implication, dissent note
    In:  ResolvedState
    Out: SynthesisArtifact"]

    FINAL{{"#15 · FINALIZE
    Actor: Analyst summary (openai:gpt-5.4-mini) + engine gates
    ─────────────────────────────────────
    Lock final artifact; enforce decision-grade gate; emit reason codes
    In:  ResolvedState · SynthesisArtifact · quality gate config
    Out: FinalResearchArtifact  OR  abort(reasonCode)"}}

    INTAKE       --> DISCROUTER
    DISCROUTER   -->|yes| SUBJDISC --> PLAN
    DISCROUTER   -->|no|  PLAN
    PLAN         --> EVROUTER
    EVROUTER     -->|native|      MEM_NATIVE --> WEB_NATIVE --> MERGE
    EVROUTER     -->|deep-assist| EVID_DA    --> MERGE
    MERGE        --> SCORE_CONF --> VERIFY --> ASSESS
    ASSESS       --> RECOVER --> RESCORE
    RESCORE      --> COHERENCE --> CHALLENGE --> COUNTER --> DEFEND
    DEFEND       --> SYNTHESIZE --> FINAL

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
- Synthesizer routes through Gemini to ensure model-family independence from the Analyst chain.
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
- Produce scoped queries and counterfactual probes for every unit (dimension or attribute).
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
- **09 — Re-score:** Update scores, values, and confidence from the recovery patch in a structured update call.

### Stages 10–12 — Critic cycle  _(Critic)_
- **10 — Coherence:** Review `AssessedStateV2` for cross-unit contradictions and logic breaks. Runs on recovered data.
- **11 — Challenge:** Adversarial pressure-test of strongest claims and overconfident assessments; uses Stage 10 findings as input.
- **12 — Counter-case:** Targeted web search for disconfirming evidence and unmodeled risks, scoped to Stage 11 flags.
- Critic flags must be explicit, traceable, and include rationale.

### Stage 13 — Concede / Defend  _(Analyst)_
- Respond to every critic flag: accept or reject with updated evidence and explicit reasoning.
- Response must map flag-by-flag; no bulk dismissals without rationale.

### Stage 14 — Synthesize  _(Synthesizer)_
- Produce an independent executive narrative using a different model family than the Analyst chain.
- Output: `executiveSummary`, `decisionImplication`, `dissent` (where the analysis may understate uncertainty).
- No access to critic flag details; reads only `ResolvedState` to maintain independence.

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
4. **Critic resolution:** unresolved critic flags `<= maxUnresolvedCriticFlags`
5. **Red-team severity:** no unresolved `severity=high` flag without an explicit analyst mitigation note

Any failure in strict mode → abort with `run_aborted_strict_quality`.

---

## Quality gates and abort criteria

Abort in strict mode when any condition makes decision-grade output unattainable:
- unrecoverable parse failures
- catastrophic post-recovery coverage shortfall
- unresolved critical evidence minimums
- route/model preflight mismatch
- token/timeout retry exhaustion on a required stage

Expected UX behavior on abort:
- show failure popup with primary `reasonCode` and a plain-language explanation
- offer `Download Debug Log` action immediately
- preserve full run state and diagnostics for troubleshooting

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

1. Preserve old export/import JSON via an adapter layer.
2. Store `artifactVersion` and `pipelineVersion` in every artifact.
3. Migration transforms:
   - legacy phase names → canonical stage ids
   - legacy evidence fields → canonical `SourceRef / ArgumentRef`
   - legacy flags → `CriticFlag`

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
    unitId:               string; // dimensionId (scorecard) or attributeId / cellKey (matrix)
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
  unitKey:            string; // dimensionId  OR  subjectId::attributeId
  flagged:            boolean;
  note:               string;
  suggestedScore?:    number;
  suggestedValue?:    string;
  suggestedConfidence?: Confidence;
  sources?:           SourceRef[];
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
