# AI Use Case Researcher

AI Use Case Researcher helps product and GTM teams assess enterprise AI opportunities for **custom outsourcing delivery**.
It converts broad ideas into evidence-backed scores, debate outcomes, and next best related use cases.

## Core Workflow

1. **Input**: PM enters a broad use case prompt.
2. **Phase 1 - Analyst (2-step)**:
   - **Step 1 - Evidence enumeration**: collects structured per-dimension facts, deployments, metrics, and source-backed signals (no scoring in this step).
   - **Step 2 - Rubric scoring from enumerated evidence**: applies the rubric to the enumerated evidence and produces scores, confidence, rationale, risks, and sources.
3. **Phase 2 - Critic**: pressure-tests Analyst claims and scores.
4. **Phase 3 - Analyst Response**: updates reasoning and final per-dimension scores after critique.
5. **Phase 4 - Discover**: generates 3-5 related candidates targeted at weak dimensions.

After completion, PM can:
- review Overview / Dimensions / Debate & Challenges / Discover / Progress tabs,
- use follow-up in-thread with intent-aware handling (challenge, question, reframe, add evidence, note/comment, re-search),
- inspect each dimension as structured arguments (supporting evidence vs limiting factors),
- challenge a specific argument directly or discard an argument (discarded items remain visible for audit),
- review and explicitly **accept** or **dismiss** any proposed score change (no silent score mutation),
- run full analysis for a discovered candidate via **Analyse ->**,
- export portfolio or single-use-case reports.

## Analysis Pipeline (Fixed)

The app now runs a single quality-first pipeline. There is no user-facing mode selector.

Every analysis run executes:
1. Analyst baseline pass (memory-only): evidence enumeration then scoring
2. Analyst web pass (live-search assisted): evidence enumeration then scoring
3. Hybrid reconcile pass: merge baseline + web evidence, then re-score
4. Targeted confidence cycle for weak dimensions:
   - Triggered for `low` confidence dimensions
   - Also triggered for `medium` confidence dimensions when `missingEvidence` is specific
5. Critic web audit pass
6. Analyst final response pass
7. Final consistency check pass
8. Discover generation + candidate pre-validation

Live web is attempted where applicable and can fallback to non-web completion when the tool path fails; fallback reasons are captured in debug logs.

## Prompt Structure and JSON Contracts

Prompting is role-based and schema-driven:
- System prompts live in `src/prompts/system.js`:
  - `SYS_ANALYST`
  - `SYS_CRITIC`
  - `SYS_ANALYST_RESPONSE`
  - `SYS_FOLLOWUP`
- Each call expects JSON-only output with explicit schema templates to reduce malformed responses.

### What the user prompt contains at each stage

The app builds a different **user prompt** for each stage (in addition to the system prompt).  
Each prompt includes context + clear instructions + strict JSON output schema.

| Stage | What is sent in the user prompt (human-readable) | What the model must return |
|---|---|---|
| Phase 1A: Evidence enumeration (baseline/web) | Original use-case text, full rubric, dimension list, and evidence rules. In web pass, it also includes required search-depth instructions for top-weighted dimensions. | Per-dimension evidence facts + missing evidence gaps only (no scores). |
| Phase 1B: Scoring from evidence (baseline/web) | Same use-case text + the full JSON evidence payload from 1A + rubric + confidence calibration rules. | Per-dimension score, confidence, brief/full reasoning, risks, sources, argument lists. |
| Phase 1C: Hybrid reconcile evidence | Side-by-side summary of baseline draft and web draft (scores/confidence/brief/sources/missing evidence) for every dimension, plus merge rules. | One merged evidence-only payload that keeps best-supported facts and unresolved gaps. |
| Phase 1D: Reconcile scoring | Reconciled evidence JSON + rubric + confidence rules. | Reconciled per-dimension scores and reasoning. |
| Targeted cycle A: Query planning (for low confidence, and some medium with specific gaps) | Use-case text + one target dimension + current score/confidence + explicit evidence gap. | 3-4 focused search queries + one-sentence gap statement. |
| Targeted cycle B: Web harvest | Target dimension + generated queries + current context. | Raw findings by query, with source links and useful/not-useful coverage. |
| Targeted cycle C: Dimension re-score | Current dimension state + query plan + harvested findings + single-dimension rubric. | Updated score/confidence/reasoning for that dimension + research brief. |
| Phase 2: Critic audit | Use-case text + analyst outputs per dimension (score/confidence/brief/full/sources) + rubric reminders. Plain-language instruction: verify claims, look for contradictions, and challenge weak points. | Per-dimension critique, suggested score, evidence links, plus overall feedback. |
| Phase 3: Analyst response to critic | Phase-1 anchor scores/confidence + critic feedback + defend/concede rules + confidence-revision rules + wording requirements for brief summaries. | Final per-dimension decision (`defend`/`concede`), final score, confidence, brief, response text, sources, conclusion. |
| Phase 3 retry/fallback prompts | Same context, but with tighter JSON constraints (shorter fields, stricter limits) when parse fails. | Same schema, but compressed and parse-safe. |
| Consistency check | Initial score, critic suggestion, and final score snapshots per dimension + rubric reminder. | Any needed score adjustments with short reasons. |
| Discover generation | Use-case text + final conclusion + weakest dimensions + specific limiting factors. | 3-5 related candidates with rationale, expected improved dimensions, and how each candidate fixes limiting factors. |
| Discover pre-validation | Original use case + one candidate + current scores for claimed improved dimensions. | Predicted scores for claimed dimensions and pass/fail rationale for validation filter. |
| Follow-up: intent classification | Latest PM message + dimension + recent thread context. | One intent label (`challenge|question|reframe|add_evidence|note|re_search`) + short rationale. |
| Follow-up: intent execution | Intent-specific context (e.g., PM question, fetched URL content, targeted evidence gaps, argument under challenge). | Intent-specific JSON reply; score changes are always proposals that PM explicitly accepts/dismisses. |

