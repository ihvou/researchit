# Manual Benchmark: Researchit vs Mainstream Deep Research (v1)

## Purpose

Side-by-side comparison of Researchit (Native and Deep Assist) against ChatGPT Deep Research, Claude Research, and Gemini Deep Research on identical prompts. Goal: identify where Researchit wins, where it loses, and what to fix.

## Test Cases

Pick **3 cases minimum** — one per research type, covering different difficulty levels.

### Case 1: Matrix — Competitive Comparison (medium difficulty)

**Prompt:**
> Compare Cursor, Windsurf, and GitHub Copilot as AI-powered code editors for a 15-person startup engineering team shipping a SaaS product. We need strong multi-file context, fast iteration speed, and reasonable cost.

**Research type:** Competitors Comparison (matrix)

**Why this case:** Well-known products with public data, multiple comparison dimensions, recent market movement (Windsurf acquisition, Copilot updates). Tests whether the pipeline can find current evidence and avoid stale claims.

**Decision context (for Researchit setup):** "Choosing our primary AI code editor for the engineering team. Budget is secondary to productivity impact. Need to decide within 2 weeks."

### Case 2: Scorecard — Strategic Assessment (hard difficulty)

**Prompt:**
> Evaluate the viability of building an AI-powered clinical trial matching platform for mid-size oncology CROs (50-200 employees) in the US market.

**Research type:** ICP / Persona or a custom scorecard config that covers market, tech feasibility, competition, regulatory, go-to-market

**Why this case:** Niche domain (oncology CRO), regulatory complexity, limited public evidence. Tests retrieval depth in hard verticals and whether confidence calibration correctly flags evidence gaps instead of hallucinating.

**Decision context:** "Evaluating whether to invest 6 months of engineering in this product direction. Need to understand market size, regulatory risk, and competitive moat before committing."

### Case 3: Matrix — Emerging Technology (very hard difficulty)

**Prompt:**
> Compare leading approaches to AI agent memory systems: RAG-based, graph-based (knowledge graphs), hybrid RAG+graph, and pure long-context window reliance. Evaluate for a production conversational AI assistant handling complex multi-session customer support.

**Research type:** Competitors Comparison (matrix) or custom matrix

**Why this case:** Cutting-edge topic with thin public evidence, rapid change, conflicting vendor claims. Tests whether the pipeline degrades gracefully and avoids confident-sounding nonsense.

**Decision context:** "Architecting the memory layer for our AI customer support agent. Need to choose an approach before sprint planning next month. Production scale is 50K conversations/day."

## What to Run

For each test case, run **5 variants**:

| # | System | Mode | What to capture |
|---|--------|------|-----------------|
| 1 | **Researchit Native** | Scorecard or Matrix | Full export (JSON + HTML/PDF) |
| 2 | **Researchit Deep Assist** | Same research type | Full export (JSON + HTML/PDF) |
| 3 | **ChatGPT Deep Research** | Same prompt (verbatim) | Copy full output + sources list |
| 4 | **Claude Research** | Same prompt (verbatim) | Copy full output + sources list |
| 5 | **Gemini Deep Research** | Same prompt (verbatim) | Copy full output + sources list |

For mainstream deep research tools, use the exact same prompt text. Do **not** add the decision context or role — that's part of Researchit's advantage and should show in results.

### Tips for mainstream tools

- ChatGPT: Use "Deep Research" mode (available in Plus/Pro)
- Claude: Use the research feature (web search enabled)
- Gemini: Use "Deep Research" in Gemini Advanced
- Save the full output as-is — don't edit or truncate

## Scoring Rubric

Score each output 1-5 on these 7 dimensions. Integer scores only.

### 1. Factual Accuracy (weight: 25%)
- **5:** All claims are verifiable, no hallucinated facts, numbers match real sources
- **4:** Minor inaccuracies that don't change conclusions
- **3:** Some unverifiable claims but core narrative is sound
- **2:** Multiple factual errors or unverifiable assertions presented as fact
- **1:** Significant hallucination or fabricated evidence

### 2. Source Quality (weight: 20%)
- **5:** Named sources with URLs, independent/press sources dominate, quotes are verifiable
- **4:** Good source mix but some vendor-heavy or URL-less citations
- **3:** Sources exist but mostly vendor blogs or unverifiable
- **2:** Few sources, mostly self-referential or generic
- **1:** No meaningful sourcing or fabricated URLs

