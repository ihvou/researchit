import { useState, useRef, useEffect } from "react";
import { RESEARCH_CONFIGS, DEFAULT_RESEARCH_CONFIG } from "../../configs/research-configurations.js";
import { calcWeightedScore } from "./lib/scoring";
import { getDimensionView } from "./lib/dimensionView";
import { runAnalysis } from "./hooks/useAnalysis";
import { handleFollowUp } from "./hooks/useFollowUp";
import {
  exportAnalysisHtml,
  exportAnalysisPdf,
  exportPortfolioJson,
  importUseCasesFromJsonText,
} from "./lib/export";
import { downloadDebugLogsBundle } from "./lib/debug";
import Spinner from "./components/Spinner";
import ScorePill from "./components/ScorePill";
import TotalPill from "./components/TotalPill";
import DimRubricToggle from "./components/DimRubricToggle";
import ExpandedRow from "./components/ExpandedRow";
import ConfidenceBadge from "./components/ConfidenceBadge";
import ChevronIcon from "./components/ChevronIcon";

const INTERNAL_ANALYSIS_MODE = "hybrid";
const CHEMICAL_NUMBER = 75;

function cloneDims(dims = []) {
  return (dims || []).map((d) => ({ ...d }));
}

function buildRuntimeConfig(baseConfig, dims) {
  return {
    ...baseConfig,
    dimensions: cloneDims(dims),
    prompts: { ...(baseConfig?.prompts || {}) },
    models: { ...(baseConfig?.models || {}) },
    limits: {
      ...(baseConfig?.limits || {}),
      tokenLimits: {
        ...(baseConfig?.limits?.tokenLimits || {}),
      },
    },
  };
}

