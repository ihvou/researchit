# Deep Assist — Evidence Mode Specification

## 1. What This Is

Deep Assist is an alternative evidence collection mode for the ResearchIt engine. Instead of the engine's internal web_search-based retrieval (the **Native** pipeline), Deep Assist sends structured prompts to external deep research APIs (Claude, ChatGPT, Gemini), merges the returned evidence, and feeds it into the engine's existing critic → scoring → verification → synthesis layers.

**This is not a new pipeline.** It is a new evidence source that plugs into the existing pipelines. The matrix and scorecard pipelines gain a new "front end" for evidence collection while keeping their existing "back end" for validation and output.

---

## 2. Why

The fundamental limitation of Native mode is that `web_search` returns short snippets, not full-page content. Deep research APIs from Claude, ChatGPT, and Gemini spend minutes reading full pages, following links, and synthesizing across documents. No amount of internal pipeline complexity can close that evidence quality gap within the snippet constraint.

**Native mode remains valuable** for: quick exploration, iterative config testing, cost-sensitive runs, and cases where speed matters more than depth. Deep Assist is for final deliverables and decision-grade output.

---

## 3. Architecture: Evidence Mode as Runtime Parameter

### 3.1 Config vs. Runtime

The ResearchConfig defines **what** to research (subjects, attributes, dimensions, prompts, scoring criteria). The output mode defines **what shape** the result takes (matrix vs. scorecard). The evidence mode defines **how** the engine collects evidence — this is a **runtime user choice**, not a config property.

```js
// Engine API — evidence mode is a runtime option, not config
runAnalysis(input, config, callbacks, {
  evidenceMode: "native",       // default: current pipeline
  // OR
  evidenceMode: "deep-assist",  // new: external deep research APIs
})

runMatrixAnalysis(input, config, callbacks, {
  evidenceMode: "native" | "deep-assist",
})
```

The same competitor-analysis config works identically with either mode. The user picks based on their need at launch time.

### 3.2 UI Surface

At research launch, the user sees a toggle or selector:

```
Evidence Mode:
  ○ Quick (Native)     — Fast, ~30s-2min, lower cost
  ● Deep Assist        — Thorough, ~3-8min, higher cost, decision-grade
```

The selection is passed through to the engine as a runtime option. No config changes required.

### 3.3 Engine Architecture

```
                    ┌─────────────────────────────────┐
                    │        ResearchConfig            │
                    │  (what to research, how to score) │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │      Evidence Collection         │
                    │                                  │
                    │  ┌──────────┐  ┌──────────────┐  │
                    │  │  Native  │  │ Deep Assist   │  │
                    │  │ web_search│  │ Claude/GPT/  │  │
                    │  │ snippets │  │ Gemini APIs   │  │
                    │  └────┬─────┘  └──────┬───────┘  │
                    │       │               │          │
                    │       └───────┬───────┘          │
                    │               │                  │
                    │    Unified Evidence Bundle        │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │     Shared Pipeline Phases        │
                    │                                  │
                    │  Critic Validation                │
                    │  Cross-Subject/Dimension Check    │
                    │  Source Verification              │
                    │  Confidence Calibration           │
                    │  Scoring (scorecard) / Structuring│
                    │  Synthesis                        │
                    │  Discovery                        │
                    └──────────────────────────────────┘
```

**Key principle:** Evidence collection is the only thing that differs. Everything downstream is shared code.

---

## 4. Deep Assist Evidence Collection

### 4.1 Matrix Mode

For a matrix research with N subjects and M attributes:

**Step 1: Per-Subject Deep Research (parallel)**

For each subject, send a structured prompt to 1-3 deep research providers:

```
Research [subject] as a [category] solution.
For each of the following attributes, provide:
- Specific factual data points with dates
- Named sources with URLs
- Confidence assessment (what you found vs. what you inferred)
- Explicit gaps (what you could not find)

Attributes:
1. [attribute_1.label]: [attribute_1.brief]
2. [attribute_2.label]: [attribute_2.brief]
...

Context: [user's research prompt / decision question]

Output structure: One section per attribute with labeled subsections for data, sources, confidence, and gaps.
```

