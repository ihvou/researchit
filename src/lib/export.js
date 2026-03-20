import { calcWeightedScore, dimScoreColor, totalScoreColor } from "./scoring";
import { getDimensionView, formatSourcesForCell } from "./dimensionView";

function csvEscape(value) {
  if (value == null) return "";
  const str = String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, "\"\"")}"`;
  return str;
}

function rowsToCsv(headers, rows) {
  const headerLine = headers.map(csvEscape).join(",");
  const rowLines = rows.map((row) => headers.map((h) => csvEscape(row[h])).join(","));
  return [headerLine, ...rowLines].join("\n");
}

function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function downloadHtml(filename, htmlContent) {
  const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function timestampTag() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `${y}${m}${d}-${h}${min}`;
}

function getScoreColumns(dims) {
  const cols = [];
  dims.forEach((d) => {
    cols.push(`${d.id}_score`);
    cols.push(`${d.id}_stage`);
  });
  return cols;
}

function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scoreTier(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "Unknown";
  if (n >= 80) return "Strong priority";
  if (n >= 65) return "Promising";
  if (n >= 50) return "Needs validation";
  return "Low priority";
}

function priorityIcon(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "❔";
  if (n >= 80) return "🚀";
  if (n >= 65) return "✅";
  if (n >= 50) return "⚠️";
  return "🧪";
}

function dimensionScoreIcon(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "❔";
  if (n >= 4.5) return "🏆";
  if (n >= 3.5) return "✅";
  if (n >= 2.5) return "⚠️";
  return "❗";
}

function sectionIcon(label) {
  const map = {
    "Strategic Conclusion": "🎯",
    "Full Analysis": "🧠",
    "Risks": "⚠️",
    "Sources": "🔎",
    "Debate": "⚖️",
    "Follow-up Thread": "💬",
    "Critic Sources": "🧾",
    "How to read this report": "🧭",
  };
  return map[label] || "📌";
}

function sourceListHtml(sources = []) {
  if (!sources?.length) return "<div class=\"muted\">No sources available.</div>";
  const items = sources.map((s) => {
    const name = escapeHtml(s?.name || "Unknown source");
    const quote = s?.quote ? `<div class="source-quote">${escapeHtml(s.quote)}</div>` : "";
    const url = s?.url
      ? `<a class="source-url" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.url)}</a>`
      : "";
    return `<li class="source-item"><div class="source-name">${name}</div>${quote}${url}</li>`;
  }).join("");
  return `<ul class="source-list">${items}</ul>`;
}

function citationBadgesHtml(sources = []) {
  if (!sources?.length) return "<div class=\"citation-line muted\">No citation listed.</div>";
  const badges = sources.slice(0, 2).map((s) => {
    const label = escapeHtml(s?.name || "Source");
    return `<span class="citation-badge">🔗 ${label}</span>`;
  }).join("");
  return `<div class="citation-line">${badges}</div>`;
}

function threadHistoryHtml(thread = []) {
  if (!thread?.length) return "<div class=\"muted\">No follow-up thread.</div>";
  const items = thread.map((m) => {
    const role = m?.role === "pm" ? "PM challenge" : "Analyst follow-up";
    const body = m?.role === "pm"
      ? (m?.text || "")
      : (m?.response || m?.text || "");
    return `
      <div class="thread-item">
        <div class="thread-role">${escapeHtml(role)}</div>
        <div class="thread-body">${escapeHtml(body)}</div>
      </div>
    `;
  }).join("");
  return `<div class="thread-list">${items}</div>`;
}

function section(label, body, className = "") {
  const icon = sectionIcon(label);
  return `
    <section class="section ${className}">
      <div class="section-label"><span class="section-icon">${icon}</span><span>${escapeHtml(label)}</span></div>
      <div class="section-body">${body}</div>
    </section>
  `;
}

