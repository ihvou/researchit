import ChevronIcon from "./ChevronIcon.jsx";
import SiteFooter from "./SiteFooter.jsx";

const AUDIENCE_BLOCKS = [
  {
    title: "Founders",
    text: "Validate market demand, size an opportunity, map competitors, and assess GTM before committing resources - with an audit trail you can show investors.",
  },
  {
    title: "Strategy and product teams",
    text: "Run build-vs-buy, market entry, or expansion decisions with per-dimension evidence and a Critic challenge - outputs you can defend in a board review.",
  },
  {
    title: "Analysts and consultants",
    text: "Reproducible research frameworks with configurable rubrics, confidence calibration, and exports that hold up to scrutiny.",
  },
];

const POWER_BLOCKS = [
  {
    title: "Evidence before scoring",
    text: "Each dimension is researched with live web search and cited sources before any score is assigned. Nothing is inferred from training data alone.",
  },
  {
    title: "Built-in Critic that disagrees",
    text: "A second model reviews the Analyst's output, challenges overconfident claims, and flags dimensions where evidence is thin. Disagreement is visible, not hidden.",
  },
  {
    title: "Two output modes",
    text: "Scorecards for go/no-go decisions - scored dimensions, weighted total, confidence per claim. Matrices for side-by-side comparisons across competitors, segments, or channels.",
  },
  {
    title: "Exportable and re-importable",
    text: "Every run exports to JSON, HTML, and PDF. Re-import to continue where you left off. Share with colleagues for async review and challenge.",
  },
];

function cardDescription(config) {
  const shortDescription = String(config?.shortDescription || "").trim();
  if (shortDescription) return shortDescription;
  const methodology = String(config?.methodology || "").trim();
  if (!methodology) return "Config-driven decision research with evidence, confidence, and critique.";
  const first = methodology.split(/(?<=[.!?])\s+/)[0] || methodology;
  return first.length > 190 ? `${first.slice(0, 187)}...` : first;
}

