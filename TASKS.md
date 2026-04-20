## Open Items — Canonical Pipeline

Baseline (current observed range): ~18 API calls per scorecard run; ~10-20 calls per matrix run when low-confidence recovery is active.

Priority scale: P0 = reliability blocker / correctness bug, P1 = strong quality lift, P2 = strategic lift, P3 = deep/expensive optional mode.

---

### Research Quality — Evidence & Confidence (highest priority)

Root cause analysis on a 9×8 enterprise healthcare matrix run: 88% of 249 sources failed verification (156 fetchFailed, 63 404), collapsing 65/72 cells to low-confidence and failing the decision gate. The cell reasoning content was substantively accurate — the failure is entirely in the sourcing and confidence layer. Core findings: (1) 175 of those sources were Gemini grounding redirect URLs (vertexaisearch.cloud.google.com/grounding-api-redirect/…) which are ephemeral session tokens that expire before the verifier fetches them; (2) URL verification is being used as a proxy for fact verification, which it isn't — a cell can be 100% accurate with no verifiable URL; (3) confident factual cells are being confidence-penalised for HTTP reachability, not knowledge quality.

#### SQ-01 — Decouple confidence scoring from URL verification · P0 · fix

**Problem:** Confidence is penalised when URLs fail HTTP verification, even when the cell content is substantively accurate. 88% URL failure rate collapsed 65/72 cells to low-confidence and failed the decision gate. URL reachability ≠ factual accuracy, especially for well-documented enterprise products.

**Solution:** Confidence reflects knowledge depth and evidence specificity (model-expressed). URL verification produces a separate `citationStatus` field (`verified` / `unverifiable` / `not_found`). Add a `confidenceSource: model | verification_penalty` field so downstream diagnostics can distinguish model-stated uncertainty from HTTP-driven downgrades. Decision gate treats citation coverage as its own dimension, not a confidence multiplier. A cell can be `confidence: high` + `citationStatus: unverifiable` — that is useful signal, not a failure.

**Acceptance:** Decision gate confidence failures occur only when the model itself expressed uncertainty (`confidenceSource: model`), never because sources failed to fetch. No cells should have `confidenceSource: verification_penalty` after this ships. Integration test: run on well-documented enterprise products — decision gate may still fail on genuine knowledge gaps, but not on fetchability.

---

#### SQ-02 — Fix Gemini grounding redirect URLs · P0 · fix

**Problem:** Stage 03b stored 175 `vertexaisearch.cloud.google.com/grounding-api-redirect/…` session tokens as source URLs in a single test run. These are ephemeral — valid when Gemini generates them, expired by the time the verifier fetches them minutes later. Primary cause of the 156 "fetchFailed" errors.

**Solution:** Two-part fix — both needed since Gemini doesn't reliably comply with prompt instructions for grounding citations: (1) At 03b call time, immediately follow redirect chains for any `vertexaisearch.*` or grounding-redirect URLs and store the resolved canonical URL before writing to state. (2) Update Gemini system prompt in 03b to explicitly request canonical page URLs rather than grounding redirects.

**Acceptance:** `vertexaisearch.*` URL count in stored source objects should be near zero after a 03b run. Measure: grep source URLs in debug bundle for `vertexaisearch.cloud.google.com` — target ≤2% of total sources (allowing for prompt non-compliance edge cases caught by the resolve step).

---

#### SQ-03 — Tiered source verification by sourceType · P0 · fix

**Problem:** A failed KLAS analyst report (paywalled), a vendor case study (login-gated, JS-rendered), and a hallucinated URL all produce the same "fetchFailed" penalty. The verifier cannot distinguish legitimately inaccessible sources from fabricated ones.

**Solution:** Tiered verification rules by sourceType: `research` / `government` → verify aggressively, penalise failure; `vendor` / `press_release` / `marketing` → verify for existence only (HEAD request), do not penalise if unreachable; `analyst` (KLAS, Gartner) → mark as `paywalled` rather than `failed`; `news` → standard verification.

**Acceptance:** After SQ-01 and SQ-03 together, decision gate failures on well-documented enterprise products must not be dominated by fetchability. Specifically: cells with `sourceType: vendor` or `sourceType: analyst` should not have their confidence downgraded due to fetch failures. `fetchFailed` count in stage 06 diagnostics should drop by >50% relative to baseline run.

---

#### SQ-04 — Fact-first prompting to reduce hallucinated citations · P1 · improvement

**Problem:** Prompts implicitly require sources to justify confidence. Models generate plausible-looking but non-existent URLs to satisfy the schema rather than acknowledging honest uncertainty.

**Solution:** Update 03a/03b system prompts: lead with "state specific known facts with confidence; cite only if you are certain the URL is publicly accessible; omitting a citation is preferable to inventing one." Make explicit that a well-reasoned low-confidence acknowledgement is more useful for decision-making than a fabricated URL.

**Acceptance:** 404 rate (truly non-existent URLs) should drop measurably — target below 15% of total sources, down from 25% baseline. Note: `fetchFailed` rate may stay similar or rise slightly as models stop inventing URLs and start citing real but gated pages — that is the correct direction. Do not use `fetchFailed` as the success metric for this task; use 404 specifically.

---

#### SQ-05 — Expand critic mandate to include factual accuracy challenges · P1 · improvement

**Problem:** Claude runs as critic across all cells (stages 10-12) but is prompted for logical/structural challenges only — coherence, source coverage, overclaims. Factual accuracy is not challenged. Cross-model fact-checking is essentially free since the critic call already runs.

**Solution:** Expand critic system prompt to include a factual accuracy pass: for each cell, flag specific claims that appear imprecise, overstated, or inconsistent with known public information, with a reference to what the correct or more accurate information is. Add `flagType: factual | coherence | coverage | structural` to critic flag objects so the split is measurable in diagnostics. Note: asking another model's memory is not a substitute — both models share training biases and agree on hallucinations. This works because Claude and GPT have meaningfully different knowledge and framing on enterprise vendor facts.

**Acceptance:** Manual review on first 3-5 post-ship runs: critic output must include at least some flags of type `factual` with specific evidence references (e.g. "This claim about X appears overstated — known public information suggests Y") when factual issues exist, not only structural observations like "this cell lacks sufficient sources." Automated: `flagType: factual` should appear in >20% of runs with non-trivial content.

---

#### SQ-06 — Targeted claim verification via web search · P2 · improvement

**Problem:** URL verification confirms a page is accessible but not that it contains the cited claim. A cell can fail URL verification while its claims are accurate; or pass verification while citing a page that doesn't support the stated fact.

