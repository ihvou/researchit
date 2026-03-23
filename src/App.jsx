import { useState, useRef, useEffect } from "react";
import { DEFAULT_DIMS } from "./constants/dimensions";
import { calcWeightedScore } from "./lib/scoring";
import { getDimensionView } from "./lib/dimensionView";
import { runAnalysis } from "./hooks/useAnalysis";
import { handleFollowUp } from "./hooks/useFollowUp";
import {
  exportSummaryCsv,
  exportDetailCsv,
  exportAnalysisHtml,
  exportAnalysisPdf,
  buildSingleUseCaseReportHtml,
} from "./lib/export";
import { downloadDebugLogsBundle } from "./lib/debug";
import Spinner from "./components/Spinner";
import ScorePill from "./components/ScorePill";
import TotalPill from "./components/TotalPill";
import DimRubricToggle from "./components/DimRubricToggle";
import ExpandedRow from "./components/ExpandedRow";
import ConfidenceBadge from "./components/ConfidenceBadge";

export default function App() {
  const [useCases, setUseCases] = useState([]);
  const [dims, setDims] = useState(DEFAULT_DIMS);
  const [inputText, setInputText] = useState("");
  const [showInputPanel, setShowInputPanel] = useState(false);
  const [showDimsPanel, setShowDimsPanel] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [globalAnalyzing, setGlobalAnalyzing] = useState(false);
  const [analysisMode, setAnalysisMode] = useState("hybrid");
  const [fuInputs, setFuInputs] = useState({});
  const [fuLoading, setFuLoading] = useState({});

  const ucRef = useRef(useCases);
  const exportMenuRef = useRef(null);
  const prebuiltSingleHtmlRef = useRef({});
  useEffect(() => { ucRef.current = useCases; }, [useCases]);

  useEffect(() => {
    const nextCache = { ...prebuiltSingleHtmlRef.current };
    const activeIds = new Set();

    useCases.forEach((uc) => {
      activeIds.add(uc.id);
      if (uc.status !== "complete") return;

      const signature = JSON.stringify({
        attributes: uc.attributes,
        dimScores: uc.dimScores,
        critique: uc.critique,
        finalScores: uc.finalScores,
        followUps: uc.followUps,
      });

      const cached = nextCache[uc.id];
      if (cached?.signature === signature) return;

      nextCache[uc.id] = {
        signature,
        html: buildSingleUseCaseReportHtml(uc, dims),
      };
    });

    Object.keys(nextCache).forEach((id) => {
      if (!activeIds.has(id)) delete nextCache[id];
    });

    prebuiltSingleHtmlRef.current = nextCache;
  }, [useCases, dims]);

  function updateUC(id, fn) {
    setUseCases(prev => prev.map(u => u.id === id ? fn(u) : u));
  }

  function setFuInput(key, val) {
    setFuInputs(prev => ({ ...prev, [key]: val }));
  }

  async function runNewAnalysis(descInput, requestedMode = analysisMode, origin = null) {
    const desc = String(descInput || "").trim();
    if (!desc || globalAnalyzing) return;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const initialPhase = requestedMode === "hybrid" ? "analyst_baseline" : "analyst";
    const blankUC = {
      id, rawInput: desc, status: "analyzing", phase: initialPhase,
      attributes: null, dimScores: null, critique: null, finalScores: null,
      debate: [], followUps: {}, errorMsg: null, discover: null, origin,
      analysisMeta: {
        analysisMode: requestedMode,
        liveSearchRequested: requestedMode !== "standard",
        liveSearchUsed: false,
        webSearchCalls: 0,
        liveSearchFallbackReason: null,
        criticLiveSearchRequested: requestedMode !== "standard",
        criticLiveSearchUsed: false,
        criticWebSearchCalls: 0,
        criticLiveSearchFallbackReason: null,
        discoveryLiveSearchRequested: requestedMode !== "standard",
        discoveryLiveSearchUsed: false,
        discoveryWebSearchCalls: 0,
        discoveryLiveSearchFallbackReason: null,
        discoverCandidatesCount: 0,
        hybridStats: null,
      },
    };

    setUseCases(prev => [...prev, blankUC]);
    setShowInputPanel(false);
    setInputText("");
    setExpandedId(id);
    setGlobalAnalyzing(true);

    try {
      await runAnalysis(desc, dims, updateUC, id, { analysisMode: requestedMode });
    } catch (err) {
      console.error("Analysis error:", err);
      updateUC(id, u => ({ ...u, status: "error", phase: "error", errorMsg: err.message }));
    }
    setGlobalAnalyzing(false);
  }

  async function startAnalysis() {
    const desc = inputText.trim();
    if (!desc || globalAnalyzing) return;
    await runNewAnalysis(desc, analysisMode, null);
  }

  async function onFollowUp(ucId, dimId, challenge) {
    if (!challenge.trim()) return;
    const fuKey = `${ucId}::${dimId}`;
    setFuLoading(prev => ({ ...prev, [fuKey]: true }));
    setFuInput(fuKey, "");

    updateUC(ucId, u => ({
      ...u,
      followUps: {
        ...u.followUps,
        [dimId]: [...(u.followUps?.[dimId] || []), { role: "pm", text: challenge }],
      },
    }));

    try {
      await handleFollowUp(ucId, dimId, challenge, dims, ucRef, updateUC);
    } catch (err) {
      updateUC(ucId, u => ({
        ...u,
        followUps: {
          ...u.followUps,
          [dimId]: [...(u.followUps?.[dimId] || []), {
            role: "analyst", response: `Error: ${err.message}`,
            sources: [], scoreAdjusted: false, newScore: null,
          }],
        },
      }));
    }
    setFuLoading(prev => ({ ...prev, [fuKey]: false }));
  }

  async function onAnalyzeRelated(parentUc, candidate) {
    const desc = (candidate?.analysisInput || candidate?.title || "").trim();
    if (!desc || globalAnalyzing) return;
    const inheritedMode = parentUc?.analysisMeta?.analysisMode || analysisMode;
    const origin = {
      type: "discover",
      fromUseCaseId: parentUc?.id,
      fromUseCaseTitle: parentUc?.attributes?.title || parentUc?.rawInput || "",
      candidateTitle: candidate?.title || "",
    };
    await runNewAnalysis(desc, inheritedMode, origin);
  }

  const activeDims = dims.filter(d => d.enabled);
  const totalWeight = dims.reduce((s, d) => s + d.weight, 0);

  const PHASE_LABEL_SHORT = {
    analyst: "Research...",
    analyst_baseline: "Baseline pass...",
    analyst_web: "Web pass...",
    analyst_reconcile: "Reconcile pass...",
    critic: "Critic review...",
    finalizing: "Debate...",
    discover: "Discover...",
  };

  return (
    <div style={{ minHeight: "100vh", width: "100%", maxWidth: "100vw", overflowX: "hidden", background: "var(--ck-bg)", color: "var(--ck-text)", fontFamily: "Inter, 'Segoe UI', -apple-system, sans-serif", fontSize: 14 }}>
      {/* HEADER */}
      <div style={{
        background: "var(--ck-surface)", borderBottom: "1px solid var(--ck-line)",
        padding: "11px 20px", display: "flex", alignItems: "center", gap: 12,
        position: "sticky", top: 0, zIndex: 20, flexWrap: "wrap",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <img
            src="https://www.ciklum.com/wp-content/uploads/2025/10/fav.png"
            alt="Ciklum icon"
            width={14}
            height={14}
            style={{ borderRadius: 3, flexShrink: 0 }}
          />
          <span className="brand-title" style={{ fontWeight: 800, fontSize: 16, color: "var(--ck-blue)" }}>AI Use Case Researcher</span>
          <span style={{ color: "var(--ck-muted-soft)", fontSize: 12, marginLeft: 2 }}>
            {"11 dimensions | evidence-first research | analyst/critic debate | per-dimension challenges"}
          </span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <details ref={exportMenuRef} style={{ position: "relative" }}>
            <summary
              onClick={(e) => {
                if (!useCases.length) e.preventDefault();
              }}
              style={{
                background: "var(--ck-surface)",
                border: "1px solid var(--ck-line)",
                color: useCases.length ? "var(--ck-blue)" : "#8b95b3",
                padding: "6px 12px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                opacity: useCases.length ? 1 : 0.5,
                listStyle: "none",
                cursor: useCases.length ? "pointer" : "not-allowed",
                userSelect: "none",
              }}>
              Export v
            </summary>
            <div style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 6px)",
              background: "var(--ck-surface)",
              border: "1px solid var(--ck-line)",
              borderRadius: 8,
              minWidth: 185,
              padding: 6,
              display: "grid",
              gap: 4,
              zIndex: 30,
            }}>
              {[
                { label: "HTML Report", action: () => exportAnalysisHtml(useCases, dims) },
                { label: "PDF Report", action: () => exportAnalysisPdf(useCases, dims) },
                { label: "Summary CSV", action: () => exportSummaryCsv(useCases, dims) },
                { label: "Detail CSV", action: () => exportDetailCsv(useCases, dims) },
                { label: "Logs JSON", action: () => downloadDebugLogsBundle() },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    item.action();
                    exportMenuRef.current?.removeAttribute("open");
                  }}
                  style={{
                    background: "var(--ck-surface-soft)",
                    border: "1px solid var(--ck-line)",
                    color: "var(--ck-text)",
                    textAlign: "left",
                    borderRadius: 6,
                    fontSize: 12,
                    padding: "6px 8px",
                    cursor: "pointer",
                  }}>
                  {item.label}
                </button>
              ))}
            </div>
          </details>
          <button
            onClick={() => setShowDimsPanel(v => !v)}
            style={{
              background: showDimsPanel ? "var(--ck-blue-soft)" : "var(--ck-surface)",
              border: "1px solid var(--ck-line)", color: "var(--ck-blue)",
              padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600,
            }}>
            Dimensions {showDimsPanel ? "^" : "v"}
          </button>
          <button
            onClick={() => setShowInputPanel(v => !v)}
            style={{ background: "var(--ck-blue)", border: "none", color: "#fff", padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700 }}>
            + Add Use Case
          </button>
        </div>
      </div>

      {/* DIMENSIONS PANEL */}
      {showDimsPanel && (
        <div style={{ background: "var(--ck-surface)", borderBottom: "1px solid var(--ck-line)", padding: "16px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-blue)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
            Scoring Dimensions & Weights - toggle to exclude from weighted score
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(290px,1fr))", gap: 10, marginBottom: 12 }}>
            {dims.map(d => (
              <div key={d.id} style={{
                background: "var(--ck-surface-soft)", border: `1px solid ${d.enabled ? "var(--ck-line-strong)" : "var(--ck-line)"}`,
                borderRadius: 8, padding: "10px 14px", opacity: d.enabled ? 1 : 0.5,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <input
                    type="checkbox" checked={d.enabled}
                    onChange={e => setDims(p => p.map(x => x.id === d.id ? { ...x, enabled: e.target.checked } : x))}
                    style={{ accentColor: "var(--ck-blue)", width: 14, height: 14 }} />
                  <span style={{ fontWeight: 600, fontSize: 12, color: d.enabled ? "var(--ck-text)" : "var(--ck-muted)" }}>{d.label}</span>
                  <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 12, color: "var(--ck-blue)", fontWeight: 700 }}>{d.weight}%</span>
                </div>
                <DimRubricToggle dim={d} />
                <input
                  type="range" min={1} max={40} step={1} value={d.weight}
                  disabled={!d.enabled}
                  onChange={e => setDims(p => p.map(x => x.id === d.id ? { ...x, weight: +e.target.value } : x))}
                  style={{ width: "100%", accentColor: "var(--ck-blue)", marginTop: 4 }} />
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--ck-muted)" }}>
            Total weight: <span style={{ color: "var(--ck-blue)", fontWeight: 700 }}>{totalWeight}%</span>
            <span style={{ marginLeft: 8 }}>- scores auto-normalize, only relative weights matter</span>
          </div>
        </div>
      )}

      {/* INPUT PANEL */}
      {showInputPanel && (
        <div style={{ background: "var(--ck-surface)", borderBottom: "1px solid var(--ck-line)", padding: "16px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-blue)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
            New Use Case - describe the problem or solution
          </div>
          <textarea
            autoFocus
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder={'Vague and high-level is fine. E.g. "AI for insurance claims processing" or "automate contract review for legal teams in financial services" or "predictive maintenance for manufacturing equipment"'}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startAnalysis(); }}
            style={{
              width: "100%", height: 90, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line-strong)",
              borderRadius: 8, color: "var(--ck-text)", padding: "10px 14px", fontSize: 13,
              resize: "vertical", lineHeight: 1.5, outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
            <button
              onClick={startAnalysis}
              disabled={!inputText.trim() || globalAnalyzing}
              style={{
                background: "var(--ck-blue)", border: "none", color: "#fff",
                padding: "8px 20px", borderRadius: 8, fontWeight: 700, fontSize: 13,
                opacity: !inputText.trim() || globalAnalyzing ? 0.5 : 1,
                display: "flex", alignItems: "center", gap: 6,
              }}>
              {globalAnalyzing ? <><Spinner size={11} color="#fff" /> Analyzing...</> : "Analyze - 3-phase debate"}
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ck-muted)" }}>
              <span>Mode:</span>
              <select
                value={analysisMode}
                onChange={(e) => setAnalysisMode(e.target.value)}
                style={{
                  background: "var(--ck-surface-soft)",
                  border: "1px solid var(--ck-line-strong)",
                  color: "var(--ck-text)",
                  borderRadius: 6,
                  fontSize: 11,
                  padding: "4px 8px",
                }}>
                <option value="standard">Standard (fastest)</option>
                <option value="live_search">Live search</option>
                <option value="hybrid">Hybrid reliability</option>
              </select>
            </label>
            <span style={{ fontSize: 11, color: "var(--ck-muted)" }}>Cmd/Ctrl+Enter to submit</span>
            <button
              onClick={() => setShowInputPanel(false)}
              style={{ marginLeft: "auto", background: "transparent", border: "1px solid var(--ck-line-strong)", color: "var(--ck-muted)", padding: "7px 14px", borderRadius: 8, fontSize: 12 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* MAIN TABLE */}
      <div style={{ padding: 20 }}>
        {useCases.length === 0 ? (
          <div style={{ textAlign: "left", padding: "40px 20px", maxWidth: 760, margin: "0 auto", background: "var(--ck-surface)", borderRadius: 14, border: "1px solid var(--ck-line)" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: "var(--ck-text)", marginBottom: 8, fontFamily: "Aileron, Inter, sans-serif" }}>
              AI Use Case Researcher
            </div>
            <div style={{ fontSize: 13, color: "var(--ck-muted)", marginBottom: 14 }}>
              Add one use case and the tool will run a structured research workflow:
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, color: "var(--ck-text)", fontSize: 13, lineHeight: 1.6, display: "grid", gap: 8 }}>
              <li style={{ display: "flex", gap: 8 }}>
                <span aria-hidden="true">🧠</span>
                <span><strong>Analyst LLM:</strong> builds the first draft with attributes, per-dimension scores, and rationale.</span>
              </li>
              <li style={{ display: "flex", gap: 8 }}>
                <span aria-hidden="true">🛡️</span>
                <span><strong>Critic LLM:</strong> audits Analyst claims and challenges weak scoring; in web-enabled modes it verifies with live search.</span>
              </li>
              <li style={{ display: "flex", gap: 8 }}>
                <span aria-hidden="true">🌐</span>
                <span><strong>Evidence layer:</strong> combines model memory with web-search passes and shows auditable sources per dimension.</span>
              </li>
              <li style={{ display: "flex", gap: 8 }}>
                <span aria-hidden="true">📈</span>
                <span><strong>Prioritization:</strong> computes weighted scores across 11 dimensions and tags each one with high/medium/low confidence.</span>
              </li>
            </ul>
            <div style={{
              marginTop: 12,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #b8e8d0",
              background: "#ebf8f0",
            }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#0f7a55", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.7 }}>
                💬 Interactive Challenge Loop
              </div>
              <div style={{ fontSize: 12, color: "#17583f", lineHeight: 1.55 }}>
                In <strong>Debate & Challenges</strong>, send follow-up facts, questions, or objections for any dimension.
                The Analyst LLM replies in-thread, can revise the score, and keeps the updated reasoning and sources visible.
              </div>
            </div>
            <div style={{ marginTop: 14, fontSize: 13, color: "var(--ck-muted)" }}>
              <button
                type="button"
                onClick={() => setShowInputPanel(true)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--ck-blue)",
                  fontWeight: 800,
                  fontSize: 13,
                  padding: 0,
                  textDecoration: "underline",
                }}>
                + Add Use Case
              </button>{" "}
              to start.
            </div>
          </div>
        ) : (
          <div style={{ overflowX: "auto", border: "1px solid var(--ck-line)", borderRadius: 12, background: "var(--ck-surface)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--ck-surface-soft)", borderBottom: "2px solid var(--ck-line)" }}>
                  <th style={{ textAlign: "left", padding: "10px 14px", color: "var(--ck-muted)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8 }}>
                    Use Case
                  </th>
                  {activeDims.map(d => (
                    <th key={d.id} style={{ textAlign: "center", padding: "8px 4px", color: "var(--ck-muted)", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, whiteSpace: "nowrap" }}>
                      {d.label
                        .replace("Applicability", "App.")
                        .replace("Readiness", "Ready")
                        .replace("Feasibility", "Build")
                        .replace("Management", "Mgmt")
                        .replace("Productization", "Reuse")
                        .replace("Pressure", "Pres.")}
                      <br />
                      <span style={{ color: "var(--ck-muted-soft)", fontWeight: 400 }}>{d.weight}%</span>
                    </th>
                  ))}
                  <th style={{ textAlign: "center", padding: "10px 14px", color: "var(--ck-blue)", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>
                    Score
                  </th>
                  <th style={{ width: 28 }} />
                </tr>
              </thead>
              <tbody>
                {useCases.map(uc => {
                  const score = calcWeightedScore(uc, dims);
                  const isExpanded = expandedId === uc.id;
                  return [
                    <tr
                      key={uc.id}
                      onClick={() => setExpandedId(isExpanded ? null : uc.id)}
                      style={{
                        borderBottom: isExpanded ? "none" : "1px solid var(--ck-line)",
                        cursor: "pointer",
                        background: isExpanded ? "var(--ck-surface-soft)" : "transparent",
                      }}
                      onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = "#f7f9ff"; }}
                      onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = "transparent"; }}>
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ fontWeight: 600, color: "var(--ck-text)", marginBottom: 4, lineHeight: 1.3 }}>
                          {uc.attributes?.title || (uc.rawInput.length > 55 ? `${uc.rawInput.slice(0, 55)}...` : uc.rawInput)}
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {uc.attributes?.vertical && (
                            <span style={{ fontSize: 11, color: "var(--ck-muted)", background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", padding: "1px 7px", borderRadius: 4 }}>
                              {uc.attributes.vertical}
                            </span>
                          )}
                          {uc.origin?.type === "discover" && (
                            <span
                              title={`Suggested from: ${uc.origin?.fromUseCaseTitle || "related analysis"}`}
                              style={{ fontSize: 11, color: "#0f7a55", background: "#ebf8f0", border: "1px solid #b8e8d0", padding: "1px 7px", borderRadius: 4 }}>
                              related
                            </span>
                          )}
                          {uc.analysisMeta?.analysisMode === "hybrid" && (
                            <span
                              title={uc.analysisMeta?.hybridStats
                                ? `Hybrid changed baseline on ${uc.analysisMeta.hybridStats.changedFromBaseline} dimensions`
                                : "Hybrid reliability mode"}
                              style={{ fontSize: 11, color: "var(--ck-blue-ink)", background: "var(--ck-blue-soft)", border: "1px solid #c5ceff", padding: "1px 7px", borderRadius: 4 }}>
                              hybrid
                            </span>
                          )}
                          {uc.analysisMeta?.analysisMode === "live_search" && (
                            <span
                              title={uc.analysisMeta?.liveSearchUsed
                                ? `Live search used (${uc.analysisMeta?.webSearchCalls || 0} calls)`
                                : "Live search requested, fallback path used"}
                              style={{ fontSize: 11, color: "var(--ck-blue)", background: "var(--ck-blue-soft)", border: "1px solid #c5ceff", padding: "1px 7px", borderRadius: 4 }}>
                              live
                            </span>
                          )}
                        </div>
                      </td>
                      {activeDims.map(d => {
                        const view = getDimensionView(uc, d.id);
                        const sc = view.effectiveScore;
                        const initScore = view.initial?.score;
                        const finScore = view.debate?.finalScore;
                        const revised = finScore != null && initScore != null && finScore !== initScore;
                        return (
                          <td key={d.id} style={{ textAlign: "center", padding: "12px 4px" }}>
                            {sc != null ? (
                              <div style={{ display: "inline-flex", flexDirection: "column", gap: 3, alignItems: "center" }}>
                                <ScorePill score={sc} revised={revised} />
                                <ConfidenceBadge
                                  level={view.confidence}
                                  reason={view.confidenceReason}
                                  compact={true}
                                />
                              </div>
                            ) : uc.status === "analyzing" ? (
                              <Spinner size={10} />
                            ) : (
                              <span style={{ color: "var(--ck-muted)" }}>-</span>
                            )}
                          </td>
                        );
                      })}
                      <td style={{ textAlign: "center", padding: "12px 14px" }}>
                        {score
                          ? <TotalPill score={score} />
                          : uc.status === "error"
                            ? <span style={{ color: "#ef4444", fontSize: 11 }}>Error</span>
                            : uc.status === "analyzing"
                              ? <span style={{ color: "var(--ck-muted)", fontSize: 11 }}>{PHASE_LABEL_SHORT[uc.phase] || "..."}</span>
                              : "-"}
                      </td>
                      <td style={{ textAlign: "center", color: "var(--ck-muted)", fontSize: 12 }}>
                        {isExpanded ? "^" : "v"}
                      </td>
                    </tr>,
                    isExpanded && (
                      <tr key={uc.id + "_expanded"}>
                        <td colSpan={activeDims.length + 3} style={{ padding: 0 }}>
                          <ExpandedRow
                            uc={uc} dims={dims}
                            fuInputs={fuInputs}
                            onFuInputChange={setFuInput}
                            fuLoading={fuLoading}
                            onFollowUp={onFollowUp}
                            onAnalyzeRelated={(candidate) => onAnalyzeRelated(uc, candidate)}
                            globalAnalyzing={globalAnalyzing}
                            getPrebuiltHtml={(id) => prebuiltSingleHtmlRef.current[id]?.html || ""}
                          />
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
