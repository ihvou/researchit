# Functional Spec: Research Config Extension & New Research Types

---

## Part 1: ResearchConfig Parameter Updates

### New Parameters

**`outputMode: "scorecard" | "matrix"`**

Controls the fundamental output structure of a research run.

- `scorecard` — the existing mode. One research subject, N dimensions each scored 1-5 with evidence, confidence, and Critic challenge. Produces a weighted overall score. All current configs use this mode.
- `matrix` — new mode. User supplies a list of subjects at run time (competitors, personas, channels, etc.). The engine researches each subject across a fixed set of attributes defined in the config. No dimension scoring, no weighted total. Critic flags cells where evidence is thin or contested.

When `outputMode` is `matrix`, the following existing config fields become irrelevant and should be ignored by the engine: `dimensions[].weight`, `dimensions[].fullDef` rubric anchors (1-5 scale), overall scoring logic, confidence-weighted score calculation. The fields `dimensions[].label` and `dimensions[].brief` are repurposed as attribute label and description.

---

**`matrixLayout: "subjects-as-rows" | "subjects-as-columns" | "auto"`**

Only relevant when `outputMode` is `matrix`. Controls the default rendering orientation.

- `subjects-as-rows` — each subject occupies a row, attributes are column headers. Better when there are 5+ subjects and 4-6 attributes. Classic comparison table.
- `subjects-as-columns` — each subject occupies a column, attributes are row headers. Better when there are 2-4 subjects with 6+ attributes. Better for reading one subject in depth.
- `auto` (default) — engine decides based on count: if subjects ≤ 4, use `subjects-as-columns`; if subjects ≥ 5, use `subjects-as-rows`. User can override in the UI at any time without re-running.

---

**`subjects` field (matrix mode only)**

A new top-level field defining how the user should supply subjects at run time.

```
subjects: {
  label: string            // e.g. "Competitors", "Customer Segments", "Channels"
  inputPrompt: string      // shown to user: "List the competitors to analyze"
  examples: string[]       // shown as placeholder examples in the input
  minCount: number         // minimum required (usually 2)
  maxCount: number         // maximum allowed (usually 8)
}
```

This field is absent in scorecard configs. In matrix configs it is required. The user populates it before running — the engine uses the supplied list as the subject axis.

---

**`relatedDiscovery` behavior in matrix mode**