This produces N × P evidence documents (N subjects × P providers).

**Step 2: Evidence Structuring**

Map the prose evidence documents into the matrix cell structure:

```js
// Per cell: merged evidence from all providers
{
  subjectId: "vendor-a",
  attributeId: "pricing",
  evidence: [
    { provider: "claude", text: "...", sources: [...], confidence: "high" },
    { provider: "chatgpt", text: "...", sources: [...], confidence: "medium" },
  ],
  providerAgreement: "agree" | "partial" | "contradict",
  mergedSources: [...],  // deduplicated across providers
  gaps: [...]            // attributes no provider could fill
}
```

The structuring step is an LLM call that takes the raw prose outputs and maps them into the cell schema. This is a structured extraction task, not a research task.

**Step 3: Hand off to shared pipeline** (critic → consistency → verification → scoring → synthesis)

### 4.2 Scorecard Mode

For a scorecard research with D dimensions:

**Step 1: Dimension-Clustered Deep Research (parallel)**

Group dimensions into 2-4 thematic clusters to avoid overwhelming a single prompt. For each cluster, send to 1-3 providers:

```
Research [topic] with focus on the following evaluation dimensions:

1. [dimension.label]: [dimension.fullDef]
   Look for: [dimension.researchHints.whereToLook]
2. [dimension.label]: [dimension.fullDef]
   ...

For each dimension provide:
- Specific evidence with named sources and URLs
- Quantitative data points where available
- Counterevidence or risk factors
- Confidence in your findings

Context: [user's research prompt + framing fields]
```

**Step 2: Evidence Structuring**

Map prose into per-dimension evidence bundles:

```js
{
  dimensionId: "problem-severity",
  evidence: [
    { provider: "claude", text: "...", sources: [...] },
    { provider: "gemini", text: "...", sources: [...] },
  ],
  providerAgreement: "agree" | "partial" | "contradict",
  mergedSources: [...],
}
```

**Step 3: Hand off to shared pipeline** (critic → response → consistency → verification → scoring → discovery)

---

## 5. Provider Adapters

### 5.1 Adapter Interface

Each deep research provider needs an adapter that conforms to:

```js
// engine/providers/deep-assist/adapter.js

/**
 * @typedef {Object} DeepResearchRequest
 * @property {string} prompt - The structured research prompt
 * @property {number} [maxWaitMs=300000] - Maximum wait time (deep research can take minutes)
 * @property {string} [model] - Provider-specific model override
 */

/**
 * @typedef {Object} DeepResearchResponse
 * @property {string} provider - Provider name
 * @property {string} text - Full prose response
 * @property {Array<{name: string, url: string, quote?: string}>} sources - Extracted sources
 * @property {number} durationMs - How long the research took
 * @property {Object} [meta] - Provider-specific metadata (tokens used, searches performed, etc.)
 */

// Adapter contract
{
  name: "claude" | "chatgpt" | "gemini",
  available: async () => boolean,     // Can we use this provider right now?
  research: async (request) => DeepResearchResponse,
}
```

### 5.2 Provider Implementation Notes

**OpenAI (ChatGPT Deep Research)**
- Uses the Responses API with `web_search_preview` tool and extended thinking
- Model: likely `gpt-5.4` or dedicated deep research model
- Returns structured output with citations
- Expected latency: 1-5 minutes
- Cost: higher per-call but produces comprehensive evidence

**Anthropic (Claude Extended Research)**
- Uses Claude API with `web_search` tool and extended thinking enabled
- Model: `claude-sonnet-4-20250514` or later with research capabilities
- Returns prose with inline citations
- Expected latency: 1-5 minutes

**Google (Gemini Deep Research)**
- Uses Gemini API with grounding/search capabilities
- Model: `gemini-2.5-pro` or dedicated deep research model
- Returns structured sections with grounding metadata
- Expected latency: 1-3 minutes

### 5.3 Provider Selection and Fallback

```js
// Runtime options
{
  evidenceMode: "deep-assist",
  deepAssist: {
    providers: ["claude", "chatgpt", "gemini"],  // default: all available
    minProviders: 1,      // minimum providers that must succeed
    maxWaitMs: 300000,    // 5 minute timeout per provider
  }
}
```