**Solution:** For cells still low-confidence after stage 08 recovery, extract 2-3 key specific claims and run targeted web searches to corroborate or contradict them (search for the claim itself, e.g. "Innovaccer 600 hospital customers", rather than checking a URL). Update a `claimVerificationStatus` field. Strictly bounded — only post-recovery low-confidence stragglers.

**Acceptance:** At least 30% of targeted cells should see confidence upgraded after claim search corroborates the key claim. Track `claimVerificationStatus` distribution in diagnostics.

---

#### SQ-07 — Tune 03a chunk timeout and start size · P2 · improvement

**Problem:** 2-minute timeout with chunk size 4 is marginal for complex enterprise subjects (Epic, Oracle). Forced splits degrade evidence depth for the largest, most important vendors in the matrix.

**Solution:** Increase 03a default `timeoutMs` to 180s. For matrices with >8 attributes, reduce `chunkSizeStart` from 4 to 2 — smaller initial chunks succeed reliably and still run in parallel, so wall-clock impact is minimal.

**Acceptance:** Zero timeout-driven splits in stage 03a diagnostics for a 9×8 matrix under normal API conditions. All initial chunks should complete without splitting.

---

#### Integration acceptance (SQ-01 through SQ-04 combined)

A run on a 9×8 matrix of well-documented large enterprise products (e.g. Epic, Oracle, Innovaccer, Arcadia) must pass the decision gate. Individual guardrails verify the mechanisms; passing the gate verifies the combined effect. This is the real end-to-end test.

---

#### Tier 1 — Surgical fixes (follow-up from first integration-acceptance run, SQ-08 … SQ-14)

Tier 1 = surgical plumbing/logic fixes. Keeps every stage shape intact. Days of work, not weeks.

First integration run on a 9×8 US-healthcare enterprise-products matrix failed the decision gate at stage 15: `lowConfidenceRatio=0.93` (gate needs ≤0.15), `citationCoverage.verifiedRatio=0.034` (gate needs ≥0.7), 187/283 verifier 404s. Root-cause forensics (debug bundle `analysis-debug-bundle-2026-04-19T22-06-44-690Z.json`) showed the underlying research was substantive — the failure came from three instrumentation/plumbing bugs not covered by SQ-01..SQ-07. The tasks below close those gaps and re-anchor the gate on fabrication signals rather than URL reachability, per the Maximum Extraction and Grounding vs. Verifiability principles added to `docs/quality-bar.md`.

Keep Gemini as the 03b web-evidence provider (user decision, 2026-04-20). Fix the plumbing around it.

Tier 1 also includes table-format items: **QG-05**, **ENG-13**, **ENG-15** (see table below).

---

#### SQ-08 — Normalize numeric confidence expressions · P0 · fix

**Problem:** Gemini 2.5 Pro returns `confidence` as integers on a 1–5 scale (trace evidence from the failed run: 120 of 125 parsed web-evidence cells had values `2`/`3`/`4`/`5`; only 5 used the requested `high|medium|low` enum). `normalizeConfidence()` in [`engine/pipeline/stages/common.js:327`](engine/pipeline/stages/common.js) matches only strings starting with `h` or `m`; every other value falls through to `"low"`. Result: ~93% of cells silently flipped from model-expressed high/medium to "low" with zero diagnostic. OpenAI analysts return strings correctly, so `mergeMatrixCells` in stage 03b (`patch?.confidence || cell?.confidence` — web wins) then overrides the honest OpenAI confidence with the coerced Gemini "low". This single bug is sufficient to fail the decision gate on its own.

**Solution:**
- Extend `normalizeConfidence()` to accept numeric scales. Mapping: `≤2 → low`, `=3 → medium`, `≥4 → high`. Accept both `Number` and numeric strings.
- When a numeric value is coerced, append reason code `confidence_scale_coerced` to the stage's reason codes and count occurrences in token diagnostics so silent coercion becomes observable.
- Tighten the 03b / 03a / 08 / recovery prompts with a one-shot example showing `"confidence": "high"` explicitly, and state "Return confidence as one of the strings: high, medium, low. Do not return a number."
- Add unit coverage for `normalizeConfidence` with string, numeric, numeric-string, null, and out-of-range inputs.

**Acceptance:** On a rerun of the failing matrix, stage 03b's confidence distribution (measured against raw model output) shows `<10%` numeric values. Low-confidence ratio drops from 0.93 to a level consistent with the actual research depth (target `<0.4` on well-documented enterprise vendors, before SQ-09..SQ-13 land). `confidence_scale_coerced` reason count appears in diagnostics whenever coercion happens.

---

#### SQ-09 — Canonicalize Gemini grounding URLs at the adapter · P0 · fix

**Problem:** SQ-02 shipped a redirect resolver in `canonicalizeGroundingSources()` inside [`engine/pipeline/stages/03b-evidence-web.js`](engine/pipeline/stages/03b-evidence-web.js), but it only runs when the model emits a `vertexaisearch.cloud.google.com/grounding-api-redirect/…` URL — which the 03b prompt explicitly forbids. Stage diagnostics on the failing run confirmed it never fired: `groundingRedirects: {detected:0, resolved:0, ...}` on every chunk. Meanwhile the model obediently omits the redirect URLs but fills citations with plausible-but-invented canonical URLs instead. The adapter ([`app/api/providerCalls.js:203`](app/api/providerCalls.js)) already extracts real grounded URLs into `response.sources`, but nothing downstream uses them.

**Solution:** Move canonicalization up to the adapter and make it unconditional:
- In `extractGeminiGroundingSources()`, for each `groundingChunk.web.uri`, follow the redirect chain once (HEAD or `resolveOnly` fetch) and store both `originalRedirectUri` and canonical `url` on each returned source.
- Cap redirect-resolution concurrency (e.g. 8 parallel) and fail-open (if resolution times out, keep the redirect URI with a `resolutionStatus: unresolved` flag rather than dropping).
- Remove the reactive resolver from 03b; stage code consumes already-canonical URLs.
- Budget: add `timeoutMs` and cap per response to bound latency impact (target p95 overhead <3s per 03b chunk).

**Acceptance:** Post-adapter Gemini responses contain zero `vertexaisearch.*` URLs in their `sources` array. The 03b stage's `groundingRedirects.detected` drops to 0 because the work moved upstream. Adapter emits a new diagnostic `groundedSourcesResolved` counter in `meta`.

---

#### SQ-10 — Plumb provider grounding metadata through callActorJson · P0 · fix

**Problem:** `callActorJson()` in [`engine/pipeline/stages/common.js:296`](engine/pipeline/stages/common.js) returns `{parsed, text, meta}` but drops `response.sources` — the provider's real, canonical retrieval set. Every stage that consumes web evidence trusts the model to self-report which URLs it "saw" inside the parsed JSON, with no way to cross-check against what the provider actually retrieved. This is the architectural root cause of citation hallucination.

