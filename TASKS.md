## Research Depth & Scoring Accuracy — Fixes and Improvements

Baseline: ~18 API calls per analysis run.

| ID | Type | Problem | Solution | Impact | Extra calls | Cost +% | Priority |
|----|------|---------|----------|--------|-------------|---------|----------|
| RA-01 | fix | Phase 3 analyst has no web search — told to "defend with NEW evidence" but can only use memory. Defense is hollow. | Pass `{ liveSearch: true, includeMeta: true }` to Phase 3 and consistency check `callAnalystAPI` calls (`useAnalysis.js:2359, 2441`). | Analyst can actually find new sources to defend scores. e.g. critic says "Mastercard claim is stale" → analyst can now search for fresh data instead of just restating Phase 1 text. | 0 | 0% | P0 |
| RA-02 | fix | Critic only sees first ~320 chars of analyst evidence per dimension. Specific metrics and named deployments in paragraphs 2-4 are invisible. | Increase `clip(dim.full, 320)` to `clip(dim.full, 800)` in `buildCriticPrompt` (`useAnalysis.js:452`). | Critic can actually audit real claims. e.g. if analyst cites "$50M savings" in paragraph 3, critic currently can't see it and never challenges it. | 0 | 0% | P0 |
| RA-03 | fix | Defense enforcement is one-sided — unsupported concessions are reverted but unsupported defenses are always accepted. | Require at least 1 new named source for defense in Phase 3 prompt. If none available, confidence must downgrade. | Debate becomes meaningful. e.g. analyst scores ROI 4/5, critic disagrees, analyst just restates "strong ROI" → now must cite a new source or admit lower confidence. | 0 | 0% | P0 |
| RA-04 | fix | Low-confidence fallback coverage: empty query string in findings marks ALL queries as "useful", masking search failures. | Change `!f.query \|\| f.query === q` to `f.query && f.query === q` in `normalizeLowConfidenceSearchHarvest` (`useAnalysis.js:633`). | Research briefs appear when search actually fails. e.g. 3 of 4 queries found nothing but system currently reports "all useful" → PM never sees the gap. | 0 | 0% | P1 |
| RA-05 | fix | Consistency check corrections get silently reverted by Phase 3 guard rails (guard sees adjustments as unsupported concessions). | Have `applyConsistencyAdjustments` write proper `revisionBasis` and `revisionJustification` fields so the guard accepts them (`useAnalysis.js:1192-1217, 2458-2462`). | Rubric-inconsistent scores actually get corrected. e.g. consistency audit catches inverted regulatory score → currently the fix is silently undone. | 0 | 0% | P1 |
| RA-06 | fix | Reconciliation merges baseline + web evidence without seeing confidence levels or missing-evidence gaps from either pass. | Add confidence, confidenceReason, missingEvidence to per-dimension snapshot in `buildHybridReconcileEvidencePrompt` (`useAnalysis.js:391-443`). | Merge favors the more confident pass. e.g. baseline says ROI=4 (high confidence) vs web says ROI=2 (low confidence) → reconciliation currently treats them equally. | 0 | 0% | P1 |
| RA-07 | fix | `absorbLowConfidenceMeta` double-counts web search calls into both main counter and targeted counter. | Remove `absorbAnalystMeta(analysisMeta, meta)` call from inside `absorbLowConfidenceMeta` (`useAnalysis.js:1593`). Track only in targeted fields. | Cost estimator FR will show correct totals. e.g. 3 targeted searches currently counted as 6 (3 main + 3 targeted). | 0 | 0% | P2 |
| RA-08 | improvement | Rubrics define anchors for scores 5/3/1 only. Models interpolate 2 and 4 inconsistently between runs. | Add Score 2/4 anchor text in `dimensions.js`. Update `buildRubricCalibrationBlock` in `rubric.js` to emit all 5 levels. | Same use case scored twice gets consistent results. e.g. "insurance claims AI" might get feasibility 3 one run and 4 the next — anchors reduce this variance. | 0 | 0% | P1 |
| RA-09 | improvement | Analyst cites vendor case studies (blog posts, product pages) as "verified" evidence. No second-source requirement. | Add SOURCE CREDIBILITY RULE to `buildPhase1EvidencePrompt`: classify each source as vendor/press/independent. Vendor-only evidence flagged in missingEvidence. | Inflated scores based on marketing claims get caught. e.g. "UiPath claims 80% cost reduction" treated as verified → now flagged as vendor-only, needs independent corroboration. | 0 | 0% | P1 |
| RA-10 | improvement | Contradictory score pairs go unchallenged (e.g. high evidence + low ROI, or high ai_fit + low feasibility). | Add cross-dimension coherence flags to `buildCriticPrompt` — 5 specific incoherent pairs the critic must flag. | Structurally impossible score combinations get caught. e.g. evidence=4 but roi=2 — strong evidence usually implies measurable financial outcomes. | 0 | 0% | P1 |
| RA-11 | improvement | regulatory, change_mgmt, build_vs_buy have counterintuitive polarity. Models invert them ~15% of runs. | Add explicit "do NOT" polarity warnings in Phase 3 and scoring prompts, supplementing existing `getPolarityHint()`. | Fewer wrong-direction scores. e.g. "healthcare is regulated" → model scores regulatory 1/5 (bad) when rubric says 1 = heavy burden, not "industry is regulated." | 0 | 0% | P1 |
| RA-12 | improvement | Confidence (high/medium/low) is tracked but has zero effect on weighted score. Low-confidence 4 counts same as high-confidence 4. | Add `calcConfidenceWeightedScore()` in `scoring.js` with discount: high=1.0, medium=0.85, low=0.65. Show both raw and adjusted scores. | Rankings reflect certainty. e.g. Use case A scores 72% (all high confidence) ranks above Use case B scoring 74% (3 dims low confidence → adjusted to 68%). | 0 | 0% | P1 |
| RA-13 | improvement | Low-confidence targeted search is single-pass. If initial queries are too broad, the whole cycle is wasted. | After rescore, if confidence still low AND <=1 useful query, generate refined queries avoiding failed ones. Cap at 1 refinement per dimension. | Weak dimensions get a second chance. e.g. "reusability" search returns generic results → refined query targets "cross-client AI template reuse case study" and finds evidence. | 3-9 | 15-50% | P2 |
| RA-14 | improvement | Critic identifies weak claims but can't verify specific facts. Debate stays reasoning-based, not evidence-based. | Add evidence verification sub-phase between Phase 2 and 3. Critic names 3-5 claims to verify → targeted web searches → VERIFIED/UNVERIFIED tags feed into Phase 3. | Score changes backed by fact-checked evidence. e.g. analyst claims "$50M fraud prevention savings" → verification search confirms via Mastercard earnings call → tagged VERIFIED. | ~6 | ~33% | P2 |
| RA-15 | improvement | Web search is all-or-nothing in Phase 1b. Model spends search budget on easy dimensions, starves hard ones. | Replace single Phase 1b call with 3 dimension-grouped calls (high/medium/low weight tiers). Each group gets dedicated search. | Every dimension gets minimum search coverage. e.g. market_size (low weight) currently gets 0 searches while roi gets 4 → now each tier gets dedicated queries. | +2 | ~11% | P2 |
| RA-16 | improvement | Discovery phase reuses SYS_ANALYST (scoring-focused) instead of a candidate-generation prompt. | Add dedicated SYS_DISCOVER to `system.js` optimized for generating strategic adjacent use cases. | Better discovery candidates. e.g. current discover outputs read like mini-analyses instead of actionable "try this narrower variant" suggestions. | 0 | 0% | P2 |