export default function LandingPage({
  featuredConfigs = [],
  onOpenConfig,
  onOpenWorkspace,
  onExportDebug,
}) {
  const DESKTOP_VISIBLE_CONFIG_COUNT = 4;
  const desktopTabConfigs = featuredConfigs.slice(0, DESKTOP_VISIBLE_CONFIG_COUNT);
  const desktopVisibleIds = new Set(desktopTabConfigs.map((config) => config.id));
  const hiddenTabConfigs = featuredConfigs.filter((config) => !desktopVisibleIds.has(config.id));

  return (
    <div className="landing-shell">
      <header className="landing-top">
        <div className="landing-brand">
          <div className="landing-logo-box">
            <span className="landing-logo-number">75</span>
            <span className="landing-logo-mark">Re</span>
          </div>
          <span className="landing-brand-name">Research it</span>
        </div>
        <div className="landing-top-actions">
          <div className="config-nav-desktop">
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.7 }}>
              Researches Available:
            </span>
            {desktopTabConfigs.map((config) => (
              <button
                key={config.id}
                type="button"
                onClick={() => onOpenConfig?.(config)}
                style={{
                  padding: "7px 12px",
                  fontSize: 13,
                  fontWeight: 700,
                  border: "1px solid var(--ck-line)",
                  background: "var(--ck-surface)",
                  color: "var(--ck-muted)",
                  whiteSpace: "nowrap",
                }}>
                {config.tabLabel || config.name}
              </button>
            ))}
            {hiddenTabConfigs.length ? (
              <details style={{ position: "relative" }}>
                <summary style={{
                  background: "var(--ck-surface)",
                  border: "1px solid var(--ck-line)",
                  color: "var(--ck-text)",
                  padding: "7px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                }}>
                  <span>More</span>
                  <ChevronIcon direction="down" size={12} />
                </summary>
                <div style={{
                  position: "absolute",
                  right: 0,
                  top: "calc(100% + 6px)",
                  minWidth: 220,
                  background: "var(--ck-surface)",
                  border: "1px solid var(--ck-line)",
                  borderRadius: 2,
                  display: "grid",
                  gap: 4,
                  padding: 6,
                  zIndex: 40,
                }}>
                  {hiddenTabConfigs.map((config) => (
                    <button
                      key={`hidden-${config.id}`}
                      type="button"
                      onClick={(e) => {
                        onOpenConfig?.(config);
                        e.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                      style={{
                        textAlign: "left",
                        background: "var(--ck-surface-soft)",
                        border: "1px solid var(--ck-line)",
                        color: "var(--ck-text)",
                        padding: "6px 8px",
                        fontSize: 12,
                        fontWeight: 600,
                      }}>
                      {config.tabLabel || config.name}
                    </button>
                  ))}
                </div>
              </details>
            ) : null}
          </div>

          <details className="config-nav-mobile" style={{ position: "relative" }}>
            <summary style={{
              background: "var(--ck-surface)",
              border: "1px solid var(--ck-line)",
              color: "var(--ck-text)",
              padding: "7px 10px",
              fontSize: 12,
              fontWeight: 700,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              textTransform: "uppercase",
              letterSpacing: 0.6,
            }}>
              <span>Researches Available</span>
              <ChevronIcon direction="down" size={12} />
            </summary>
            <div style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 6px)",
              minWidth: 240,
              maxHeight: 320,
              overflowY: "auto",
              background: "var(--ck-surface)",
              border: "1px solid var(--ck-line)",
              borderRadius: 2,
              display: "grid",
              gap: 4,
              padding: 6,
              zIndex: 45,
            }}>
              {featuredConfigs.map((config) => (
                <button
                  key={`mobile-${config.id}`}
                  type="button"
                  onClick={(e) => {
                    onOpenConfig?.(config);
                    e.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                  style={{
                    textAlign: "left",
                    background: "var(--ck-surface-soft)",
                    border: "1px solid var(--ck-line)",
                    color: "var(--ck-text)",
                    padding: "6px 8px",
                    fontSize: 12,
                    fontWeight: 600,
                  }}>
                  {config.tabLabel || config.name}
                </button>
              ))}
            </div>
          </details>
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <div className="landing-hero-layout">
            <div className="landing-hero-copy">
              <p className="landing-kicker">Evidence-first. Critic-reviewed. Auditable.</p>
              <h1>Research before you build.</h1>
              <p className="landing-subtitle">
                Structured AI research for product and strategy decisions. Every run scores evidence per dimension, surfaces a Critic challenge, and produces an auditable artifact - not a confident-sounding narrative.
              </p>
              <div className="landing-hero-actions">
                <button
                  type="button"
                  className="landing-btn landing-btn-primary"
                  onClick={onOpenWorkspace}>
                  Run your first research
                </button>
              </div>
            </div>

            <aside className="landing-hero-diagram" aria-label="Comparison of generic LLMs and Research it workflow">
              <div className="hero-diagram-columns">
                <div className="hero-diagram-column">
                  <div className="hero-diagram-column-label">Generic LLMs</div>
                  <div className="hero-diagram-card hero-diagram-card-flow hero-diagram-card-flow-top">
                    <span className="hero-diagram-card-head">Your question</span>
                  </div>
                  <div className="hero-diagram-arrow">↓</div>
                  <div className="hero-diagram-card hero-diagram-card-flow">
                    <span className="hero-diagram-card-head">Single model pass</span>
                    <span className="hero-diagram-card-sub">one shot, no explicit structure</span>
                  </div>
                  <div className="hero-diagram-arrow">↓</div>
                  <div className="hero-diagram-card hero-diagram-card-flow">
                    <span className="hero-diagram-card-head">Narrative output</span>
                    <span className="hero-diagram-card-sub">confident, hard to audit</span>
                  </div>
                  <div className="hero-diagram-list">
                    <div className="hero-diagram-item">no evidence trail</div>
                    <div className="hero-diagram-item">hallucinations hidden</div>
                    <div className="hero-diagram-item">hard to challenge</div>
                  </div>
                </div>

                <div className="hero-diagram-column">
                  <div className="hero-diagram-column-label">Research it - LLM wrapper</div>
                  <div className="hero-diagram-card hero-diagram-card-flow hero-diagram-card-flow-top">
                    <span className="hero-diagram-card-head">Question + research type</span>
                  </div>
                  <div className="hero-diagram-arrow">↓</div>
                  <div className="hero-diagram-card hero-diagram-card-flow">
                    <span className="hero-diagram-card-head">Analyst model pass</span>
                    <span className="hero-diagram-card-sub">web search · evidence per dimension · score 1-5 · confidence level</span>
                  </div>
                  <div className="hero-diagram-arrow">↓</div>
                  <div className="hero-diagram-card hero-diagram-card-flow">
                    <span className="hero-diagram-card-head">Critic model challenge</span>
                    <span className="hero-diagram-card-sub">challenges weak claims · flags thin evidence</span>
                  </div>
                  <div className="hero-diagram-arrow">↓</div>
                  <div className="hero-diagram-card">
                    <span className="hero-diagram-card-head">Structured output</span>
                    <span className="hero-diagram-card-sub">scorecard or matrix · auditable artifact</span>
                  </div>
                  <div className="hero-diagram-arrow">↓</div>
                  <div className="hero-diagram-card hero-diagram-card-note">
                    <span className="hero-diagram-card-head">Refine manually</span>
                    <span className="hero-diagram-card-sub">debate scoring and evidence</span>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </section>

        <section className="landing-grid-section">
          <h2>Who It Is For</h2>
          <div className="landing-grid landing-grid-3">
            {AUDIENCE_BLOCKS.map((item) => (
              <article key={item.title} className="landing-card">
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-grid-section">
          <h2>Research Types</h2>
          <div className="landing-grid landing-grid-featured">
            {featuredConfigs.map((config) => (
              <article key={config.id} className="landing-card landing-feature-card">
                <div className="landing-feature-top">
                  <span className="landing-tag">{config.outputMode === "matrix" ? "Matrix" : "Scorecard"}</span>
                  <span className="landing-slug">/{config.slug}/</span>
                </div>
                <h3>{config.tabLabel || config.name}</h3>
                <p>{cardDescription(config)}</p>
                <button
                  type="button"
                  className="landing-btn landing-btn-ghost"
                  onClick={() => onOpenConfig?.(config)}>
                  Open Research
                </button>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-grid-section">
          <h2>How It Works</h2>
          <div className="landing-grid landing-grid-4">
            {POWER_BLOCKS.map((item) => (
              <article key={item.title} className="landing-card">
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter onExportDebug={onExportDebug} />
    </div>
  );
}