function renderUseCaseSummaryPage(uc, dims, index) {
  const title = uc.attributes?.title || uc.rawInput || `Use case ${index + 1}`;
  const weighted = calcWeightedScore(uc, dims);
  const tier = scoreTier(weighted);
  const scoreColor = weighted ? totalScoreColor(weighted) : "#64748b";
  const dimCards = dims.map((d) => {
    const view = getDimensionView(uc, d.id);
    const score = view.effectiveScore;
    const color = score != null ? dimScoreColor(Number(score)) : "#64748b";
    const dimIcon = dimensionScoreIcon(score);
    return `
      <div class="dim-card">
        <div class="dim-head">
          <span class="dim-name">${dimIcon} ${escapeHtml(d.label)}</span>
          <span class="dim-weight">${escapeHtml(d.weight)}%</span>
        </div>
        <div class="dim-score" style="color:${escapeHtml(color)}">${score == null ? "-" : `${escapeHtml(score)}/5`}</div>
        <div class="dim-brief">${escapeHtml(view.brief || "No brief available.")}</div>
        ${citationBadgesHtml(view.sources)}
      </div>
    `;
  }).join("");

  const summaryMeta = `
    <div class="meta-grid">
      <div><span class="meta-k">Vertical</span><span class="meta-v">${escapeHtml(uc.attributes?.vertical || "-")}</span></div>
      <div><span class="meta-k">Buyer</span><span class="meta-v">${escapeHtml(uc.attributes?.buyerPersona || "-")}</span></div>
      <div><span class="meta-k">AI Solution</span><span class="meta-v">${escapeHtml(uc.attributes?.aiSolutionType || "-")}</span></div>
      <div><span class="meta-k">Timeline</span><span class="meta-v">${escapeHtml(uc.attributes?.typicalTimeline || "-")}</span></div>
      <div><span class="meta-k">Delivery</span><span class="meta-v">${escapeHtml(uc.attributes?.deliveryModel || "-")}</span></div>
      <div><span class="meta-k">Priority Tier</span><span class="meta-v">${escapeHtml(tier)}</span></div>
    </div>
  `;

  return `
    <article class="page summary-page">
      <div class="page-topline">📊 AI Use Case Analysis Report</div>
      <h1 class="uc-title">${escapeHtml(title)}</h1>
      <div class="score-hero">
        <div class="score-value" style="color:${escapeHtml(scoreColor)}">${weighted == null ? "-" : `${escapeHtml(weighted)}%`}</div>
        <div class="score-tier">${priorityIcon(weighted)} ${escapeHtml(tier)}</div>
      </div>
      <div class="summary-desc">${escapeHtml(uc.attributes?.expandedDescription || uc.rawInput || "")}</div>
      ${summaryMeta}
      ${section("Strategic Conclusion", `<div class="small-text">${escapeHtml(uc.finalScores?.conclusion || "No conclusion available yet.")}</div>`)}
      <div class="dim-grid">${dimCards}</div>
    </article>
  `;
}

function renderDimensionPage(uc, d) {
  const view = getDimensionView(uc, d.id);
  const critic = uc.critique?.dimensions?.[d.id];
  const score = view.effectiveScore;
  const scoreColor = score != null ? dimScoreColor(Number(score)) : "#64748b";
  const title = uc.attributes?.title || uc.rawInput || "Untitled use case";

  const debateBody = `
    <div class="small-text"><strong>Critic:</strong> ${escapeHtml(critic?.critique || "No critic comment.")}</div>
    <div class="small-text"><strong>Analyst response:</strong> ${escapeHtml(view.debate?.response || "No debate response.")}</div>
  `;

  return `
    <article class="page dimension-page">
      <div class="page-topline">🧩 ${escapeHtml(title)} - ${escapeHtml(d.label)}</div>
      <div class="dim-page-head">
        <h2 class="dim-page-title">${dimensionScoreIcon(score)} ${escapeHtml(d.label)}</h2>
        <div class="dim-page-weight">⚖️ Weight ${escapeHtml(d.weight)}%</div>
      </div>
      <div class="score-brief-band">
        <div class="big-score" style="color:${escapeHtml(scoreColor)}">${score == null ? "-" : `${escapeHtml(score)}/5`}</div>
        <div class="big-brief">${escapeHtml(view.brief || "No brief summary available.")}</div>
      </div>
      ${section("Full Analysis", `<div class="small-text pre-wrap">${escapeHtml(view.full || "No full analysis available.")}</div>`)}
      ${section("Risks", `<div class="small-text pre-wrap">${escapeHtml(view.risks || "No risk notes provided.")}</div>`)}
      ${section("Sources", sourceListHtml(view.sources), "compact")}
      ${section("Debate", debateBody, "compact")}
      ${section("Follow-up Thread", threadHistoryHtml(uc.followUps?.[d.id] || []), "compact")}
      ${section("Critic Sources", sourceListHtml(critic?.sources || []), "compact")}
    </article>
  `;
}

