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

## No Silent Failure Policy

ResearchIt must not silently return “complete” output when core quality/completeness gates are unmet.

If hard quality gates fail, the system should:
1. retry within bounded recovery rules,
2. then fail/abort with explicit reason codes if still below the bar.

Degraded output is acceptable only when explicitly labeled and when hard abort criteria are not violated.

## Required Engineering Behavior

- Prefer recover-or-fail over silent fallback.
- Preserve evidence content; do not drop valid model output due to schema mapping drift.
- Enforce actor model/provider routing correctness in strict/test runs.
- Track and expose diagnostics needed to explain quality outcomes.
- Evaluate pipeline changes by decision-grade impact first, not by functional completion alone.

## Source of Truth for Prioritization

When tradeoffs conflict, `quality/completeness/accuracy/decision-readiness` wins.

Backlog prioritization, architecture decisions, and release gates should be evaluated against this document.
