# AI Use Case Researcher

Internal tool for an AI outsourcing company's product & GTM team. Takes a vague problem or solution statement, runs a 3-phase AI analyst / critic debate, and outputs a scored, evidence-backed prioritization across 11 dimensions relevant to custom AI delivery.

## What it does

1. PM enters a use case description (e.g. "AI for insurance claims processing")
2. **Phase 1 — Analyst** scores the use case across 11 dimensions with brief + full evidence, sources, risks, and a per-dimension confidence level (`high`/`medium`/`low`) + reason
3. **Phase 2 — Critic** audits Analyst claims with live web search, challenges overconfident scores, and cites current SaaS/incumbent counter-evidence
4. **Phase 3 — Analyst responds** per dimension — concedes with revised score or defends with new evidence, and updates confidence where needed
5. PM sees a scored table with expandable detail and can **challenge any dimension directly** via a follow-up thread, triggering a new Analyst response
6. PM selects an analysis mode (**Hybrid reliability** is default; also **Standard** and **Live search**) and uses the **Export** dropdown for **Summary CSV**, **Detail CSV**, **HTML report**, **PDF report**, or **Logs JSON**
7. PM can also export a single use case directly from the expanded row panel (**Export HTML** / **Export PDF** / **Export Images ZIP**)

## Key design decisions

- **Outsourcing delivery context throughout** — not a SaaS product builder tool. Every dimension is framed around "does a custom delivery project exist here?"
- **Build vs. Buy Pressure** replaces generic "Competitive Space" — score 5 = no SaaS, client must commission custom build; score 1 = commodity SaaS covers it, no project opportunity
- **Evidence-first scoring** — Analyst is instructed to cite named companies with specific metrics and real URLs. Scores without evidence are invalid
- **Per-dimension confidence** — every dimension includes confidence level (`high`/`medium`/`low`) plus a reason; low-confidence dimensions are visually flagged for manual validation
- **Multi-LLM debate** — Analyst uses OpenAI GPT-5.4 mini, Critic uses OpenAI GPT-5.4. Architecture supports swapping to other models via the API route layer
- **Live-search with fallback** — Analyst and Critic routes attempt OpenAI Responses API web search (`web_search` / `web_search_preview`) and fall back to standard completion if unavailable
- **Hybrid reliability mode (default)** — runs baseline (no web) + web-assisted draft, then reconciles both into a final Phase 1 result to reduce overreaction to weak web snippets
- **Per-dimension follow-up threads** — PM can challenge any individual dimension score in a collapsible thread; score revisions propagate to the weighted total
- **Layered exports via one menu** — Summary CSV + Detail CSV for data workflows, visual HTML/PDF report pack (portfolio overview, use-case summary pages, and per-dimension pages with citations), single-use-case HTML/PDF export, and on-demand debug log export

## 11 Scoring Dimensions

| ID | Dimension | Default Weight | What it measures |
|----|-----------|---------------|-----------------|
| `roi` | ROI Magnitude | 18% | Scale of verifiable financial impact |
| `ai_fit` | AI Applicability | 14% | How uniquely AI-suited vs traditional software |
| `evidence` | Evidence Density | 13% | Verified real-world deployments with quantified ROI |
| `ttv` | Time to Value | 11% | Speed from kick-off to measurable client ROI |
| `data_readiness` | Client Data Readiness | 9% | Whether clients have the data infrastructure needed |
| `feasibility` | Build Feasibility | 9% | Technical complexity for outsourcing delivery team |
| `market_size` | Market Size | 7% | Total potential client engagements globally |
| `build_vs_buy` | Build vs. Buy Pressure | 9% | Does SaaS already cover it well enough to kill the project? |
| `regulatory` | Regulatory & Compliance Risk | 8% | Scope expansion, delays, shared liability risk |
| `change_mgmt` | Change Management | 8% | Organizational resistance — leading cause of AI project failure |
| `reusability` | Reusability / Productization | 7% | Can this be repackaged across clients to build IP? |

Each dimension has a 5-level rubric with named examples baked into both the LLM prompt and the UI (expandable).

## Tech stack