In matrix mode, `relatedDiscovery` if `true` produces a different output than in scorecard mode. Instead of suggesting adjacent research questions, it suggests:
- Additional subjects the user may have missed (e.g. competitors they didn't list)
- Additional attributes worth adding to the matrix for completeness

This is purely additive — it does not re-run the matrix.

---

### Research Logic Changes Based on outputMode

**Scorecard mode — no changes.** Existing pipeline runs as-is.

**Matrix mode — new pipeline behavior:**

1. **Input phase:** User provides research question + list of subjects. Config provides attribute definitions. Engine constructs an N×M research plan.

2. **Evidence collection:** For each subject, the engine runs a focused evidence pass across all attributes. Web search queries are constructed per (subject, attribute) pair using the attribute's `brief` as the search intent. Unlike scorecard mode, there are no rubric levels to score against — the goal is factual evidence retrieval per cell.

3. **No scoring phase:** Matrix mode skips the Phase 1 scoring step entirely. There are no 1-5 scores, no weights, no weighted total.

4. **Confidence per cell:** Each cell carries a confidence indicator (high/medium/low) based on source quality and evidence volume, same calibration logic as scorecard mode. Low confidence cells are flagged visually.

5. **Critic pass:** Critic reviews each cell for: overconfident claims, missing important context, internally inconsistent evidence, and cells that contradict each other within the same subject row/column. Critic does not challenge scoring because there is no scoring.

6. **Summary row/column:** At the end of the matrix, the engine generates a brief editorial summary per subject (1-2 sentences) and a cross-matrix observation block (key patterns, gaps, and surprises across all subjects). This replaces the overall score and analyst summary from scorecard mode.

7. **No consistency audit phase:** The phase that checks cross-dimension score consistency does not apply and is skipped.

8. **Related discovery:** If enabled, runs after the matrix is complete and appends a separate block suggesting missed subjects or attributes.

---

## Part 2: Migration of Existing Configs

All six existing configs use `outputMode: "scorecard"`. Migration is additive — no existing behavior changes.

Add the following to each existing config:

```javascript
outputMode: "scorecard",
matrixLayout: null,   // not applicable, set to null
subjects: null,       // not applicable, set to null
```

No dimension definitions, weights, rubrics, prompts, or model configs change. No re-testing required for existing configs. The engine treats absence of `outputMode` as `"scorecard"` for backward compatibility during any transition period.

---

## Part 3: New Research Type Configs

---

### Config 1: Market Sizing (TAM/SAM/SOM)

**outputMode:** `scorecard`
**relatedDiscovery:** `true`

**Methodological foundation:**
Grounded in bottom-up market sizing methodology as documented in Sequoia's market sizing guidance and a16z's market analysis frameworks, which both emphasize segment-specific evidence over top-down industry reports. <br>Dimensions reflect the six questions that distinguish a credible market size case from an inflated one, drawing on Bill Gurley's "market size" framework and the standard bottom-up / top-down triangulation approach described in Y Combinator's startup curriculum. Weight follows decision irreversibility: the dimensions that catch false positives on market scale carry higher weight than those that refine the story.

**Most commonly misjudged:** Market Definition Clarity (founders define markets too broadly to avoid confronting small numbers) and Reachability (founders assume distribution before proving it).

**Dimensions:**

| Dimension | Weight | What it scores |
|-----------|--------|---------------|
| Demand Evidence Quality | 22% | How well-evidenced is actual buyer demand — behavioral signals (spending, workarounds, search intent, job postings) rather than stated interest |
| Market Definition Clarity | 18% | How precisely the target segment is defined: role, company type, geography, trigger condition. "SMBs" = 1. "B2B SaaS 20-200 employees in DACH, CTO as buyer" = 5 |
| Size Estimation Methodology | 18% | Whether the case is built bottom-up from unit economics, or relies solely on top-down industry reports. Bottom-up with stated assumptions = higher score |
| Growth Trajectory | 12% | Whether the market is expanding, flat, or contracting — with credible evidence. Tailwinds from technology shift, regulation, or demographic change |
| Reachability | 18% | Whether the founder can actually reach this market given current GTM, budget, channel access, and competitive positioning. Large but unreachable market = low score |
| Competitive Density | 12% | How many well-funded alternatives are competing for the same budget and attention. Relevant to whether SOM assumptions are realistic |

**Rubric calibration principle:** Dimensions score the quality and defensibility of the evidence, not the absolute size of the numbers. A $3M local market with rigorous bottom-up evidence scores higher than a "$50B global TAM" claimed from a single analyst report. The estimated TAM/SAM/SOM figures appear as metadata on the research question, not as scored dimensions.

**Suggested next research type:** Competitive Landscape, Idea Validation

---

### Config 2: ICP / Customer Persona

**outputMode:** `matrix`
**matrixLayout:** `subjects-as-columns`
**relatedDiscovery:** `true`

**subjects:**
```
label: "Customer Segments"
inputPrompt: "Describe 2-4 distinct customer segments or personas you want to profile"
examples: ["Early-stage SaaS founders", "Enterprise IT Directors", "Bootstrapped agency owners"]
minCount: 2
maxCount: 4
```

**Methodological foundation:**
Grounded in the Jobs to Be Done framework (Christensen, Ulwick) for structuring pain points around the job the customer is trying to get done, not demographics. Attribute selection draws on Marty Cagan's customer discovery approach in *Empowered* and *Inspired* — specifically the emphasis on decision triggers, workarounds, and willingness to pay as the three dimensions that separate real demand from polite interest. The ICP vs Buyer Persona distinction follows the framework popularized by OpenView Partners and widely adopted in B2B SaaS go-to-market practice: ICP defines the account, persona defines the individual within it. Both levels are captured per profile.

**Attributes (columns):**

| Attribute | Description |
|-----------|-------------|
| Company / Context | Company type, size, stage, industry, and operating model that characterizes this segment |
| Buyer Role | The specific role(s) that make the purchase decision and the role(s) that use the product daily |
| Core Pain | The specific problem this segment experiences — described in behavioral terms, not categories |
| Current Workarounds | What they do today instead of buying your product — the clearest signal of problem reality |
| Decision Trigger | The specific event or threshold that moves them from tolerating the problem to actively seeking a solution |
| Willingness to Pay | Evidence-based estimate of price range, pricing model preference, and procurement process |
| Acquisition Channels | Where this persona is reachable — communities, publications, events, search intent, outbound |
| Editorial Priority | AI-generated directional signal: which segment represents the best initial wedge and why |

**Critic behavior:** Flags persona descriptions built on assumptions rather than behavioral evidence. Specifically challenges "Decision Trigger" and "Willingness to Pay" cells where claims are asserted without proxy signals.

**Suggested next research type:** Channel / GTM Analysis, Competitive Landscape

---

### Config 3: Competitive Landscape

**outputMode:** `matrix`
**matrixLayout:** `auto`
**relatedDiscovery:** `false`

**subjects:**
```
label: "Competitors"
inputPrompt: "List the competitors to analyze — direct and indirect"
examples: ["Notion", "Coda", "Confluence", "Linear"]
minCount: 2
maxCount: 8
```

**Methodological foundation:**
Attribute selection draws on Hamilton Helmer's *7 Powers* for the moat and defensibility attributes, McKinsey's granular competitive advantage framework for customer choice drivers, and the Jobs to Be Done lens for positioning. The matrix deliberately excludes feature checklists — following the practitioner guidance from ProductPlan and Marty Cagan that feature parity analysis misses what actually drives customer choice. The Critic is specifically instructed to challenge "incumbent looks outdated therefore incumbent is weak" — the most common error in competitive analysis.

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| Target ICP | Who they actually sell to — role, company type, segment. Not their stated positioning |
| Core Positioning | The primary value claim and the job it addresses |
| Pricing Model | Pricing structure, tiers, and approx. price point. Free tier if any |
| Key Strengths | Durable advantages — distribution, data, switching costs, brand, ecosystem |
| Key Weaknesses | Structural gaps, common complaints in reviews, known failure modes |
| PMF Signal | Evidence of product-market fit — growth rate, review sentiment, funding, press coverage |
| Gaps / Opportunities | Where this competitor underserves its users or leaves segments unaddressed |
| Moat Assessment | How defensible is their current position if a well-funded competitor entered |

**Critic behavior:** Specifically challenges:
- Cells where "weakness" is inferred from outdated information
- "Gaps" that are described without evidence of user demand for the missing capability
- PMF signal cells that conflate funding with actual user adoption

**Suggested next research type:** Market Entry Analysis, Idea Validation

---

### Config 4: Channel / GTM Analysis — Scorecard

**outputMode:** `scorecard`
**relatedDiscovery:** `true`

**Methodological foundation:**
Dimensions draw on Brian Balfour's channel-product-market fit framework (the three-way fit between channel, product, and market that determines whether GTM can scale), Andrew Chen's cold start problem framework for distribution moats, and the go-to-market motion taxonomy from OpenView Partners (self-serve PLG, sales-led, partner-led, community-led). Weight follows decision cost: dimensions that determine whether the GTM is structurally viable carry more weight than those that refine execution.

**Use case:** answers "Is my overall GTM strategy sound?" — a go/no-go assessment of the proposed approach. Use this when you have a specific GTM hypothesis to pressure-test. Use the matrix version (Config 5) when you want to compare channels and have not yet committed to one.

**Dimensions:**

| Dimension | Weight | What it scores |
|-----------|--------|---------------|
| ICP-Channel Fit | 22% | Whether the target ICP actually inhabits and responds to the proposed channels — based on behavioral evidence, not assumption |
| Distribution Advantage | 20% | Whether the founder or company has any structural head-start in the proposed channel (existing audience, relationships, domain authority, community trust) |
| CAC Sustainability | 18% | Whether estimated customer acquisition cost is compatible with unit economics — LTV:CAC ratio implied by the channel mix |
| Channel-Product Fit | 15% | Whether the product's complexity, price point, and buying process match what the channel supports (e.g. high-touch enterprise sales vs. self-serve viral loop) |
| Competitive Channel Density | 13% | How crowded the proposed channels are with well-funded competitors targeting the same ICP |
| Time to First Signal | 12% | How quickly the proposed approach can generate meaningful data — weeks vs. quarters. Relevant to runway and iteration speed |

**Suggested next research type:** Channel / GTM Analysis (Matrix), Idea Validation

---

### Config 5: Channel / GTM Analysis — Matrix

**outputMode:** `matrix`
**matrixLayout:** `subjects-as-rows`
**relatedDiscovery:** `true`

**subjects:**
```
label: "Channels"
inputPrompt: "List the acquisition channels or GTM motions to compare"
examples: ["Product Hunt launch", "SEO / content", "LinkedIn outbound", "Community-led", "Paid social"]
minCount: 2
maxCount: 8
```

**Methodological foundation:**
Attribute selection draws on the same frameworks as Config 4 (Balfour, Chen, OpenView), applied at the per-channel level rather than the strategy level. The matrix answers "which channel should I prioritize?" rather than "is my GTM sound?" The Critic is specifically instructed to challenge CAC estimates that assume reply rates or conversion rates better than current benchmarks, and to flag channels where the evidence of ICP presence is inferred from the channel's general audience rather than from the specific segment.

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| ICP Reach | Whether this channel contains the target ICP in meaningful density — evidence from competitor activity, audience data, or community research |
| Estimated CAC | Evidence-based CAC range for this channel in this segment. Stated as a range with reasoning, not a single number |
| Competitive Density | How many well-funded competitors are active in this channel targeting the same ICP |
| Founder Advantage | Whether this founder/team has any structural advantage in this channel — existing audience, relationships, content track record |
| Time to First Signal | How quickly this channel generates actionable data — days, weeks, or months |
| Channel-Product Fit | Whether the product's price, complexity, and buying process match what this channel supports |
| Verdict | AI-generated directional recommendation: prioritize, test small, or deprioritize — with one-sentence rationale |

**Critic behavior:** Specifically challenges:
- CAC estimates that assume above-benchmark conversion rates
- "Founder advantage" claims that are aspirational rather than demonstrated
- Verdict cells where the recommendation contradicts the evidence in other cells of the same row

**Suggested next research type:** Channel / GTM Analysis (Scorecard), ICP / Customer Persona

---

## Summary of all configs after this update

| Research Type | Mode | Layout | relatedDiscovery |
|--------------|------|--------|-----------------|
| Idea Validation | scorecard | — | true |
| Market Entry Analysis | scorecard | — | true |
| Competitive Landscape (original) | scorecard | — | false |
| Build vs. Buy | scorecard | — | true |
| Investment / M&A Screening | scorecard | — | true |
| Product Expansion | scorecard | — | true |
| **Market Sizing (TAM/SAM/SOM)** | scorecard | — | true |
| **ICP / Customer Persona** | matrix | subjects-as-columns | true |
| **Competitive Landscape (matrix)** | matrix | auto | false |
| **Channel / GTM — Scorecard** | scorecard | — | true |
| **Channel / GTM — Matrix** | matrix | subjects-as-rows | true |

The original Competitive Landscape scorecard config remains. Users who want a holistic narrative readout of a competitive situation use it. Users who want a per-competitor breakdown use the new matrix version. Both are valid, different questions.