- All configured providers are called in parallel per subject/dimension cluster
- If a provider fails or times out, the run continues with remaining providers
- If fewer than `minProviders` succeed, the subject/cluster is marked as degraded
- Provider availability is checked before launching (API key present, rate limit OK)

### 5.4 Transport Integration

Deep Assist adapters are injected through the same dependency injection pattern as existing transport:

```js
// Extended transport contract
createTransport(callFn, {
  deepResearch: {
    claude: adapter,
    chatgpt: adapter,
    gemini: adapter,
  }
})
```

The engine never directly imports provider SDKs. The app provides adapter implementations via the transport layer, keeping the engine host-agnostic.

---

## 6. Evidence Merge Algorithm

When multiple providers return evidence for the same cell/dimension:

### 6.1 Source Deduplication

```
1. Normalize URLs (strip tracking params, trailing slashes, www prefix)
2. Group sources by normalized URL
3. Per URL: keep the richest quote/snippet across providers
4. Score each source: independent > analyst report > news > vendor marketing
5. Tag source with which providers cited it (agreement signal)
```

### 6.2 Claim Merge

```
1. Extract distinct claims per cell from each provider's evidence
2. Classify: agreed (2+ providers), single-source, contradicted
3. Agreed claims → high base confidence
4. Single-source claims → medium base confidence, flag for critic
5. Contradicted claims → low confidence, explicit flag with both positions
```

### 6.3 Cell Population

```js
// After merge, each cell contains:
{
  summary: "Merged narrative from all providers",
  claims: [
    { text: "...", agreement: "agreed|single|contradicted", providers: [...] }
  ],
  sources: [...],  // deduplicated, scored
  confidence: "high|medium|low",  // derived from agreement + source quality
  gaps: [...],     // what no provider could fill
  flags: [...],    // contradictions, single-source claims, etc.
}
```

---

## 7. What Changes in Existing Pipeline Phases

### 7.1 Phases Replaced by Deep Assist (Matrix)

| Current Phase | Deep Assist Equivalent |
|--------------|----------------------|
| Baseline matrix pass (memory-only) | Deep Research per subject (replaces) |
| Web matrix pass (web_search) | Deep Research per subject (replaces) |
| Reconcile (merge baseline + web) | Evidence Merge (replaces) |
| Low-confidence recovery | Not needed — deep research rarely leaves empty cells |

### 7.2 Phases Replaced by Deep Assist (Scorecard)

| Current Phase | Deep Assist Equivalent |
|--------------|----------------------|
| Analyst baseline (memory-only) | Deep Research per dimension cluster (replaces) |
| Analyst web pass (web_search) | Deep Research per dimension cluster (replaces) |
| Reconcile (merge passes) | Evidence Merge (replaces) |
| Low-confidence cycle | Not needed in most cases; optional fallback |

### 7.3 Phases That Stay Unchanged

These run identically regardless of evidence mode:

- **Critic validation** — reviews evidence quality, flags weak cells
- **Cross-subject consistency** (MX-04) — checks contradictions across subjects
- **Cross-dimension coherence** (RA-10) — checks logical consistency
- **Source verification** — fetches cited URLs, confirms claims
- **Confidence calibration** — computes from measurable signals
- **Scoring** (scorecard) — applies rubric to verified evidence
- **Response formatting** — structures output per config
- **Discovery generation** — suggests adjacent opportunities

### 7.4 Phases That Gain Quality with Deep Assist

- **Critic** — has richer evidence to audit, can be more specific in challenges
- **Source verification** — more diverse URLs to verify, higher success rate
- **Confidence calibration** — provider agreement is an additional signal
- **Synthesis** — more complete evidence produces better executive summaries

---

## 8. Cost Model

### 8.1 Per-Run Estimates

**Matrix (5 subjects, 8 attributes):**