---

## [ ] FR - In-App Cost Estimator

**Problem**

PMs cannot see expected or actual analysis cost per use case directly in the app. Cost/quality trade-off discussions happen outside the product and are hard to validate against real run behavior (web-search calls, retries, low-confidence extra cycles, discovery validation passes).

**Solution**

Add an in-app cost estimator that uses run metadata (`analysisMeta`) plus configurable pricing inputs to calculate:
- estimated cost before run (based on expected pipeline steps),
- actual cost after run (based on real call counts and token usage proxies),
- incremental delta for optional modes/features (for example dual-search provider mode).

Expose this in a compact UI panel and in exports/debug logs with a clear breakdown by phase:
- analyst passes,
- critic pass,
- low-confidence targeted cycle,
- discovery + candidate validation,
- web-search tool-call costs.

---

## [ ] FR - Benchmark Regression Suite (Public Use Cases)

**Problem**

Prompt/model changes can silently degrade scoring quality. Without a fixed benchmark set, regressions are hard to detect early and quality checks rely on ad-hoc manual testing.

**Solution**

Add an automated benchmark suite with 10-20 publicly documented use cases (for example hospital readmission risk AI). For each benchmark case, store expected score ranges per dimension, confidence expectations, and key reference sources. Run the full analysis pipeline and compare outputs against expected bounds. Fail the benchmark run when dimensions drift outside tolerance, confidence collapses unexpectedly, or source quality falls below threshold.

Integrate as a repeatable script (and optional CI gate) so quality regressions are visible before release.