function trimText(text, max = 170) {
  const str = String(text || "").trim();
  if (!str) return "";
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1).trimEnd()}...`;
}

export default function App() {
  const [useCases, setUseCases] = useState([]);
  const [activeConfigId, setActiveConfigId] = useState(DEFAULT_RESEARCH_CONFIG.id);
  const [dimsByConfig, setDimsByConfig] = useState(() => (
    Object.fromEntries(
      RESEARCH_CONFIGS.map((config) => [config.id, cloneDims(config.dimensions)])
    )
  ));
  const [inputText, setInputText] = useState("");
  const [showInputPanel, setShowInputPanel] = useState(false);
  const [showDimsPanel, setShowDimsPanel] = useState(false);
  const [showMethodologyFull, setShowMethodologyFull] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [globalAnalyzing, setGlobalAnalyzing] = useState(false);
  const [fuInputs, setFuInputs] = useState({});
  const [fuLoading, setFuLoading] = useState({});
  const [toolbarExportLoading, setToolbarExportLoading] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  const [importWarning, setImportWarning] = useState("");
  const [importError, setImportError] = useState("");

  const ucRef = useRef(useCases);
  const cardRefs = useRef({});
  const exportMenuRef = useRef(null);
  const importFileRef = useRef(null);
  useEffect(() => { ucRef.current = useCases; }, [useCases]);
  useEffect(() => { setShowMethodologyFull(false); }, [activeConfigId]);

  const activeConfig = RESEARCH_CONFIGS.find((config) => config.id === activeConfigId)
    || DEFAULT_RESEARCH_CONFIG;
  const dims = dimsByConfig[activeConfig.id] || cloneDims(activeConfig.dimensions);

  function setActiveDims(updater) {
    setDimsByConfig((prev) => {
      const current = cloneDims(prev[activeConfig.id] || activeConfig.dimensions);
      const next = typeof updater === "function" ? updater(current) : updater;
      return {
        ...prev,
        [activeConfig.id]: cloneDims(next),
      };
    });
  }

  function updateUC(id, fn) {
    setUseCases(prev => prev.map(u => u.id === id ? fn(u) : u));
  }

  function setFuInput(key, val) {
    setFuInputs(prev => ({ ...prev, [key]: val }));
  }

  async function runNewAnalysis(descInput, origin = null, configOverride = null) {
    const desc = String(descInput || "").trim();
    if (!desc || globalAnalyzing) return;

    const selectedConfig = configOverride || activeConfig;
    const selectedDims = dimsByConfig[selectedConfig.id] || selectedConfig.dimensions;
    const runtimeConfig = buildRuntimeConfig(selectedConfig, selectedDims);

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const initialPhase = "analyst_baseline";
    const blankUC = {
      id, rawInput: desc, status: "analyzing", phase: initialPhase,
      attributes: null, dimScores: null, critique: null, finalScores: null,
      debate: [], followUps: {}, errorMsg: null, discover: null, origin,
      researchConfigId: selectedConfig.id,
      researchConfigName: selectedConfig.name,
      analysisMeta: {
        analysisMode: INTERNAL_ANALYSIS_MODE,
        liveSearchRequested: true,
        liveSearchUsed: false,
        webSearchCalls: 0,
        liveSearchFallbackReason: null,
        criticLiveSearchRequested: true,
        criticLiveSearchUsed: false,
        criticWebSearchCalls: 0,
        criticLiveSearchFallbackReason: null,
        discoveryLiveSearchRequested: true,
        discoveryLiveSearchUsed: false,
        discoveryWebSearchCalls: 0,
        discoveryLiveSearchFallbackReason: null,
        generatedDiscoverCandidatesCount: 0,
        discoverCandidatesCount: 0,
        rejectedDiscoverCandidatesCount: 0,
        lowConfidenceInitialCount: 0,
        lowConfidenceUpgradedCount: 0,
        lowConfidenceValidatedLowCount: 0,
        lowConfidenceCycleFailures: 0,
        lowConfidenceTargetedSearchUsed: false,
        lowConfidenceTargetedWebSearchCalls: 0,
        lowConfidenceTargetedFallbackReason: null,
        hybridStats: null,
      },
    };

    setUseCases(prev => [...prev, blankUC]);
    setShowInputPanel(false);
    setInputText("");
    setExpandedId(id);
    setGlobalAnalyzing(true);

    try {
      await runAnalysis(desc, selectedDims, updateUC, id, {
        analysisMode: INTERNAL_ANALYSIS_MODE,
        origin,
        config: runtimeConfig,
      });
    } catch (err) {
      console.error("Analysis error:", err);
      updateUC(id, u => ({ ...u, status: "error", phase: "error", errorMsg: err.message }));
    }
    setGlobalAnalyzing(false);
  }

  async function startAnalysis() {
    const desc = inputText.trim();
    if (!desc || globalAnalyzing) return;
    await runNewAnalysis(desc, null);
  }

  async function onFollowUp(ucId, dimId, challenge, options = {}) {
    if (!challenge.trim()) return;
    const fuKey = `${ucId}::${dimId}`;
    setFuLoading(prev => ({ ...prev, [fuKey]: true }));
    setFuInput(fuKey, "");

    try {
      const targetUseCase = ucRef.current.find((u) => u.id === ucId);
      const targetConfigId = targetUseCase?.researchConfigId || activeConfig.id;
      const targetConfig = RESEARCH_CONFIGS.find((config) => config.id === targetConfigId) || activeConfig;
      const targetDims = dimsByConfig[targetConfig.id] || targetConfig.dimensions;
      await handleFollowUp(
        ucId,
        dimId,
        challenge,
        targetDims,
        ucRef,
        updateUC,
        {
          ...options,
          config: buildRuntimeConfig(targetConfig, targetDims),
        }
      );
    } catch (err) {
      updateUC(ucId, u => ({
        ...u,
        followUps: {
          ...u.followUps,
          [dimId]: [...(u.followUps?.[dimId] || []), {
            id: `fu-analyst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "analyst", response: `Error: ${err.message}`,
            sources: [], scoreAdjusted: false, newScore: null,
            scoreProposal: null,
          }],
        },
      }));
    }
    setFuLoading(prev => ({ ...prev, [fuKey]: false }));
  }

  function onDiscardArgument(ucId, dimId, argument, reason = "") {
    if (!argument?.id) return;
    const detail = String(reason || "").trim();
    const fallbackText = `Discarded ${argument.group === "limiting" ? "limiting factor" : "supporting evidence"} "${argument.claim || argument.id}"`;
    updateUC(ucId, (u) => ({
      ...u,
      followUps: {
        ...u.followUps,
        [dimId]: [...(u.followUps?.[dimId] || []), {
          id: `fu-pm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "pm",
          intent: "note",
          text: detail ? `${fallbackText}. ${detail}` : fallbackText,
          argumentAction: {
            action: "discard",
            group: argument.group === "limiting" ? "limiting" : "supporting",
            id: String(argument.id),
            reason: detail || fallbackText,
          },
          timestamp: new Date().toISOString(),
        }],
      },
    }));
  }

  function onResolveFollowUpProposal(ucId, dimId, messageId, decision) {
    updateUC(ucId, (u) => ({
      ...u,
      followUps: {
        ...u.followUps,
        [dimId]: (u.followUps?.[dimId] || []).map((msg) => {
          if (msg?.id !== messageId || msg?.role !== "analyst" || !msg?.scoreProposal) return msg;
          const status = decision === "accept" ? "accepted" : "dismissed";
          return {
            ...msg,
            scoreProposal: {
              ...msg.scoreProposal,
              status,
              resolvedAt: new Date().toISOString(),
            },
            scoreAdjusted: status === "accepted",
            newScore: status === "accepted" ? msg.scoreProposal.newScore : null,
          };
        }),
      },
    }));
  }

  async function onAnalyzeRelated(parentUc, candidate) {
    const desc = (candidate?.analysisInput || candidate?.title || "").trim();
    if (!desc || globalAnalyzing) return;
    const parentConfig = RESEARCH_CONFIGS.find((config) => config.id === parentUc?.researchConfigId)
      || activeConfig;
    const origin = {
      type: "discover",
      fromUseCaseId: parentUc?.id,
      fromUseCaseTitle: parentUc?.attributes?.title || parentUc?.rawInput || "",
      candidateTitle: candidate?.title || "",
    };
    await runNewAnalysis(desc, origin, parentConfig);
  }

  function focusResearch(id, options = {}) {
    const { forceOpen = false } = options;
    setExpandedId((prev) => (forceOpen ? id : (prev === id ? null : id)));
    requestAnimationFrame(() => {
      const el = cardRefs.current[id];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
    });
  }

  async function runToolbarExport(kind, action) {
    if (toolbarExportLoading) return;
    setToolbarExportLoading(kind);
    setImportError("");
    try {
      await action();
    } catch (err) {
      setImportError(`Export failed: ${err?.message || "Unknown error."}`);
    } finally {
      setToolbarExportLoading("");
      exportMenuRef.current?.removeAttribute("open");
    }
  }

  function triggerImportJson() {
    if (importLoading) return;
    setImportError("");
    importFileRef.current?.click();
  }

  async function onImportJsonChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportLoading(true);
    setImportError("");
    setImportWarning("");
    try {
      const text = await file.text();
      const parsed = importUseCasesFromJsonText(text, dims, useCases.map((u) => u.id));
      if (!parsed.useCases.length) {
        throw new Error("No completed researches were found in this file.");
      }
      const importedWithConfig = parsed.useCases.map((uc) => ({
        ...uc,
        researchConfigId: activeConfig.id,
        researchConfigName: activeConfig.name,
      }));
      setUseCases((prev) => [...prev, ...importedWithConfig]);
      setExpandedId(importedWithConfig[importedWithConfig.length - 1].id);
      setImportWarning(parsed.warning || "");
    } catch (err) {
      setImportError(err?.message || "Import failed.");
    } finally {
      setImportLoading(false);
      e.target.value = "";
    }
  }

  const visibleUseCases = useCases.filter((u) => {
    const configId = u?.researchConfigId || DEFAULT_RESEARCH_CONFIG.id;
    return configId === activeConfig.id;
  });
  const activeDims = dims.filter(d => d.enabled);
  const totalWeight = dims.reduce((s, d) => s + d.weight, 0);
  const completedCount = visibleUseCases.filter((u) => u.status === "complete").length;
  const methodology = activeConfig?.methodology || "";
  const dimensionSnapshot = activeDims.map((d) => {
    const scored = visibleUseCases
      .map((u) => getDimensionView(u, d.id, { dimLabel: d.label, dim: d }).effectiveScore)
      .filter((v) => v != null);
    const avg = scored.length
      ? (scored.reduce((sum, v) => sum + Number(v), 0) / scored.length).toFixed(1)
      : null;
    return { ...d, avg };
  });

  const PHASE_LABEL_SHORT = {
    analyst: "Research...",
    analyst_baseline: "Baseline pass...",
    analyst_web: "Web pass...",
    analyst_reconcile: "Reconcile pass...",
    analyst_targeted: "Low-confidence deep search...",
    critic: "Critic review...",
    finalizing: "Debate...",
    discover: "Discover...",
  };

  return (
    <div className="app-shell">
      <div className="app-header">
        <div className="header-row">
          <div style={{
            position: "relative",
            width: 28,
            height: 28,
            borderRadius: 2,
            border: "1px solid var(--ck-line-strong)",
            background: "var(--ck-surface-soft)",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
            fontWeight: 800,
            color: "var(--ck-text)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}>
            <span style={{ position: "absolute", top: 1, left: 3, fontSize: 8, color: "var(--ck-muted)" }}>{CHEMICAL_NUMBER}</span>
            <span style={{ fontSize: 13, lineHeight: 1 }}>Re</span>
          </div>
          <span className="brand-title" style={{ fontWeight: 800, fontSize: 17, color: "var(--ck-text)" }}>Researchit</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <details ref={exportMenuRef} style={{ position: "relative" }}>
              <summary
                onClick={(e) => {
                  if (!visibleUseCases.length || toolbarExportLoading || importLoading) e.preventDefault();
                }}
                style={{
                  background: "var(--ck-surface)",
                  border: "1px solid var(--ck-line)",
                  color: visibleUseCases.length ? "var(--ck-text)" : "var(--ck-muted-soft)",
                  padding: "6px 10px",
                  borderRadius: 2,
                  fontSize: 12,
                  fontWeight: 600,
                  opacity: visibleUseCases.length && !importLoading ? 1 : 0.5,
                  cursor: visibleUseCases.length && !toolbarExportLoading && !importLoading ? "pointer" : "not-allowed",
                  userSelect: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}>
                <span>{toolbarExportLoading ? "Exporting..." : "Export"}</span>
                <ChevronIcon direction="down" size={12} />
              </summary>
              <div style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 6px)",
                background: "var(--ck-surface)",
                border: "1px solid var(--ck-line)",
                borderRadius: 2,
                minWidth: 185,
                padding: 6,
                display: "grid",
                gap: 4,
                zIndex: 30,
              }}>
                {[
                  { key: "html", label: "HTML Report", action: () => exportAnalysisHtml(visibleUseCases, dims) },
                  { key: "pdf", label: "PDF Report", action: () => exportAnalysisPdf(visibleUseCases, dims) },
                  {
                    key: "portfolio-json",
                    label: "Portfolio JSON",
                    action: () => {
                      if (!completedCount) {
                        throw new Error("No completed researches available for portfolio JSON export.");
                      }
                      return exportPortfolioJson(visibleUseCases, dims);
                    },
                  },
                  { key: "logs", label: "Logs JSON", action: () => downloadDebugLogsBundle() },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => { void runToolbarExport(item.key, item.action); }}
                    disabled={!!toolbarExportLoading || importLoading}
                    style={{
                      background: "var(--ck-surface-soft)",
                      border: "1px solid var(--ck-line)",
                      color: "var(--ck-text)",
                      textAlign: "left",
                      borderRadius: 2,
                      fontSize: 12,
                      padding: "6px 8px",
                      opacity: toolbarExportLoading && toolbarExportLoading !== item.key ? 0.55 : 1,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}>
                    {toolbarExportLoading === item.key ? <Spinner size={10} /> : null}
                    <span>{toolbarExportLoading === item.key ? `${item.label}...` : item.label}</span>
                  </button>
                ))}
              </div>
            </details>
            <input
              ref={importFileRef}
              type="file"
              accept=".json,application/json"
              onChange={onImportJsonChange}
              style={{ display: "none" }}
            />
            <button
              onClick={triggerImportJson}
              disabled={importLoading}
              style={{
                background: "var(--ck-surface)",
                border: "1px solid var(--ck-line)",
                color: "var(--ck-text)",
                padding: "6px 12px",
                borderRadius: 2,
                fontSize: 12,
                fontWeight: 600,
                opacity: importLoading ? 0.6 : 1,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}>
              {importLoading ? <><Spinner size={10} color="var(--ck-text)" /> Importing...</> : "Import JSON"}
            </button>
            <button
              onClick={() => setShowDimsPanel(v => !v)}
              style={{
                background: showDimsPanel ? "var(--ck-blue-soft)" : "var(--ck-surface)",
                border: "1px solid var(--ck-line)",
                color: "var(--ck-text)",
                padding: "6px 12px",
                borderRadius: 2,
                fontSize: 12,
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}>
              <span>Dimensions</span>
              <ChevronIcon direction={showDimsPanel ? "up" : "down"} size={12} />
            </button>
            <button
              onClick={() => setShowInputPanel(v => !v)}
              style={{ background: "var(--ck-accent)", border: "none", color: "var(--ck-accent-ink)", padding: "7px 14px", borderRadius: 2, fontSize: 13, fontWeight: 700 }}>
              + Research
            </button>
          </div>
        </div>

        <div className="scroll-row">
          <div className="scroll-row-inner">
            {RESEARCH_CONFIGS.map((config) => {
              const isActive = config.id === activeConfig.id;
              return (
                <button
                  key={config.id}
                  type="button"
                  onClick={() => {
                    setActiveConfigId(config.id);
                    setShowInputPanel(false);
                    setExpandedId(null);
                    exportMenuRef.current?.removeAttribute("open");
                  }}
                  style={{
                    padding: "6px 11px",
                    fontSize: 12,
                    fontWeight: 700,
                    border: `1px solid ${isActive ? "var(--ck-accent)" : "var(--ck-line)"}`,
                    background: isActive ? "var(--ck-blue-soft)" : "var(--ck-surface)",
                    color: isActive ? "var(--ck-text)" : "var(--ck-muted)",
                    whiteSpace: "nowrap",
                  }}>
                  {config.tabLabel || config.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="methodology-panel">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
              Methodology / Description
            </div>
            <button
              type="button"
              onClick={() => setShowMethodologyFull((v) => !v)}
              style={{ border: "none", background: "transparent", color: "var(--ck-muted)", padding: 0, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600 }}>
              <ChevronIcon direction={showMethodologyFull ? "up" : "down"} size={11} />
              {showMethodologyFull ? "less" : "more"}
            </button>
          </div>
          <p
            className="methodology-text"
            style={!showMethodologyFull ? {
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            } : undefined}>
            {methodology || "No methodology description is available for this configuration yet."}
          </p>
        </div>

        <div className="scroll-row">
          <div className="scroll-row-inner">
            {dimensionSnapshot.map((d) => (
              <div key={d.id} className="dimension-strip-item">
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>
                  {d.label}
                </div>
                <div style={{ marginTop: 2, display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>
                  <span className="mono" style={{ color: "var(--ck-text)", fontWeight: 700 }}>{d.weight}%</span>
                  <span style={{ color: "var(--ck-muted-soft)" }}>|</span>
                  <span style={{ color: "var(--ck-muted)" }}>{d.avg ? `avg ${d.avg}/5` : "no scores yet"}</span>
                </div>
              </div>
            ))}
            {!dimensionSnapshot.length && (
              <div style={{ fontSize: 11, color: "var(--ck-muted)" }}>Enable at least one dimension in the Dimensions panel.</div>
            )}
          </div>
        </div>

        <div className="scroll-row">
          <div className="scroll-row-inner">
            {visibleUseCases.length ? visibleUseCases.map((uc) => {
              const title = uc.attributes?.title || trimText(uc.rawInput, 44) || "Untitled research";
              const score = calcWeightedScore(uc, dims);
              const active = expandedId === uc.id;
              return (
                <button
                  key={`tab-${uc.id}`}
                  type="button"
                  onClick={() => focusResearch(uc.id, { forceOpen: true })}
                  style={{
                    padding: "5px 8px",
                    border: `1px solid ${active ? "var(--ck-accent)" : "var(--ck-line)"}`,
                    background: active ? "var(--ck-blue-soft)" : "var(--ck-surface)",
                    color: "var(--ck-text)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    maxWidth: 260,
                  }}>
                  <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
                  <span style={{ color: "var(--ck-muted-soft)" }}>|</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--ck-muted)" }}>{score != null ? `${score}%` : PHASE_LABEL_SHORT[uc.phase] || "-"}</span>
                </button>
              );
            }) : (
              <span style={{ fontSize: 11, color: "var(--ck-muted)" }}>No researches in this configuration yet.</span>
            )}
          </div>
        </div>
      </div>

      {showDimsPanel && (
        <div style={{ background: "var(--ck-surface)", borderBottom: "1px solid var(--ck-line)", padding: "16px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
            {activeConfig.tabLabel || activeConfig.name} - dimension definitions, rubrics, weights
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(290px,1fr))", gap: 10, marginBottom: 12 }}>
            {dims.map(d => (
              <div key={d.id} style={{
                background: "var(--ck-surface-soft)", border: `1px solid ${d.enabled ? "var(--ck-line-strong)" : "var(--ck-line)"}`,
                borderRadius: 2, padding: "10px 14px", opacity: d.enabled ? 1 : 0.5,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <input
                    type="checkbox" checked={d.enabled}
                    onChange={e => setActiveDims((p) => p.map((x) => (x.id === d.id ? { ...x, enabled: e.target.checked } : x)))}
                    style={{ accentColor: "var(--ck-accent)", width: 14, height: 14 }} />
                  <span style={{ fontWeight: 600, fontSize: 12, color: d.enabled ? "var(--ck-text)" : "var(--ck-muted)" }}>{d.label}</span>
                  <span className="mono" style={{ marginLeft: "auto", fontSize: 12, color: "var(--ck-text)", fontWeight: 700 }}>{d.weight}%</span>
                </div>
                <DimRubricToggle dim={d} />
                <input
                  type="range" min={1} max={40} step={1} value={d.weight}
                  disabled={!d.enabled}
                  onChange={e => setActiveDims((p) => p.map((x) => (x.id === d.id ? { ...x, weight: +e.target.value } : x)))}
                  style={{ width: "100%", accentColor: "var(--ck-accent)", marginTop: 4 }} />
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--ck-muted)" }}>
            Total weight: <span style={{ color: "var(--ck-text)", fontWeight: 700 }}>{totalWeight}%</span>
            <span style={{ marginLeft: 8 }}>- scores auto-normalize, only relative weights matter</span>
          </div>
        </div>
      )}

      {showInputPanel && (
        <div style={{ background: "var(--ck-surface)", borderBottom: "1px solid var(--ck-line)", padding: "16px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
            New Research - describe the problem or solution
          </div>
          <textarea
            autoFocus
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder={'Vague and high-level is fine. E.g. "AI for insurance claims processing" or "automate contract review for legal teams in financial services"'}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startAnalysis(); }}
            style={{
              width: "100%", height: 90, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line-strong)",
              borderRadius: 2, color: "var(--ck-text)", padding: "10px 14px", fontSize: 13,
              resize: "vertical", lineHeight: 1.5, outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={startAnalysis}
              disabled={!inputText.trim() || globalAnalyzing}
              style={{
                background: "var(--ck-accent)", border: "none", color: "var(--ck-accent-ink)",
                padding: "8px 20px", borderRadius: 2, fontWeight: 700, fontSize: 13,
                opacity: !inputText.trim() || globalAnalyzing ? 0.5 : 1,
                display: "inline-flex", alignItems: "center", gap: 6,
              }}>
              {globalAnalyzing ? <><Spinner size={11} color="var(--ck-accent-ink)" /> Analyzing...</> : "Analyze"}
            </button>
            <span style={{ fontSize: 11, color: "var(--ck-muted)" }}>Cmd/Ctrl+Enter to submit</span>
            <button
              onClick={() => setShowInputPanel(false)}
              style={{ marginLeft: "auto", background: "transparent", border: "1px solid var(--ck-line-strong)", color: "var(--ck-muted)", padding: "7px 14px", borderRadius: 2, fontSize: 12 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ padding: 20 }}>
        {importError && (
          <div style={{ marginBottom: 10, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "9px 12px", color: "var(--ck-text)", fontSize: 12 }}>
            {importError}
          </div>
        )}
        {importWarning && (
          <div style={{ marginBottom: 10, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "9px 12px", color: "var(--ck-muted)", fontSize: 12 }}>
            {importWarning}
          </div>
        )}
        {visibleUseCases.length === 0 ? (
          <div style={{ textAlign: "left", padding: "32px 20px", maxWidth: 760, margin: "0 auto", background: "var(--ck-surface)", borderRadius: 2, border: "1px solid var(--ck-line)" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--ck-text)", marginBottom: 8 }}>
              Researchit
            </div>
            <div style={{ fontSize: 13, color: "var(--ck-muted)", marginBottom: 14 }}>
              Add one research and the tool will run a structured workflow.
            </div>
            <button
              type="button"
              onClick={() => setShowInputPanel(true)}
              style={{ background: "var(--ck-accent)", border: "none", color: "var(--ck-accent-ink)", fontWeight: 700, fontSize: 13, padding: "8px 12px" }}>
              + Research
            </button>
          </div>
        ) : (
          <div className="research-list">
            {visibleUseCases.map((uc) => {
              const score = calcWeightedScore(uc, dims);
              const isExpanded = expandedId === uc.id;
              const title = uc.attributes?.title || trimText(uc.rawInput, 80) || "Untitled research";
              const summary = trimText(uc.attributes?.expandedDescription || uc.rawInput, 260);
              const problem = trimText(uc.attributes?.problemStatement || uc.rawInput, 220);
              const solution = trimText(uc.attributes?.solutionStatement || uc.attributes?.expandedDescription || "", 220);

              return (
                <article
                  key={uc.id}
                  className="research-card"
                  ref={(el) => { cardRefs.current[uc.id] = el; }}>
                  <div className="research-card-head">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ck-text)", lineHeight: 1.3, marginBottom: 2 }}>{title}</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", color: "var(--ck-muted)", fontSize: 11 }}>
                        {uc.attributes?.vertical ? <span>{uc.attributes.vertical}</span> : null}
                        {uc.attributes?.buyerPersona ? <span>| {uc.attributes.buyerPersona}</span> : null}
                        {uc.origin?.type === "discover" ? <span>| related</span> : null}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", display: "grid", gap: 3 }}>
                      {score
                        ? <TotalPill score={score} />
                        : uc.status === "analyzing"
                          ? <span style={{ color: "var(--ck-muted)", fontSize: 11 }}>{PHASE_LABEL_SHORT[uc.phase] || "..."}</span>
                          : <span style={{ color: "var(--ck-muted)", fontSize: 11 }}>-</span>}
                    </div>
                    <button
                      type="button"
                      onClick={() => focusResearch(uc.id)}
                      style={{
                        border: "1px solid var(--ck-line)",
                        background: isExpanded ? "var(--ck-blue-soft)" : "var(--ck-surface)",
                        color: "var(--ck-text)",
                        width: 28,
                        height: 28,
                        padding: 0,
                        display: "grid",
                        placeItems: "center",
                      }}>
                      <ChevronIcon direction={isExpanded ? "up" : "down"} size={13} />
                    </button>
                  </div>

                  <div className="research-card-summary">
                    <div className="research-definition">
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.7 }}>
                        Definition
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ck-text)", lineHeight: 1.55 }}>{summary || "-"}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 }}>Problem Statement</div>
                          <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45 }}>{problem || "-"}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 }}>Solution Statement</div>
                          <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45 }}>{solution || "-"}</div>
                        </div>
                      </div>
                    </div>

                    <div className="research-dimensions-scroll">
                      <div className="research-dimensions-row">
                        {activeDims.map((d) => {
                          const view = getDimensionView(uc, d.id, { dimLabel: d.label, dim: d });
                          const sc = view.effectiveScore;
                          const initScore = view.initial?.score;
                          const finScore = view.debate?.finalScore;
                          const revised = finScore != null && initScore != null && finScore !== initScore;
                          return (
                            <div key={`${uc.id}-${d.id}`} className="research-dimension-cell">
                              <div style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                                {d.label}
                              </div>
                              <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                {sc != null ? (
                                  <>
                                    <ScorePill score={sc} revised={revised} />
                                    <ConfidenceBadge level={view.confidence} reason={view.confidenceReason} compact={true} />
                                  </>
                                ) : uc.status === "analyzing" ? (
                                  <Spinner size={10} />
                                ) : (
                                  <span style={{ color: "var(--ck-muted)" }}>-</span>
                                )}
                              </div>
                              <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.4 }}>
                                {trimText(view.brief || "No summary available.", 120)}
                              </div>
                            </div>
                          );
                        })}
                        {!activeDims.length && (
                          <div className="research-dimension-cell">
                            <div style={{ fontSize: 11, color: "var(--ck-muted)" }}>No active dimensions configured.</div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <ExpandedRow
                      uc={uc}
                      dims={dims}
                      fuInputs={fuInputs}
                      onFuInputChange={setFuInput}
                      fuLoading={fuLoading}
                      onFollowUp={onFollowUp}
                      onDiscardArgument={onDiscardArgument}
                      onResolveFollowUpProposal={onResolveFollowUpProposal}
                      onAnalyzeRelated={(candidate) => onAnalyzeRelated(uc, candidate)}
                      globalAnalyzing={globalAnalyzing}
                    />
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