function buildPortfolioTable(useCases, dims) {
  if (!useCases.length) {
    return "<div class=\"muted\">No use cases available.</div>";
  }
  const rows = useCases.map((uc, idx) => {
    const title = uc.attributes?.title || uc.rawInput || `Use case ${idx + 1}`;
    const weighted = calcWeightedScore(uc, dims);
    const conclusion = uc.finalScores?.conclusion || "No conclusion available yet.";
    return `
      <tr>
        <td>${idx + 1}</td>
        <td>${escapeHtml(title)}</td>
        <td>${weighted == null ? "-" : `${escapeHtml(weighted)}%`}</td>
        <td>${escapeHtml(conclusion)}</td>
      </tr>
    `;
  }).join("");

  return `
    <table class="portfolio-table">
      <thead>
        <tr>
          <th>#</th>
          <th>🧩 Use Case</th>
          <th>📈 Weighted Score</th>
          <th>🎯 Strategic Conclusion</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function reportCss() {
  return `
    :root {
      color-scheme: light;
      --bg: #f6f8fc;
      --panel: #ffffff;
      --ink: #0f172a;
      --muted: #475569;
      --line: #dbe2f0;
      --accent: #2563eb;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      line-height: 1.35;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .report {
      width: 100%;
      max-width: 1050px;
      margin: 0 auto;
      padding: 18px;
    }
    .page {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 28px 30px;
      margin-bottom: 16px;
      page-break-after: always;
      break-after: page;
      min-height: 90vh;
    }
    .page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .page-topline {
      color: var(--accent);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 12px;
      margin-bottom: 10px;
    }
    .uc-title {
      margin: 0;
      font-size: 42px;
      line-height: 1.08;
      letter-spacing: -0.02em;
    }
    .score-hero {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-top: 12px;
      margin-bottom: 12px;
    }
    .score-value {
      font-size: 72px;
      font-weight: 800;
      line-height: 0.95;
    }
    .score-tier {
      font-size: 20px;
      font-weight: 700;
      color: var(--ink);
    }
    .summary-desc {
      font-size: 18px;
      color: #1e293b;
      margin: 12px 0 14px;
      font-weight: 500;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 16px;
      margin-bottom: 16px;
    }
    .meta-grid > div {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid #eef2ff;
      padding-bottom: 4px;
    }
    .meta-k {
      min-width: 92px;
      font-size: 12px;
      text-transform: uppercase;
      color: #64748b;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .meta-v {
      font-size: 13px;
      font-weight: 600;
      color: #0f172a;
    }
    .dim-grid {
      margin-top: 16px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .dim-card {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 12px;
      background: #fcfdff;
    }
    .dim-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 8px;
    }
    .dim-name {
      font-size: 14px;
      font-weight: 700;
      color: #0f172a;
    }
    .dim-weight {
      font-size: 12px;
      color: #64748b;
      font-weight: 700;
    }
    .dim-score {
      font-size: 28px;
      font-weight: 800;
      line-height: 1;
      margin-bottom: 6px;
    }
    .dim-brief {
      font-size: 15px;
      font-weight: 700;
      color: #1e293b;
    }
    .citation-line {
      margin-top: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .citation-badge {
      display: inline-block;
      border: 1px solid #bfdbfe;
      background: #eff6ff;
      color: #1d4ed8;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 999px;
      line-height: 1.3;
    }
    .dim-page-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 10px;
      margin-bottom: 10px;
    }
    .dim-page-title {
      margin: 0;
      font-size: 36px;
      line-height: 1.05;
    }
    .dim-page-weight {
      font-size: 14px;
      color: #334155;
      font-weight: 700;
    }
    .score-brief-band {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 16px;
      align-items: center;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .big-score {
      font-size: 54px;
      font-weight: 800;
      line-height: 1;
      min-width: 120px;
      text-align: center;
    }
    .big-brief {
      font-size: 24px;
      line-height: 1.2;
      font-weight: 800;
      color: #0f172a;
    }
    .section {
      margin-bottom: 12px;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 10px 12px;
      background: #ffffff;
    }
    .section-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #64748b;
      font-weight: 700;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section-icon {
      font-size: 13px;
      line-height: 1;
    }
    .small-text {
      font-size: 12px;
      line-height: 1.45;
      color: #334155;
    }
    .pre-wrap {
      white-space: pre-wrap;
    }
    .source-list {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 6px;
    }
    .source-item {
      font-size: 12px;
      color: #334155;
    }
    .source-name {
      font-weight: 700;
      color: #0f172a;
    }
    .source-quote {
      margin-top: 2px;
      font-style: italic;
    }
    .source-url {
      display: inline-block;
      margin-top: 1px;
      color: #2563eb;
      text-decoration: none;
      word-break: break-all;
    }
    .source-url:hover {
      text-decoration: underline;
    }
    .thread-list {
      display: grid;
      gap: 6px;
    }
    .thread-item {
      padding: 8px 9px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
    }
    .thread-role {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #475569;
      margin-bottom: 2px;
    }
    .thread-body {
      font-size: 12px;
      color: #334155;
      line-height: 1.4;
      white-space: pre-wrap;
    }
    .portfolio-title {
      margin: 0 0 10px;
      font-size: 34px;
      letter-spacing: -0.01em;
    }
    .portfolio-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
      font-size: 13px;
    }
    .portfolio-table th,
    .portfolio-table td {
      text-align: left;
      border-bottom: 1px solid #e2e8f0;
      padding: 7px 6px;
      vertical-align: top;
    }
    .portfolio-table th {
      font-size: 11px;
      text-transform: uppercase;
      color: #64748b;
      letter-spacing: 0.04em;
    }
    .muted {
      color: #64748b;
      font-size: 12px;
    }
    @media print {
      body {
        background: #fff;
      }
      .report {
        max-width: none;
        margin: 0;
        padding: 0;
      }
      .page {
        border: none;
        border-radius: 0;
        margin: 0;
        padding: 14mm 12mm;
        min-height: auto;
      }
    }
    @media (max-width: 840px) {
      .uc-title {
        font-size: 32px;
      }
      .score-value {
        font-size: 58px;
      }
      .dim-grid {
        grid-template-columns: 1fr;
      }
      .score-brief-band {
        grid-template-columns: 1fr;
      }
      .big-score {
        text-align: left;
        min-width: 0;
      }
      .big-brief {
        font-size: 20px;
      }
    }
  `;
}

function buildReportHtml(useCases, dims) {
  const generated = new Date().toLocaleString();
  const portfolioPage = `
    <article class="page">
      <div class="page-topline">📁 Portfolio Overview</div>
      <h1 class="portfolio-title">AI Use Case Portfolio Summary</h1>
      <div class="small-text">Generated: ${escapeHtml(generated)} | Use cases: ${useCases.length}</div>
      ${buildPortfolioTable(useCases, dims)}
      ${section("How to read this report", "<div class=\"small-text\">Each use case has one summary page, followed by one page per scoring dimension. Large typography highlights score and brief judgment. Smaller typography contains full reasoning, sources, and debate details.</div>")}
    </article>
  `;

  const useCasePages = useCases.map((uc, index) => {
    const summary = renderUseCaseSummaryPage(uc, dims, index);
    const dimPages = dims.map((d) => renderDimensionPage(uc, d)).join("");
    return `${summary}${dimPages}`;
  }).join("");

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>AI Use Case Analysis Report</title>
        <style>${reportCss()}</style>
      </head>
      <body>
        <main class="report">
          ${portfolioPage}
          ${useCasePages}
        </main>
      </body>
    </html>
  `;
}

