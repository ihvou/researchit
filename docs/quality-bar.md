# ResearchIt Quality Bar

This document defines the non-negotiable quality objective for ResearchIt.

## Primary Goal

ResearchIt should outperform any single mainstream LLM run (including deep-research style runs) on:
- quality of evidence,
- completeness of coverage,
- factual accuracy/verifiability,
- decision-readiness of the final output.

Short form:

**Better than individual LLM outputs for high-stakes decisions.**

## What “Outperform” Means

For relevant benchmark cases, ResearchIt should consistently provide:
- more complete structured coverage of required dimensions/cells,
- stronger evidence grounding (more verified/cited, less unsupported text),
- more accurate and contradiction-aware conclusions,
- clearer pass/fail decision utility (not just narrative confidence).

This is a product-level objective, not a single-model objective.

## Decision-Grade First

Decision-grade output has priority over:
- lower latency,
- fewer API calls,
- lower token spend.

Cost and speed matter, but they are secondary constraints. Any optimization that degrades decision quality is a regression.

## Maximum Extraction, Not Minimum Filtering

ResearchIt's goal is to extract the maximum decision-grade value from the evidence actually available — from LLM memory and from live retrieval — not to enforce a purity threshold that rejects otherwise-strong research because of source-level noise.

Quality gates exist to tell the user **what to trust**, not to refuse to ship well-reasoned work when verification signals are imperfect. A gate that fails when the pipeline is operating correctly is mis-calibrated.

Engineering consequences:
- Gate thresholds must be calibrated against what memory + retrieval can realistically produce on well-documented topics. If the pipeline works and the gate still fails, the gate is wrong — not the output.
- Recovery stages strengthen weak cells; they do not disqualify them wholesale.
- Where evidence is genuinely thin, the system surfaces that cell-by-cell in the output — not by dropping it.
- Factual accuracy must not be penalised for verification-infrastructure noise (anti-bot blocks, paywalls, rate limits, stale slugs, moved redirects).

This principle does not override "No Silent Failure" below — it constrains it. Both apply.

## No Silent Failure Policy

ResearchIt must not silently return "complete" output when core quality/completeness gates are unmet.

If hard quality gates fail, the system should:
1. retry within bounded recovery rules,
2. then fail/abort with explicit reason codes if still below the bar.

This is intentionally aggressive. Weak output from an internal pipeline issue (bug, prompt drift, model behaviour change) is often indistinguishable from weak output from a genuine data gap. Aborting preserves the remediation signal and avoids publishing low-quality work as if it were decision-grade.

Degraded output is acceptable only when explicitly labeled and when hard abort criteria are not violated.

### What counts as fatal

Hard-abort when:
- **Pipeline-structural failure**: parse exhaustion, route mismatch, stage exception, transport failure beyond retry budget.
- **Fabrication at scale**: a meaningful fraction of citations are URLs not present in the provider's retrieval set, or 404 on the subject's own domain. This indicates the output is unreliable regardless of reasoning quality.
- **Quality gates fail after the above are ruled out**: signals pipeline / prompt / model drift and must produce actionable diagnostics. Failure reason must distinguish infrastructure noise, pipeline coercion, data gap, and fabrication — so remediation is targeted, not speculative.

Do **not** hard-abort solely on:
- Verification-infrastructure noise (`403`, `429`, paywall, timeout) — these are source-level reachability signals, not quality signals.
- Cell-level gaps where the model correctly expressed low confidence on genuinely hard-to-find information.

### Grounding vs. citation verifiability

Evidence grounding — whether a claim is anchored in real retrieved content — is not the same as URL verifiability at a later point in time. Legitimate well-grounded sources routinely fail post-hoc URL checks: anti-bot responses (`403`), rate limits (`429`), paywalls, DOI/archive redirects, slugs that moved. Conversely, a model can emit well-formed URLs that were never retrieved and do not exist.

Engineering consequences:
- Gate on fabrication signals (URL absent from the provider's grounding set; 404 on the vendor's own domain; citation contradicted by retrieved content), not on reachability alone.
- Treat transport-unreachable sources (`403`, `429`, paywall, timeout) as neutral evidence, not as quality failures.
- Preserve the evidence content even when URLs cannot be verified — verification status is a separate signal attached to each source, not a reason to drop the source.

## Required Engineering Behavior

- Prefer recover-or-fail over silent degradation. No automatic provider/model failover in quality-critical flows.
- Preserve evidence content; do not drop valid model output due to schema mapping drift.
- Enforce actor model/provider routing correctness in strict/test runs.
- Track and expose diagnostics needed to explain quality outcomes.
- Evaluate pipeline changes by decision-grade impact first, not by functional completion alone.

## Source of Truth for Prioritization

When tradeoffs conflict, `quality/completeness/accuracy/decision-readiness` wins.

Backlog prioritization, architecture decisions, and release gates should be evaluated against this document.
