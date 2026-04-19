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

---
