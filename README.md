# AI Use Case Prioritizer

Internal tool for an AI outsourcing company's product & GTM team. Takes a vague problem or solution statement, runs a 3-phase AI analyst ↔ critic debate, and outputs a scored, evidence-backed prioritization across 11 dimensions relevant to custom AI delivery.

## What it does

1. PM enters a use case description (e.g. "AI for insurance claims processing")
2. **Phase 1 — Analyst** scores the use case across 11 dimensions with brief + full evidence, sources, and risks per dimension
3. **Phase 2 — Critic** challenges overconfident scores, names real SaaS incumbents and counter-evidence
4. **Phase 3 — Analyst responds** per dimension — concedes with revised score or defends with new evidence
5. PM sees a scored table with expandable detail and can **challenge any dimension directly** via a follow-up thread, triggering a new Analyst response

## Key design decisions

- **Outsourcing delivery context throughout** — not a SaaS product builder tool. Every dimension is framed around "does a custom delivery project exist here?"
- **Build vs. Buy Pressure** replaces generic "Competitive Space" — score 5 = no SaaS, client must commission custom build; score 1 = commodity SaaS covers it, no project opportunity
- **Evidence-first scoring** — Analyst is instructed to cite named companies with specific metrics and real URLs. Scores without evidence are invalid
- **Multi-LLM debate** — Analyst and Critic currently both use Claude Sonnet 4.6. Architecture supports swapping Critic to GPT-4o for genuine model diversity (see TASKS)
- **Per-dimension follow-up threads** — PM can challenge any individual dimension score in a collapsible thread; score revisions propagate to the weighted total

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

- **Frontend**: React (single JSX file, no build step required in Claude.ai sandbox)
- **AI**: Anthropic API — `claude-sonnet-4-20250514` for all 3 phases currently
- **API calls**: Made directly from the frontend (works in Claude.ai sandbox which injects auth). For external hosting, requires a backend proxy to protect API keys
- **Styling**: Inline styles only, dark theme (`#07090f` base)
- **Storage**: In-memory React state only — no persistence between sessions yet

## Running locally (once scaffolded)

```bash
npm create vite@latest prioritizer -- --template react
cd prioritizer
# replace src/App.jsx with ai-use-case-prioritizer.jsx contents
npm install
npm run dev
```

For external hosting, add a `/api/analyze` proxy route (Vercel serverless function or Express) that holds `ANTHROPIC_API_KEY` in env and forwards requests to `https://api.anthropic.com/v1/messages`.

## Source documents

The `docs/` folder contains the research report this tool was designed around:
- `Merged_ENTERPRISE_AI_DEPLOYMENTS_WITH_PROVEN_ROI__2024_2026.pdf` — 68+ verified enterprise AI case studies across 11 verticals, used as ground truth for scoring calibration

## Known issues

- Phase 1 can timeout or truncate on long responses — patched with 12k token ceiling + JSON repair + condensed retry fallback (see TASKS for remaining edge cases)
- No session persistence — refreshing loses all use cases
- Sources are training-knowledge-based, not live-fetched — web search integration pending
