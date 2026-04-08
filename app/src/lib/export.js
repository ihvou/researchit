import { calcWeightedScore, dimScoreColor, totalScoreColor } from "./scoring";
import { getDimensionView, formatSourcesForCell } from "@researchit/engine";
import {
  buildSingleUseCaseJsonPayload as buildSingleUseCaseJsonPayloadCore,
  buildPortfolioJsonPayload as buildPortfolioJsonPayloadCore,
  importUseCasesFromJsonText as importUseCasesFromJsonTextCore,
  EXPORT_SCHEMA_VERSION,
} from "@researchit/engine";
import JSZip from "jszip";
import { toPng } from "html-to-image";

const APP_VERSION = import.meta.env.VITE_APP_VERSION || "1.0.0";

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
  downloadBlob(filename, blob);
}

function downloadBlob(filename, blob) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

function buildOffscreenReportHost(html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const styles = Array.from(parsed.querySelectorAll("style")).map((s) => s.textContent || "").join("\n");
  const report = parsed.querySelector("main.report");
  if (!report) throw new Error("Could not find report content for image export.");

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.left = "-200vw";
  host.style.top = "0";
  host.style.width = "1600px";
  host.style.background = "#ffffff";
  host.style.pointerEvents = "none";
  host.style.zIndex = "-1";
  host.innerHTML = `<style>${styles}</style><main class="report">${report.innerHTML}</main>`;
  return host;
}