**Solution:**
- Extend `callActorJson`'s return to include `meta.groundedSources: Array<{url, title?, snippet?}>`.
- Extend transport payload contract (`app/api/providerCalls.js` + `analyst.js` + `critic.js`) to forward provider `sources` end-to-end. Claude's `web_search` result URLs and OpenAI `web_search_preview` annotation URLs plumb the same way; normalize the shape at the adapter layer.
- Add grounded sources to `tokenDiagnostics` count (`groundedSourceCount`) for observability.
- No stage consumes them yet — that's SQ-11.

**Acceptance:** A 03b chunk call's `tokenDiagnostics.groundedSourceCount` matches the adapter's `webSearchCalls`×~2-5 URL yield range. `meta.groundedSources` surfaces in debug bundles at each stage that used live search.

---

#### SQ-11 — Cross-check model-cited URLs against grounded set · P0 · fix

**Problem:** Even after SQ-09 and SQ-10, stages 03b / 08 / 14 continue trusting URLs the model writes into its JSON. Trace evidence: the failed run had cells citing `https://www.innovaccer.com/resources/case-study/reducing-30-day-readmission-rates-at-scale` — plausible slug shape, 404 on the vendor's own domain, not in the grounded set.

**Solution:**
- In stages 03b, 08 recovery, and 14 synthesize, after parsing the model's JSON, for each cell source:
  - Mark source with `groundedByProvider: true` if its URL (normalized — lowercase host, strip trailing slash) appears in the stage call's `meta.groundedSources`.
  - Mark `groundedByProvider: false` otherwise.
- Compute per-cell `fabricationSignal`:
  - `low` — all cited URLs are `groundedByProvider`.
  - `medium` — some are not grounded; partial match.
  - `high` — none of the cited URLs appear in the grounded set despite `webSearchCalls > 0`.
- Store `fabricationSignal` on the cell for downstream gating (SQ-13).
- Add a stage diagnostic `citations.groundedRatio` per stage call.

**Acceptance:** On a rerun, ≥70% of 03b cells report `fabricationSignal: low`. Cells with `fabricationSignal: high` are visible in debug bundle for root-cause inspection. No behavior change yet in the decision gate — that is SQ-13.

---

#### SQ-12 — Tier URL verification outcomes into fabrication / unreachable / verified · P0 · fix

**Problem:** [`engine/pipeline/stages/06-source-verify.js`](engine/pipeline/stages/06-source-verify.js) currently treats `404`, `403`, `429`, paywall, and fetch timeout as broadly similar failures. A Forbes anti-bot `403` and a fabricated vendor-case-study `404` both end up penalising the cell. Per the Grounding vs. Verifiability principle, these are different signals and must be gated differently.

**Solution:** Extend stage 06 to classify each source's verification outcome into one of:
- `verified` — `200` + (content-match OR lightweight existence check passed).
- `unreachable_infrastructure` — `403`, `429`, request timeout, paywall sentinel hosts, Cloudflare block pages. Neutral signal.
- `unreachable_stale` — `410`, moved URL with no redirect.
- `fabricated` — `404` on the subject's own domain, OR URL absent from the stage's grounded set (SQ-11) when grounded set is available and non-empty, OR DNS failure on a host that looks fabricated (e.g. mangled subdomains).
- `unverifiable` — insufficient signal to decide (e.g. binary content, `200` without content-match on a paywalled host).

Inference rules live alongside existing `inferSourceType` — the two tiers (content type and verification outcome) are independent. Populate `verificationTier` on each source.

**Acceptance:** Stage 06 diagnostics emit per-tier counts. On the failing run's inputs, the 187 current `notFound` entries redistribute: `fabricated` count highlights the real quality issue; `unreachable_infrastructure` absorbs the noise from Forbes/WSJ/anti-bot hosts. No source's `citationStatus` changes as a result of this task alone — that is SQ-13.

---

#### SQ-13 — Gate on fabrication signal, not on cited-source ratio · P0 · fix

**Problem:** [`engine/lib/guards/decision-gate.js`](engine/lib/guards/decision-gate.js) fails the run when `citationCoverage.verifiedRatio < minCitedSourceRatio` (defaults `0.7`). With the current verifier, `verified` is reserved for URLs that return `200`+content-match to our fetcher — roughly the worst possible proxy for "evidence is real." Legitimate sources routinely fail reachability; fabricated ones can pass. Re-anchor on fabrication per `docs/quality-bar.md` § "Grounding vs. citation verifiability."

**Solution:**
- Replace `minCitedSourceRatio` with `maxFabricatedSourceRatio` (default e.g. `0.05`).
- Compute `fabricationRatio = count(verificationTier == "fabricated") / relevantSourcesTotal` (SQ-12 input). Fail gate if ratio exceeds threshold.
- Keep `maxUnverifiedSourceRatio` as a separate, looser check, distinguishing `unreachable_infrastructure` (excluded from numerator) from `fabricated` (included).
- Per-critical-cell rule (`minSourcesPerCriticalCell` / `minIndependentSourcesPerCriticalCell`) counts any non-fabricated source as eligible — paywalled analyst reports should not disqualify a critical cell.
- Emit `decision_gate_fabrication_flagged` reason code when the fabrication-based check fails.
- Config: add new gate keys to `configs/research-configurations.js` matrix gate; keep old keys valid but log a deprecation in diagnostics.

**Acceptance:** Given a run where `fabricationSignal` is low across cells but HTTP verification has 60%+ `unreachable_infrastructure`, gate passes. Given a run where model fabricated most URLs, gate fails with `decision_gate_fabrication_flagged`. The failing-test debug bundle, rerun after SQ-08..SQ-13, passes the gate.

---

#### SQ-14 — Fix confidence merge preference in stage 03b · P1 · fix

**Problem:** `mergeMatrixCells` / `mergeScorecard` in [`engine/pipeline/stages/03b-evidence-web.js`](engine/pipeline/stages/03b-evidence-web.js) take `patch?.confidence || cell?.confidence` — web-evidence confidence wins unconditionally over memory-evidence confidence. This made the SQ-08 bug worse: OpenAI 03a produced honest `high`/`medium` strings, Gemini 03b coerced to `low`, and the merge buried the stronger signal.

**Solution:** Merge by confidence rank, not by source stage. If web confidence ≥ memory confidence (ranked low<medium<high), use web; otherwise keep memory and merge web's `full` / `sources` / `arguments` as supporting context. Preserve both confidenceReason strings, joined, so downstream critic has visibility into both signals.

**Acceptance:** On a test case where memory confidence is `high` and web confidence is `low`, merged cell retains `high` confidence but includes web's sources. Unit test covers all nine combinations of (low/medium/high) × (low/medium/high).