export function exportSummaryCsv(useCases, dims) {
  const headers = [
    "use_case_id",
    "status",
    "title",
    "vertical",
    "buyer_persona",
    "ai_solution_type",
    "typical_timeline",
    "delivery_model",
    "weighted_score_pct",
    "analysis_mode",
    "live_search_requested",
    "live_search_used",
    "web_search_calls",
    "hybrid_changed_from_baseline",
    "hybrid_changed_from_web",
    "hybrid_large_delta_from_baseline",
    "hybrid_baseline_weighted_score",
    "hybrid_web_weighted_score",
    "hybrid_reconciled_weighted_score",
    "conclusion",
    "raw_input",
    ...getScoreColumns(dims),
  ];

  const rows = useCases.map((uc) => {
    const row = {
      use_case_id: uc.id,
      status: uc.status,
      title: uc.attributes?.title || "",
      vertical: uc.attributes?.vertical || "",
      buyer_persona: uc.attributes?.buyerPersona || "",
      ai_solution_type: uc.attributes?.aiSolutionType || "",
      typical_timeline: uc.attributes?.typicalTimeline || "",
      delivery_model: uc.attributes?.deliveryModel || "",
      weighted_score_pct: calcWeightedScore(uc, dims) ?? "",
      analysis_mode: uc.analysisMeta?.analysisMode || "standard",
      live_search_requested: uc.analysisMeta?.liveSearchRequested ? "yes" : "no",
      live_search_used: uc.analysisMeta?.liveSearchUsed ? "yes" : "no",
      web_search_calls: uc.analysisMeta?.webSearchCalls ?? 0,
      hybrid_changed_from_baseline: uc.analysisMeta?.hybridStats?.changedFromBaseline ?? "",
      hybrid_changed_from_web: uc.analysisMeta?.hybridStats?.changedFromWeb ?? "",
      hybrid_large_delta_from_baseline: uc.analysisMeta?.hybridStats?.largeDeltaFromBaseline ?? "",
      hybrid_baseline_weighted_score: uc.analysisMeta?.hybridStats?.baselineWeightedScore ?? "",
      hybrid_web_weighted_score: uc.analysisMeta?.hybridStats?.webWeightedScore ?? "",
      hybrid_reconciled_weighted_score: uc.analysisMeta?.hybridStats?.reconciledWeightedScore ?? "",
      conclusion: uc.finalScores?.conclusion || "",
      raw_input: uc.rawInput || "",
    };
    dims.forEach((d) => {
      const view = getDimensionView(uc, d.id);
      row[`${d.id}_score`] = view.effectiveScore ?? "";
      row[`${d.id}_stage`] = view.stageLabel;
    });
    return row;
  });

  downloadCsv(`use-case-summary-${timestampTag()}.csv`, rowsToCsv(headers, rows));
}

