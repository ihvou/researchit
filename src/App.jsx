import { useState, useRef, useEffect } from "react";
import { DEFAULT_DIMS } from "./constants/dimensions";
import { getEffectiveScore, calcWeightedScore } from "./lib/scoring";
import { runAnalysis } from "./hooks/useAnalysis";
import { handleFollowUp } from "./hooks/useFollowUp";
import { exportSummaryCsv, exportDetailCsv, exportAnalysisHtml, exportAnalysisPdf } from "./lib/export";
import { downloadDebugLogsBundle } from "./lib/debug";
import Spinner from "./components/Spinner";
import ScorePill from "./components/ScorePill";
import TotalPill from "./components/TotalPill";
import DimRubricToggle from "./components/DimRubricToggle";
import ExpandedRow from "./components/ExpandedRow";

export default function App() {
  const [useCases, setUseCases] = useState([]);
  const [dims, setDims] = useState(DEFAULT_DIMS);
  const [inputText, setInputText] = useState("");
  const [showInputPanel, setShowInputPanel] = useState(false);
  const [showDimsPanel, setShowDimsPanel] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [globalAnalyzing, setGlobalAnalyzing] = useState(false);
  const [analysisMode, setAnalysisMode] = useState("live_search");
  const [fuInputs, setFuInputs] = useState({});
  const [fuLoading, setFuLoading] = useState({});

  const ucRef = useRef(useCases);
  const exportMenuRef = useRef(null);
  useEffect(() => { ucRef.current = useCases; }, [useCases]);

  function updateUC(id, fn) {
    setUseCases(prev => prev.map(u => u.id === id ? fn(u) : u));
  }

  function setFuInput(key, val) {
    setFuInputs(prev => ({ ...prev, [key]: val }));
  }

  async function startAnalysis() {
    const desc = inputText.trim();
    if (!desc || globalAnalyzing) return;

    const id = Date.now().toString();
    const initialPhase = analysisMode === "hybrid" ? "analyst_baseline" : "analyst";
    const blankUC = {
      id, rawInput: desc, status: "analyzing", phase: initialPhase,
      attributes: null, dimScores: null, critique: null, finalScores: null,
      debate: [], followUps: {}, errorMsg: null,
      analysisMeta: {
        analysisMode,
        liveSearchRequested: analysisMode !== "standard",
        liveSearchUsed: false,
        webSearchCalls: 0,
        liveSearchFallbackReason: null,
        hybridStats: null,
      },
    };

    setUseCases(prev => [...prev, blankUC]);
    setShowInputPanel(false);
    setInputText("");
    setExpandedId(id);
    setGlobalAnalyzing(true);

    try {
      await runAnalysis(desc, dims, updateUC, id, { analysisMode });
    } catch (err) {
      console.error("Analysis error:", err);
      updateUC(id, u => ({ ...u, status: "error", phase: "error", errorMsg: err.message }));
    }
    setGlobalAnalyzing(false);
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

  const activeDims = dims.filter(d => d.enabled);
  const totalWeight = dims.reduce((s, d) => s + d.weight, 0);

  const PHASE_LABEL_SHORT = {
    analyst: "Research...",
    analyst_baseline: "Baseline pass...",
    analyst_web: "Web pass...",
    analyst_reconcile: "Reconcile pass...",
    critic: "Critique...",
    finalizing: "Debate...",
  };

  return (
    <div style={{ minHeight: "100vh", background: "#07090f", color: "#e2e8f0", fontFamily: "system-ui,-apple-system,sans-serif", fontSize: 14 }}>
      {/* HEADER */}
      <div style={{
        background: "#0a0d17", borderBottom: "1px solid #141a28",
        padding: "11px 20px", display: "flex", alignItems: "center", gap: 12,
        position: "sticky", top: 0, zIndex: 20,
      }}>
        <div>
          <span style={{ fontWeight: 800, fontSize: 15, color: "#a855f7" }}>AI Use Case Prioritizer</span>
          <span style={{ color: "#2d3748", fontSize: 12, marginLeft: 10 }}>
            {"11 dimensions | analyst <-> critic debate | per-dimension challenges | outsourcing delivery focus"}
          </span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <details ref={exportMenuRef} style={{ position: "relative" }}>
            <summary
              onClick={(e) => {
                if (!useCases.length) e.preventDefault();
              }}
              style={{
                background: "#0f1520",
                border: "1px solid #2d3748",
                color: useCases.length ? "#93c5fd" : "#374151",
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
              background: "#0f1520",
              border: "1px solid #2d3748",
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
                    background: "#0a0d17",
                    border: "1px solid #1f2937",
                    color: "#cbd5e1",
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
              background: showDimsPanel ? "#3b0764" : "#0f1520",
              border: "1px solid #2d3748", color: "#c084fc",
              padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600,
            }}>
            Dimensions {showDimsPanel ? "^" : "v"}
          </button>
          <button
            onClick={() => setShowInputPanel(v => !v)}
            style={{ background: "#7c3aed", border: "none", color: "#fff", padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700 }}>
            + Add Use Case
          </button>
        </div>
      </div>

      {/* DIMENSIONS PANEL */}
      {showDimsPanel && (
        <div style={{ background: "#0a0d17", borderBottom: "1px solid #141a28", padding: "16px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#a855f7", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>
            Scoring Dimensions & Weights - toggle to exclude from weighted score
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(290px,1fr))", gap: 10, marginBottom: 12 }}>
            {dims.map(d => (
              <div key={d.id} style={{
                background: "#0f1520", border: `1px solid ${d.enabled ? "#1e2a3a" : "#141820"}`,
                borderRadius: 8, padding: "10px 14px", opacity: d.enabled ? 1 : 0.5,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <input
                    type="checkbox" checked={d.enabled}
                    onChange={e => setDims(p => p.map(x => x.id === d.id ? { ...x, enabled: e.target.checked } : x))}
                    style={{ accentColor: "#a855f7", width: 14, height: 14 }} />
                  <span style={{ fontWeight: 600, fontSize: 12, color: d.enabled ? "#e2e8f0" : "#4b5563" }}>{d.label}</span>
                  <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 12, color: "#a855f7", fontWeight: 700 }}>{d.weight}%</span>
                </div>
                <DimRubricToggle dim={d} />
                <input
                  type="range" min={1} max={40} step={1} value={d.weight}
                  disabled={!d.enabled}
                  onChange={e => setDims(p => p.map(x => x.id === d.id ? { ...x, weight: +e.target.value } : x))}
                  style={{ width: "100%", accentColor: "#7c3aed", marginTop: 4 }} />
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#374151" }}>
            Total weight: <span style={{ color: "#a855f7", fontWeight: 700 }}>{totalWeight}%</span>
            <span style={{ marginLeft: 8 }}>- scores auto-normalize, only relative weights matter</span>
          </div>
        </div>
      )}

      {/* INPUT PANEL */}
      {showInputPanel && (
        <div style={{ background: "#0a0d17", borderBottom: "1px solid #141a28", padding: "16px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#a855f7", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
            New Use Case - describe the problem or solution
          </div>
          <textarea
            autoFocus
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder={'Vague and high-level is fine. E.g. "AI for insurance claims processing" or "automate contract review for legal teams in financial services" or "predictive maintenance for manufacturing equipment"'}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startAnalysis(); }}
            style={{
              width: "100%", height: 90, background: "#07090f", border: "1px solid #2d3748",
              borderRadius: 8, color: "#e2e8f0", padding: "10px 14px", fontSize: 13,
              resize: "vertical", lineHeight: 1.5, outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
            <button
              onClick={startAnalysis}
              disabled={!inputText.trim() || globalAnalyzing}
              style={{
                background: "#7c3aed", border: "none", color: "#fff",
                padding: "8px 20px", borderRadius: 8, fontWeight: 700, fontSize: 13,
                opacity: !inputText.trim() || globalAnalyzing ? 0.5 : 1,
                display: "flex", alignItems: "center", gap: 6,
              }}>
              {globalAnalyzing ? <><Spinner size={11} color="#fff" /> Analyzing...</> : "Analyze - 3-phase debate"}
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#94a3b8" }}>
              <span>Mode:</span>
              <select
                value={analysisMode}
                onChange={(e) => setAnalysisMode(e.target.value)}
                style={{
                  background: "#07090f",
                  border: "1px solid #2d3748",
                  color: "#e2e8f0",
                  borderRadius: 6,
                  fontSize: 11,
                  padding: "4px 8px",
                }}>
                <option value="standard">Standard (fastest)</option>
                <option value="live_search">Live search</option>
                <option value="hybrid">Hybrid reliability</option>
              </select>
            </label>
            <span style={{ fontSize: 11, color: "#2d3748" }}>Cmd/Ctrl+Enter to submit</span>
            <button
              onClick={() => setShowInputPanel(false)}
              style={{ marginLeft: "auto", background: "transparent", border: "1px solid #2d3748", color: "#6b7280", padding: "7px 14px", borderRadius: 8, fontSize: 12 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* MAIN TABLE */}
      <div style={{ padding: 20 }}>
        {useCases.length === 0 ? (
          <div style={{ textAlign: "center", padding: "80px 20px" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#2d3748", marginBottom: 8 }}>No use cases yet</div>
            <div style={{ fontSize: 13, color: "#1f2937" }}>
              Click <strong style={{ color: "#a855f7" }}>+ Add Use Case</strong> {`to start the 3-phase analyst <-> critic analysis`}
            </div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#0a0d17", borderBottom: "2px solid #141a28" }}>
                  <th style={{ textAlign: "left", padding: "10px 14px", color: "#4b5563", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, minWidth: 200 }}>
                    Use Case
                  </th>
                  {activeDims.map(d => (
                    <th key={d.id} style={{ textAlign: "center", padding: "8px 4px", color: "#4b5563", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, whiteSpace: "nowrap", minWidth: 66 }}>
                      {d.label
                        .replace("Applicability", "App.")
                        .replace("Readiness", "Ready")
                        .replace("Feasibility", "Build")
                        .replace("Management", "Mgmt")
                        .replace("Productization", "Reuse")
                        .replace("Pressure", "Pres.")}
                      <br />
                      <span style={{ color: "#2d3748", fontWeight: 400 }}>{d.weight}%</span>
                    </th>
                  ))}
                  <th style={{ textAlign: "center", padding: "10px 14px", color: "#a855f7", fontSize: 11, fontWeight: 700, textTransform: "uppercase", minWidth: 90 }}>
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
                        borderBottom: isExpanded ? "none" : "1px solid #0f1218",
                        cursor: "pointer",
                        background: isExpanded ? "#0a0d17" : "transparent",
                      }}
                      onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = "#0c0f18"; }}
                      onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = "transparent"; }}>
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ fontWeight: 600, color: "#e2e8f0", marginBottom: 4, lineHeight: 1.3 }}>
                          {uc.attributes?.title || (uc.rawInput.length > 55 ? `${uc.rawInput.slice(0, 55)}...` : uc.rawInput)}
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {uc.attributes?.vertical && (
                            <span style={{ fontSize: 11, color: "#4b5563", background: "#0f1520", padding: "1px 7px", borderRadius: 4 }}>
                              {uc.attributes.vertical}
                            </span>
                          )}
                          {uc.analysisMeta?.analysisMode === "hybrid" && (
                            <span
                              title={uc.analysisMeta?.hybridStats
                                ? `Hybrid changed baseline on ${uc.analysisMeta.hybridStats.changedFromBaseline} dimensions`
                                : "Hybrid reliability mode"}
                              style={{ fontSize: 11, color: "#a78bfa", background: "#1b1530", padding: "1px 7px", borderRadius: 4 }}>
                              hybrid
                            </span>
                          )}
                          {uc.analysisMeta?.analysisMode === "live_search" && (
                            <span
                              title={uc.analysisMeta?.liveSearchUsed
                                ? `Live search used (${uc.analysisMeta?.webSearchCalls || 0} calls)`
                                : "Live search requested, fallback path used"}
                              style={{ fontSize: 11, color: "#60a5fa", background: "#0a1628", padding: "1px 7px", borderRadius: 4 }}>
                              live
                            </span>
                          )}
                        </div>
                      </td>
                      {activeDims.map(d => {
                        const sc = getEffectiveScore(uc, d.id);
                        const initScore = uc.dimScores?.[d.id]?.score;
                        const finScore = uc.finalScores?.dimensions?.[d.id]?.finalScore;
                        const revised = finScore != null && initScore != null && finScore !== initScore;
                        return (
                          <td key={d.id} style={{ textAlign: "center", padding: "12px 4px" }}>
                            {sc != null
                              ? <ScorePill score={sc} revised={revised} />
                              : uc.status === "analyzing"
                                ? <Spinner size={10} />
                                : <span style={{ color: "#2d3748" }}>-</span>}
                          </td>
                        );
                      })}
                      <td style={{ textAlign: "center", padding: "12px 14px" }}>
                        {score
                          ? <TotalPill score={score} />
                          : uc.status === "error"
                            ? <span style={{ color: "#ef4444", fontSize: 11 }}>Error</span>
                            : uc.status === "analyzing"
                              ? <span style={{ color: "#4b5563", fontSize: 11 }}>{PHASE_LABEL_SHORT[uc.phase] || "..."}</span>
                              : "-"}
                      </td>
                      <td style={{ textAlign: "center", color: "#374151", fontSize: 12 }}>
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