---

#### Tier 2 — Targeted redesigns (RETR-01, CR-01)

Tier 2 = targeted redesigns where a stage's shape changes. Larger scope than Tier 1 — redraws the boundary between retrieval and reasoning, or adds new tool budgets to actors that currently run without them. Depends on Tier 1 plumbing being correct (fabrication signal, grounded-source metadata, tiered verification) — otherwise Tier 2 changes are built on broken foundations.

Tier 2 also includes table-format items: **ENG-09** (stage 09 LLM rescore), **ENG-10** (stage 15 LLM run-summary), **ENG-11** (stage 02 dead-check arming), **ENG-12** (stage 04 preserve-evidence reconcile), **UX-07** (clarifying questions in Research Setup) — see table below.

---

#### RETR-01 — Retrieve-then-Reason: split stage 03 into deterministic retrieve + LLM read · P1 · architecture

**Problem:** Stage 03b today conflates retrieval and reasoning into one Gemini call: the model receives a prompt, internally calls `google_search`, and emits cells with cited URLs. The model is free to invent URLs, misattribute claims to pages it didn't read, or drop grounded pages in favour of ones it "remembers" from training. Tier 1 fixes (SQ-09, SQ-10, SQ-11) instrument this path — they expose fabrication but don't eliminate the architectural cause. The model is still the retriever and the reader. Without structural separation, we keep paying a compounding hallucination tax on every retrieval-heavy stage.

**Solution:** Restructure stage 03 (and stage 08 recovery) into two deterministic sub-stages:
- **03b.1 Retrieve** — the model proposes queries only (no cells yet). Queries execute through provider tool-use (Gemini `google_search` or OpenAI `web_search_preview`). Results are captured by the engine into a `retrievedCorpus: Array<{url, title, snippet, query, rank}>`. No model output beyond queries.
- **03b.2 Read** — the model receives the retrieved corpus as structured context and produces cells. Prompt constraint: `sources[].url` must exist in the corpus, referenced by corpus index. Any cell source not present in corpus is dropped at parse time and emits `source_absent_from_corpus` reason code.

Stage 08 recovery follows the same split (propose-search → read-and-score). Stage 14 synthesis reads only from the aggregated corpus across all prior stages — synthesis cannot introduce new URLs.

Keep Gemini for 03b.1 retrieve (user decision, 2026-04-20 — Gemini grounding yields better recall than OpenAI for web search). Reasoning/read (03b.2) can route to any Analyst model; default keep Gemini to minimize context-passing overhead, but make the role override cheap so we can A/B swap in gpt-5.4 without touching orchestrator logic.

Depends on SQ-08..SQ-13 shipping first: grounded sources must already be plumbed end-to-end (SQ-10) and fabrication must already be measurable (SQ-11) before this redesign is testable. If Tier 1 ships and fabrication signal is already low across runs, RETR-01's priority drops — re-evaluate at that point.

**Acceptance:** Zero cells emit URLs absent from their stage's `retrievedCorpus`. `fabricationSignal: high` drops to near-zero across runs. Retrieval call count per stage becomes observable and tunable independently from reasoning call count. Token budget for read stage drops noticeably (context is corpus-scoped, not full-retrieval-scoped). Integration: a 9×8 enterprise matrix shows the decision-gate's `fabricated` count at `≤1%` even under adversarial prompts.

---

#### CR-01 — Critic with web-search retrieval for factual verification · P1 · architecture

**Problem:** Critic stages 10–12 run Claude `claude-sonnet-4` against the Analyst's output with no retrieval tools. SQ-05 expanded the critic's *prompt* to challenge factual accuracy, but without a way to verify against live evidence, the critic can only pattern-match against its own training — which shares hallucination modes with the Analyst's training (both know the same outdated vendor facts, agree on the same invented product names). Cross-model fact-checking only works if one of the models actually looks things up. Today neither does.

**Solution:** Give stages 10–12 a bounded `web_search` budget through the Anthropic Messages API:
- Enable Claude `web_search` tool with a per-stage cap (e.g. `max_uses: 3` for stage 10 coherence, `5` for stage 11 overclaims, `3` for stage 12 counter-case — tuned to keep p95 latency under ~30s/stage).
- Extend critic JSON schema: each flag gains `evidence: { citedClaim, correctingSource?, searchQueriesUsed[] }` so the critic can attach retrieved URLs to the factual-challenge flag.
- Plumb critic's retrieved sources into `meta.groundedSources` same as Analyst (SQ-10 contract — one path for all actors).
- Scope: ONLY for critic factual-challenge flags (`flagType: factual`). Coherence/structural flags do not need retrieval and should not spend the search budget.
- Feed the critic's grounded sources into stage 13 (defend) so the analyst can see what the critic found, not just what the critic flagged.

Extends SQ-05 from "prompt says find factual issues" to "critic is architecturally capable of finding factual issues." Depends on SQ-10 (grounded-source plumbing contract must be provider-neutral before Claude can feed into it).

Cost/latency: +1 search-enabled Claude call per cell with `factual` flags. Budget-capped. Expected impact: +15–25% per affected stage, which is acceptable per quality-bar.md § "Decision-Grade First."

**Acceptance:** Critic flags of type `factual` include `correctingSource` with a URL from Claude's own `web_search` retrieval in ≥60% of cases where the Analyst cited information that was factually outdated or wrong. Manual review on 3–5 runs: does the critic catch specific vendor-fact errors (acquired product lines, renamed offerings, customer-count claims) that the Analyst got wrong? Integration: on a matrix where Analyst hallucinates a specific vendor fact, critic stage 11 fires a `factual` flag with a grounding URL; stage 13 defend takes the critic's URL into account when re-scoring.

---

#### Tier 3 — Architectural shifts (CONF-01)

Tier 3 = architectural shifts that touch the data model or cross-cutting state. Highest risk/reward; only worth picking up once Tier 1 and Tier 2 have landed and we can measure whether the residual quality gap justifies the cost. Not committing to Tier 3 now — capturing it so the design trade-off is on record.

Tier 3 also includes table-format items: **ENG-14** (unify assessment state path) — see table below.

---

#### CONF-01 — Deterministic Confidence Derivation from Evidence Signals · P2 · architecture

**Problem:** Confidence is a free-form model self-report. Even with SQ-08 (numeric-scale coercion fix), the model is asked to rate its own certainty — a task LLMs are notoriously poorly calibrated on. Two cells with identical evidence can get different confidence levels depending on model mood / prompt phrasing / sampling temperature. Confidence drives the decision gate, and the gate's thresholds assume confidence is a signal. Today it's noise smoothed by convention.