| Component | Native | Deep Assist (3 providers) | Deep Assist (1 provider) |
|-----------|--------|--------------------------|--------------------------|
| Evidence collection | $0.50-3.00 (10-20 calls) | $5.00-15.00 (15 calls) | $1.50-5.00 (5 calls) |
| Evidence structuring | included | $0.10-0.30 (1 call) | $0.10-0.30 (1 call) |
| Critic + validation | $0.20-0.80 (3-5 calls) | $0.20-0.80 (3-5 calls) | $0.20-0.80 (3-5 calls) |
| Source verification | ~$0 (HTTP fetches) | ~$0 (HTTP fetches) | ~$0 (HTTP fetches) |
| Synthesis | $0.05-0.15 (1 call) | $0.05-0.15 (1 call) | $0.05-0.15 (1 call) |
| **Total** | **$0.75-4.00** | **$5.35-16.25** | **$1.85-6.25** |
| **Quality** | Exploration-grade | Decision-grade | Good |

**Scorecard (10 dimensions):**

| Component | Native | Deep Assist (3 providers) | Deep Assist (1 provider) |
|-----------|--------|--------------------------|--------------------------|
| Evidence collection | $0.50-2.50 (12-18 calls) | $3.00-9.00 (9 calls) | $1.00-3.00 (3 calls) |
| Evidence structuring | included | $0.10-0.30 (1 call) | $0.10-0.30 (1 call) |
| Critic + validation | $0.20-0.60 (3-4 calls) | $0.20-0.60 (3-4 calls) | $0.20-0.60 (3-4 calls) |
| **Total** | **$0.70-3.10** | **$3.30-9.90** | **$1.30-3.90** |

### 8.2 Cost Controls

- Default to 1 provider (cheapest) — user can opt into multi-provider
- Show estimated cost before launch: "This run will use ~5 deep research calls across 2 providers. Estimated cost: $3-8."
- Provider selection per run (e.g., "use only Claude for this run")

---

## 9. Latency and Progress

### 9.1 Expected Latency

| Mode | Evidence Phase | Total (with critic + verification) |
|------|---------------|-----------------------------------|
| Native | 30s-90s | 60s-180s |
| Deep Assist (1 provider, parallel) | 60s-300s | 90s-360s |
| Deep Assist (3 providers, parallel) | 60s-300s (same — parallel) | 90s-360s |

Deep Assist evidence collection runs in parallel per subject/cluster, so adding providers does not add latency — it adds cost.

### 9.2 Progress Reporting

Deep research calls take minutes. The progress callback must surface meaningful status:

```js
onProgress("deep_assist_evidence", {
  status: "collecting",
  subjects: [
    { id: "vendor-a", providers: { claude: "complete", chatgpt: "running", gemini: "running" } },
    { id: "vendor-b", providers: { claude: "running", chatgpt: "complete", gemini: "failed" } },
    ...
  ],
  completedCells: 24,
  totalCells: 40,
})
```

UI shows per-subject, per-provider progress with real-time status updates.

---

## 10. Prompt Engineering: The Core IP

With Deep Assist, prompt quality for the deep research calls becomes the primary determinant of output quality. These prompts are ResearchIt's core intellectual property.

### 10.1 Prompt Template Structure

Each prompt must:
1. **Set the research scope** — what exactly to investigate, with boundaries
2. **Define output structure** — sections per attribute/dimension, required subsections
3. **Require evidence standards** — named sources, URLs, dates, quantitative data
4. **Demand explicit gaps** — what could not be found, what was inferred vs. evidenced
5. **Inject config context** — the user's research prompt, framing fields, and any config-level hints

### 10.2 Per-Research-Type Prompt Customization

The prompt templates should be influenced by the ResearchConfig's existing fields:
- `dimensions[].fullDef` — rubric definitions guide what to look for
- `dimensions[].researchHints` — where to look, query templates
- `dimensions[].polarityHint` — what direction is "good"
- `attributes[].brief` — what each matrix column should capture
- `prompts.analyst` — config-level system prompt overlay
- `methodology` — methodological framing to guide evidence standards

---

## 11. Implementation Plan

### Phase 1: Single-Provider Matrix (MVP)