## Model Request Profile (Approximate)

### Runtime model configuration
- Analyst and Critic model identifiers are configured in API handlers:
  - `api/analyst.js`
  - `api/critic.js`
- Live-search calls use Responses API tools (`web_search` / `web_search_preview`) with fallback to non-tool completion.

### Analysis run request pattern

Core run (all active dimensions are batch-processed, not one call per dimension):

| Stage | Route / runtime config | Typical calls | Notes |
|---|---|---:|---|
| Baseline analyst pass | Analyst route (configured analyst model) | 2 | Evidence + scoring |
| Web analyst pass | Analyst route (configured analyst model) | 2 | Evidence (live web) + scoring |
| Reconcile analyst pass | Analyst route (configured analyst model) | 2 | Reconcile evidence + scoring |
| Targeted confidence cycle | Analyst route (configured analyst model) | +3 per targeted dimension | Query plan + targeted live search + re-score |
| Critic audit | Critic route (configured critic model) | 1 | +1 retry on parse failure |
| Analyst response | Analyst route (configured analyst model) | 1 | +up to 2 retries on parse failure |
| Consistency check | Analyst route (configured analyst model) | 1 | Post-response score audit |
| Discover generation | Analyst route (configured analyst model) | 1 | +1 retry on parse failure |
| Discover validation | Analyst route (configured analyst model) | +1 per candidate | Up to 5 candidates |

No-retry formula:
- `total_calls ~= 10 + (3 * targeted_dimensions) + validated_candidates`

Examples:
- Low-variance run (`targeted_dimensions=0`, `validated_candidates=3`): about `13` model calls
- Typical run (`targeted_dimensions=2`, `validated_candidates=4`): about `20` model calls
- Deep run (`targeted_dimensions=4`, `validated_candidates=5`): about `27` model calls

Retry behavior can add extra calls when strict JSON repair retries are needed.

### Follow-up request pattern (per PM message)

- Intent classification: `1` analyst call
- Intent execution:
  - `note`: `0` extra model calls
  - `question|reframe|challenge`: `+1` analyst call
  - `add_evidence`: `+1` analyst call (+ up to 3 source-fetch HTTP calls to `/api/fetch-source`)
  - `re_search`: `+1` analyst live-search call

## Scoring Model

Dimension definitions, IDs, and default weights are configuration-driven:
- Source of truth: `src/constants/dimensions.js`
- Runtime controls: UI dimension toggles/weights in the Dimensions panel
- Import/export: JSON includes a dimension configuration snapshot for compatibility checks

Each dimension includes:
- score (`1-5`)
- brief summary
- full analysis
- risks
- sources
- confidence + reason
- `arguments.supporting[]`: evidence claims that push score up
- `arguments.limiting[]`: constraints that cap score
- argument audit state: active/discarded, discard reason, and thread-linked updates

## Export Options

Global **Export** menu:
- `HTML Report`
- `PDF Report`
- `Portfolio JSON`
- `Logs JSON`

Global toolbar:
- `Import JSON` (single use case or portfolio envelope)

Single-use-case panel:
- `Export HTML` (generated on demand, opens in a new tab)
- `Export PDF`
- `Export Images ZIP`
- `Export JSON`

Report pages include argument sections per dimension:
- `Supporting Evidence`
- `Limiting Factors`
- discarded arguments shown as discarded (not deleted)

## Tech Stack

- Frontend: React + Vite
- API routes: Vercel serverless functions (`app/api/analyst.js`, `app/api/critic.js`, `app/api/fetch-source.js`)
- Provider adapter: shared OpenAI provider in `engine/providers/openai.js`
- Web search path: OpenAI Responses API tools (`web_search` / `web_search_preview`) with fallback
- Storage: in-memory UI state (no persistence yet)

## Repository Layout

```txt
researchit/
  app/                               # Product shell
    api/
      analyst.js
      critic.js
      fetch-source.js
    src/
      App.jsx
      components/
      hooks/
      lib/
      constants/
      prompts/
    package.json
  engine/                            # Reusable research engine
    pipeline/
      analysis.js
      followUp.js
    providers/
      openai.js
    lib/
      arguments.js
      confidence.js
      debug.js
      dimensionView.js
      followUpIntent.js
      json.js
      researchBrief.js
      rubric.js
      scoring.js
      serialize.js
      transport.js
    configs/
      ai-use-case-dims.js
    prompts/
      defaults.js
    index.js
  configs/
    ai-use-case-prioritizer.js
```

## Local Setup

```bash
cd app
npm install
npx vercel dev
```

App URL: `http://localhost:3000`

### Environment

Create `app/.env.local`:

```bash
OPENAI_API_KEY=sk-...
```

## Deploy (Vercel)

1. Push to GitHub
2. Import repo into Vercel
3. Add `OPENAI_API_KEY` in Project Settings -> Environment Variables
4. Keep auto-deploy enabled for `main`

## Current Constraints

- No local/session persistence yet.
- Long LLM JSON outputs can still require retry/repair.
- Live web paths may fallback to non-web mode when tool route is unavailable.
- Quality-first pipeline can be costlier/slower on runs with many targeted-dimension cycles and discovery validations.
- PDF output depends on browser print behavior.
