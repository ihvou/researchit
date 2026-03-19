# Task Backlog — AI Use Case Prioritizer

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

---

## P0 — Stability & correctness (do first)

### [~] T-01: JSON parse resilience for Phase 1 truncation
**Problem**: Phase 1 requests ~11k tokens of structured JSON. If response truncates mid-object, the parser throws and the whole analysis fails.
**What's done**: Raised max_tokens to 12,000. Added structural JSON repair (closes unclosed strings/arrays/objects). Added condensed retry fallback prompt.
**Remaining**:
- [ ] Add a visible "Retrying with condensed prompt…" status message in the UI when fallback triggers
- [ ] Log which dimensions came back with truncated `full` fields (length < 100 chars) and flag them in UI with a "⚠ condensed" badge
- [ ] Consider splitting Phase 1 into two API calls: attributes + first 6 dims, then last 5 dims — eliminates truncation entirely at cost of one extra call

### [ ] T-02: Per-phase error recovery
**Problem**: If Phase 2 (Critic) or Phase 3 (Analyst response) fails, the whole use case shows as error even though Phase 1 data is valid and displayable.
**Fix**: Catch Phase 2 and Phase 3 errors independently. If Critic fails, show Phase 1 results as "partial — critic unavailable" and still render the Dimensions tab. If Phase 3 fails, show the Critic's raw output without the Analyst response.

### [ ] T-03: Timeout UX
**Problem**: 2+ minute analyses show no progress feedback other than a spinner and phase label.
**Fix**: Add a per-phase elapsed timer ("🔍 Researching… 0:42") so PM knows it's working. Add a soft timeout warning at 90s ("Taking longer than usual — API may be under load").

---

## P1 — Core feature gaps

### [ ] T-04: Web search integration for Phase 1
**What**: Enable the Analyst to fetch live market data before scoring — vendor pages, press releases, recent case studies, pricing pages.
**How**: Add `tools: [{ type: "web_search_20250305", name: "web_search" }]` to Phase 1 API call. Handle multi-turn tool-use loop: check `stop_reason === "tool_use"`, extract `web_search` tool blocks, send results back as `tool_result` content, continue until `stop_reason === "end_turn"`.
**Impact**: Sources become verifiable real URLs instead of training-knowledge-based citations. Scores reflect current market (new entrants, recent acquisitions, pricing changes).
**Notes**: Will increase Phase 1 latency by 20-40s but dramatically improves evidence quality. Should be opt-in toggle in UI ("🔍 Live search" checkbox).

### [ ] T-05: GPT-4o as Critic option
**What**: Route Phase 2 (Critic) to OpenAI GPT-4o instead of Claude Sonnet for genuine model diversity.
**How**:
- Add `OPENAI_API_KEY` to backend proxy env
- Add `criticModel` selector in UI: "Claude Sonnet" / "GPT-4o" (default to Claude until backend proxy is set up)
- For GPT-4o call: `POST https://api.openai.com/v1/chat/completions`, model `gpt-4o`, same JSON schema, parse `choices[0].message.content`
- Response format is identical — same `safeParseJSON` works
**Why**: GPT-4o has different training priors on market data and vendor landscape. Critic disagreements become more meaningful.

### [ ] T-06: Session persistence (localStorage)
**What**: Use cases survive page refresh.
**How**: On every `setUseCases` update, serialize to `localStorage.setItem('uc_state', JSON.stringify(useCases))`. On mount, hydrate from localStorage. Add "Clear all" button.
**Notes**: Keep a max of 20 use cases. Serialize only completed/error states — skip in-progress analyses (they can't be resumed).

### [ ] T-07: Delete and re-analyze per row
**What**: Each row in the table needs a delete button (×) and a re-analyze button (↺).
**Re-analyze**: Resets the use case to blank and reruns all 3 phases with the same `rawInput`. Useful after changing dimension weights.
**Delete**: Removes from state and localStorage.

### [ ] T-08: Sort table by weighted score
**What**: Click the "Score" column header to sort rows descending by weighted score.
**Secondary**: Add sort by individual dimension columns too.

---

## P2 — Output & sharing

### [ ] T-09: Export to PDF / shareable report
**What**: Export the full analysis of one use case as a clean PDF — title, attributes, dimension scores with evidence, debate summary, conclusion.
**How**: Use `@react-pdf/renderer` or generate an HTML page and call `window.print()` with a print stylesheet. The HTML approach is simpler and requires no new dependency.
**Format**: 2-3 page document. Cover: title, score, tier, vertical, buyer persona. Body: one section per dimension with score, brief, key evidence, risks. Back: debate summary and conclusion.

### [ ] T-10: Compare view (side-by-side 2-3 use cases)
**What**: Select 2-3 use cases and view their dimension scores side-by-side for go/no-go decision making.
**How**: Add checkboxes to table rows. "Compare selected" button opens a modal with a radar/spider chart (recharts `RadarChart`) overlaying scores for selected use cases.

---

## P3 — AI-assisted enhancements

### [ ] T-11: LLM-suggested dimensions (Phase 0)
**What**: Before Phase 1 runs, add a Phase 0 call that reads the use case description and suggests custom dimensions specific to that use case — e.g. for a healthcare use case it might suggest "Clinical Validation Pathway" as an additional dimension.
**How**: Small fast call (Haiku), returns array of `{id, label, brief, fullDef}`. PM can accept/reject each suggestion before Phase 1 runs.

### [ ] T-12: Auto-generated GTM pitch brief
**What**: After analysis is complete, one-click generates a 1-page go-to-market brief for that use case — buyer profile, pain point framing, proof points, suggested engagement model, competitive positioning.
**How**: New API call post-Phase 3 using the full analysis as context. Output rendered in a modal and exportable. This is the "downstream prototype" that closes the loop from prioritization to pitching.

### [ ] T-13: Batch analysis mode
**What**: Paste a list of 5-10 use case descriptions and run them all. Each queues and runs sequentially (or parallel with rate-limit handling). Useful for rapid portfolio mapping with a new client.

---

## Infrastructure (do when moving out of Claude.ai sandbox)

### [ ] T-14: Backend proxy for API keys
**What**: Vercel serverless function at `/api/analyze` that proxies requests to Anthropic (and optionally OpenAI) with keys in env vars. Frontend calls `/api/analyze` instead of `api.anthropic.com` directly.
**Files needed**: `api/analyze.js`, `api/critique.js` (if separating Critic endpoint), `.env.local` template.

### [ ] T-15: Vite project scaffold
**What**: Proper project structure for local dev and Vercel deployment.
```
prioritizer/
  src/
    App.jsx
    components/
      ScorePill.jsx
      EvidenceBlock.jsx
      FollowUpThread.jsx
      DimRubricToggle.jsx
    hooks/
      useAnalysis.js
      useFollowUp.js
    prompts/
      analyst.js
      critic.js
      followup.js
    constants/
      dimensions.js
  api/
    analyze.js
  public/
  index.html
  vite.config.js
  .env.local (gitignored)
```

### [ ] T-16: GitHub Actions CI
**What**: On push to main — lint (ESLint), build check (`vite build`), deploy preview to Vercel.

---

## Completed

- [x] Initial prototype — table, 3-phase debate, dimension scoring
- [x] Expanded to 11 dimensions with full rubrics
- [x] Rich evidence (brief + full + sources + risks) with expand/collapse
- [x] Build vs. Buy Pressure dimension replacing generic Competitive Space
- [x] Per-dimension follow-up challenge threads with score revision
- [x] Citations required in all 3 LLM phases
- [x] Phase 1 token ceiling raised to 12k + JSON repair + condensed retry fallback