- **Frontend**: Vite + React, modular component architecture
- **AI (Analyst)**: OpenAI GPT-5.4 mini via `/api/analyst.js` serverless function
- **AI (Critic)**: OpenAI GPT-5.4 via `/api/critic.js` serverless function
- **API routes**: Vercel serverless functions in `api/` — keys stay server-side
- **Analysis modes**: Standard (no web), Live search (web-assisted), Hybrid reliability (baseline + web + reconciliation)
- **Optional live web**: OpenAI Responses API tools for analyst Phase 1 when mode uses web
- **Critic web audit**: Critic phase always runs with live web-search attempt (with fallback), focused on verifying/challenging Analyst claims
- **Report exports**: Client-side HTML report generation and browser print-to-PDF flow (no extra backend required)
- **Styling**: Inline styles, light theme aligned to Ciklum visual language
- **Storage**: In-memory React state only — no persistence between sessions yet

## Project structure

```
ai-use-case-prioritizer/
  api/
    analyst.js          # Analyst LLM serverless route (OpenAI GPT-5.4 mini)
    critic.js           # Critic LLM serverless route (OpenAI GPT-5.4)
  src/
    App.jsx             # Main app shell
    main.jsx            # Entry point
    index.css           # Global styles
    components/
      DebateTab.jsx     # Phase 2-3 debate view
      DimRubricToggle.jsx
      DimensionsTab.jsx # Scored dimension table
      EvidenceBlock.jsx
      ExpandedRow.jsx
      FollowUpThread.jsx
      OverviewTab.jsx
      ScorePill.jsx
      SourcesList.jsx
      Spinner.jsx
      TotalPill.jsx
    constants/
      dimensions.js     # 11 dimensions with rubrics & weights
    hooks/
      useAnalysis.js    # 3-phase analysis orchestration + mode-aware Phase 1 (standard/live/hybrid)
      useFollowUp.js    # Per-dimension follow-up
    lib/
      api.js            # API call helpers
      dimensionView.js  # Derives latest per-dimension view (initial + debate + follow-up)
      export.js         # CSV + HTML + PDF export helpers
      json.js           # JSON parse + repair utilities
      scoring.js        # Score calculation helpers
    prompts/
      system.js         # System prompts for all LLM phases
  index.html
  vite.config.js
  vercel.json
  .env.local.example
```

## Running locally

```bash
npm install
npx vercel dev
```

The app runs at `http://localhost:3000`. Vercel CLI serves both the Vite frontend and the serverless API routes.

### Environment variables

Copy `.env.local.example` to `.env.local` and fill in your keys:

```
OPENAI_API_KEY=sk-...           # For OpenAI-based analyst & critic
```
Use **Export > Logs JSON** when needed to download captured analysis debug logs (prompt/response excerpts, parse failures, retries) and share that file for investigation.

## Deploying to Vercel

1. Push to GitHub
2. Import the repo in [Vercel](https://vercel.com)
3. Add `OPENAI_API_KEY` (and `ANTHROPIC_API_KEY` when needed) in Vercel project settings > Environment Variables
4. Deploy — Vercel auto-detects the Vite framework and `api/` routes

## Source documents

The `docs/` folder contains the research report this tool was designed around:
- `Merged_ENTERPRISE_AI_DEPLOYMENTS_WITH_PROVEN_ROI__2024_2026.pdf` — 68+ verified enterprise AI case studies across 11 verticals, used as ground truth for scoring calibration

## Known issues

- Phase 1 can timeout or truncate on long responses — patched with 12k token ceiling + JSON repair + condensed retry fallback
- No session persistence — refreshing loses all use cases
- Live search can increase variance in scores depending on source freshness/availability
- Analyst/Critic live search may fall back to non-search mode when web tool path is unavailable
- Hybrid reliability mode is slower/costlier because it runs three analyst passes before Critic
- PDF export relies on browser print capabilities and may look slightly different across browsers
- LLM JSON can still be malformed; parser includes stronger repair + debate/final retry, and debug logs are available on demand via the Export menu
- HTML report pages are optimized as landscape slides; PDF pages are optimized for portrait print