1. Define `DeepResearchAdapter` interface in engine
2. Implement OpenAI adapter in app (using existing `callOpenAI` with extended parameters)
3. Add `evidenceMode` runtime option to `runMatrixAnalysis`
4. Build evidence structuring step (map prose → matrix cells)
5. Wire Deep Assist evidence into existing critic/verification flow
6. Add UI toggle for evidence mode selection
7. Add progress reporting for deep research phase

**Validates:** Does a single-provider deep research call produce meaningfully better matrix evidence than native web_search?

### Phase 2: Multi-Provider + Scorecard

1. Add Claude and Gemini adapters
2. Build evidence merge algorithm (dedup, agreement detection, contradiction flagging)
3. Extend `runAnalysis` (scorecard) with `evidenceMode` support
4. Add dimension clustering logic for scorecard prompts
5. Add provider agreement as a confidence signal in calibration engine

### Phase 3: Polish

1. Cost estimation before launch
2. Provider-level diagnostics in run output
3. Per-provider contribution tracking in `analysisMeta`
4. Graceful degradation when providers are unavailable

---

## 12. What This Does NOT Change

- **ResearchConfig contract** — no changes. Configs are evidence-mode-agnostic.
- **Output format** — same matrix/scorecard structure regardless of evidence source.
- **Follow-up pipeline** — follows up work against the stored evidence, regardless of how it was collected.
- **Export format** — same HTML/PDF/ZIP output.
- **Engine invariants** — engine still has zero host dependencies, zero direct API calls, all I/O through injected transport.

---

## 13. Open Questions

1. **Deep research API stability**: These APIs are new and pricing/availability may shift. How aggressively should we depend on specific provider features?
   → Mitigation: Adapter pattern means we can swap/add providers without pipeline changes.

2. **Evidence structuring quality**: Mapping long-form prose into cell-level evidence is a non-trivial extraction task. How reliable is LLM extraction here?
   → Mitigation: Start with single-provider MVP and measure cell fill rates before adding merge complexity.

3. **Provider-specific prompt tuning**: Each deep research API may respond better to different prompt styles. How much per-provider customization is needed?
   → Mitigation: Start with a single prompt template, measure per-provider evidence quality, tune as needed.

4. **Rate limits and quotas**: Deep research APIs may have aggressive rate limits. Can we run 5 parallel calls per provider?
   → Mitigation: Sequential fallback if parallel calls are rate-limited. Provider availability check before launch.

---

## 14. Things We Considered Beyond Deep Assist

Before finalizing this spec, we evaluated other improvement dimensions to ensure we are not missing higher-leverage changes:

### 14.1 Output Layer Improvements (Orthogonal to Evidence Mode)

These improvements apply regardless of evidence source and are tracked separately in TASKS.md:

- **Decision-grade synthesis** (RQ-22) — executive summary with uncertainty markers
- **Run diagnostics surface** (RQ-23) — coverage %, source quality, critic flag rates
- **Confidence calibration** (RQ-21) — signal-based instead of self-reported
- **Export enhancements** — methodology notes, evidence trail, confidence rationale in exports

### 14.2 Prompt Layer Improvements (Applies to Both Modes)

- Better rubric injection into analyst prompts (scorecard dimensions have rich `fullDef` text that could be utilized more aggressively)
- Config-level `researchHints` actually consumed in query generation (CF-02 + engine integration)
- Polarity-aware scoring prompts (RA-11)

### 14.3 Infrastructure Improvements (Applies to Both Modes)

- **Transport error recovery** (NEW-03) — retry, timeout, graceful degradation
- **Benchmark regression suite** (FR-02) — measure impact of every change
- **Empty cell diagnostics** (NEW-01) — understand why cells are empty before trying to fix it

### 14.4 What We Explicitly Chose NOT to Build

- **Hybrid mode** (native first → deep assist for gaps): More latency, similar cost, added complexity. Deep research APIs do not work well at the single-cell level — you would still need per-subject calls, making the cost savings negligible.
- **Domain adapters** (RQ-16): Cannot direct web_search to specific sources. Deep Assist providers handle domain-specific retrieval naturally.
- **Full-page content extraction in Native mode**: Would require building a headless browser infrastructure for page rendering, JS execution, paywall handling, etc. Deep Assist providers already do this.
