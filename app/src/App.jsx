import { useState, useRef, useEffect } from "react";
import { RESEARCH_CONFIGS, DEFAULT_RESEARCH_CONFIG } from "../../configs/research-configurations.js";
import { calcWeightedScore } from "./lib/scoring";
import { getDimensionView } from "./lib/dimensionView";
import { runAnalysis } from "./hooks/useAnalysis";
import { handleFollowUp } from "./hooks/useFollowUp";
import {
  openSingleUseCaseHtml,
  exportSingleUseCasePdf,
  exportSingleUseCaseImagesZip,
  exportSingleUseCaseJson,
  importUseCasesFromJsonText,
} from "./lib/export";
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

function normalizeAssumptions(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function dimensionAcronym(label) {
  const words = String(label || "")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const letters = words.map((w) => w[0]?.toUpperCase() || "").join("");
  if (letters) return letters.slice(0, 4);
  return String(label || "").slice(0, 3).toUpperCase();
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
  const [showDetailsPanel, setShowDetailsPanel] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [expandAllResearches, setExpandAllResearches] = useState(false);
  const [expandedInputFrames, setExpandedInputFrames] = useState({});
  const [globalAnalyzing, setGlobalAnalyzing] = useState(false);
  const [fuInputs, setFuInputs] = useState({});
  const [fuLoading, setFuLoading] = useState({});
  const [toolbarExportLoading, setToolbarExportLoading] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  const [importWarning, setImportWarning] = useState("");
  const [importError, setImportError] = useState("");

  const ucRef = useRef(useCases);
  const cardRefs = useRef({});
  const importFileRef = useRef(null);
  useEffect(() => { ucRef.current = useCases; }, [useCases]);
  useEffect(() => {
    setShowDimsPanel(false);
    setShowDetailsPanel(true);
    setExpandAllResearches(false);
  }, [activeConfigId]);

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

  function selectResearchConfig(configId) {
    setActiveConfigId(configId);
    setShowInputPanel(false);
    setExpandedId(null);
    setExpandAllResearches(false);
  }

  function focusResearch(id, options = {}) {
    const { forceOpen = false } = options;
    setExpandAllResearches(false);
    setExpandedId((prev) => (forceOpen ? id : (prev === id ? null : id)));
    requestAnimationFrame(() => {
      const el = cardRefs.current[id];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
    });
  }

  function onResearchHeaderClick(e, id) {
    const interactiveTarget = e.target instanceof Element
      ? e.target.closest("button,summary,a,input,select,textarea,label,[role='button']")
      : null;
    if (interactiveTarget) return;
    focusResearch(id);
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
  const methodology = activeConfig?.methodology || "";
  const activeInputSpec = activeConfig?.inputSpec || {};
  const inputPanelLabel = String(activeInputSpec?.label || "New Research - describe what should be researched").trim();
  const inputPanelPlaceholder = String(
    activeInputSpec?.placeholder
    || "Describe what you want to research. Broad or detailed inputs are both acceptable."
  ).trim();
  const inputPanelDescription = String(activeInputSpec?.description || "").trim();
  const DESKTOP_VISIBLE_CONFIG_COUNT = 4;
  const desktopTabConfigs = (() => {
    const initial = RESEARCH_CONFIGS.slice(0, DESKTOP_VISIBLE_CONFIG_COUNT);
    if (initial.some((config) => config.id === activeConfig.id)) return initial;
    const merged = [...initial.slice(0, Math.max(DESKTOP_VISIBLE_CONFIG_COUNT - 1, 0)), activeConfig];
    return merged.filter((config, idx, arr) => arr.findIndex((item) => item.id === config.id) === idx);
  })();
  const desktopVisibleIds = new Set(desktopTabConfigs.map((config) => config.id));
  const hiddenTabConfigs = RESEARCH_CONFIGS.filter((config) => !desktopVisibleIds.has(config.id));

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
        <div className="header-row" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
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
          </div>
          <div style={{ minWidth: 0, flex: 1, marginLeft: 16, display: "flex", justifyContent: "flex-end" }}>
            <div className="config-nav-desktop">
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.7 }}>
                Researches Available:
              </span>
              {desktopTabConfigs.map((config) => {
                const isActive = config.id === activeConfig.id;
                return (
                  <button
                    key={config.id}
                    type="button"
                    onClick={() => selectResearchConfig(config.id)}
                    style={{
                      padding: "7px 12px",
                      fontSize: 13,
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
                    {hiddenTabConfigs.map((config) => {
                      const isActive = config.id === activeConfig.id;
                      return (
                        <button
                          key={`hidden-${config.id}`}
                          type="button"
                          onClick={(e) => {
                            selectResearchConfig(config.id);
                            e.currentTarget.closest("details")?.removeAttribute("open");
                          }}
                          style={{
                            textAlign: "left",
                            background: isActive ? "var(--ck-blue-soft)" : "var(--ck-surface-soft)",
                            border: `1px solid ${isActive ? "var(--ck-line-strong)" : "var(--ck-line)"}`,
                            color: "var(--ck-text)",
                            padding: "6px 8px",
                            fontSize: 12,
                            fontWeight: isActive ? 700 : 600,
                          }}>
                          {config.tabLabel || config.name}
                        </button>
                      );
                    })}
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
                {RESEARCH_CONFIGS.map((config) => {
                  const isActive = config.id === activeConfig.id;
                  return (
                    <button
                      key={`mobile-${config.id}`}
                      type="button"
                      onClick={(e) => {
                        selectResearchConfig(config.id);
                        e.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                      style={{
                        textAlign: "left",
                        background: isActive ? "var(--ck-blue-soft)" : "var(--ck-surface-soft)",
                        border: `1px solid ${isActive ? "var(--ck-line-strong)" : "var(--ck-line)"}`,
                        color: "var(--ck-text)",
                        padding: "6px 8px",
                        fontSize: 12,
                        fontWeight: isActive ? 700 : 600,
                      }}>
                      {config.tabLabel || config.name}
                    </button>
                  );
                })}
              </div>
            </details>
          </div>
        </div>
      </div>

      <div className="research-type-area">
        <div className="header-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h1 style={{ margin: 0, fontSize: "clamp(32px,4vw,44px)", lineHeight: 1.1, fontWeight: 700, color: "var(--ck-text)" }}>
            {activeConfig.tabLabel || activeConfig.name}
          </h1>
          <button
            type="button"
            onClick={() => {
              setShowDetailsPanel((v) => {
                const next = !v;
                if (!next) setShowDimsPanel(false);
                return next;
              });
            }}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--ck-muted)",
              fontWeight: 700,
              fontSize: 12,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: 0,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}>
            <span>{showDetailsPanel ? "Hide details" : "Show details"}</span>
            <ChevronIcon direction={showDetailsPanel ? "up" : "down"} size={12} />
          </button>
        </div>

        {showDetailsPanel && (
          <div className="methodology-panel" style={{ marginTop: 12, padding: "12px 14px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 5 }}>
              Methodology / Description
            </div>
            <p className="methodology-text" style={{ fontSize: 13, color: "var(--ck-muted)", lineHeight: 1.5 }}>
              {methodology || "No methodology description is available for this configuration yet."}
            </p>

            <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
                Dimensions
              </div>
              <button
                type="button"
                onClick={() => setShowDimsPanel((v) => !v)}
                style={{
                  border: "1px solid var(--ck-line)",
                  background: showDimsPanel ? "var(--ck-blue-soft)" : "var(--ck-surface)",
                  color: "var(--ck-text)",
                  fontSize: 12,
                  fontWeight: 700,
                  padding: "6px 10px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}>
                <span>{showDimsPanel ? "Hide Configuration" : "Configure Dimensions"}</span>
                <ChevronIcon direction={showDimsPanel ? "up" : "down"} size={12} />
              </button>
            </div>

            <div className="dimension-descriptions-scroll">
              <div
                className="dimension-descriptions-row"
                style={{ "--dimension-count": Math.max(dims.length, 1) }}>
                {dims.length ? dims.map((d) => (
                  <div
                    key={`${d.id}-desc`}
                    className="dimension-description-card"
                    style={{ opacity: d.enabled ? 1 : 0.6 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ck-text)" }}>{d.label}</span>
                      {showDimsPanel && <span className="mono" style={{ fontSize: 11, color: "var(--ck-muted)" }}>{d.weight}%</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.45 }}>
                      {d.brief}
                    </div>
                    {showDimsPanel && (
                      <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input
                            type="checkbox"
                            checked={d.enabled}
                            onChange={e => setActiveDims((p) => p.map((x) => (x.id === d.id ? { ...x, enabled: e.target.checked } : x)))}
                            style={{ accentColor: "var(--ck-accent)", width: 14, height: 14 }} />
                          <span style={{ fontSize: 11, color: "var(--ck-muted)", fontWeight: 600 }}>
                            {d.enabled ? "included" : "excluded"}
                          </span>
                          <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--ck-text)", fontWeight: 700 }}>{d.weight}%</span>
                        </div>
                        <DimRubricToggle dim={d} />
                        <input
                          type="range"
                          min={1}
                          max={40}
                          step={1}
                          value={d.weight}
                          disabled={!d.enabled}
                          onChange={e => setActiveDims((p) => p.map((x) => (x.id === d.id ? { ...x, weight: +e.target.value } : x)))}
                          style={{ width: "100%", minWidth: 0, accentColor: "var(--ck-accent)" }} />
                      </div>
                    )}
                  </div>
                )) : (
                  <div style={{ fontSize: 12, color: "var(--ck-muted)" }}>No dimensions configured for this research type.</div>
                )}
              </div>
            </div>

            {showDimsPanel && (
              <div style={{ fontSize: 11, color: "var(--ck-muted)", marginTop: 10 }}>
                Total weight: <span style={{ color: "var(--ck-text)", fontWeight: 700 }}>{totalWeight}%</span>
                <span style={{ marginLeft: 8 }}>- scores auto-normalize, only relative weights matter</span>
              </div>
            )}
          </div>
        )}

        <div className="header-row panel-actions" style={{ marginTop: 12 }}>
          <button
            onClick={() => setShowInputPanel(v => !v)}
            style={{ background: "var(--ck-accent)", border: "none", color: "var(--ck-accent-ink)", padding: "8px 14px", borderRadius: 2, fontSize: 13, fontWeight: 700 }}>
            + Research
          </button>
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
        </div>
      </div>

      {showInputPanel && (
        <div style={{ background: "var(--ck-surface)", borderBottom: "1px solid var(--ck-line)", padding: "16px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
            {inputPanelLabel}
          </div>
          {inputPanelDescription ? (
            <div style={{ fontSize: 12, color: "var(--ck-muted)", marginBottom: 8 }}>
              {inputPanelDescription}
            </div>
          ) : null}
          <textarea
            autoFocus
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder={inputPanelPlaceholder}
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
          <>
            {visibleUseCases.length >= 2 ? (
              <div className="research-list-toolbar">
                <button
                  type="button"
                  onClick={() => {
                    setExpandAllResearches((prev) => {
                      const next = !prev;
                      if (!next) setExpandedId(null);
                      return next;
                    });
                  }}
                  style={{
                    border: "1px solid var(--ck-line)",
                    background: "var(--ck-surface)",
                    color: "var(--ck-text)",
                    padding: "6px 10px",
                    fontSize: 12,
                    fontWeight: 700,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}>
                  <span>{expandAllResearches ? "Collapse All" : "Expand All"}</span>
                  <ChevronIcon direction={expandAllResearches ? "up" : "down"} size={12} />
                </button>
              </div>
            ) : null}
            <div className="research-list">
            {visibleUseCases.map((uc) => {
              const score = calcWeightedScore(uc, dims);
              const isExpanded = expandAllResearches || expandedId === uc.id;
              const title = uc.attributes?.title || trimText(uc.rawInput, 80) || "Untitled research";
              const ucConfig = RESEARCH_CONFIGS.find((config) => config.id === (uc?.researchConfigId || activeConfig.id))
                || activeConfig;
              const framingFieldDefs = Array.isArray(ucConfig?.framingFields) ? ucConfig.framingFields : [];
              const inputFrame = uc.attributes?.inputFrame || {};
              const providedInput = String(inputFrame?.providedInput || uc.rawInput || "");
              const frameValues = inputFrame?.framingFields && typeof inputFrame.framingFields === "object"
                ? inputFrame.framingFields
                : {};
              const assumptions = normalizeAssumptions(inputFrame?.assumptionsUsed);
              const confidenceLimits = String(inputFrame?.confidenceLimits || "");
              const analysisSummary = String(uc.attributes?.expandedDescription || "");
              const frameCombinedLength = [
                providedInput,
                analysisSummary,
                ...framingFieldDefs.map((field) => String(frameValues?.[field.id] || "")),
                assumptions.join(" "),
                confidenceLimits,
              ].join(" ").length;
              const canCollapseFrame = frameCombinedLength > 620;
              const isFrameExpanded = !!expandedInputFrames[uc.id];
              const canExportResearch = uc.status === "complete";
              const researchExportItems = [
                { key: "html", label: "Export HTML", action: () => openSingleUseCaseHtml(uc, dims) },
                { key: "pdf", label: "Export PDF", action: () => exportSingleUseCasePdf(uc, dims) },
                { key: "images", label: "Export Images ZIP", action: () => exportSingleUseCaseImagesZip(uc, dims) },
                {
                  key: "json",
                  label: "Export JSON",
                  action: () => exportSingleUseCaseJson(uc, dims),
                },
              ];

              return (
                <article
                  key={uc.id}
                  className="research-card"
                  ref={(el) => { cardRefs.current[uc.id] = el; }}>
                  <div
                    className="research-card-head"
                    onClick={(e) => onResearchHeaderClick(e, uc.id)}
                    style={{ cursor: "pointer" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, marginBottom: 2 }}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            focusResearch(uc.id);
                          }}
                          style={{
                            border: "1px solid var(--ck-line)",
                            background: isExpanded ? "var(--ck-blue-soft)" : "var(--ck-surface)",
                            color: "var(--ck-text)",
                            width: 22,
                            height: 22,
                            padding: 0,
                            display: "grid",
                            placeItems: "center",
                            flexShrink: 0,
                          }}>
                          <ChevronIcon direction={isExpanded ? "up" : "down"} size={11} />
                        </button>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ck-text)", lineHeight: 1.3, minWidth: 0 }}>
                          {title}
                        </div>
                      </div>
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
                    <div className="desktop-only research-head-export-buttons">
                      {researchExportItems.map((item) => {
                        const key = `research-${uc.id}-${item.key}`;
                        const isLoading = toolbarExportLoading === key;
                        return (
                          <button
                            key={`${key}-desktop`}
                            type="button"
                            onClick={() => { void runToolbarExport(key, item.action); }}
                            disabled={!!toolbarExportLoading || importLoading || !canExportResearch}
                            style={{
                              background: "var(--ck-surface)",
                              border: "1px solid var(--ck-line)",
                              color: "var(--ck-text)",
                              borderRadius: 2,
                              fontSize: 11,
                              padding: "4px 8px",
                              cursor: !canExportResearch || toolbarExportLoading ? "not-allowed" : "pointer",
                              opacity: canExportResearch ? (toolbarExportLoading && toolbarExportLoading !== key ? 0.55 : 1) : 0.5,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              whiteSpace: "nowrap",
                            }}>
                            {isLoading ? <Spinner size={9} color="var(--ck-text)" /> : null}
                            {isLoading ? `${item.label}...` : item.label}
                          </button>
                        );
                      })}
                    </div>
                    <details className="mobile-only" style={{ position: "relative" }}>
                      <summary
                        style={{
                          border: "1px solid var(--ck-line)",
                          background: "var(--ck-surface)",
                          color: "var(--ck-text)",
                          width: 28,
                          height: 28,
                          padding: 0,
                          display: "grid",
                          placeItems: "center",
                          fontSize: 14,
                          fontWeight: 700,
                        }}>
                        ...
                      </summary>
                      <div style={{
                        position: "absolute",
                        right: 0,
                        top: "calc(100% + 6px)",
                        background: "var(--ck-surface)",
                        border: "1px solid var(--ck-line)",
                        borderRadius: 2,
                        minWidth: 170,
                        padding: 6,
                        display: "grid",
                        gap: 4,
                        zIndex: 40,
                      }}>
                        {researchExportItems.map((item) => {
                          const key = `research-${uc.id}-${item.key}`;
                          return (
                            <button
                              key={`${key}-mobile`}
                              type="button"
                              onClick={(e) => {
                                void runToolbarExport(key, item.action);
                                e.currentTarget.closest("details")?.removeAttribute("open");
                              }}
                              disabled={!!toolbarExportLoading || importLoading || !canExportResearch}
                              style={{
                                background: "var(--ck-surface-soft)",
                                border: "1px solid var(--ck-line)",
                                color: "var(--ck-text)",
                                textAlign: "left",
                                borderRadius: 2,
                                fontSize: 12,
                                padding: "6px 8px",
                                opacity: toolbarExportLoading && toolbarExportLoading !== key ? 0.55 : 1,
                            }}>
                              {toolbarExportLoading === key ? `${item.label}...` : item.label}
                            </button>
                          );
                        })}
                      </div>
                    </details>
                  </div>

                  <div className="research-card-summary">
                    <div className="research-definition">
                      <div
                        style={{
                          maxHeight: canCollapseFrame && !isFrameExpanded ? 205 : "none",
                          overflow: canCollapseFrame && !isFrameExpanded ? "hidden" : "visible",
                          position: "relative",
                          display: "grid",
                          gap: 8,
                        }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.7 }}>
                          Input + Framing
                        </div>
                        <div style={{ fontSize: 12, color: "var(--ck-text)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                          {providedInput || "-"}
                        </div>
                        {analysisSummary ? (
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 }}>
                              Analysis Framing
                            </div>
                            <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{analysisSummary}</div>
                          </div>
                        ) : null}
                        {framingFieldDefs.length ? (
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 8 }}>
                            {framingFieldDefs.map((field) => {
                              const value = String(frameValues?.[field.id] || "unspecified");
                              return (
                                <div key={`${uc.id}-frame-${field.id}`}>
                                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 }}>
                                    {field.label || field.id}
                                  </div>
                                  <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
                                    {value || "unspecified"}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 }}>
                              Assumptions Used
                            </div>
                            <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
                              {assumptions.length ? assumptions.join(" | ") : "None."}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 }}>
                              Confidence Limits
                            </div>
                            <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
                              {confidenceLimits || "No explicit limits were captured."}
                            </div>
                          </div>
                        </div>
                        {canCollapseFrame && !isFrameExpanded ? (
                          <div style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            bottom: 0,
                            height: 36,
                            background: "linear-gradient(180deg, rgba(247,247,246,0) 0%, rgba(247,247,246,1) 80%)",
                            pointerEvents: "none",
                          }} />
                        ) : null}
                      </div>
                      {canCollapseFrame ? (
                        <button
                          type="button"
                          onClick={() => setExpandedInputFrames((prev) => ({ ...prev, [uc.id]: !prev[uc.id] }))}
                          style={{
                            marginTop: 2,
                            border: "1px solid var(--ck-line)",
                            background: "var(--ck-surface)",
                            color: "var(--ck-text)",
                            padding: "5px 9px",
                            fontSize: 11,
                            fontWeight: 600,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            width: "fit-content",
                          }}>
                          {isFrameExpanded ? "Collapse" : "Expand"}
                          <ChevronIcon direction={isFrameExpanded ? "up" : "down"} size={11} />
                        </button>
                      ) : null}
                    </div>

                    <div className="research-dimensions-scroll">
                      <div className="research-dimensions-row" style={{ "--score-dimension-count": Math.max(activeDims.length, 1) }}>
                        {activeDims.map((d) => {
                          const view = getDimensionView(uc, d.id, { dimLabel: d.label, dim: d });
                          const sc = view.effectiveScore;
                          const initScore = view.initial?.score;
                          const finScore = view.debate?.finalScore;
                          const revised = finScore != null && initScore != null && finScore !== initScore;
                          return (
                            <div key={`${uc.id}-${d.id}`} className="research-dimension-cell">
                              <div className="dim-label-wrap" style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                                <span className="dim-label-full">{d.label}</span>
                                <span className="dim-label-acronym">{dimensionAcronym(d.label)}</span>
                              </div>
                              <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                {sc != null ? (
                                  <>
                                    <ScorePill score={sc} revised={revised} />
                                    <span className="dim-confidence">
                                      <ConfidenceBadge level={view.confidence} reason={view.confidenceReason} compact={true} />
                                    </span>
                                  </>
                                ) : uc.status === "analyzing" ? (
                                  <Spinner size={10} />
                                ) : (
                                  <span style={{ color: "var(--ck-muted)" }}>-</span>
                                )}
                              </div>
                              <div className="dim-brief" style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.4 }}>
                                {view.brief || "No summary available."}
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
          </>
        )}
      </div>
    </div>
  );
}
