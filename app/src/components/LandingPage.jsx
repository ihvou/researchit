import ChevronIcon from "./ChevronIcon.jsx";
import SiteFooter from "./SiteFooter.jsx";

const AUDIENCE_BLOCKS = [
  {
    title: "Founders",
    text: "Pressure-test ideas before you commit roadmap, hiring, and GTM budget.",
  },
  {
    title: "Top Managers",
    text: "Compare strategic options with explicit evidence and confidence, not slides-only narratives.",
  },
  {
    title: "Analysts",
    text: "Run repeatable research frameworks with auditable outputs and exports.",
  },
];

const POWER_BLOCKS = [
  {
    title: "Evidence-first by default",
    text: "Research it prioritizes verifiable evidence before scoring or recommendations.",
  },
  {
    title: "Built-in critic pass",
    text: "A dedicated critic model challenges weak claims and confidence inflation.",
  },
  {
    title: "Scorecard and matrix modes",
    text: "Use scorecards for go/no-go decisions and matrices for side-by-side comparisons.",
  },
  {
    title: "Operational outputs",
    text: "Export JSON/HTML/PDF artifacts and keep a reproducible research trail.",
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
          <p className="landing-kicker">Strategic Research Instrument</p>
          <h1>Make higher-stakes decisions with evidence you can defend.</h1>
          <p className="landing-subtitle">
            Research it helps founders, executives, and analysts evaluate ideas, markets, channels, and competitors using a structured analyst-plus-critic workflow.
          </p>
          <div className="landing-hero-actions">
            <button
              type="button"
              className="landing-btn landing-btn-primary"
              onClick={onOpenWorkspace}>
              Start Researching
            </button>
          </div>
        </section>

        <section className="landing-grid-section">
          <h2>Why Founders, Leaders, and Analysts Use Research it</h2>
          <div className="landing-grid landing-grid-4">
            {POWER_BLOCKS.map((item) => (
              <article key={item.title} className="landing-card">
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
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
          <h2>Start With These Researches</h2>
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
      </main>
      <SiteFooter onExportDebug={onExportDebug} />
    </div>
  );
}
