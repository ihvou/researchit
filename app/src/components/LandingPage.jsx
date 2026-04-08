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
    text: "Researchit prioritizes verifiable evidence before scoring or recommendations.",
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

function summarizeMethodology(text) {
  const raw = String(text || "").trim();
  if (!raw) return "Config-driven decision research with evidence, confidence, and critique.";
  const first = raw.split(/(?<=[.!?])\s+/)[0] || raw;
  return first.length > 180 ? `${first.slice(0, 177)}...` : first;
}

export default function LandingPage({
  featuredConfigs = [],
  onOpenConfig,
  onOpenWorkspace,
}) {
  return (
    <div className="landing-shell">
      <header className="landing-top">
        <div className="landing-brand">
          <div className="landing-logo-box">
            <span className="landing-logo-number">75</span>
            <span className="landing-logo-mark">Re</span>
          </div>
          <span className="landing-brand-name">Researchit</span>
        </div>
        <div className="landing-top-actions">
          <button
            type="button"
            className="landing-btn landing-btn-ghost"
            onClick={onOpenWorkspace}>
            Open Workspace
          </button>
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-hero">
          <p className="landing-kicker">Strategic Research Instrument</p>
          <h1>Make higher-stakes decisions with evidence you can defend.</h1>
          <p className="landing-subtitle">
            Researchit helps founders, executives, and analysts evaluate ideas, markets, channels, and competitors using a structured analyst-plus-critic workflow.
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
          <h2>Why Teams Use Researchit</h2>
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
                <p>{summarizeMethodology(config.methodology)}</p>
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
    </div>
  );
}