export function exportDetailCsv(useCases, dims) {
  const headers = [
    "use_case_id",
    "use_case_title",
    "analysis_mode",
    "dimension_id",
    "dimension_label",
    "dimension_weight_pct",
    "enabled",
    "effective_score",
    "initial_score",
    "debate_score",
    "follow_up_score",
    "update_stage",
    "brief",
    "full_analysis",
    "risks",
    "combined_sources",
    "critic_score_justified",
    "critic_suggested_score",
    "critic_critique",
    "critic_sources",
    "thread_history",
  ];

  const rows = [];

  useCases.forEach((uc) => {
    dims.forEach((d) => {
      const view = getDimensionView(uc, d.id);
      const critic = uc.critique?.dimensions?.[d.id];
      const threadHistory = (uc.followUps?.[d.id] || [])
        .map((m) => (m.role === "pm" ? `PM: ${m.text || ""}` : `Analyst: ${m.response || m.text || ""}`))
        .join("\n");

      rows.push({
        use_case_id: uc.id,
        use_case_title: uc.attributes?.title || uc.rawInput || "",
        analysis_mode: uc.analysisMeta?.analysisMode || "standard",
        dimension_id: d.id,
        dimension_label: d.label,
        dimension_weight_pct: d.weight,
        enabled: d.enabled ? "yes" : "no",
        effective_score: view.effectiveScore ?? "",
        initial_score: view.initial?.score ?? "",
        debate_score: view.debate?.finalScore ?? "",
        follow_up_score: view.followUp?.newScore ?? "",
        update_stage: view.stageLabel,
        brief: view.brief,
        full_analysis: view.full,
        risks: view.risks,
        combined_sources: formatSourcesForCell(view.sources),
        critic_score_justified: critic?.scoreJustified == null ? "" : String(critic.scoreJustified),
        critic_suggested_score: critic?.suggestedScore ?? "",
        critic_critique: critic?.critique || "",
        critic_sources: formatSourcesForCell(critic?.sources || []),
        thread_history: threadHistory,
      });
    });
  });

  downloadCsv(`use-case-detail-${timestampTag()}.csv`, rowsToCsv(headers, rows));
}

export function exportAnalysisHtml(useCases, dims) {
  const html = buildReportHtml(useCases, dims);
  downloadHtml(`use-case-analysis-${timestampTag()}.html`, html);
}

export function exportAnalysisPdf(useCases, dims) {
  const html = buildReportHtml(useCases, dims);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.opacity = "0";

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
  };

  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) {
      cleanup();
      return;
    }

    const afterPrint = () => {
      win.removeEventListener("afterprint", afterPrint);
      cleanup();
    };
    win.addEventListener("afterprint", afterPrint);

    setTimeout(() => {
      try {
        win.focus();
        win.print();
      } finally {
        setTimeout(cleanup, 25000);
      }
    }, 250);
  };

  document.body.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) {
    cleanup();
    window.alert("Could not initialize PDF print frame.");
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
}