**Solution:** Replace (or supplement) model-expressed confidence with a deterministic function of evidence signals captured during retrieval:
- Inputs per cell: count of `groundedByProvider: true` sources; count of independent sources (research/government/registry/news); count of verified-tier sources (SQ-12); source recency median; corroboration count (how many distinct sources assert the same claim); critic flags resolved/unresolved (stage 10–13 outcomes).
- Function: `confidence = f(groundedCount, independentCount, verifiedTierRatio, recencyScore, corroborationScore, criticFactualFlagsUnresolved)`. Parameters tuned against a labeled benchmark set (FR-02 prerequisite).
- Emit both signals on each cell: `confidence` (the final, deterministic value) and `confidenceSelfReported` (the model's self-reported, kept for diagnostic comparison). `confidenceSource: derived | model_fallback` distinguishes.
- If retrieval signals are too thin to derive (e.g. memory-only cells in `native` mode before 03b merges), fall back to model self-report with `confidenceSource: model_fallback`.
- Depends on RETR-01: deterministic confidence requires a deterministic retrieval corpus. Without RETR-01, the "grounded source count" denominator is unreliable. Also depends on FR-02 (benchmark suite) to tune the function parameters empirically rather than by intuition.

Risk: over-indexes on retrieval recency and corroboration counts — a niche but correct claim cited by one good source could be under-confident. Mitigation: give the model a "confidence nudge" pathway where it can flag a cell as high-confidence-despite-thin-evidence with a rationale, which the function accepts as an additional input (bounded, audited).

Reward: the decision gate becomes trustworthy. Decision-grade output depends on confidence meaning something; today it's convention. This is the prerequisite for claims of reproducibility against mainstream deep-research baselines (quality-bar.md § "Primary Goal").

**Acceptance:** On the benchmark set (FR-02), deterministic-confidence matches labeled ground truth on ≥80% of cells, vs. model-self-report at ~50–60% (hypothesized — measured by FR-02 harness). Decision gate thresholds can be tuned against a stable signal. Debug bundle shows both `confidence` and `confidenceSelfReported` side-by-side so regressions are diagnosable.

---

Classic-flow target stack (quality-first default routing): OpenAI reasoning model as Analyst, Anthropic model as Critic, Gemini-grounded retrieval/query planning for web evidence, with strict model pinning and fail-fast behavior on provider/model errors (no failover routing).

Execution order for user account roadmap: durable run persistence first, then auth, then billing gates, then collaboration (`DA-05 -> RU-03 -> UA-01/UA-02/UA-03 -> PAY-01/PAY-02/BIL-01 -> CO-01/CO-02`).

### Delivery Phases (Account -> Monetization/Sharing)

Phase 1 — account foundation (store researches under account, sign in/sign up):
- `DA-05` async orchestration + run persistence (Native + Deep Research ×3)
- `RU-01` client crash-safety restore
- `RU-03` run storage, retention, hard delete
- `UA-01` magic-link auth baseline
- `UA-02` anonymous-to-account claiming
- `UA-03` user research library + resume

Phase 2 — payment gate, payments/billing/balance, and sharing:
- `PAY-01` payment provider and checkout integration
- `PAY-02` balance ledger + usage charging + webhook reconciliation
- `BIL-01` free-run policy, balance gates, pre-run estimate gate, export gate
- `FR-01` in-app cost transparency
- `CO-01` share links/TTL/access controls
- `CO-02` collaborative comments and review threads

| ID | Type | Problem | Solution | Impact | Extra calls | Cost +% | Priority |
|----|------|---------|----------|--------|-------------|---------|----------|
| QG-03 (Parse-Failure Guardrails With Retry) | fix | Parse failures can still collapse to placeholder objects in some paths, allowing runs to continue with degraded content instead of explicit recovery/fail semantics. | Promote parse failures to first-class guardrail events, record them in `analysisMeta.safetyGuardrails`, retry with reduced output scope/chunk size, and abort with explicit reason code when recoverability threshold is not met. | Converts hidden content corruption into deterministic recover-or-fail behavior. | +0-3 | +0-15% | P0 |
| QG-04 (Reconcile Acceptance Gate) | fix | Reconcile can still be accepted without measurable lift; current Stage `04` logic includes a placeholder `contradictionReduced = true`, which weakens rejection behavior. | Replace placeholder logic with real reconcile lift metrics (minimum low-confidence reduction, source-coverage lift, and contradiction delta). If unmet, reject reconcile result, retain best prior draft, regenerate targeted plan, and mark reconcile health failure in diagnostics. | Prevents reconcile from locking in low-information outputs. | 0 | 0% | P0 |
| CO-01 (Share Links, TTL, and Access Controls) | feature | Shared research is needed for async review, but current flow lacks controlled link-based access and expiry. | Implement share links for one or multiple researches, configurable TTL, revoke controls, and "shared with me" access model. | Enables lightweight collaboration without forcing immediate full account creation for reviewers. Blocked on DA-05 + UA-01. | 0 | 0% | P2 |
| CO-02 (Collaborative Comment Threads) | feature | Current challenge threads are single-user; reviewer feedback cannot be captured inline in shared research. | Add per-dimension/per-cell comments and replies with participant labeling, notifications, and owner moderation/revoke actions. | Turns outputs into collaborative decision artifacts instead of static reports. Blocked on CO-01. | 0 | 0% | P3 |
| FR-02 (Benchmark Regression Suite) | feature | Pipeline/prompt/model changes can silently degrade quality. No way to measure impact of improvements. | Build hybrid benchmark stack: (1) replay regression tests in CI using dumped model/tool responses (zero API spend), (2) small live canary subset on schedule to detect provider/retrieval drift, (3) full live benchmark pre-release and before major quality claims. Start with 6-8 gold cases, expand to 20. Define fixed scoring rubric + scorer protocol so DA-04 comparisons are reproducible. Prerequisite for DA-04. | Measurement infrastructure: prevents regressions and makes "beats mainstream deep research" claims auditable when DA-04 runs on top. | low recurring + periodic full run | low recurring + periodic full run | P3 |
| DA-04 (External Deep Research Head-to-Head Harness) | feature | "Beats mainstream deep research" cannot be claimed without direct side-by-side evidence. | Add benchmark harness that runs fixed prompts against Researchit, ChatGPT Deep Research, Claude Research, and Gemini Research; score with rubric (accuracy, source quality, decision utility, contradiction handling). Publish win/loss deltas in debug artifacts. Depends on FR-02 for infrastructure. | Objective proof that quality direction is working. | benchmark-only | benchmark-only | P3 |
| DA-05 (Async Orchestration + Run Persistence, Native + Deep Research ×3) | feature | Closing/reloading browser tabs can drop in-flight progress visibility and make long runs feel lost. Deep Research ×3 has higher risk due to multi-minute, multi-provider execution. | Introduce durable async run orchestration with persisted run state, resumable steps, cancellation, and idempotent retries for both Native and Deep Research ×3. Progress events must survive reconnects and recover by `runId`. | Foundation for reliable resume/reconnect behavior and prerequisite for account-backed run continuity. | 0 (quality infra) | 0% | P0 |
| DA-06 (Deep Research ×3 Run Manifest + Evidence Cache) | feature | Retries/re-runs can re-pay for identical deep calls and make audits hard. | Persist a deterministic run manifest (prompt hash + config version + provider/model set + timestamps) and cache raw provider outputs + normalized extraction. Reuse cache on safe retries/replays; expose provenance in debug/export artifacts. | Lower avoidable cost, better reproducibility, stronger auditability. | 0 (happy path) | 0% to lower | P1 |
| DA-07 (Provider Data Governance + Privacy Controls) | feature | Three-provider Deep Research ×3 increases data handling risk (PII leakage, unclear retention, compliance ambiguity). | Add provider-level data governance controls: redaction policy before provider calls, provider allow/deny list per run, retention policy metadata, and explicit diagnostics about where data was sent. | Required trust/compliance foundation for enterprise usage. | 0 | 0% | P1 |
| DA-08 (Deep Research ×3 Source Provenance + Quality-Ranked Merge) | feature | Deep Research ×3 merge currently deduplicates sources but does not preserve provider-level source provenance or explicitly rank retained source records by quality tier as defined in the evidence-mode spec. | Extend deep-research-x3 merge to keep per-source provenance (`citedByProviders[]`) and apply deterministic source ranking (`independent > press > vendor`) before confidence calibration and export rendering. Include merge diagnostics in `analysisMeta` and debug artifacts. | Stronger auditability of merged evidence and clearer trust weighting per claim. | 0 | 0% | P2 |
| ENG-05 (Align analysisMeta Initialization) | refactor | `analysisMeta` is initialized in three places (App.jsx partial subset, engine `createInitialState` full set, `runMatrixAnalysis` partial re-spread) with different field sets. Stale values from one layer can leak through. | Centralize `analysisMeta` initialization in engine only. App.jsx should not pre-build `analysisMeta` — let the engine own the full shape. | Prevents subtle field mismatch bugs as diagnostics expand. | 0 | 0% | P3 |
| ENG-08 (Shared Source Universe Normalization Across UI/Exports) | refactor | `normalizeSourceUniverse`/`cleanText` style logic is repeated in `SourcesList.jsx`, `DimensionsTab.jsx`, and `export.js`, creating formatting drift risk. | Add shared frontend utility module (`app/src/lib/sourceUniverse.js`) and reuse in UI + export rendering. | Consistent source-universe presentation and fewer subtle UI/export mismatches. | 0 | 0% | P3 |
| RQ-26 (Retrieval Mesh: Multi-Engine Search) | feature | Single search stack can miss important sources and collapse coverage quality. Overlaps with CF-08 (Gemini as default web evidence provider); this item extends to corroboration across multiple engines. | Add pluggable retrieval mesh with Gemini-grounded retrieval as default engine plus optional parallel corroboration engines (not failover). Dedupe/rank results by source quality/recency and expose per-provider hit diagnostics. | Higher recall and better corroboration signal quality. | +6-18 | +30-90% | P2 |
| RQ-25 (Model Portfolio by Function) | feature | One-model-heavy pipelines can share blind spots across phases. Includes multi-model ensemble (Anthropic, Gemini adapters). | Route phases to role-specialized models with config overrides and explicit fail-fast behavior when pinned routes fail. Add multi-provider adapters for configured lanes only (no silent rerouting). Routing infrastructure exists (`withRoleModelOptions`, per-role model config), adapters are missing. | Better robustness and lower correlated errors. Cross-provider disagreement exposes weak claims earlier. | ~same | ~0% | P2 |
| RQ-19 (Evidence Graph Layer) | feature | Claims are stored as prose; provenance and contradiction tracking are hard. | Introduce structured claim graph (`claim → evidence nodes → source spans`) with recency/verification/conflict metadata. Score from graph signals, not only narrative. | Strong auditability and better machine-checkable logic. Prerequisite: SQ-01 through SQ-03 must land first or the graph will be built on broken confidence signals. | 0-2 | 0-10% | P3 |
| RQ-24 (Research Memory with Revalidation) | feature | Useful prior evidence is not reused systematically; stale reuse risk is unmanaged. | Add memory store of vetted claims with decay + mandatory revalidation before reuse in new runs. | Faster future runs with controlled freshness risk. | 0-2 | 0-10% | P2 |
| RU-01 (Client Crash-Safety Draft Restore) | feature | Before full server-backed persistence, users can still lose visible in-progress context after accidental tab close or refresh. | Persist lightweight in-progress snapshots locally, restore with resume/clear prompt on reload, and show unload guard when a run is active. | Immediate UX safety net while durable orchestration is rolling out. | 0 | 0% | P1 |
| RU-03 (Run Storage, Retention, and Hard Delete) | feature | Account features require explicit lifecycle rules for run artifacts and user-controlled deletion. | Add durable run artifact storage model with retention metadata, hard-delete path, and compatibility with existing export/import artifacts. | Enables trustworthy persistence and privacy controls before broad auth rollout. | 0 | 0% | P1 |
| UA-01 (Magic-Link Auth Baseline) | feature | Returning users currently rely on local state and cannot reliably recover work across devices/sessions. | Implement email magic-link sign-in/up, session handling, and account shell integrated with persisted run retrieval. | Baseline identity layer for returning users and durable history access. | 0 | 0% | P1 |
| UA-02 (Anonymous-to-Account Claiming) | feature | Hard auth gate before users see value increases drop-off and can orphan anonymous runs. | Allow anonymous first run, then claim recent runs after sign-up using secure ownership handoff. | Keeps low-friction onboarding while preserving continuity after signup. | 0 | 0% | P1 |
| UA-03 (User Research Library + Resume) | feature | Returning users need a reliable home for owned runs, status, and continuation actions. | Add "My Researches" library with status filters (`running/completed/degraded/failed`), resume/open/delete/export actions, and reconnect by `runId`. | Makes Researchit usable as an ongoing workspace, not a single-session tool. | 0 | 0% | P1 |
| PAY-01 (Payments Provider Integration) | feature | Billing gates cannot work without a reliable top-up checkout path tied to account identity. | Integrate payment provider checkout/session return flow and account crediting entry point; support test/sandbox and production modes. | Enables monetization and funding of paid runs. | 0 | 0% | P1 |
| PAY-02 (Balance Ledger + Usage Charging + Webhook Reconciliation) | feature | Balance changes can drift without a canonical ledger and asynchronous payment reconciliation. | Implement append-only balance ledger, per-run debit records, idempotent webhook reconciliation, and audit trail for credits/debits/refunds/adjustments. | Accurate balances and trustworthy billing operations. | 0 | 0% | P1 |
| BIL-01 (Free Run + Balance Gate Policy) | feature | Onboarding/billing flow in product scenarios requires explicit gate rules tied to identity, payments, and persisted runs. | Add free-run entitlement policy, pre-run estimate checks, low-balance handling, export/top-up gates, and UX messaging wired to account state + ledger. Depends on `PAY-01` and `PAY-02`. | Aligns onboarding promise with operable monetization and cost controls. | 0 | 0% | P1 |
| FR-01 (In-App Cost Transparency) | feature | No-cap Deep Research ×3 policy needs clear visibility into expected and actual cost. | Show estimated range before launch, live spend/progress during run, and actual by phase/provider in exports/debug logs. | Preserves quality-first policy while avoiding surprise spend. | 0 | 0% | P1 |
| FR-04 (Per-Run USD Cost Accounting by Provider/Model) | feature | We cannot yet compute trustworthy per-research and per-model spending because token/tool usage is not normalized across all providers and persisted at step level. | Add canonical usage ledger per run step: capture prompt/output/cached/tool tokens + search/tool calls from OpenAI/Anthropic/Gemini responses; normalize to common schema; versioned pricing table by provider/model/effective-date (env-overridable); compute estimated USD per call, per phase, per provider/model, and total per research; persist in run artifact + debug/export payloads; show estimation confidence and mismatch note versus provider invoice. | Enables reliable spending analytics, pre-run estimate accuracy, and auditable billing foundations. | 0 | 0% | P1 |
| UX-05 (Continue Recovery Action for Non-Decision-Grade Runs) | feature | Non-decision-grade runs currently show failure reasons but do not offer direct one-click continuation. | Add "Continue Recovery" action that re-enters targeted recovery for failed checks only (bounded by configurable extra budget) and re-evaluates decision-grade gate. | Improves remediation loop and reduces full rerun cost. | +0-20 | +0-100% | P1 |
| UX-06 (Live Deep Research ×3 Provider Progress Telemetry) | feature | Progress UI shows phase-level status, but long deep-research-x3 runs do not expose live per-provider state transitions during collection. | Emit provider-level progress snapshots (`queued/running/completed/failed`, duration, retries) during deep-research-x3 collection and render them in Progress tab for both scorecard and matrix runs. Persist snapshots in run metadata for reconnect visibility. | Better observability and lower user uncertainty during multi-minute runs. | 0 | 0% | P1 |
| FR-03 (Decision-Grade Acceptance Suite) | feature | Decision-grade thresholds can regress without automated enforcement. | Add fixture/live acceptance suite validating gate metrics and export/UI consistency for both matrix and scorecard; fail CI on threshold regressions. | Makes decision-grade guarantees testable and auditable. | benchmark-only | benchmark-only | P1 |
| MX-09 (Matrix Cell Jump-to-Detail Affordance) | feature | Matrix grid cells include compact summaries, but there is no direct affordance to jump from a table cell to its corresponding detailed debate thread. | Add per-cell `open details` affordance in Matrix tab that deep-links to the matching item in Debate & Challenges (subject × attribute), with focus/scroll targeting. | Faster review workflow and better usability on large matrices. | 0 | 0% | P2 |
| RA-12 | improvement | Weighted score ignores confidence quality. | Add confidence-weighted score alongside raw score (e.g. H=1.0, M=0.85, L=0.65) and display both. Depends on RQ-21. | Better ranking trust under uncertainty. | 0 | 0% | P2 |
| RA-16 | improvement | Discovery generation quality can be generic. | Add dedicated `SYS_DISCOVER` prompt optimized for strategic adjacent opportunities and clearer candidate rationale. | Better discover candidates. | 0 | 0% | P2 |
| CF-02 | improvement | Many config dimensions still lack robust polarity/research hints. | Add `polarityHint` and rich `researchHints` (`whereToLook`, `queryTemplates`) to all dimensions across configs. Prerequisite: ensure engine retrieval actually consumes these hints. | Better targeted retrieval for every research type. | 0 | 0% | P2 |
| DM-01 (Demo Research Pack) | feature | New users start with empty state and cannot benchmark output shape quickly. | Ship static demo pack fixtures (scorecard + matrix) and tag as demo; include representative high-quality examples. | Faster onboarding and quality expectations calibration. | 0 runtime | 0% | P2 |
| CF-06 | improvement | Config definitions remain harder to contribute to than necessary. | Refactor config schema to self-contained per-config objects + shared global defaults with lightweight normalization. | Easier contribution and lower config drift risk. | 0 | 0% | P2 |
| CF-03 | fix | Some scorecard configs can still rely on default output mode behavior. | Keep explicit `outputMode` in every config to avoid implicit mode-resolution bugs. | Stability and clarity. | 0 | 0% | P2 |
| RQ-07 (Deep Mode: Triple Baseline) | feature | Standard mode lacks explicit model-divergence signal. | Add optional deep mode with parallel baseline passes and disagreement-guided retrieval focus. Depends on RQ-25. | Better calibration on high-stakes runs. | +3 (parallel) | +15% | P3 |
| RQ-08 (Targeted Multi-Model Search) | feature | Single-model query framing misses retrieval diversity in disputed cells. | In deep mode, run disputed-dimension retrieval through multiple models, merge evidence, and reconcile. Depends on RQ-25 + RQ-07. | Higher recall in contentious cells. | +4-8 | +20-40% | P3 |
| ENG-09 (Stage 09 Rescore: Implement as LLM Call) | fix | `docs/pipeline-architecture.md` declares Stage 09 as Analyst/gpt-5.4 rescore. Actual [`engine/pipeline/stages/09-rescore.js`](engine/pipeline/stages/09-rescore.js) is deterministic ±1 adjustment based on confidence counts — no LLM. Recovery-informed rescoring therefore cannot re-interpret newly added evidence; it can only nudge numbers by ±1. Doc-code drift and a real quality gap: after stage 08 brings in new sources/claims, we never re-score with a reasoning pass. | Implement the rescore as an Analyst call. Feed in (a) prior score + confidence + full, (b) recovery-added sources and claims, (c) critic flags pending. Model rewrites score and confidence with justification; deterministic guardrail bounds movement per iteration to prevent unstable swings. Keep the deterministic path as fallback if the LLM call fails. | Closes a documented-but-not-implemented stage. Gives recovery evidence actual decision-influence instead of a ±1 nudge. | +1-2 | +5-10% | P1 |
| ENG-10 (Stage 15 Finalize: Implement Run-Summary LLM Call) | fix | `docs/pipeline-architecture.md` says Stage 15 is "engine + Analyst (openai:gpt-5.4-mini) generate run summary." Actual [`engine/pipeline/stages/15-finalize.js`](engine/pipeline/stages/15-finalize.js) has no `callActorJson` — it only assembles state and runs the decision gate. Another doc-code drift: we advertise a final concise run summary and never produce one. | Add an Analyst gpt-5.4-mini call to Stage 15 that produces a short run-summary object (decision, top-3 evidence highlights, top-3 risks, top-2 open questions). Persist on state as `runSummary`. Cheap model, short prompt — minimal cost. Non-blocking: if the call fails or times out, fall back to engine-computed summary so the gate still runs. | Matches doc. Gives UI/export a pre-computed exec summary instead of deriving ad hoc. | +1 | +2-5% | P1 |
| ENG-11 (Stage 02: Remove or Arm Dead CRITICAL_UNITS_UNRESOLVED Check) | fix | Stage 02 raises `CRITICAL_UNITS_UNRESOLVED` if `normalizePlan` returns units without queries — but `normalizePlan` inserts fallback queries for every unit, so the check is unreachable. Planner failures go silent. | Two-step: (1) Remove fallback query injection from `normalizePlan` and let `CRITICAL_UNITS_UNRESOLVED` actually fire when the model returns no queries. (2) OR, keep fallbacks but have them trigger a weaker `plan_used_fallback_queries` reason code so we can distinguish real from fabricated plans. Prefer option 1 for quality clarity; option 2 is a compatibility-friendly alternative. | Removes false success signal from planner. Planner failures become visible instead of silently degraded. | 0 | 0% | P1 |
| ENG-12 (Stage 04: Reconcile No-Lift Preserves Evidence) | fix | [`engine/pipeline/stages/04-merge.js`](engine/pipeline/stages/04-merge.js) `shouldRejectReconcile` discards ALL web evidence wholesale when no numeric lift is detected, emitting `RECONCILE_REJECTED_NO_LIFT`. Web evidence can add valuable sources and arguments even when scores don't move. Correct behaviour is to retain the new evidence entries but keep the prior score. | Change rejection behaviour: keep the prior assessment's scores and confidence, but merge in new sources and supporting/limiting arguments added by web. Only reject if the new sources are themselves low-quality (SQ-12 fabrication signal). Emit `reconcile_scored_retained_evidence_merged` reason code for transparency. | Prevents silent data loss. Matches Maximum Extraction principle. | 0 | 0% | P1 |
| ENG-13 (Stage 13: Fix Silent Disposition Flip on Empty Analyst Note) | fix | In [`engine/pipeline/stages/13-defend.js`](engine/pipeline/stages/13-defend.js), `normalizeOutcome` requires a non-empty `analystNote` to treat a flag as `resolved: true`. If the model returns `resolved: true` without a note, it silently flips to `rejected_with_evidence` — no reason code, no diagnostic. A model that resolved a flag correctly but was terse gets misrepresented. | If `resolved: true` with empty `analystNote`, either (a) retry with explicit "include a resolution note" instruction, or (b) keep as resolved but mark `analystNote: "model returned resolution without note"` and emit `defend_note_missing` reason code. Do not silently invert the disposition. | Removes silent data inversion. Makes defend stage outcomes trustworthy. | +0-1 (retry) | +0-5% | P2 |
| ENG-14 (Unify Assessment State Path: coverage-gate vs decision-gate) | fix | [`engine/lib/guards/coverage-gate.js`](engine/lib/guards/coverage-gate.js) reads `state.assessment` only. [`engine/lib/guards/decision-gate.js`](engine/lib/guards/decision-gate.js) prefers `state.resolved.assessment` and falls back to `state.assessment`. Post-stage-09, these can diverge and the two gates evaluate different data. Latent correctness bug. | Decide on one canonical location (recommend `state.resolved.assessment` after stage 09 exists; `state.assessment` before). Both gates use the same accessor, centralized in a shared helper. Add a dev assertion that flags drift between the two paths if both are populated and different. | Removes a class of "gates disagree silently" bugs. Prerequisite for stable decision-gate tuning. | 0 | 0% | P2 |
| ENG-15 (Dedupe Source-Type Inference) | refactor | `inferSourceType` logic exists independently in [`engine/pipeline/stages/06-source-verify.js`](engine/pipeline/stages/06-source-verify.js) and [`engine/lib/guards/decision-gate.js`](engine/lib/guards/decision-gate.js). Host lists drift; a new trusted analyst host added to one place is missing from the other. | Extract to `engine/lib/sources/source-type.js`, import in both consumers. Single host list. Keep the test suite that covers both consumers. | Prevents silent drift. | 0 | 0% | P3 |
| QG-05 (Failure Cause Classification in Debug Bundles) | feature | When a run aborts on quality gates, the debug bundle does not distinguish *why* the gates failed. Forensic work on the 2026-04-19 failing-test bundle required deep trace analysis to figure out that confidence numbers were being coerced and URLs were being hallucinated. The quality-bar.md "Fatal" definition requires that failures be actionable — the bundle must surface the cause. | At stage 15 / decision-gate evaluation, classify each failed check into one of: `infrastructure_noise` (e.g. verifier 403/429), `pipeline_coercion` (e.g. `confidence_scale_coerced` count > N), `data_gap` (cells where model correctly expressed low confidence and no grounded sources found), `fabrication` (fabricationSignal high). Emit `failureCauses: []` on run artefact. Show in UI as a quality card on aborted runs. | Turns forensic investigations into a click-through. Lets "abort" stay aggressive while keeping the debugging cost manageable. | 0 | 0% | P1 |
| UX-07 (Clarifying Questions in Research Setup) | feature | Broad or ambiguous research objectives produce weaker downstream research (attributes too generic, subjects misaligned with intent). A pre-research clarification pass — asking the user 2–4 targeted questions to sharpen scope/intent — lifts accuracy substantially. | Extend existing `Research Setup` modal (`app/src/App.jsx` — `showSetupModal` + `setupDraft`) with a "Sharpen Scope" step: after initial draft is entered, send to an Analyst call that proposes 2–4 clarifying questions (e.g. "Which geography?", "B2B or B2C?", "Which specific decision horizon?"). User answers; answers persist into the setup draft as structured fields. Optional, skippable. Do not add a new pipeline stage — this is a pre-pipeline UI interaction. | Improves decision-grade quality at the source by sharpening objective/scope before expensive pipeline runs. | +1 pre-run (small) | +2-5% | P2 |

---