### 3. Evidence Depth (weight: 15%)
- **5:** Specific deployments, named companies, concrete metrics, multiple independent data points per claim
- **4:** Good evidence but some dimensions rely on single data points
- **3:** Surface-level evidence, few specifics, mostly general market knowledge
- **2:** Thin evidence dressed up with confident language
- **1:** No real evidence, just opinions or common knowledge restated

### 4. Decision Utility (weight: 15%)
- **5:** Output directly answers the decision question with clear trade-offs, risks, and actionable implications
- **4:** Useful for decision-making but requires reader interpretation
- **3:** Informative but doesn't connect to the actual decision
- **2:** Generic analysis that could apply to any similar question
- **1:** No decision relevance

### 5. Contradiction & Uncertainty Handling (weight: 10%)
- **5:** Contradictions between sources are explicitly surfaced, uncertainty is clearly marked, confidence tracks evidence strength
- **4:** Some uncertainty noted but not systematically
- **3:** Uncertainty is implicit or inconsistent
- **2:** Contradictions ignored, false confidence on weak evidence
- **1:** Confidently wrong or contradictions actively hidden

### 6. Structure & Completeness (weight: 10%)
- **5:** Every dimension/cell is covered, consistent format, no gaps, scannable and deep
- **4:** Minor coverage gaps or inconsistent depth across sections
- **3:** Some dimensions thin or missing, uneven structure
- **2:** Significant gaps or disorganized output
- **1:** Incomplete or unusable structure

### 7. Recency & Relevance (weight: 5%)
- **5:** Evidence is current (last 12 months), market context reflects latest developments
- **4:** Mostly current with minor stale references
- **3:** Mix of current and outdated evidence
- **2:** Predominantly stale evidence
- **1:** Outdated analysis that misses major recent changes

## Scoring Sheet Template

Copy this for each test case:

```
Test Case: [1/2/3]
Prompt: [first 50 chars...]
Date: [YYYY-MM-DD]

                        | Accuracy | Sources | Depth | Decision | Contradiction | Structure | Recency | Weighted |
                        | (25%)    | (20%)   | (15%) | (15%)    | (10%)         | (10%)     | (5%)    | Total    |
Researchit Native       |          |         |       |          |               |           |         |          |
Researchit Deep Assist  |          |         |       |          |               |           |         |          |
ChatGPT Deep Research   |          |         |       |          |               |           |         |          |
Claude Research         |          |         |       |          |               |           |         |          |
Gemini Deep Research    |          |         |       |          |               |           |         |          |

Notes:
- Winner(s):
- Biggest Researchit advantage:
- Biggest Researchit gap:
- Specific fix ideas:
```

Weighted total formula: `(Accuracy * 0.25) + (Sources * 0.20) + (Depth * 0.15) + (Decision * 0.15) + (Contradiction * 0.10) + (Structure * 0.10) + (Recency * 0.05)`

## What to Upload for Review

For each test case, share with Claude:
1. Researchit Native export (JSON preferred, HTML/PDF also fine)
2. Researchit Deep Assist export
3. ChatGPT output (copy-paste or screenshot)
4. Claude Research output (copy-paste or screenshot)
5. Gemini output (copy-paste or screenshot)
6. Your filled scoring sheet (even partial — we can co-score)

## Expected Outcomes

Based on current implementation state:

**Where Researchit Native should win:**
- Structure & Completeness (structured matrix/scorecard vs prose)
- Contradiction & Uncertainty Handling (confidence calibration, polarity guards, critic monitoring)
- Decision Utility (decision context injection, executive synthesis)

**Where Researchit Native might lose:**
- Evidence Depth on hard topics (single web_search pass vs deep research's extended browsing)
- Recency on fast-moving topics (web_search snippet quality varies)
- Source Quality when retrieval returns thin results for niche domains

**Where Deep Assist should win over Native:**
- Evidence Depth (3 providers searching independently)
- Source Quality (more sources, cross-validated)
- Factual Accuracy (provider agreement catches hallucination)

**Where Deep Assist might still lose vs mainstream:**
- DA-02 (quality recovery loop) is not implemented yet — thin/contradictory cells aren't retried
- DA-03 (safety guardrails) is not implemented — no per-step timeouts
- The merge is "pick best provider per cell" — not a true synthesis of all 3

## After Scoring

Use results to:
1. Validate or adjust priorities in TASKS.md
2. Identify if RQ-02 (Red Team) or RQ-05 (Counterfactual Evidence) would have changed outcomes
3. Decide whether Deep Assist merge strategy needs rework before DA-02
4. Feed specific weak cases into FR-02 benchmark suite when it's built