async function ensureRendered() {
  if (typeof document !== "undefined" && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch (_) {
      // Ignore font readiness errors.
    }
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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

function dateTag() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getScoreColumns(dims) {
  const cols = [];
  dims.forEach((d) => {
    cols.push(`${d.id}_score`);
    cols.push(`${d.id}_stage`);
    cols.push(`${d.id}_confidence`);
    cols.push(`${d.id}_confidence_reason`);
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

function limitWords(text, maxWords) {
  if (!text) return "";
  const parts = String(text).trim().split(/\s+/);
  if (parts.length <= maxWords) return parts.join(" ");
  return `${parts.slice(0, maxWords).join(" ")}...`;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

function trimUrlSuffix(raw) {
  if (!raw) return { url: "", trailing: "" };
  const clean = String(raw).replace(/[),.;!?]+$/g, "");
  return { url: clean, trailing: String(raw).slice(clean.length) };
}

function sourceLabel(n) {
  return `Source ${n}`;
}

function createSourceUrlMap(sources = []) {
  const map = new Map();
  sources.forEach((s, idx) => {
    const { url } = trimUrlSuffix(s?.url || "");
    if (url && !map.has(url)) map.set(url, sourceLabel(idx + 1));
  });
  return map;
}

function replaceUrlsWithSourceLabels(text, sources = []) {
  if (!text) return "";
  const known = createSourceUrlMap(sources);
  let next = known.size + 1;
  return String(text).replace(URL_PATTERN, (raw) => {
    const { url, trailing } = trimUrlSuffix(raw);
    if (!url) return raw;
    let label = known.get(url);
    if (!label) {
      label = sourceLabel(next);
      known.set(url, label);
      next += 1;
    }
    return `${label}${trailing}`;
  });
}

function safeFilePart(value, fallback = "research") {
  const raw = String(value || fallback).trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function dimensionConfigSnapshot(dims = []) {
  return (dims || []).map((d) => ({
    id: d.id,
    label: d.label,
    weight: d.weight,
    enabled: !!d.enabled,
  }));
}

function isCompletedUseCase(uc) {
  return uc?.status === "complete" && isPlainObject(uc);
}

function validateUseCaseShape(uc) {
  if (!isPlainObject(uc)) throw new Error("Use case entry is not an object.");
  if (typeof uc.id !== "string" || !uc.id.trim()) throw new Error("Use case is missing a valid id.");
  if (typeof uc.rawInput !== "string") throw new Error(`Use case ${uc.id} is missing rawInput.`);
  if (uc.status !== "complete") throw new Error(`Use case ${uc.id} is not completed.`);
  if (!isPlainObject(uc.dimScores)) throw new Error(`Use case ${uc.id} is missing dimScores.`);
  if (!isPlainObject(uc.finalScores)) throw new Error(`Use case ${uc.id} is missing finalScores.`);
  if (!Array.isArray(uc.debate)) throw new Error(`Use case ${uc.id} has invalid debate history.`);
  if (uc.followUps != null && !isPlainObject(uc.followUps)) {
    throw new Error(`Use case ${uc.id} has invalid follow-up threads.`);
  }
}

function compareDimensionConfigs(importedConfig = [], currentDims = []) {
  const current = dimensionConfigSnapshot(currentDims);
  if (!Array.isArray(importedConfig) || importedConfig.length !== current.length) return false;
  for (let i = 0; i < importedConfig.length; i += 1) {
    const a = importedConfig[i];
    const b = current[i];
    if (!a || !b) return false;
    if (a.id !== b.id) return false;
    if (Number(a.weight) !== Number(b.weight)) return false;
    if (!!a.enabled !== !!b.enabled) return false;
  }
  return true;
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
  if (!Number.isFinite(n)) return "N/A";
  if (n >= 80) return "A";
  if (n >= 65) return "B";
  if (n >= 50) return "C";
  return "D";
}

function sectionIcon(label) {
  const map = {
    "Strategic Conclusion": "CONC",
    "Supporting Evidence": "SUP",
    "Limiting Factors": "LIM",
    "Research Brief": "BRF",
    "Full Analysis": "ANL",
    "Risks": "RSK",
    "Sources": "SRC",
    "Debate": "DEB",
    "Follow-up Thread": "THR",
    "Critic Sources": "CRS",
    "How to read this report": "GDE",
  };
  return map[label] || "SEC";
}

function normalizeConfidence(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("h")) return "high";
  if (raw.startsWith("m")) return "medium";
  if (raw.startsWith("l")) return "low";
  return "";
}

function confidenceLabel(level) {
  if (level === "high") return "High confidence";
  if (level === "medium") return "Medium confidence";
  if (level === "low") return "Low confidence";
  return "Confidence unavailable";
}

function confidenceChipHtml(level, reason = "", compact = false) {
  const normalized = normalizeConfidence(level);
  if (!normalized) return "";
  const tone = normalized === "high"
    ? { bg: "#f7f7f6", line: "#d5d5d2", ink: "#121212", icon: "H", short: "High" }
    : normalized === "medium"
      ? { bg: "#f7f7f6", line: "#d5d5d2", ink: "#4b4b48", icon: "M", short: "Med" }
      : { bg: "#f7f7f6", line: "#b8b8b4", ink: "#4b4b48", icon: "L", short: "Low" };
  const title = reason ? `${confidenceLabel(normalized)}: ${reason}` : confidenceLabel(normalized);

  return `
    <span class="confidence-chip" title="${escapeHtml(title)}" style="background:${tone.bg};border-color:${tone.line};color:${tone.ink};">
      <span>${escapeHtml(compact ? tone.icon : `${tone.short} confidence`)}</span>
    </span>
  `;
}

function useCaseProblem(uc) {
  return uc?.attributes?.problemStatement
    || uc?.rawInput
    || "Problem statement not available.";
}

function useCaseSolution(uc) {
  return uc?.attributes?.solutionStatement
    || uc?.attributes?.expandedDescription
    || "Solution statement not available.";
}

function sourceChipArrayHtml(sources = [], options = {}) {
  const { maxItems = Number.POSITIVE_INFINITY } = options;
  if (!sources?.length) return "<div class=\"muted\">No sources available.</div>";
  const visible = Number.isFinite(maxItems) ? sources.slice(0, maxItems) : sources;
  const chips = visible.map((s, idx) => {
    const label = sourceLabel(idx + 1);
    const note = [s?.name, s?.quote ? limitWords(s.quote, 14) : ""].filter(Boolean).join(" - ");
    const title = note ? ` title="${escapeHtml(note)}"` : "";
    if (s?.url) {
      return `<a class="source-chip" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer"${title}>${escapeHtml(label)}</a>`;
    }
    return `<span class="source-chip source-chip-static"${title}>${escapeHtml(label)}</span>`;
  }).join("");
  const extra = Number.isFinite(maxItems) && sources.length > maxItems
    ? `<span class="source-chip source-chip-static">+${sources.length - maxItems}</span>`
    : "";
  return `<div class="source-chip-array">${chips}${extra}</div>`;
}

function argumentActionSummary(action) {
  if (!action?.id || !action?.action) return "";
  const scope = action.group === "limiting" ? "Limiting factor" : "Supporting evidence";
  if (action.action === "discard") {
    return `${scope} ${action.id} discarded${action.reason ? ` (${action.reason})` : ""}`;
  }
  if (action.action === "modify") {
    return `${scope} ${action.id} updated${action.reason ? ` (${action.reason})` : ""}`;
  }
  if (action.action === "keep") {
    return `${scope} ${action.id} retained${action.reason ? ` (${action.reason})` : ""}`;
  }
  return "";
}

function argumentRowsHtml(argumentsList = [], options = {}) {
  const { emptyText = "No arguments available.", maxSourceItems = 4 } = options;
  if (!argumentsList?.length) return `<div class="muted">${escapeHtml(emptyText)}</div>`;
  return `
    <div class="arg-list">
      ${argumentsList.map((arg, idx) => {
        const claim = arg?.claim || `Argument ${idx + 1}`;
        const detail = String(arg?.detail || "").trim();
        const discarded = arg?.status === "discarded";
        const reason = discarded
          ? `Discarded by ${arg?.discardedBy || "reviewer"}${arg?.discardReason ? ` - ${arg.discardReason}` : ""}`
          : "";
        return `
          <div class="arg-item ${discarded ? "arg-item-discarded" : ""}">
            <div class="arg-claim">${escapeHtml(claim)}</div>
            ${detail ? `<div class="arg-detail">${escapeHtml(detail)}</div>` : ""}
            ${reason ? `<div class="arg-discard-note">${escapeHtml(reason)}</div>` : ""}
            ${arg?.sources?.length ? sourceChipArrayHtml(arg.sources, { maxItems: maxSourceItems }) : ""}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function researchBriefHtml(brief) {
  if (!brief) return "<div class=\"muted\">No research brief available.</div>";
  const missingEvidence = String(brief.missingEvidence || "").trim();
  const whereToLook = Array.isArray(brief.whereToLook) ? brief.whereToLook.filter(Boolean).slice(0, 4) : [];
  const suggestedQueries = Array.isArray(brief.suggestedQueries) ? brief.suggestedQueries.filter(Boolean).slice(0, 4) : [];
  return `
    <div class="research-brief">
      ${missingEvidence ? `<div class="small-text"><strong>Missing evidence:</strong> ${escapeHtml(missingEvidence)}</div>` : ""}
      ${whereToLook.length ? `
        <div class="small-text" style="margin-top:4px;"><strong>Where to look:</strong></div>
        <ul class="brief-list">
          ${whereToLook.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      ` : ""}
      ${suggestedQueries.length ? `
        <div class="small-text" style="margin-top:4px;"><strong>Suggested queries:</strong></div>
        <div class="source-chip-array">
          ${suggestedQueries.map((q) => `<span class="source-chip source-chip-static">${escapeHtml(q)}</span>`).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function threadHistoryHtml(thread = [], options = {}) {
  const { maxItems = Number.POSITIVE_INFINITY, maxBodyWords = 0 } = options;
  if (!thread?.length) return "<div class=\"muted\">No follow-up thread.</div>";
  const visible = Number.isFinite(maxItems) ? thread.slice(-maxItems) : thread;
  const items = visible.map((m) => {
    const pmLabel = m?.intent
      ? `PM ${String(m.intent).replace(/_/g, " ")}`
      : "PM challenge";
    const role = m?.role === "pm" ? pmLabel : "Analyst follow-up";
    const body = m?.role === "pm"
      ? (m?.text || "")
      : (m?.response || m?.text || "");
    const proposal = m?.role === "analyst" && m?.scoreProposal?.newScore != null
      ? ` [Score proposal ${m.scoreProposal.previousScore}/5 -> ${m.scoreProposal.newScore}/5 (${m.scoreProposal.status || "pending"})]`
      : "";
    const analystArg = m?.role === "analyst" ? argumentActionSummary(m?.argumentUpdate) : "";
    const pmArg = m?.role === "pm" ? argumentActionSummary(m?.argumentAction) : "";
    const argSuffix = analystArg || pmArg ? ` [${analystArg || pmArg}]` : "";
    const fullBody = `${body}${proposal}${argSuffix}`.trim();
    const displayBody = maxBodyWords > 0 ? limitWords(fullBody, maxBodyWords) : fullBody;
    return `
      <div class="thread-item">
        <div class="thread-role">${escapeHtml(role)}</div>
        <div class="thread-body">${escapeHtml(displayBody)}</div>
      </div>
    `;
  }).join("");
  return `<div class="thread-list">${items}</div>`;
}

function discoverCandidatesHtml(uc, dims = [], options = {}) {
  const { maxItems = 5 } = options;
  const candidates = uc?.discover?.candidates || [];
  const labelById = new Map((dims || []).map((d) => [d.id, d.label]));
  const generatedCount = Number(uc?.discover?.generatedCandidatesCount);
  const validatedCount = Number(uc?.discover?.validatedCandidatesCount);
  const generated = Number.isFinite(generatedCount) ? generatedCount : candidates.length;
  const validated = Number.isFinite(validatedCount) ? validatedCount : candidates.length;
  const rejected = Math.max(0, Number(uc?.discover?.rejectedCandidates?.length ?? generated - validated));
  const summary = `
    <div class="discover-summary">
      Generated ${generated} | Validated ${validated}${rejected ? ` | Filtered out ${rejected}` : ""}
    </div>
  `;
  if (!candidates.length) {
    return `${summary}<div class="muted">No validated discovery candidates available.</div>`;
  }
  const items = candidates.slice(0, maxItems).map((c) => {
    const improved = (c?.expectedImprovedDimensions || [])
      .map((id) => labelById.get(id) || id)
      .join(", ");
    const targeted = (Array.isArray(c?.targetedWeaknesses) ? c.targetedWeaknesses : [])
      .map((item) => {
        const label = labelById.get(item?.dimensionId) || item?.dimensionId || "Dimension";
        const factor = String(item?.limitingFactor || "").trim();
        const approach = String(item?.resolutionApproach || "").trim();
        if (!factor && !approach) return "";
        return `<div class="discover-target"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(factor)}${approach ? ` &rarr; ${escapeHtml(approach)}` : ""}</div>`;
      })
      .filter(Boolean)
      .join("");
    const checks = (Array.isArray(c?.preValidation?.checks) ? c.preValidation.checks : [])
      .map((check) => {
        const label = labelById.get(check?.dimensionId) || check?.dimensionId || "Dimension";
        const current = Number.isFinite(Number(check?.currentScore)) ? `${Number(check.currentScore)}/5` : "?";
        const predicted = Number.isFinite(Number(check?.predictedScore)) ? `${Number(check.predictedScore)}/5` : "?";
        const reason = String(check?.reason || "").trim();
        return `<div class="discover-check"><strong>${escapeHtml(label)}</strong>: ${escapeHtml(current)} &rarr; ${escapeHtml(predicted)}${reason ? ` (${escapeHtml(reason)})` : ""}</div>`;
      })
      .join("");
    return `
      <div class="discover-item">
        <div class="discover-title">${escapeHtml(c?.title || "Untitled candidate")}</div>
        <div class="discover-rationale">${escapeHtml(c?.rationale || "")}</div>
        ${improved ? `<div class="discover-improves">Expected lift: ${escapeHtml(improved)}</div>` : ""}
        ${targeted ? `<div class="discover-targets">${targeted}</div>` : ""}
        ${checks ? `<div class="discover-checks"><div class="discover-check-title">Pre-score validation</div>${checks}</div>` : ""}
      </div>
    `;
  }).join("");
  return `<div class="discover-list">${summary}${items}</div>`;
}

function section(label, body, className = "") {
  const icon = sectionIcon(label);
  return `
    <section class="section ${className}">
      <div class="section-label"><span class="section-code">${escapeHtml(icon)}</span><span>${escapeHtml(label)}</span></div>
      <div class="section-body">${body}</div>
    </section>
  `;
}

function renderUseCaseIntroPage(uc, dims, index) {
  const title = uc.attributes?.title || uc.rawInput || `Use case ${index + 1}`;
  const problem = useCaseProblem(uc);
  const solution = useCaseSolution(uc);
  const context = uc.attributes?.expandedDescription || uc.rawInput || "";

  return `
    <article class="page intro-page">
      <div class="page-topline">Research Brief</div>
      <h1 class="uc-title">${escapeHtml(title)}</h1>
      <div class="intro-context">${escapeHtml(context)}</div>
      <section class="intro-block">
        <div class="intro-label">Problem Statement</div>
        <div class="intro-text">${escapeHtml(problem)}</div>
      </section>
      <section class="intro-block">
        <div class="intro-label">Solution Statement</div>
        <div class="intro-text">${escapeHtml(solution)}</div>
      </section>
      ${section("Discovery Candidates", discoverCandidatesHtml(uc, dims, { maxItems: 5 }), "compact")}
      <div class="intro-meta-grid">
        <div><span class="meta-k">Vertical</span><span class="meta-v">${escapeHtml(uc.attributes?.vertical || "-")}</span></div>
        <div><span class="meta-k">Buyer</span><span class="meta-v">${escapeHtml(uc.attributes?.buyerPersona || "-")}</span></div>
        <div><span class="meta-k">AI Solution</span><span class="meta-v">${escapeHtml(uc.attributes?.aiSolutionType || "-")}</span></div>
        <div><span class="meta-k">Timeline</span><span class="meta-v">${escapeHtml(uc.attributes?.typicalTimeline || "-")}</span></div>
      </div>
    </article>
  `;
}

function renderUseCaseSummaryPage(uc, dims, index, options = {}) {
  const mode = options.mode || "html";
  const summaryCols = mode === "pdf" ? 3 : 4;

  const title = uc.attributes?.title || uc.rawInput || `Use case ${index + 1}`;
  const weighted = calcWeightedScore(uc, dims);
  const tier = scoreTier(weighted);
  const scoreColor = weighted ? totalScoreColor(weighted) : "#73736f";
  const baseCards = dims.map((d) => {
    const view = getDimensionView(uc, d.id, { dimLabel: d.label, dim: d });
    const score = view.effectiveScore;
    const color = score != null ? dimScoreColor(Number(score)) : "#73736f";
    return `
      <div class="dim-card">
        <div class="dim-head-inline">
          <span class="dim-name">${escapeHtml(d.label)}</span>
          <span class="dim-inline-meta">
            <span class="dim-score-inline" style="color:${escapeHtml(color)}">${score == null ? "-" : `${escapeHtml(score)}/5`}</span>
            ${confidenceChipHtml(view.confidence, view.confidenceReason, true)}
            <span class="dim-weight">${escapeHtml(d.weight)}%</span>
          </span>
        </div>
        <div class="dim-brief">${escapeHtml(view.brief || "No brief available.")}</div>
      </div>
    `;
  }).join("");
  const remainder = dims.length % summaryCols;
  const fillerMissing = remainder ? (summaryCols - remainder) : 0;
  const fillerCard = fillerMissing
    ? `
      <div class="dim-card dim-card-filler" style="grid-column: span ${fillerMissing};">
        <div class="dim-filler-title">Deep-Dive Slides</div>
        <div class="dim-filler-text">Dimension pages include full analysis, debate details, and compact source links.</div>
      </div>
    `
    : "";
  const dimCards = `${baseCards}${fillerCard}`;
  const lowConfidence = dims
    .map((d) => ({ dim: d, view: getDimensionView(uc, d.id, { dimLabel: d.label, dim: d }) }))
    .filter((item) => item.view.confidence === "low");

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
  const lowConfidenceBanner = lowConfidence.length
    ? `
      <div class="confidence-alert">
        <strong>Low-confidence dimensions: ${lowConfidence.length}</strong>
        <span>${escapeHtml(lowConfidence.map((item) => item.dim.label).join(", "))}</span>
      </div>
    `
    : "";

  return `
    <article class="page summary-page">
      <div class="page-topline">Research it Analysis Report</div>
      <h1 class="uc-title">${escapeHtml(title)}</h1>
      <div class="score-hero">
        <div class="score-value" style="color:${escapeHtml(scoreColor)}">${weighted == null ? "-" : `${escapeHtml(weighted)}%`}</div>
        <div class="score-tier">Tier ${priorityIcon(weighted)} | ${escapeHtml(tier)}</div>
      </div>
      <div class="summary-desc">${escapeHtml(uc.attributes?.expandedDescription || uc.rawInput || "")}</div>
      ${summaryMeta}
      ${lowConfidenceBanner}
      ${section("Strategic Conclusion", `<div class="small-text">${escapeHtml(uc.finalScores?.conclusion || "No conclusion available yet.")}</div>`)}
      <div class="dim-grid">${dimCards}</div>
    </article>
  `;
}

function renderDimensionPage(uc, d, options = {}) {
  const view = getDimensionView(uc, d.id, { dimLabel: d.label, dim: d });
  const critic = uc.critique?.dimensions?.[d.id];
  const score = view.effectiveScore;
  const scoreColor = score != null ? dimScoreColor(Number(score)) : "#73736f";
  const title = uc.attributes?.title || uc.rawInput || "Untitled research";
  const fullWithSourceLabels = replaceUrlsWithSourceLabels(
    view.full || "No full analysis available.",
    view.sources || []
  );
  const normalizedConfidence = normalizeConfidence(view.confidence);
  const confidenceReasonLine = normalizedConfidence
    ? `${confidenceLabel(normalizedConfidence)}: ${view.confidenceReason || "Reason not provided."}`
    : "Confidence unavailable.";

  const debateBody = `
    <div class="small-text"><strong>Critic:</strong> ${escapeHtml(critic?.critique || "No critic comment.")}</div>
    <div class="small-text"><strong>Analyst response:</strong> ${escapeHtml(view.debate?.response || "No debate response.")}</div>
  `;

  return `
    <article class="page dimension-page">
      <div class="page-topline">${escapeHtml(title)} - ${escapeHtml(d.label)}</div>
      <div class="dim-page-head">
        <h2 class="dim-page-title">${escapeHtml(d.label)}</h2>
        <div class="dim-page-meta">
          <div class="dim-page-weight">Weight ${escapeHtml(d.weight)}%</div>
          ${confidenceChipHtml(view.confidence, view.confidenceReason)}
        </div>
      </div>
      <div class="score-brief-band">
        <div class="big-score" style="color:${escapeHtml(scoreColor)}">${score == null ? "-" : `${escapeHtml(score)}/5`}</div>
        <div class="big-brief">${escapeHtml(view.brief || "No brief summary available.")}</div>
      </div>
      <div class="confidence-detail">${escapeHtml(confidenceReasonLine)}</div>
      ${section(
        "Supporting Evidence",
        argumentRowsHtml(view.supportingArguments, { emptyText: "No supporting evidence arguments." }),
        "compact"
      )}
      ${section(
        "Limiting Factors",
        argumentRowsHtml(view.limitingArguments, { emptyText: "No limiting-factor arguments." }),
        "compact"
      )}
      ${view.researchBrief ? section("Research Brief", researchBriefHtml(view.researchBrief), "compact") : ""}
      ${section("Full Analysis", `<div class="small-text pre-wrap">${escapeHtml(fullWithSourceLabels)}</div>`)}
      ${section("Risks", `<div class="small-text pre-wrap">${escapeHtml(view.risks || "No risk notes provided.")}</div>`)}
      ${section("Sources", sourceChipArrayHtml(view.sources), "compact")}
      ${section("Debate", debateBody, "compact")}
      ${section("Follow-up Thread", threadHistoryHtml(uc.followUps?.[d.id] || []), "compact")}
      ${section("Critic Sources", sourceChipArrayHtml(critic?.sources || []), "compact")}
    </article>
  `;
}

function buildPortfolioTable(useCases, dims) {
  if (!useCases.length) {
    return "<div class=\"muted\">No researches available.</div>";
  }
  const rows = useCases.map((uc, idx) => {
    const title = uc.attributes?.title || uc.rawInput || `Use case ${idx + 1}`;
    const weighted = calcWeightedScore(uc, dims);
    const conclusion = limitWords(uc.finalScores?.conclusion || "No conclusion available yet.", 30);
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
          <th>Research</th>
          <th>Weighted Score</th>
          <th>Strategic Conclusion</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function reportCss(mode = "html") {
  const isPdf = mode === "pdf";
  return `
    ${isPdf ? "@page { size: A4 portrait; margin: 8mm; }" : ""}
    @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap");
    :root {
      color-scheme: light;
      --bg: #f3f3f2;
      --panel: #ffffff;
      --ink: #121212;
      --muted: #4b4b48;
      --line: #d5d5d2;
      --accent: #121212;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: "IBM Plex Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      line-height: 1.4;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .report {
      width: 100%;
      max-width: ${isPdf ? "980px" : "1400px"};
      margin: 0 auto;
      padding: 18px;
    }
    .page {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 2px;
      padding: ${isPdf ? "20px 22px" : "24px 26px"};
      margin-bottom: 16px;
      page-break-after: always;
      break-after: page;
      min-height: ${isPdf ? "1040px" : "740px"};
      overflow: visible;
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
      font-size: ${isPdf ? "34px" : "40px"};
      line-height: 1.08;
      letter-spacing: -0.02em;
    }
    .score-hero {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 12px;
      margin-top: 12px;
      margin-bottom: 12px;
    }
    .score-value {
      font-size: ${isPdf ? "62px" : "68px"};
      font-weight: 800;
      line-height: 0.95;
      white-space: nowrap;
    }
    .score-tier {
      font-size: 20px;
      font-weight: 700;
      color: var(--ink);
      white-space: nowrap;
      line-height: 1.1;
      margin-bottom: ${isPdf ? "6px" : "8px"};
    }
    .summary-desc {
      font-size: ${isPdf ? "14px" : "15px"};
      color: #2e2e2b;
      margin: 8px 0 10px;
      font-weight: 500;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 14px;
      margin-bottom: 10px;
    }
    .meta-grid > div {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid #d5d5d2;
      padding-bottom: 4px;
    }
    .intro-context {
      font-size: ${isPdf ? "14px" : "15px"};
      color: #2e2e2b;
      margin: 10px 0 12px;
      font-weight: 500;
      line-height: 1.4;
    }
    .intro-block {
      border: 1px solid #d5d5d2;
      background: #f7f7f6;
      border-radius: 2px;
      padding: 10px 12px;
      margin-bottom: 10px;
    }
    .intro-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #121212;
      font-weight: 700;
      margin-bottom: 5px;
    }
    .intro-text {
      font-size: ${isPdf ? "12px" : "13px"};
      line-height: 1.45;
      color: #121212;
      font-weight: 600;
      white-space: pre-wrap;
    }
    .intro-meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px 14px;
      margin-top: 8px;
    }
    .intro-meta-grid > div {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid #d5d5d2;
      padding-bottom: 4px;
    }
    .meta-k {
      min-width: 92px;
      font-size: 12px;
      text-transform: uppercase;
      color: #73736f;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .meta-v {
      font-size: 13px;
      font-weight: 600;
      color: #121212;
    }
    .confidence-alert {
      margin-bottom: 8px;
      border: 1px solid var(--line);
      background: #f7f7f6;
      color: var(--muted);
      border-radius: 2px;
      padding: 6px 10px;
      font-size: 11px;
      line-height: 1.35;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .dim-grid {
      margin-top: 8px;
      display: grid;
      grid-template-columns: repeat(${isPdf ? 3 : 4}, minmax(0, 1fr));
      gap: 6px;
    }
    .dim-card {
      border: 1px solid #d5d5d2;
      border-radius: 2px;
      padding: 7px 8px;
      background: #f7f7f6;
    }
    .dim-card-filler {
      display: flex;
      flex-direction: column;
      justify-content: center;
      border-style: dashed;
      background: #f7f7f6;
    }
    .dim-filler-title {
      font-size: 12px;
      font-weight: 800;
      color: #121212;
      margin-bottom: 4px;
    }
    .dim-filler-text {
      font-size: 10px;
      color: #4b4b48;
      line-height: 1.35;
      font-weight: 600;
    }
    .dim-head-inline {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .dim-inline-meta {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
    }
    .confidence-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid;
      border-radius: 2px;
      font-size: 10px;
      font-weight: 700;
      line-height: 1.2;
      padding: 2px 7px;
      white-space: nowrap;
    }
    .dim-name {
      font-size: 12px;
      font-weight: 700;
      color: #121212;
      line-height: 1.15;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dim-weight {
      font-size: 11px;
      color: #73736f;
      font-weight: 700;
    }
    .dim-score-inline {
      font-size: ${isPdf ? "17px" : "19px"};
      font-weight: 800;
      line-height: 1;
      min-width: ${isPdf ? "36px" : "40px"};
      text-align: right;
    }
    .dim-brief {
      font-size: ${isPdf ? "9.2px" : "9.8px"};
      font-weight: 700;
      color: #2e2e2b;
      line-height: 1.16;
      margin-top: 2px;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .dim-page-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 10px;
      margin-bottom: 10px;
    }
    .dim-page-meta {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 5px;
    }
    .dim-page-title {
      margin: 0;
      font-size: ${isPdf ? "30px" : "34px"};
      line-height: 1.05;
    }
    .dim-page-weight {
      font-size: 14px;
      color: #4b4b48;
      font-weight: 700;
    }
    .score-brief-band {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 10px;
      align-items: center;
      background: #f0f0ef;
      border: 1px solid #d5d5d2;
      border-radius: 2px;
      padding: ${isPdf ? "9px 11px" : "10px 12px"};
      margin-bottom: 10px;
    }
    .big-score {
      font-size: ${isPdf ? "44px" : "48px"};
      font-weight: 800;
      line-height: 1;
      min-width: ${isPdf ? "100px" : "110px"};
      text-align: center;
    }
    .big-brief {
      font-size: ${isPdf ? "15px" : "16px"};
      line-height: 1.18;
      font-weight: 800;
      color: #121212;
    }
    .confidence-detail {
      margin: -2px 0 8px;
      font-size: ${isPdf ? "10px" : "10.5px"};
      color: #4b4b48;
      line-height: 1.28;
      font-weight: 700;
    }
    .section {
      margin-bottom: 6px;
      border: 1px solid #d5d5d2;
      border-radius: 2px;
      padding: 7px 9px;
      background: #ffffff;
    }
    .section-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #73736f;
      font-weight: 700;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section-code {
      font-size: 10px;
      line-height: 1;
      font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      letter-spacing: 0.02em;
      color: #121212;
    }
    .small-text {
      font-size: ${isPdf ? "10px" : "10.5px"};
      line-height: 1.28;
      color: #4b4b48;
    }
    .arg-list {
      display: grid;
      gap: 5px;
    }
    .arg-item {
      border: 1px solid #d5d5d2;
      border-radius: 2px;
      padding: 6px 8px;
      background: #f7f7f6;
    }
    .arg-item-discarded {
      opacity: 0.72;
      background: #f7f7f6;
    }
    .arg-item-discarded .arg-claim,
    .arg-item-discarded .arg-detail {
      text-decoration: line-through;
    }
    .arg-claim {
      font-size: ${isPdf ? "10.2px" : "10.6px"};
      line-height: 1.26;
      font-weight: 800;
      color: #121212;
    }
    .arg-detail {
      margin-top: 2px;
      font-size: ${isPdf ? "9.6px" : "10px"};
      line-height: 1.24;
      color: #4b4b48;
    }
    .arg-discard-note {
      margin-top: 3px;
      font-size: ${isPdf ? "9px" : "9.4px"};
      line-height: 1.2;
      color: var(--muted);
      font-weight: 700;
    }
    .brief-list {
      margin: 3px 0 0;
      padding-left: 16px;
      display: grid;
      gap: 2px;
      font-size: ${isPdf ? "9.6px" : "10px"};
      color: #4b4b48;
      line-height: 1.22;
    }
    .pre-wrap {
      white-space: pre-wrap;
    }
    .source-chip-array {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .source-chip {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border: 1px solid #d5d5d2;
      border-radius: 2px;
      background: #f0f0ef;
      color: #121212;
      text-decoration: none;
      font-size: 10px;
      font-weight: 700;
      line-height: 1.25;
    }
    .source-chip:hover {
      text-decoration: underline;
    }
    .source-chip-static {
      border-color: #d5d5d2;
      background: #f7f7f6;
      color: #4b4b48;
      text-decoration: none;
    }
    .thread-list {
      display: grid;
      gap: 6px;
    }
    .thread-item {
      padding: 6px 8px;
      background: #f7f7f6;
      border: 1px solid #d5d5d2;
      border-radius: 2px;
    }
    .thread-role {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #4b4b48;
      margin-bottom: 2px;
    }
    .thread-body {
      font-size: ${isPdf ? "10px" : "10.5px"};
      color: #4b4b48;
      line-height: 1.22;
      white-space: pre-wrap;
    }
    .discover-list {
      display: grid;
      gap: 6px;
    }
    .discover-summary {
      font-size: ${isPdf ? "9.2px" : "9.6px"};
      color: #121212;
      font-weight: 700;
      line-height: 1.2;
      margin-bottom: 1px;
    }
    .discover-item {
      border: 1px solid #d5d5d2;
      background: #f7f7f6;
      border-radius: 2px;
      padding: 6px 8px;
    }
    .discover-title {
      font-size: ${isPdf ? "10.5px" : "11px"};
      font-weight: 800;
      color: #121212;
      margin-bottom: 2px;
    }
    .discover-rationale {
      font-size: ${isPdf ? "9.4px" : "9.8px"};
      color: #4b4b48;
      line-height: 1.25;
    }
    .discover-improves {
      margin-top: 3px;
      font-size: ${isPdf ? "9px" : "9.4px"};
      color: #121212;
      line-height: 1.2;
      font-weight: 700;
    }
    .discover-targets {
      margin-top: 4px;
      display: grid;
      gap: 2px;
    }
    .discover-target {
      font-size: ${isPdf ? "8.9px" : "9.3px"};
      color: #4b4b48;
      line-height: 1.2;
    }
    .discover-checks {
      margin-top: 4px;
      border: 1px solid #d5d5d2;
      border-radius: 2px;
      background: #f0f0ef;
      padding: 4px 6px;
      display: grid;
      gap: 2px;
    }
    .discover-check-title {
      font-size: ${isPdf ? "8.6px" : "9px"};
      color: #121212;
      line-height: 1.1;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .discover-check {
      font-size: ${isPdf ? "8.7px" : "9.1px"};
      color: #2e2e2b;
      line-height: 1.2;
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
      border-bottom: 1px solid #d5d5d2;
      padding: 7px 6px;
      vertical-align: top;
    }
    .portfolio-table th {
      font-size: 11px;
      text-transform: uppercase;
      color: #73736f;
      letter-spacing: 0.04em;
    }
    .muted {
      color: #73736f;
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
        padding: 0;
        min-height: calc(297mm - 16mm);
        overflow: visible;
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
        grid-template-columns: repeat(2, minmax(0, 1fr));
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

function buildReportHtml(useCases, dims, options = {}) {
  const mode = options.mode || "html";
  const includePortfolio = options.includePortfolio !== false;
  const generated = new Date().toLocaleString();
  const portfolioPage = `
    <article class="page">
      <div class="page-topline">Portfolio Overview</div>
      <h1 class="portfolio-title">Research it Portfolio Summary</h1>
      <div class="small-text">Generated: ${escapeHtml(generated)} | Use cases: ${useCases.length}</div>
      ${buildPortfolioTable(useCases, dims)}
      ${section("How to read this report", "<div class=\"small-text\">Each research has one intro page (problem + solution), one summary page, then one page per scoring dimension. Large typography highlights score and brief judgment. Smaller typography contains full reasoning, sources, and debate details.</div>")}
    </article>
  `;

  const useCasePages = useCases.map((uc, index) => {
    const intro = renderUseCaseIntroPage(uc, dims, index);
    const summary = renderUseCaseSummaryPage(uc, dims, index, { mode });
    const dimPages = dims.map((d) => renderDimensionPage(uc, d, { mode })).join("");
    return `${intro}${summary}${dimPages}`;
  }).join("");

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Research it Analysis Report</title>
        <style>${reportCss(mode)}</style>
      </head>
      <body>
        <main class="report">
          ${includePortfolio ? portfolioPage : ""}
          ${useCasePages}
        </main>
      </body>
    </html>
  `;
}

export function buildSingleUseCaseReportHtml(uc, dims) {
  return buildReportHtml([uc], dims, { mode: "html", includePortfolio: false });
}

function openHtmlInNewTab(html) {
  const tab = window.open("", "_blank");
  if (!tab) return false;
  tab.document.open();
  tab.document.write(html);
  tab.document.close();
  return true;
}

function buildSingleUseCaseJsonPayload(uc, dims) {
  return buildSingleUseCaseJsonPayloadCore(uc, dims, { appVersion: APP_VERSION });
}

function buildPortfolioJsonPayload(useCases, dims) {
  return buildPortfolioJsonPayloadCore(useCases, dims, { appVersion: APP_VERSION });
}

function downloadJson(filename, payload) {
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: "application/json;charset=utf-8;" });
  downloadBlob(filename, blob);
}

function markdownEscapeInline(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ");
}

function markdownTextBlock(value) {
  return String(value == null ? "" : value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function markdownSourceLine(source, index) {
  const label = `Source ${index + 1}`;
  const name = markdownEscapeInline(source?.name || "");
  const quote = markdownEscapeInline(source?.quote || "");
  const url = String(source?.url || "").trim();
  const meta = [name, quote].filter(Boolean).join(" - ");
  if (url) {
    return `- [${label}](${url})${meta ? `: ${meta}` : ""}`;
  }
  return `- ${label}${meta ? `: ${meta}` : ""}`;
}

function markdownSourcesSection(sources = []) {
  const normalized = Array.isArray(sources) ? sources : [];
  if (!normalized.length) return "- No sources.";
  return normalized.map((source, idx) => markdownSourceLine(source, idx)).join("\n");
}

function markdownThreadSection(thread = []) {
  if (!Array.isArray(thread) || !thread.length) return "- No follow-up thread.";
  return thread.map((entry) => {
    const role = entry?.role === "pm" ? "PM" : "Analyst";
    const body = entry?.role === "pm"
      ? String(entry?.text || "").trim()
      : String(entry?.response || entry?.text || "").trim();
    const proposal = entry?.role === "analyst" && entry?.scoreProposal?.newScore != null
      ? ` | score proposal ${entry.scoreProposal.previousScore}/5 -> ${entry.scoreProposal.newScore}/5 (${entry.scoreProposal.status || "pending"})`
      : "";
    return `- **${role}:** ${markdownEscapeInline(body || "(empty)")}${proposal}`;
  }).join("\n");
}

function buildScorecardMarkdown(uc, dims = []) {
  const title = String(uc?.attributes?.title || uc?.rawInput || uc?.id || "Untitled research").trim();
  const weighted = calcWeightedScore(uc, dims);
  const conclusion = String(uc?.finalScores?.conclusion || "").trim();
  const lines = [];

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`- Research ID: ${markdownEscapeInline(uc?.id || "")}`);
  lines.push("- Output mode: scorecard");
  lines.push(`- Exported at: ${new Date().toISOString()}`);
  if (Number.isFinite(Number(weighted))) lines.push(`- Weighted score: ${Number(weighted)}%`);
  lines.push("");

  lines.push("## Input");
  lines.push("");
  lines.push(markdownTextBlock(uc?.rawInput || "No input captured."));
  lines.push("");

  if (conclusion) {
    lines.push("## Strategic Conclusion");
    lines.push("");
    lines.push(markdownTextBlock(conclusion));
    lines.push("");
  }

  lines.push("## Dimension Analysis");
  lines.push("");

  if (!Array.isArray(dims) || !dims.length) {
    lines.push("No dimensions configured.");
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  dims.forEach((dim) => {
    const view = getDimensionView(uc, dim.id, { dimLabel: dim.label, dim });
    const critic = uc?.critique?.dimensions?.[dim.id] || {};
    const score = view?.effectiveScore;
    const confidence = String(view?.confidence || "").trim() || "unknown";
    const confidenceReason = String(view?.confidenceReason || "").trim();
    const brief = markdownTextBlock(view?.brief || "");
    const full = markdownTextBlock(view?.full || "");
    const risks = markdownTextBlock(view?.risks || "");
    const researchBrief = view?.researchBrief || null;
    const supporting = Array.isArray(view?.supportingArguments) ? view.supportingArguments : [];
    const limiting = Array.isArray(view?.limitingArguments) ? view.limitingArguments : [];
    const followUps = uc?.followUps?.[dim.id] || [];

    lines.push(`### ${dim.label}`);
    lines.push("");
    lines.push(`- Score: ${score == null ? "-" : `${score}/5`}`);
    lines.push(`- Weight: ${Number(dim?.weight) || 0}%`);
    lines.push(`- Confidence: ${confidence}${confidenceReason ? ` (${markdownEscapeInline(confidenceReason)})` : ""}`);
    lines.push(`- Stage: ${markdownEscapeInline(view?.stageLabel || "unknown")}`);
    lines.push("");

    if (brief) {
      lines.push("#### Brief");
      lines.push("");
      lines.push(brief);
      lines.push("");
    }

    if (full) {
      lines.push("#### Full Analysis");
      lines.push("");
      lines.push(full);
      lines.push("");
    }

    if (risks) {
      lines.push("#### Risks");
      lines.push("");
      lines.push(risks);
      lines.push("");
    }

    lines.push("#### Supporting Evidence");
    lines.push("");
    if (supporting.length) {
      supporting.forEach((arg) => {
        const claim = markdownEscapeInline(arg?.claim || "Unnamed claim");
        const detail = markdownEscapeInline(arg?.detail || "");
        const discarded = arg?.status === "discarded";
        const prefix = discarded ? "[discarded] " : "";
        lines.push(`- ${prefix}${claim}${detail ? ` - ${detail}` : ""}`);
      });
    } else {
      lines.push("- None.");
    }
    lines.push("");

    lines.push("#### Limiting Factors");
    lines.push("");
    if (limiting.length) {
      limiting.forEach((arg) => {
        const claim = markdownEscapeInline(arg?.claim || "Unnamed factor");
        const detail = markdownEscapeInline(arg?.detail || "");
        const discarded = arg?.status === "discarded";
        const prefix = discarded ? "[discarded] " : "";
        lines.push(`- ${prefix}${claim}${detail ? ` - ${detail}` : ""}`);
      });
    } else {
      lines.push("- None.");
    }
    lines.push("");

    if (researchBrief) {
      lines.push("#### Research Brief");
      lines.push("");
      const missingEvidence = markdownTextBlock(researchBrief?.missingEvidence || "");
      if (missingEvidence) {
        lines.push(`- Missing evidence: ${markdownEscapeInline(missingEvidence)}`);
      }
      const whereToLook = Array.isArray(researchBrief?.whereToLook) ? researchBrief.whereToLook.filter(Boolean) : [];
      if (whereToLook.length) {
        lines.push("- Where to look:");
        whereToLook.forEach((item) => lines.push(`  - ${markdownEscapeInline(item)}`));
      }
      const suggestedQueries = Array.isArray(researchBrief?.suggestedQueries) ? researchBrief.suggestedQueries.filter(Boolean) : [];
      if (suggestedQueries.length) {
        lines.push("- Suggested queries:");
        suggestedQueries.forEach((item) => lines.push(`  - ${markdownEscapeInline(item)}`));
      }
      if (!missingEvidence && !whereToLook.length && !suggestedQueries.length) {
        lines.push("- No research brief details.");
      }
      lines.push("");
    }

    lines.push("#### Sources");
    lines.push("");
    lines.push(markdownSourcesSection(view?.sources || []));
    lines.push("");

    lines.push("#### Critic");
    lines.push("");
    lines.push(`- Suggested score: ${critic?.suggestedScore == null ? "-" : `${critic.suggestedScore}/5`}`);
    lines.push(`- Score justified: ${critic?.scoreJustified == null ? "-" : String(critic.scoreJustified)}`);
    lines.push(`- Note: ${markdownEscapeInline(critic?.critique || "No critic comment.")}`);
    lines.push("- Critic sources:");
    const criticSources = markdownSourcesSection(critic?.sources || []).split("\n");
    criticSources.forEach((line) => lines.push(`  ${line}`));
    lines.push("");

    lines.push("#### Follow-up Thread");
    lines.push("");
    lines.push(markdownThreadSection(followUps));
    lines.push("");
  });

  return `${lines.join("\n")}\n`;
}

function buildMatrixMarkdown(uc) {
  const title = String(uc?.attributes?.title || uc?.rawInput || uc?.id || "Untitled matrix research").trim();
  const matrix = uc?.matrix || {};
  const subjects = Array.isArray(matrix?.subjects) ? matrix.subjects : [];
  const attributes = Array.isArray(matrix?.attributes) ? matrix.attributes : [];
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const coverage = matrix?.coverage || {};
  const lines = [];

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`- Research ID: ${markdownEscapeInline(uc?.id || "")}`);
  lines.push("- Output mode: matrix");
  lines.push(`- Exported at: ${new Date().toISOString()}`);
  lines.push(`- Cells: ${Number(coverage?.totalCells) || cells.length}`);
  lines.push(`- Low-confidence cells: ${Number(coverage?.lowConfidenceCells) || 0}`);
  lines.push(`- Critic flags: ${Number(coverage?.contestedCells) || 0}`);
  lines.push("");

  const decisionQuestion = markdownTextBlock(matrix?.decisionQuestion || "");
  if (decisionQuestion) {
    lines.push("## Decision Question");
    lines.push("");
    lines.push(decisionQuestion);
    lines.push("");
  }

  lines.push("## Subjects");
  lines.push("");
  if (subjects.length) {
    subjects.forEach((subject) => lines.push(`- ${markdownEscapeInline(subject?.label || subject?.id || "Unknown subject")}`));
  } else {
    lines.push("- No subjects.");
  }
  lines.push("");

  lines.push("## Attributes");
  lines.push("");
  if (attributes.length) {
    attributes.forEach((attribute) => {
      const label = markdownEscapeInline(attribute?.label || attribute?.id || "Unknown attribute");
      const brief = markdownEscapeInline(attribute?.brief || "");
      lines.push(`- ${label}${brief ? ` - ${brief}` : ""}`);
    });
  } else {
    lines.push("- No attributes.");
  }
  lines.push("");

  if (subjects.length && attributes.length) {
    const cellMap = new Map();
    cells.forEach((cell) => {
      const key = `${String(cell?.subjectId || "")}::${String(cell?.attributeId || "")}`;
      cellMap.set(key, cell);
    });

    lines.push("## Matrix (compact)");
    lines.push("");
    lines.push(`| Subject | ${attributes.map((attribute) => markdownEscapeInline(attribute?.label || attribute?.id || "Attribute")).join(" | ")} |`);
    lines.push(`| --- | ${attributes.map(() => "---").join(" | ")} |`);
    subjects.forEach((subject) => {
      const row = attributes.map((attribute) => {
        const key = `${String(subject?.id || "")}::${String(attribute?.id || "")}`;
        const cell = cellMap.get(key);
        const confidence = String(cell?.confidence || "").trim().toLowerCase();
        const confidenceMark = confidence === "high" ? "H" : confidence === "medium" ? "M" : confidence === "low" ? "L" : "-";
        const value = markdownEscapeInline(limitWords(cell?.value || "", 16) || "-");
        return `[${confidenceMark}] ${value}`;
      });
      lines.push(`| ${markdownEscapeInline(subject?.label || subject?.id || "Unknown subject")} | ${row.join(" | ")} |`);
    });
    lines.push("");
  }

  lines.push("## Cell Details");
  lines.push("");
  if (cells.length) {
    const subjectLabelById = new Map(subjects.map((subject) => [subject.id, subject.label || subject.id]));
    const attributeLabelById = new Map(attributes.map((attribute) => [attribute.id, attribute.label || attribute.id]));
    cells.forEach((cell) => {
      const subjectLabel = subjectLabelById.get(cell?.subjectId) || cell?.subjectId || "Unknown subject";
      const attributeLabel = attributeLabelById.get(cell?.attributeId) || cell?.attributeId || "Unknown attribute";
      lines.push(`### ${markdownEscapeInline(subjectLabel)} x ${markdownEscapeInline(attributeLabel)}`);
      lines.push("");
      lines.push(`- Confidence: ${markdownEscapeInline(cell?.confidence || "unknown")}${cell?.confidenceReason ? ` (${markdownEscapeInline(cell.confidenceReason)})` : ""}`);
      lines.push(`- Critic flagged: ${cell?.contested ? "yes" : "no"}`);
      if (cell?.analystDecision) lines.push(`- Analyst decision: ${markdownEscapeInline(cell.analystDecision)}`);
      if (cell?.analystNote) lines.push(`- Analyst note: ${markdownEscapeInline(cell.analystNote)}`);
      lines.push("");
      lines.push(markdownTextBlock(cell?.value || "No value."));
      lines.push("");
      lines.push("Sources:");
      lines.push(markdownSourcesSection(cell?.sources || []));
      lines.push("");
    });
  } else {
    lines.push("No matrix cells.");
    lines.push("");
  }

  const subjectSummaries = Array.isArray(matrix?.subjectSummaries) ? matrix.subjectSummaries : [];
  if (subjectSummaries.length) {
    const subjectLabelById = new Map(subjects.map((subject) => [subject.id, subject.label || subject.id]));
    lines.push("## Subject Summaries");
    lines.push("");
    subjectSummaries.forEach((summary) => {
      const label = subjectLabelById.get(summary?.subjectId) || summary?.subjectId || "Unknown subject";
      lines.push(`### ${markdownEscapeInline(label)}`);
      lines.push("");
      lines.push(markdownTextBlock(summary?.summary || "No summary."));
      lines.push("");
    });
  }

  const crossMatrixSummary = markdownTextBlock(matrix?.crossMatrixSummary || "");
  if (crossMatrixSummary) {
    lines.push("## Cross-Matrix Summary");
    lines.push("");
    lines.push(crossMatrixSummary);
    lines.push("");
  }

  const discover = uc?.discover || {};
  const suggestedSubjects = Array.isArray(discover?.suggestedSubjects) ? discover.suggestedSubjects : [];
  const suggestedAttributes = Array.isArray(discover?.suggestedAttributes) ? discover.suggestedAttributes : [];
  if (suggestedSubjects.length || suggestedAttributes.length) {
    lines.push("## Discovery Suggestions");
    lines.push("");
    if (suggestedSubjects.length) {
      lines.push("### Suggested Subjects");
      lines.push("");
      suggestedSubjects.forEach((item) => {
        lines.push(`- ${markdownEscapeInline(item?.label || "Unknown")} - ${markdownEscapeInline(item?.reason || "")}`);
      });
      lines.push("");
    }
    if (suggestedAttributes.length) {
      lines.push("### Suggested Attributes");
      lines.push("");
      suggestedAttributes.forEach((item) => {
        lines.push(`- ${markdownEscapeInline(item?.label || "Unknown")} - ${markdownEscapeInline(item?.reason || "")}`);
      });
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

export function exportSingleUseCaseMarkdown(uc, dims = []) {
  const outputMode = String(uc?.outputMode || (uc?.matrix ? "matrix" : "scorecard")).trim().toLowerCase();
  const markdown = outputMode === "matrix"
    ? buildMatrixMarkdown(uc)
    : buildScorecardMarkdown(uc, Array.isArray(dims) ? dims : []);
  const tag = safeFilePart(uc?.attributes?.title || uc?.rawInput || uc?.id || "research");
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8;" });
  downloadBlob(`research-report-${tag}-${timestampTag()}.md`, blob);
  return markdown;
}

function parseEnvelope(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error("File is not valid JSON.");
  }
  if (!isPlainObject(parsed)) throw new Error("Top-level JSON must be an object.");
  if (typeof parsed.format !== "string") throw new Error("Missing export format marker.");
  if (!Number.isFinite(Number(parsed.schemaVersion))) throw new Error("Missing or invalid schemaVersion.");
  const schemaVersion = Number(parsed.schemaVersion);
  if (schemaVersion > EXPORT_SCHEMA_VERSION) {
    throw new Error(`File was produced by a newer schema version (${schemaVersion}).`);
  }
  if (typeof parsed.appVersion === "string" && parsed.appVersion.trim()) {
    const fileMajor = Number(String(parsed.appVersion).split(".")[0]) || 0;
    const currentMajor = Number(String(APP_VERSION).split(".")[0]) || 0;
    if (fileMajor > currentMajor && currentMajor > 0) {
      throw new Error(`File was produced by a newer app version (${parsed.appVersion}).`);
    }
  }
  if (parsed.format !== "uc-single" && parsed.format !== "uc-portfolio") {
    throw new Error(`Unsupported export format: ${parsed.format}`);
  }
  return parsed;
}

function extractImportedUseCases(envelope) {
  if (envelope.format === "uc-single") {
    if (!isPlainObject(envelope.useCase)) throw new Error("Single-use-case file is missing useCase payload.");
    validateUseCaseShape(envelope.useCase);
    return [deepClone(envelope.useCase)];
  }
  if (!Array.isArray(envelope.useCases)) throw new Error("Portfolio file is missing useCases array.");
  envelope.useCases.forEach(validateUseCaseShape);
  return deepClone(envelope.useCases);
}

export function importUseCasesFromJsonText(text, currentConfigItems, existingIds = [], outputMode = "scorecard") {
  return importUseCasesFromJsonTextCore(text, currentConfigItems, existingIds, {
    appVersion: APP_VERSION,
    outputMode,
  });
}

export function exportSingleUseCaseJson(uc, dims) {
  const payload = buildSingleUseCaseJsonPayload(uc, dims);
  const slug = safeFilePart(uc?.attributes?.title || uc?.rawInput || uc?.id || "research");
  downloadJson(`${slug}-${dateTag()}.json`, payload);
  return payload;
}

export function exportPortfolioJson(useCases, dims) {
  const outputMode = String(useCases?.[0]?.outputMode || (useCases?.[0]?.matrix ? "matrix" : "scorecard"));
  const payload = buildPortfolioJsonPayload(useCases, dims, { outputMode });
  const count = payload.useCases.length;
  downloadJson(`uc-portfolio-${dateTag()}-${count}-cases.json`, payload);
  return payload;
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
      conclusion: uc.finalScores?.conclusion || "",
      raw_input: uc.rawInput || "",
    };
    dims.forEach((d) => {
      const view = getDimensionView(uc, d.id, { dimLabel: d.label, dim: d });
      row[`${d.id}_score`] = view.effectiveScore ?? "";
      row[`${d.id}_stage`] = view.stageLabel;
      row[`${d.id}_confidence`] = view.confidence || "";
      row[`${d.id}_confidence_reason`] = view.confidenceReason || "";
    });
    return row;
  });

  downloadCsv(`research-summary-${timestampTag()}.csv`, rowsToCsv(headers, rows));
}

export function exportDetailCsv(useCases, dims) {
  const headers = [
    "use_case_id",
    "use_case_title",
    "dimension_id",
    "dimension_label",
    "dimension_weight_pct",
    "enabled",
    "effective_score",
    "initial_score",
    "debate_score",
    "follow_up_score",
    "update_stage",
    "confidence_level",
    "confidence_reason",
    "research_missing_evidence",
    "research_where_to_look",
    "research_suggested_queries",
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
      const view = getDimensionView(uc, d.id, { dimLabel: d.label, dim: d });
      const critic = uc.critique?.dimensions?.[d.id];
      const threadHistory = (uc.followUps?.[d.id] || [])
        .map((m) => (m.role === "pm" ? `PM: ${m.text || ""}` : `Analyst: ${m.response || m.text || ""}`))
        .join("\n");

      rows.push({
        use_case_id: uc.id,
        use_case_title: uc.attributes?.title || uc.rawInput || "",
        dimension_id: d.id,
        dimension_label: d.label,
        dimension_weight_pct: d.weight,
        enabled: d.enabled ? "yes" : "no",
        effective_score: view.effectiveScore ?? "",
        initial_score: view.initial?.score ?? "",
        debate_score: view.debate?.finalScore ?? "",
        follow_up_score: view.followUp?.newScore ?? "",
        update_stage: view.stageLabel,
        confidence_level: view.confidence || "",
        confidence_reason: view.confidenceReason || "",
        research_missing_evidence: view.researchBrief?.missingEvidence || "",
        research_where_to_look: (view.researchBrief?.whereToLook || []).join(" | "),
        research_suggested_queries: (view.researchBrief?.suggestedQueries || []).join(" | "),
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

  downloadCsv(`research-detail-${timestampTag()}.csv`, rowsToCsv(headers, rows));
}

function printHtmlFromHiddenFrame(html) {
  return new Promise((resolve) => {
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
        resolve(false);
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
          resolve(true);
        } catch (_) {
          resolve(false);
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
      resolve(false);
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();
  });
}

export async function exportAnalysisHtml(useCases, dims) {
  const html = buildReportHtml(useCases, dims, { mode: "html", includePortfolio: true });
  downloadHtml(`research-analysis-${timestampTag()}.html`, html);
  return true;
}

export async function exportAnalysisPdf(useCases, dims) {
  const html = buildReportHtml(useCases, dims, { mode: "pdf", includePortfolio: true });
  return printHtmlFromHiddenFrame(html);
}

export async function exportSingleUseCaseHtml(uc, dims) {
  const html = buildSingleUseCaseReportHtml(uc, dims);
  const tag = safeFilePart(uc?.attributes?.title || uc?.id || "research");
  const opened = openHtmlInNewTab(html);
  if (!opened) {
    downloadHtml(`research-report-${tag}-${timestampTag()}.html`, html);
  }
  return true;
}

export async function openSingleUseCaseHtml(uc, dims) {
  const html = buildSingleUseCaseReportHtml(uc, dims);
  const opened = openHtmlInNewTab(html);
  if (!opened) {
    const tag = safeFilePart(uc?.attributes?.title || uc?.id || "research");
    downloadHtml(`research-report-${tag}-${timestampTag()}.html`, html);
  }
  return true;
}

export async function exportSingleUseCasePdf(uc, dims) {
  const html = buildReportHtml([uc], dims, { mode: "pdf", includePortfolio: false });
  return printHtmlFromHiddenFrame(html);
}

export async function exportSingleUseCaseImagesZip(uc, dims) {
  const title = uc?.attributes?.title || uc?.rawInput || uc?.id || "research";
  const baseTag = safeFilePart(title);
  const html = buildReportHtml([uc], dims, { mode: "html", includePortfolio: false });
  const host = buildOffscreenReportHost(html);

  document.body.appendChild(host);
  try {
    await ensureRendered();
    const pages = Array.from(host.querySelectorAll(".page"));
    if (!pages.length) {
      window.alert("No pages found for image export.");
      return;
    }

    const zip = new JSZip();
    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i];
      const dataUrl = await toPng(page, {
        cacheBust: true,
        pixelRatio: 3,
        backgroundColor: "#ffffff",
        width: page.scrollWidth,
        height: page.scrollHeight,
      });
      const blob = await dataUrlToBlob(dataUrl);
      const idx = String(i + 1).padStart(2, "0");
      zip.file(`${baseTag}-slide-${idx}.png`, blob);
    }

    const zipBlob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    downloadBlob(`research-images-${baseTag}-${timestampTag()}.zip`, zipBlob);
  } catch (err) {
    console.error("Image export failed:", err);
    window.alert(`Image export failed: ${err.message}`);
  } finally {
    if (host.parentNode) host.parentNode.removeChild(host);
  }
}
