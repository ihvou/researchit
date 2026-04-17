# Pipeline Architecture Suggestions: Quality-First Without Waste

This document proposes model-routing updates that materially improve output completeness/accuracy while avoiding unnecessary spend.

## Why update now

From debug bundle `analysis-debug-bundle-2026-04-17T17-16-53-859Z.json`:

- One native matrix run took ~77.3 minutes total.
- The major stall was **matrix_web** (not baseline):
  - matrix_web total: **3243.4s**
  - single slow call: **2914.2s** (~48.6 min)
- Run failed at `matrix_response` due malformed JSON after long execution.

## Current effective routing (observed)

- Analyst lane dominates native matrix (`openai:gpt-5.4-mini`) for baseline, web, reconcile, targeted, and response.
- Critic lane uses `anthropic:claude-sonnet-4-20250514`.
- Deep Assist lane already uses 3-provider setup (`gpt-5.4`, `claude-sonnet-4`, `gemini-2.5-pro`).

## Recommended routing profile (Balanced Quality)

Use higher-quality models where reasoning quality is highest leverage, keep cheaper models for planning/auxiliary tasks.

### Scorecard

| Step group | Recommended route | Why |
| --- | --- | --- |
| Query strategist + targeted query planning | `gemini:gemini-2.5-flash` | Low-cost planning; quality is sufficient for query generation. |
| Evidence web passes (Phase 1 web + targeted search harvest) | `gemini:gemini-2.5-pro` | Better retrieval synthesis and web grounding quality than flash/mini. |
| Baseline scoring + reconcile scoring + phase-3 response | `openai:gpt-5.4` | Higher structured reasoning quality for score integrity and decision framing. |
| Critic / Red team / Consistency | `anthropic:claude-sonnet-4-20250514` | Strong adversarial review quality. |
| Synthesizer | `anthropic:claude-sonnet-4-20250514` (or dedicated synthesizer model) | Stable concise synthesis over structured signals. |
| Discovery suggestions | `openai:gpt-5.4-mini` or `gemini-2.5-flash` | Non-critical recommendation step. |

### Matrix

| Step group | Recommended route | Why |
| --- | --- | --- |
| Subject discovery + strategist/query-plan | `gemini:gemini-2.5-flash` | Cheap planning/discovery where depth is less critical. |
| Baseline pass | `openai:gpt-5.4` | Better completeness and cleaner structured cell generation. |
| Web pass | `gemini:gemini-2.5-pro` | Stronger web-grounded evidence extraction and lower OpenAI web tool dependence. |
| Reconcile pass | `openai:gpt-5.4` | High-leverage merge judgment between baseline/web drafts. |
| Targeted search harvest | `gemini:gemini-2.5-pro` | Better retrieval depth on weak cells. |
| Targeted rescore | default `openai:gpt-5.4-mini`; upgrade to `gpt-5.4` for critical attributes | Spend only where scoring risk is highest. |
| Critic + consistency + red team | `anthropic:claude-sonnet-4-20250514` | Strong challenge quality and cross-cell critique. |
| Analyst response (contested cells) | `openai:gpt-5.4` | Better JSON reliability and adjudication quality under large contested payloads. |
| Derived attributes + discovery | `openai:gpt-5.4-mini` | Lower-risk summarization/derivation tasks. |
| Synthesizer | `anthropic:claude-sonnet-4-20250514` | Consistent executive synthesis. |

## Estimated cost impact (from this specific failed run)

Method: approximate tokens via `chars/4`; pricing based on public list rates. Excludes unknown provider-side search surcharges.

- Current observed routing (mostly `gpt-5.4-mini` analyst + Claude critic): **~$1.60** token-cost estimate.
- Balanced Quality profile above: **~$3.74** token-cost estimate.
- Full quality-heavy profile (upgrade most analyst reasoning passes): **~$4.61** token-cost estimate.

Interpretation:

- Balanced profile is ~2.3x token spend vs current, but should materially improve matrix completeness and JSON stability.
- It avoids the most expensive path (running all analyst reasoning on high-tier models).

## Reliability and latency safeguards to apply with routing update

1. Add step-specific hard timeout + retry split
- Example: matrix web chunk timeout 90-120s; on timeout split subject chunk and retry.
- Prevents single 40-50 minute stuck calls.

2. Add phase-level fail-fast on malformed JSON for critical phases
- If `matrix_response` parse fails after bounded retry, stop with explicit error modal + download debug button.

3. Route web-heavy native matrix steps through retrieval capability explicitly
- Eliminate accidental OpenAI web-search tool spending when policy intends Gemini web grounding.

4. Add per-step model map in config (not hardcoded role-only)
- Example keys: `matrixBaselineModel`, `matrixWebModel`, `matrixReconcileModel`, `matrixTargetedSearchModel`, `matrixResponseModel`.
- Makes quality/cost tradeoffs transparent and contributor-friendly.

## Suggested default policy

- Default mode: **Balanced Quality** profile above.
- Keep Deep Assist for highest-stakes runs or when native quality gate fails.

