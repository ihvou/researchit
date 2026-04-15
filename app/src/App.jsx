import { useState, useRef, useEffect } from "react";
import { getDimensionView, resolveMatrixResearchInput } from "@researchit/engine";
import { RESEARCH_CONFIGS, DEFAULT_RESEARCH_CONFIG } from "../../configs/research-configurations.js";
import { calcWeightedScore } from "./lib/scoring";
import { runAnalysis } from "./hooks/useAnalysis";
import { handleFollowUp } from "./hooks/useFollowUp";
import {
  openSingleUseCaseHtml,
  exportSingleUseCasePdf,
  exportSingleUseCaseImagesZip,
  exportSingleUseCaseMarkdown,
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
import { downloadDebugLogsBundle } from "./lib/debug";
import SiteFooter from "./components/SiteFooter";
import { appTransport } from "./lib/api";
import { listAccountResearches, upsertAccountResearches } from "./lib/accountApi";
import { loadLocalDraftState, saveLocalDraftState } from "./lib/localDrafts";

const INTERNAL_ANALYSIS_MODE = "hybrid";
const CHEMICAL_NUMBER = 75;

function resolveConfigId(configId) {
  const value = String(configId || "").trim();
  if (!value) return DEFAULT_RESEARCH_CONFIG.id;
  const found = RESEARCH_CONFIGS.find((config) => config.id === value);
  return found?.id || DEFAULT_RESEARCH_CONFIG.id;
}

function cloneDims(dims = []) {
  return (dims || []).map((d) => ({ ...d }));
}

function buildRuntimeConfig(baseConfig, dims) {
  const outputMode = String(baseConfig?.outputMode || "scorecard").trim().toLowerCase();
  const scorecardDims = outputMode === "scorecard" ? cloneDims(dims) : [];
  const matrixAttributes = outputMode === "matrix" ? cloneDims(baseConfig?.attributes || []) : [];
  return {
    ...baseConfig,
    outputMode,
    dimensions: scorecardDims,
    attributes: matrixAttributes,
    matrixLayout: outputMode === "matrix" ? (baseConfig?.matrixLayout || "auto") : null,
    subjects: outputMode === "matrix" ? (baseConfig?.subjects || null) : null,
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

function parseSubjectsInput(text) {
  const values = String(text || "")
    .split(/[,\n]/g)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [];
  const seen = new Set();
  values.forEach((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(value);
  });
  return unique;
}

function getMatrixCoverage(uc) {
  const coverage = uc?.matrix?.coverage;
  const criticFlags = Number(uc?.analysisMeta?.criticFlagsRaised || 0);
  if (coverage && Number.isFinite(Number(coverage.totalCells))) {
    return {
      totalCells: Number(coverage.totalCells),
      lowConfidenceCells: Number(coverage.lowConfidenceCells) || 0,
      contestedCells: Number(coverage.contestedCells) || 0,
      criticFlags: Number.isFinite(criticFlags) && criticFlags >= 0
        ? criticFlags
        : (Number(coverage.contestedCells) || 0),
    };
  }
  const cells = Array.isArray(uc?.matrix?.cells) ? uc.matrix.cells : [];
  return {
    totalCells: cells.length,
    lowConfidenceCells: cells.filter((cell) => String(cell?.confidence || "").toLowerCase() === "low").length,
    contestedCells: cells.filter((cell) => !!cell?.contested).length,
    criticFlags: Number.isFinite(criticFlags) && criticFlags >= 0
      ? criticFlags
      : cells.filter((cell) => !!cell?.contested).length,
  };
}

function normalizeAssumptions(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function resolveResearchTitle(uc = {}, isMatrixMode = false) {
  const explicit = String(uc?.attributes?.title || "").trim();
  if (explicit) return explicit;
  if (isMatrixMode) {
    const decision = String(uc?.matrix?.decisionQuestion || uc?.researchSetup?.decisionContext || uc?.analysisMeta?.decisionContext || "").trim();
    if (decision) return decision;
  }
  return String(uc?.rawInput || "").trim() || "Untitled research";
}

function resolveMatrixFramingFallbackValues(uc = {}, providedInput = "", frameValues = {}) {
  const existing = frameValues && typeof frameValues === "object" ? frameValues : {};
  const decisionQuestion = String(existing?.decisionQuestion || uc?.matrix?.decisionQuestion || uc?.researchSetup?.decisionContext || uc?.analysisMeta?.decisionContext || "").trim();
  const roleContext = String(uc?.researchSetup?.userRoleContext || uc?.analysisMeta?.userRoleContext || "").trim();
  const scopeContext = String(existing?.scopeContext || roleContext).trim();
  const researchObject = String(existing?.researchObject || providedInput || uc?.rawInput || "").trim();
  return {
    ...existing,
    researchObject: researchObject || "unspecified",
    decisionQuestion: decisionQuestion || "unspecified",
    scopeContext: scopeContext || "unspecified",
  };
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

function renderTextWithLinks(text) {
  const input = String(text || "");
  if (!input) return "";
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^)\s]+)/g;
  const out = [];
  let lastIndex = 0;
  let match;
  let key = 0;
  while ((match = pattern.exec(input)) !== null) {
    if (match.index > lastIndex) {
      out.push(input.slice(lastIndex, match.index));
    }
    const markdownLabel = match[1];
    const markdownUrl = match[2];
    const plainUrl = match[3];
    const href = markdownUrl || plainUrl;
    const label = markdownLabel || "source";
    out.push(
      <a
        key={`methodology-link-${key++}`}
        href={href}
        target="_blank"
        rel="noreferrer"
        style={{ color: "var(--ck-accent)", textDecoration: "none" }}>
        {label}
      </a>
    );
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < input.length) {
    out.push(input.slice(lastIndex));
  }
  return out;
}

function matrixFollowUpThreadKey(subjectId, attributeId) {
  return `matrix::${subjectId}::${attributeId}`;
}

function normalizeResearchSetup(raw = {}) {
  return {
    decisionContext: String(raw?.decisionContext || "").trim(),
    userRoleContext: String(raw?.userRoleContext || "").trim(),
    subjectsText: String(raw?.subjectsText || "").trim(),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function withUpdatedAt(nextState, previousState = null) {
  const createdAt = String(nextState?.createdAt || previousState?.createdAt || nowIso());
  const updatedAt = nowIso();
  return {
    ...nextState,
    createdAt,
    updatedAt,
  };
}

function normalizeRecoveredUseCase(useCase = {}, options = {}) {
  if (!useCase || typeof useCase !== "object") return null;
  const markInterrupted = options?.markInterrupted !== false;
  const status = String(useCase.status || "").trim().toLowerCase();
  if (markInterrupted && status === "analyzing") {
    return {
      ...useCase,
      status: "error",
      phase: "error",
      errorMsg: useCase.errorMsg || "Run was interrupted. Start the research again to continue.",
      updatedAt: nowIso(),
      recoveredDraft: true,
    };
  }
  return {
    ...useCase,
    createdAt: String(useCase.createdAt || nowIso()),
    updatedAt: String(useCase.updatedAt || useCase.createdAt || nowIso()),
  };
}

function mergeUseCaseLists(localList = [], remoteList = []) {
  const map = new Map();
  const entries = [
    ...(Array.isArray(localList) ? localList.map((item) => ({ item })) : []),
    ...(Array.isArray(remoteList) ? remoteList.map((item) => ({ item })) : []),
  ];
  entries.forEach(({ item }) => {
    if (!item || typeof item !== "object") return;
    const id = String(item.id || "").trim();
    if (!id) return;
    const normalized = normalizeRecoveredUseCase(item, {
      markInterrupted: false,
    });
    if (!normalized) return;
    const existing = map.get(id);
    if (!existing) {
      map.set(id, normalized);
      return;
    }
    const existingStatus = String(existing.status || "").toLowerCase();
    const candidateStatus = String(normalized.status || "").toLowerCase();
    if (existingStatus === "analyzing" && candidateStatus === "error" && normalized.recoveredDraft) {
      map.set(id, existing);
      return;
    }
    if (candidateStatus === "analyzing" && existingStatus === "error" && existing.recoveredDraft) {
      map.set(id, normalized);
      return;
    }
    const existingTime = Date.parse(existing.updatedAt || existing.createdAt || "") || 0;
    const candidateTime = Date.parse(normalized.updatedAt || normalized.createdAt || "") || 0;
    map.set(id, candidateTime >= existingTime ? normalized : existing);
  });
  return Array.from(map.values()).sort((a, b) => {
    const aTime = Date.parse(a.updatedAt || a.createdAt || "") || 0;
    const bTime = Date.parse(b.updatedAt || b.createdAt || "") || 0;
    return bTime - aTime;
  });
}

export default function App({
  initialConfigId = DEFAULT_RESEARCH_CONFIG.id,
  routeConfigId = null,
  onActiveConfigChange = null,
  onNavigateHome = null,
  authUser = null,
  authLoading = false,
  onOpenAuth = null,
  onSignOut = null,
}) {
  const draftRef = useRef(loadLocalDraftState());
  const draftState = draftRef.current || {};
  const initialDimsByConfig = Object.fromEntries(
    RESEARCH_CONFIGS.map((config) => [config.id, cloneDims(config.dimensions)])
  );
  const initialSetupByConfig = Object.fromEntries(
    RESEARCH_CONFIGS.map((config) => [config.id, normalizeResearchSetup({})])
  );

  const [useCases, setUseCases] = useState(() => (
    Array.isArray(draftState?.useCases)
      ? draftState.useCases.map((item) => normalizeRecoveredUseCase(item)).filter(Boolean)
      : []
  ));
  const [activeConfigId, setActiveConfigId] = useState(resolveConfigId(routeConfigId || draftState?.activeConfigId || initialConfigId));
  const [dimsByConfig, setDimsByConfig] = useState(() => {
    const loaded = draftState?.dimsByConfig && typeof draftState.dimsByConfig === "object"
      ? draftState.dimsByConfig
      : {};
    const merged = { ...initialDimsByConfig };
    Object.keys(loaded).forEach((configId) => {
      if (!merged[configId]) return;
      merged[configId] = cloneDims(loaded[configId]);
    });
    return merged;
  });
  const [inputText, setInputText] = useState(() => String(draftState?.inputText || ""));
  const [setupByConfig, setSetupByConfig] = useState(() => {
    const loaded = draftState?.setupByConfig && typeof draftState.setupByConfig === "object"
      ? draftState.setupByConfig
      : {};
    const merged = { ...initialSetupByConfig };
    Object.keys(loaded).forEach((configId) => {
      if (!merged[configId]) return;
      merged[configId] = normalizeResearchSetup(loaded[configId]);
    });
    return merged;
  });
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupMode, setSetupMode] = useState("scorecard");
  const [setupDraft, setSetupDraft] = useState(normalizeResearchSetup({}));
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [setupNotice, setSetupNotice] = useState("");
  const [showInputPanel, setShowInputPanel] = useState(false);
  const [evidenceMode, setEvidenceMode] = useState(() => (
    String(draftState?.evidenceMode || "").trim().toLowerCase() === "deep-assist"
      ? "deep-assist"
      : "native"
  ));
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
  const [accountSyncMessage, setAccountSyncMessage] = useState("");

  const ucRef = useRef(useCases);
  const accountSyncStateRef = useRef({
    lastSyncedUpdatedAt: new Map(),
    lastSyncAtById: new Map(),
    initializedForUser: null,
    timer: null,
  });
  const cardRefs = useRef({});
  const importFileRef = useRef(null);
  useEffect(() => { ucRef.current = useCases; }, [useCases]);
  useEffect(() => {
    if (!routeConfigId) return;
    const nextId = resolveConfigId(routeConfigId);
    setActiveConfigId((prev) => (prev === nextId ? prev : nextId));
  }, [routeConfigId]);
  useEffect(() => {
    setShowDimsPanel(false);
    setShowDetailsPanel(true);
    setExpandAllResearches(false);
  }, [activeConfigId]);

  const activeConfig = RESEARCH_CONFIGS.find((config) => config.id === activeConfigId)
    || DEFAULT_RESEARCH_CONFIG;
  const outputMode = String(activeConfig?.outputMode || "scorecard").trim().toLowerCase();
  const isMatrixMode = outputMode === "matrix";
  const dims = dimsByConfig[activeConfig.id] || cloneDims(activeConfig.dimensions);
  const matrixAttributes = cloneDims(activeConfig?.attributes || []);

  useEffect(() => {
    setSetupError("");
    setSetupNotice("");
    setShowSetupModal(false);
    setSetupBusy(false);
  }, [activeConfig?.id, isMatrixMode]);

  useEffect(() => {
    const timer = setTimeout(() => {
      saveLocalDraftState({
        useCases,
        setupByConfig,
        dimsByConfig,
        activeConfigId,
        inputText,
        evidenceMode,
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [useCases, setupByConfig, dimsByConfig, activeConfigId, inputText, evidenceMode]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const hasActiveRun = useCases.some((item) => String(item?.status || "").toLowerCase() === "analyzing");
    if (!hasActiveRun) return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [useCases]);

  useEffect(() => {
    const userId = String(authUser?.id || "").trim();
    const syncState = accountSyncStateRef.current;
    if (!userId) {
      syncState.initializedForUser = null;
      syncState.lastSyncedUpdatedAt = new Map();
      syncState.lastSyncAtById = new Map();
      if (syncState.timer) {
        clearTimeout(syncState.timer);
        syncState.timer = null;
      }
      setAccountSyncMessage("");
      return;
    }

    let cancelled = false;
    syncState.initializedForUser = userId;
    syncState.lastSyncedUpdatedAt = new Map();
    syncState.lastSyncAtById = new Map();
    if (syncState.timer) {
      clearTimeout(syncState.timer);
      syncState.timer = null;
    }

    setAccountSyncMessage("Syncing account researches...");
    (async () => {
      try {
        const payload = await listAccountResearches();
        if (cancelled) return;
        const remoteList = Array.isArray(payload?.researches)
          ? payload.researches.map((item) => normalizeRecoveredUseCase(item)).filter(Boolean)
          : [];
        setUseCases((prev) => mergeUseCaseLists(prev, remoteList));
        remoteList.forEach((item) => {
          syncState.lastSyncedUpdatedAt.set(item.id, String(item.updatedAt || item.createdAt || ""));
          syncState.lastSyncAtById.set(item.id, Date.now());
        });
        setAccountSyncMessage(
          remoteList.length
            ? `Account sync enabled (${remoteList.length} stored researches).`
            : "Account sync enabled."
        );
      } catch (err) {
        if (cancelled) return;
        setAccountSyncMessage(`Account sync unavailable: ${err?.message || "failed to load researches"}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authUser?.id]);

  useEffect(() => {
    const userId = String(authUser?.id || "").trim();
    const syncState = accountSyncStateRef.current;
    if (!userId || syncState.initializedForUser !== userId) return undefined;

    if (syncState.timer) {
      clearTimeout(syncState.timer);
      syncState.timer = null;
    }

    syncState.timer = setTimeout(async () => {
      const nowMs = Date.now();
      const changed = useCases.filter((item) => {
        const id = String(item?.id || "").trim();
        if (!id) return false;
        const updatedAt = String(item?.updatedAt || item?.createdAt || "");
        const previouslySynced = syncState.lastSyncedUpdatedAt.get(id);
        if (updatedAt && previouslySynced === updatedAt) return false;

        const status = String(item?.status || "").toLowerCase();
        if (status === "analyzing") {
          const lastSyncMs = Number(syncState.lastSyncAtById.get(id) || 0);
          if (nowMs - lastSyncMs < 5000) return false;
        }
        return true;
      });

      if (!changed.length) return;

      try {
        await upsertAccountResearches(changed);
        changed.forEach((item) => {
          syncState.lastSyncedUpdatedAt.set(item.id, String(item.updatedAt || item.createdAt || ""));
          syncState.lastSyncAtById.set(item.id, Date.now());
        });
        setAccountSyncMessage(`Synced ${changed.length} research${changed.length === 1 ? "" : "es"} to account.`);
      } catch (err) {
        setAccountSyncMessage(`Account sync failed: ${err?.message || "unknown error"}`);
      }
    }, 1200);

    return () => {
      if (syncState.timer) {
        clearTimeout(syncState.timer);
        syncState.timer = null;
      }
    };
  }, [useCases, authUser?.id]);

  function setActiveDims(updater) {
    if (isMatrixMode) return;
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
    setUseCases((prev) => prev.map((u) => (u.id === id ? withUpdatedAt(fn(u), u) : u)));
  }

  function setFuInput(key, val) {
    setFuInputs(prev => ({ ...prev, [key]: val }));
  }

  function getConfigSetup(configId = activeConfig.id) {
    return normalizeResearchSetup(setupByConfig[configId] || {});
  }

  function persistConfigSetup(configId = activeConfig.id, nextSetup = {}) {
    const normalized = normalizeResearchSetup(nextSetup);
    setSetupByConfig((prev) => ({
      ...prev,
      [configId]: normalized,
    }));
    return normalized;
  }

  async function runNewAnalysis(descInput, origin = null, configOverride = null, matrixSubjects = [], researchSetup = null) {
    const desc = String(descInput || "").trim();
    if (!desc || globalAnalyzing) return;

    const selectedConfig = configOverride || activeConfig;
    const strictQuality = (() => {
      if (typeof selectedConfig?.quality?.strictFailFast === "boolean") return selectedConfig.quality.strictFailFast;
      const envDefault = String(import.meta.env.VITE_RESEARCHIT_STRICT_QUALITY_DEFAULT || "").trim().toLowerCase();
      return envDefault === "true" || envDefault === "1" || envDefault === "yes" || envDefault === "on";
    })();
    const selectedMode = String(selectedConfig?.outputMode || "scorecard").trim().toLowerCase();
    const normalizedSetup = normalizeResearchSetup(researchSetup || setupByConfig[selectedConfig.id] || {});
    const normalizedEvidenceMode = String(evidenceMode || "").trim().toLowerCase() === "deep-assist"
      ? "deep-assist"
      : "native";
    const deepAssistDefaults = selectedConfig?.deepAssist?.defaults || {};
    const deepAssistRunOptions = {
      providers: Array.isArray(deepAssistDefaults?.providers) && deepAssistDefaults.providers.length
        ? deepAssistDefaults.providers
        : ["chatgpt", "claude", "gemini"],
      minProviders: Number(deepAssistDefaults?.minProviders) || 2,
      maxWaitMs: Number(deepAssistDefaults?.maxWaitMs) || 300000,
      maxRetries: Number(deepAssistDefaults?.maxRetries) || 1,
    };
    const selectedDims = selectedMode === "scorecard"
      ? (dimsByConfig[selectedConfig.id] || selectedConfig.dimensions)
      : [];
    const runtimeConfig = buildRuntimeConfig(selectedConfig, selectedDims);

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const initialPhase = selectedMode === "matrix"
      ? "matrix_plan"
      : (normalizedEvidenceMode === "deep-assist" ? "deep_assist_collect" : "analyst_baseline");
    const blankUC = {
      id, rawInput: desc, status: "analyzing", phase: initialPhase,
      attributes: null, dimScores: null, critique: null, finalScores: null,
      debate: [], followUps: {}, errorMsg: null, discover: null, origin,
      researchConfigId: selectedConfig.id,
      researchConfigName: selectedConfig.name,
      outputMode: selectedMode,
      researchSetup: normalizedSetup,
      matrix: selectedMode === "matrix"
        ? {
          layout: selectedConfig?.matrixLayout || "auto",
          subjects: matrixSubjects.map((label, idx) => ({ id: `subject-${idx + 1}`, label })),
          attributes: cloneDims(selectedConfig?.attributes || []),
          cells: [],
          subjectSummaries: [],
          crossMatrixSummary: "",
          executiveSummary: null,
          coverage: { totalCells: 0, lowConfidenceCells: 0, contestedCells: 0 },
          discovery: null,
        }
        : null,
      analysisMeta: {
        analysisMode: selectedMode === "matrix"
          ? (normalizedEvidenceMode === "deep-assist" ? "matrix-deep-assist" : "matrix")
          : (normalizedEvidenceMode === "deep-assist" ? "deep-assist" : INTERNAL_ANALYSIS_MODE),
        evidenceMode: normalizedEvidenceMode,
        strictQuality,
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
        lowConfidenceBudgetStrategy: "adaptive",
        hybridStats: null,
        qualityGrade: "standard",
        degradedReasons: [],
        requiredSubjectsRequested: 0,
        requiredSubjectsMissing: 0,
        decisionGradePassed: false,
        decisionGradeFailureReason: "",
        decisionGradeGate: null,
        deepAssistProvidersRequested: normalizedEvidenceMode === "deep-assist"
          ? deepAssistRunOptions.providers.length
          : 0,
        deepAssistProvidersSucceeded: 0,
        deepAssistProvidersFailed: 0,
        deepAssistProviderRuns: [],
        decisionContext: normalizedSetup.decisionContext,
        userRoleContext: normalizedSetup.userRoleContext,
      },
    };
    const stampedBlankUC = withUpdatedAt(blankUC);

    setUseCases(prev => [...prev, stampedBlankUC]);
    setShowInputPanel(false);
    setInputText("");
    setExpandedId(id);
    setGlobalAnalyzing(true);

    try {
      await runAnalysis(desc, selectedDims, updateUC, id, {
        analysisMode: INTERNAL_ANALYSIS_MODE,
        origin,
        config: runtimeConfig,
        matrixSubjects,
        researchSetup: normalizedSetup,
        evidenceMode: normalizedEvidenceMode,
        deepAssist: normalizedEvidenceMode === "deep-assist" ? deepAssistRunOptions : null,
        strictQuality,
        initialState: stampedBlankUC,
      });
    } catch (err) {
      console.error("Analysis error:", err);
      updateUC(id, u => ({ ...u, status: "error", phase: "error", errorMsg: err.message }));
    }
    setGlobalAnalyzing(false);
  }

  function openScorecardSetupModal() {
    if (globalAnalyzing || !showInputPanel) return;
    setSetupMode("scorecard");
    setSetupError("");
    setSetupNotice("");
    setSetupBusy(false);
    const current = getConfigSetup(activeConfig.id);
    setSetupDraft({
      decisionContext: current.decisionContext,
      userRoleContext: current.userRoleContext,
      subjectsText: "",
    });
    setShowSetupModal(true);
  }

  async function openMatrixSetupModal(descInput) {
    const desc = String(descInput || "").trim();
    if (!desc || globalAnalyzing) return;

    setSetupMode("matrix");
    setSetupError("");
    setSetupNotice("");
    setSetupBusy(true);
    setShowSetupModal(true);

    const existing = getConfigSetup(activeConfig.id);
    let nextDraft = {
      decisionContext: existing.decisionContext,
      userRoleContext: existing.userRoleContext,
      subjectsText: existing.subjectsText,
    };
    const runtimeConfig = buildRuntimeConfig(activeConfig, dimsByConfig[activeConfig.id] || activeConfig.dimensions);
    try {
      const parsedExisting = parseSubjectsInput(existing.subjectsText).slice(0, matrixSubjectMax);
      const resolved = await resolveMatrixResearchInput(
        {
          id: `matrix-preflight-${Date.now()}`,
          description: desc,
          options: {
            matrixSubjects: parsedExisting,
            researchSetup: {
              decisionContext: existing.decisionContext,
              userRoleContext: existing.userRoleContext,
            },
          },
        },
        runtimeConfig,
        { transport: appTransport },
        { requireConfirmation: true }
      );
      const resolvedSubjects = Array.isArray(resolved?.subjects)
        ? resolved.subjects.map((subject) => String(subject?.label || "").trim()).filter(Boolean)
        : [];
      if (resolvedSubjects.length) {
        const existingParsed = parseSubjectsInput(existing.subjectsText);
        const shouldReplace = !existingParsed.length || (resolved?.requiresConfirmation && resolved?.usedSubjectDiscovery);
        if (shouldReplace) {
          nextDraft.subjectsText = resolvedSubjects.join("\n");
        }
      }
      if (resolved?.usedSubjectDiscovery) {
        setSetupNotice("Suggested subjects were generated from your prompt. Edit before running if needed.");
      } else if (resolved?.extractedSubjects?.length) {
        setSetupNotice("Subjects were extracted from your prompt. You can edit them before running.");
      }
    } catch (err) {
      setSetupError(err?.message || "Failed to prepare matrix setup.");
    } finally {
      setSetupDraft(nextDraft);
      setSetupBusy(false);
    }
  }

  async function submitMatrixSetupAndAnalyze() {
    if (setupBusy || globalAnalyzing) return;
    const desc = inputText.trim();
    if (!desc) {
      setSetupError("Research prompt is empty.");
      return;
    }
    const parsedSubjects = parseSubjectsInput(setupDraft.subjectsText).slice(0, matrixSubjectMax);
    if (parsedSubjects.length < matrixSubjectMin) {
      setSetupError(`Please provide at least ${matrixSubjectMin} subjects.`);
      return;
    }
    const savedSetup = persistConfigSetup(activeConfig.id, {
      ...setupDraft,
      subjectsText: parsedSubjects.join("\n"),
    });
    setShowSetupModal(false);
    setSetupNotice("");
    setSetupError("");
    await runNewAnalysis(desc, null, null, parsedSubjects, savedSetup);
  }

  function saveScorecardSetupOnly() {
    persistConfigSetup(activeConfig.id, {
      ...setupDraft,
      subjectsText: "",
    });
    setShowSetupModal(false);
    setSetupNotice("");
    setSetupError("");
  }

  async function startAnalysis() {
    setImportError("");
    setImportWarning("");
    const desc = inputText.trim();
    if (!desc || globalAnalyzing) return;
    if (isMatrixMode) {
      await openMatrixSetupModal(desc);
      return;
    }
    await runNewAnalysis(desc, null, null, [], getConfigSetup(activeConfig.id));
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

  async function onMatrixFollowUp(ucId, subjectId, attributeId, challenge, options = {}) {
    if (!challenge.trim()) return;
    const threadKey = matrixFollowUpThreadKey(subjectId, attributeId);
    const fuKey = `${ucId}::${threadKey}`;
    setFuLoading((prev) => ({ ...prev, [fuKey]: true }));
    setFuInput(fuKey, "");

    try {
      const targetUseCase = ucRef.current.find((u) => u.id === ucId);
      const targetConfigId = targetUseCase?.researchConfigId || activeConfig.id;
      const targetConfig = RESEARCH_CONFIGS.find((config) => config.id === targetConfigId) || activeConfig;
      const targetDims = dimsByConfig[targetConfig.id] || targetConfig.dimensions;
      await handleFollowUp(
        ucId,
        null,
        challenge,
        targetDims,
        ucRef,
        updateUC,
        {
          ...options,
          subjectId,
          attributeId,
          config: buildRuntimeConfig(targetConfig, targetDims),
        }
      );
    } catch (err) {
      updateUC(ucId, (u) => ({
        ...u,
        followUps: {
          ...u.followUps,
          [threadKey]: [...(u.followUps?.[threadKey] || []), {
            id: `fu-analyst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "analyst",
            response: `Error: ${err.message}`,
            sources: [],
          }],
        },
      }));
    }

    setFuLoading((prev) => ({ ...prev, [fuKey]: false }));
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
    const nextConfig = RESEARCH_CONFIGS.find((config) => config.id === configId);
    if (!nextConfig) return;
    setActiveConfigId(nextConfig.id);
    setShowInputPanel(false);
    setExpandedId(null);
    setExpandAllResearches(false);
    if (typeof onActiveConfigChange === "function") {
      onActiveConfigChange(nextConfig);
    }
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

  function handleExportDebugLogs() {
    downloadDebugLogsBundle();
  }

  async function onImportJsonChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportLoading(true);
    setImportError("");
    setImportWarning("");
    try {
      const text = await file.text();
      const parsed = importUseCasesFromJsonText(text, configItems, useCases.map((u) => u.id), outputMode);
      if (!parsed.useCases.length) {
        throw new Error("No completed researches were found in this file.");
      }
      const importedWithConfig = parsed.useCases.map((uc) => ({
        ...uc,
        researchConfigId: activeConfig.id,
        researchConfigName: activeConfig.name,
        createdAt: String(uc?.createdAt || nowIso()),
        updatedAt: String(uc?.updatedAt || nowIso()),
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
  const configItems = isMatrixMode ? matrixAttributes : dims;
  const activeDims = isMatrixMode ? [] : dims.filter(d => d.enabled);
  const totalWeight = isMatrixMode ? 0 : dims.reduce((s, d) => s + d.weight, 0);
  const methodology = activeConfig?.methodology || "";
  const activeInputSpec = activeConfig?.inputSpec || {};
  const inputPanelLabel = String(activeInputSpec?.label || "New Research - describe what should be researched").trim();
  const inputPanelPlaceholder = String(
    activeInputSpec?.placeholder
    || "Describe what you want to research. Broad or detailed inputs are both acceptable."
  ).trim();
  const inputPanelDescription = String(activeInputSpec?.description || "").trim();
  const subjectsSpec = activeConfig?.subjects || null;
  const subjectsLabel = String(subjectsSpec?.label || "Subjects").trim();
  const subjectsPrompt = String(subjectsSpec?.inputPrompt || "List subjects to compare").trim();
  const subjectsExamples = Array.isArray(subjectsSpec?.examples) ? subjectsSpec.examples : [];
  const matrixSubjectMin = Math.max(2, Number(subjectsSpec?.minCount) || 2);
  const matrixSubjectMax = Math.max(matrixSubjectMin, Number(subjectsSpec?.maxCount) || 8);
  const activeSetup = getConfigSetup(activeConfig.id);
  const decisionHints = Array.isArray(activeConfig?.decisionHints) ? activeConfig.decisionHints : [];
  const setupParsedSubjects = parseSubjectsInput(setupDraft.subjectsText).slice(0, matrixSubjectMax);
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
    deep_assist_collect: "Deep Assist collect...",
    deep_assist_merge: "Deep Assist merge...",
    analyst_targeted: "Low-confidence deep search...",
    critic: "Critic review...",
    finalizing: "Debate...",
    discover: "Discover...",
    matrix_plan: "Planning...",
    matrix_baseline: "Baseline pass...",
    matrix_web: "Web pass...",
    matrix_reconcile: "Reconcile pass...",
    matrix_deep_assist: "Deep Assist merge...",
    matrix_targeted: "Low-confidence deep search...",
    matrix_evidence: "Matrix evidence...",
    matrix_critic: "Critic audit...",
    matrix_response: "Analyst response...",
    matrix_consistency: "Consistency audit...",
    matrix_derived: "Derived attributes...",
    matrix_synthesis: "Executive synthesis...",
    matrix_summary: "Summarizing...",
    matrix_discover: "Coverage discover...",
  };

  return (
    <div className="app-shell">
      <div className="app-main">
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
              {typeof onNavigateHome === "function" ? (
                <button
                  type="button"
                  onClick={onNavigateHome}
                  className="brand-title"
                  style={{
                    fontWeight: 800,
                    fontSize: 17,
                    color: "var(--ck-text)",
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    margin: 0,
                  }}>
                  Research it
                </button>
              ) : (
                <span className="brand-title" style={{ fontWeight: 800, fontSize: 17, color: "var(--ck-text)" }}>Research it</span>
              )}
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
            <div style={{ marginLeft: 10, display: "inline-flex", alignItems: "center", gap: 8 }}>
              {authLoading ? (
                <button
                  type="button"
                  disabled
                  style={{
                    border: "1px solid var(--ck-line)",
                    background: "var(--ck-surface)",
                    color: "var(--ck-muted)",
                    padding: "7px 10px",
                    fontSize: 12,
                    fontWeight: 700,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}>
                  <Spinner size={10} color="var(--ck-muted)" /> Session
                </button>
              ) : authUser ? (
                <details style={{ position: "relative" }}>
                  <summary
                    style={{
                      border: "1px solid var(--ck-line)",
                      background: "var(--ck-surface)",
                      color: "var(--ck-text)",
                      padding: "7px 10px",
                      fontSize: 12,
                      fontWeight: 700,
                    }}>
                    {authUser.email}
                  </summary>
                  <div style={{
                    position: "absolute",
                    right: 0,
                    top: "calc(100% + 6px)",
                    minWidth: 220,
                    background: "var(--ck-surface)",
                    border: "1px solid var(--ck-line)",
                    borderRadius: 2,
                    padding: 8,
                    display: "grid",
                    gap: 8,
                    zIndex: 55,
                  }}>
                    <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45 }}>
                      Account storage active. Researches sync as you work.
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        onSignOut?.();
                        e.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                      style={{
                        border: "1px solid var(--ck-line)",
                        background: "var(--ck-surface-soft)",
                        color: "var(--ck-text)",
                        textAlign: "left",
                        fontSize: 12,
                        fontWeight: 700,
                        padding: "6px 8px",
                      }}>
                      Sign out
                    </button>
                  </div>
                </details>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenAuth?.()}
                  style={{
                    border: "1px solid var(--ck-line)",
                    background: "var(--ck-surface)",
                    color: "var(--ck-text)",
                    padding: "7px 10px",
                    fontSize: 12,
                    fontWeight: 700,
                  }}>
                  Sign in
                </button>
              )}
            </div>
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
              {methodology ? renderTextWithLinks(methodology) : "No methodology description is available for this configuration yet."}
            </p>
            {isMatrixMode && subjectsSpec ? (
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--ck-text)" }}>{subjectsLabel} input:</strong> {subjectsPrompt}
                <span style={{ marginLeft: 8 }}>
                  ({matrixSubjectMin}-{matrixSubjectMax} items)
                </span>
              </div>
            ) : null}

            <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
                {isMatrixMode ? "Attributes" : "Dimensions"}
              </div>
              {!isMatrixMode ? (
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
              ) : null}
            </div>

            <div className="dimension-descriptions-scroll">
              <div
                className="dimension-descriptions-row"
                style={{ "--dimension-count": Math.max(configItems.length, 1) }}>
                {configItems.length ? configItems.map((d) => (
                  <div
                    key={`${d.id}-desc`}
                    className="dimension-description-card"
                    style={{ opacity: isMatrixMode ? 1 : (d.enabled ? 1 : 0.6) }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ck-text)" }}>{d.label}</span>
                      {!isMatrixMode && showDimsPanel && <span className="mono" style={{ fontSize: 11, color: "var(--ck-muted)" }}>{d.weight}%</span>}
                      {isMatrixMode && d.derived ? <span className="mono" style={{ fontSize: 11, color: "var(--ck-muted)" }}>derived</span> : null}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ck-muted)", lineHeight: 1.45 }}>
                      {d.brief}
                    </div>
                    {!isMatrixMode && showDimsPanel && (
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
                  <div style={{ fontSize: 12, color: "var(--ck-muted)" }}>
                    {isMatrixMode
                      ? "No attributes configured for this research type."
                      : "No dimensions configured for this research type."}
                  </div>
                )}
              </div>
            </div>

            {!isMatrixMode && showDimsPanel && (
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
          <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
              Evidence Mode
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                onClick={() => setEvidenceMode("native")}
                style={{
                  border: `1px solid ${evidenceMode === "native" ? "var(--ck-line-strong)" : "var(--ck-line)"}`,
                  background: evidenceMode === "native" ? "var(--ck-surface-soft)" : "var(--ck-surface)",
                  color: "var(--ck-text)",
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                }}>
                Native
              </button>
              <button
                type="button"
                onClick={() => setEvidenceMode("deep-assist")}
                style={{
                  border: `1px solid ${evidenceMode === "deep-assist" ? "var(--ck-line-strong)" : "var(--ck-line)"}`,
                  background: evidenceMode === "deep-assist" ? "var(--ck-surface-soft)" : "var(--ck-surface)",
                  color: "var(--ck-text)",
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                }}>
                Deep Assist
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
              {evidenceMode === "deep-assist"
                ? "Deep Assist runs multi-provider evidence collection and agreement checks before finalization."
                : "Native uses the default analyst/critic pipeline with live web evidence and targeted recovery."}
            </div>
          </div>
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
          {!isMatrixMode ? (
            <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
              <button
                type="button"
                onClick={openScorecardSetupModal}
                style={{
                  width: "fit-content",
                  background: "var(--ck-surface)",
                  border: "1px solid var(--ck-line)",
                  color: "var(--ck-text)",
                  padding: "6px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                }}>
                Configure research
              </button>
              {(activeSetup.decisionContext || activeSetup.userRoleContext) ? (
                <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45 }}>
                  {activeSetup.decisionContext ? `Decision context: ${activeSetup.decisionContext}` : "Decision context: not set"}
                  {" | "}
                  {activeSetup.userRoleContext ? `Role: ${activeSetup.userRoleContext}` : "Role: not set"}
                </div>
              ) : (
                <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45 }}>
                  Optional setup is available for decision context and role.
                </div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 10, fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.45 }}>
              Matrix setup opens after Analyze. You will confirm subjects ({matrixSubjectMin}-{matrixSubjectMax}), decision context, and role before the run starts.
            </div>
          )}
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
              {globalAnalyzing ? <><Spinner size={11} color="var(--ck-accent-ink)" /> Analyzing...</> : (isMatrixMode ? "Continue to setup" : "Analyze")}
            </button>
            <span style={{ fontSize: 11, color: "var(--ck-muted)" }}>
              Cmd/Ctrl+Enter to submit
            </span>
            <button
              onClick={() => setShowInputPanel(false)}
              style={{ marginLeft: "auto", background: "transparent", border: "1px solid var(--ck-line-strong)", color: "var(--ck-muted)", padding: "7px 14px", borderRadius: 2, fontSize: 12 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {showSetupModal && (
        <div className="setup-modal-backdrop" onClick={() => !setupBusy && setShowSetupModal(false)}>
          <div className="setup-modal" onClick={(e) => e.stopPropagation()}>
            <div className="setup-modal-header">
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ck-text)" }}>
                {setupMode === "matrix" ? "Research Setup" : "Configure Research"}
              </div>
              <button
                type="button"
                onClick={() => !setupBusy && setShowSetupModal(false)}
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
                ×
              </button>
            </div>

            <div style={{ fontSize: 11, color: "var(--ck-muted)", lineHeight: 1.5 }}>
              {setupMode === "matrix"
                ? "Set subjects and optional context before starting this matrix research."
                : "Optional context that shapes evidence collection, critic review, and synthesis."}
            </div>

            {setupError ? (
              <div style={{ marginTop: 8, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "8px 10px", color: "var(--ck-text)", fontSize: 12 }}>
                {setupError}
              </div>
            ) : null}
            {setupNotice ? (
              <div style={{ marginTop: 8, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "8px 10px", color: "var(--ck-muted)", fontSize: 12 }}>
                {setupNotice}
              </div>
            ) : null}

            {setupMode === "matrix" ? (
              <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
                  {subjectsLabel}
                </div>
                <div style={{ fontSize: 11, color: "var(--ck-muted)" }}>
                  {subjectsPrompt} ({matrixSubjectMin}-{matrixSubjectMax} items)
                </div>
                <textarea
                  value={setupDraft.subjectsText}
                  onChange={(e) => setSetupDraft((prev) => ({ ...prev, subjectsText: e.target.value }))}
                  placeholder={subjectsExamples.length ? subjectsExamples.join("\n") : "One subject per line or comma-separated"}
                  style={{
                    width: "100%",
                    minHeight: 100,
                    background: "var(--ck-surface-soft)",
                    border: "1px solid var(--ck-line-strong)",
                    borderRadius: 2,
                    color: "var(--ck-text)",
                    padding: "10px 12px",
                    fontSize: 13,
                    resize: "vertical",
                    lineHeight: 1.45,
                    outline: "none",
                  }}
                />
                <div style={{ fontSize: 11, color: setupParsedSubjects.length > matrixSubjectMax ? "var(--ck-text)" : "var(--ck-muted)" }}>
                  Parsed: {setupParsedSubjects.length} subject{setupParsedSubjects.length === 1 ? "" : "s"}
                </div>
              </div>
            ) : null}

            <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
                Decision Context (optional)
              </div>
              {decisionHints.length ? (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {decisionHints.map((hint, idx) => (
                    <button
                      key={`hint-${idx}`}
                      type="button"
                      onClick={() => setSetupDraft((prev) => ({ ...prev, decisionContext: hint }))}
                      style={{
                        border: "1px solid var(--ck-line)",
                        background: setupDraft.decisionContext === hint ? "var(--ck-blue-soft)" : "var(--ck-surface)",
                        color: "var(--ck-text)",
                        padding: "5px 8px",
                        fontSize: 11,
                        fontWeight: 600,
                      }}>
                      {hint}
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                value={setupDraft.decisionContext}
                onChange={(e) => setSetupDraft((prev) => ({ ...prev, decisionContext: e.target.value }))}
                placeholder="What concrete decision should this research support?"
                style={{
                  width: "100%",
                  minHeight: 76,
                  background: "var(--ck-surface-soft)",
                  border: "1px solid var(--ck-line)",
                  borderRadius: 2,
                  color: "var(--ck-text)",
                  padding: "9px 11px",
                  fontSize: 12,
                  resize: "vertical",
                  lineHeight: 1.45,
                  outline: "none",
                }}
              />
            </div>

            <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ck-muted)", textTransform: "uppercase", letterSpacing: 0.8 }}>
                Role / Context (optional)
              </div>
              <input
                value={setupDraft.userRoleContext}
                onChange={(e) => setSetupDraft((prev) => ({ ...prev, userRoleContext: e.target.value }))}
                placeholder="e.g. VP Product deciding whether to build or buy under a six-month timeline"
                style={{
                  width: "100%",
                  background: "var(--ck-surface-soft)",
                  border: "1px solid var(--ck-line)",
                  borderRadius: 2,
                  color: "var(--ck-text)",
                  padding: "9px 11px",
                  fontSize: 12,
                  lineHeight: 1.4,
                  outline: "none",
                }}
              />
            </div>

            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setShowSetupModal(false)}
                disabled={setupBusy}
                style={{
                  border: "1px solid var(--ck-line)",
                  background: "var(--ck-surface)",
                  color: "var(--ck-text)",
                  padding: "7px 12px",
                  fontSize: 12,
                  fontWeight: 700,
                  opacity: setupBusy ? 0.6 : 1,
                }}>
                Cancel
              </button>
              {setupMode === "matrix" ? (
                <button
                  type="button"
                  onClick={() => { void submitMatrixSetupAndAnalyze(); }}
                  disabled={setupBusy || globalAnalyzing}
                  style={{
                    border: "1px solid var(--ck-accent)",
                    background: "var(--ck-accent)",
                    color: "var(--ck-accent-ink)",
                    padding: "7px 12px",
                    fontSize: 12,
                    fontWeight: 700,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    opacity: (setupBusy || globalAnalyzing) ? 0.65 : 1,
                  }}>
                  {setupBusy ? <><Spinner size={10} color="var(--ck-accent-ink)" /> Preparing...</> : "Run research"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={saveScorecardSetupOnly}
                  disabled={setupBusy}
                  style={{
                    border: "1px solid var(--ck-accent)",
                    background: "var(--ck-accent)",
                    color: "var(--ck-accent-ink)",
                    padding: "7px 12px",
                    fontSize: 12,
                    fontWeight: 700,
                    opacity: setupBusy ? 0.65 : 1,
                  }}>
                  Save setup
                </button>
              )}
            </div>
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
        {accountSyncMessage ? (
          <div style={{ marginBottom: 10, background: "var(--ck-surface-soft)", border: "1px solid var(--ck-line)", borderRadius: 2, padding: "9px 12px", color: "var(--ck-muted)", fontSize: 12 }}>
            {accountSyncMessage}
          </div>
        ) : null}
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
              const ucConfig = RESEARCH_CONFIGS.find((config) => config.id === (uc?.researchConfigId || activeConfig.id))
                || activeConfig;
              const ucMode = String(uc?.outputMode || ucConfig?.outputMode || "scorecard").trim().toLowerCase();
              const ucIsMatrix = ucMode === "matrix";
              const ucDims = ucIsMatrix ? [] : cloneDims(dimsByConfig[ucConfig.id] || ucConfig?.dimensions || []);
              const score = ucIsMatrix ? null : calcWeightedScore(uc, ucDims);
              const matrixCoverage = ucIsMatrix ? getMatrixCoverage(uc) : null;
              const isExpanded = expandAllResearches || expandedId === uc.id;
              const title = resolveResearchTitle(uc, ucIsMatrix);
              const framingFieldDefs = Array.isArray(ucConfig?.framingFields) ? ucConfig.framingFields : [];
              const inputFrame = uc.attributes?.inputFrame || {};
              const providedInput = String(inputFrame?.providedInput || uc.rawInput || "");
              const frameValues = inputFrame?.framingFields && typeof inputFrame.framingFields === "object"
                ? inputFrame.framingFields
                : {};
              const resolvedFrameValues = ucIsMatrix
                ? resolveMatrixFramingFallbackValues(uc, providedInput, frameValues)
                : frameValues;
              const assumptions = normalizeAssumptions(inputFrame?.assumptionsUsed);
              const confidenceLimits = String(inputFrame?.confidenceLimits || "");
              const analysisSummary = String(uc.attributes?.expandedDescription || "");
              const frameCombinedLength = [
                providedInput,
                analysisSummary,
                ...framingFieldDefs.map((field) => String(resolvedFrameValues?.[field.id] || "")),
                assumptions.join(" "),
                confidenceLimits,
              ].join(" ").length;
              const canCollapseFrame = frameCombinedLength > 620;
              const isFrameExpanded = !!expandedInputFrames[uc.id];
              const canExportResearch = uc.status === "complete";
              const researchExportItems = ucIsMatrix
                ? [
                  { key: "html", label: "Export HTML", action: () => openSingleUseCaseHtml(uc, ucConfig?.attributes || []) },
                  { key: "pdf", label: "Export PDF", action: () => exportSingleUseCasePdf(uc, ucConfig?.attributes || []) },
                  { key: "images", label: "Export Images ZIP", action: () => exportSingleUseCaseImagesZip(uc, ucConfig?.attributes || []) },
                  {
                    key: "markdown",
                    label: "Export Markdown",
                    action: () => exportSingleUseCaseMarkdown(uc, ucConfig?.attributes || []),
                  },
                  {
                    key: "json",
                    label: "Export JSON",
                    action: () => exportSingleUseCaseJson(uc, ucConfig?.attributes || []),
                  },
                ]
                : [
                  { key: "html", label: "Export HTML", action: () => openSingleUseCaseHtml(uc, ucDims) },
                  { key: "pdf", label: "Export PDF", action: () => exportSingleUseCasePdf(uc, ucDims) },
                  { key: "images", label: "Export Images ZIP", action: () => exportSingleUseCaseImagesZip(uc, ucDims) },
                  { key: "markdown", label: "Export Markdown", action: () => exportSingleUseCaseMarkdown(uc, ucDims) },
                  {
                    key: "json",
                    label: "Export JSON",
                    action: () => exportSingleUseCaseJson(uc, ucDims),
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
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ck-text)", lineHeight: 1.3, minWidth: 0, overflowWrap: "anywhere" }}>
                          {title}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", color: "var(--ck-muted)", fontSize: 11 }}>
                        {uc.attributes?.vertical ? <span>{uc.attributes.vertical}</span> : null}
                        {uc.attributes?.buyerPersona ? <span>| {uc.attributes.buyerPersona}</span> : null}
                        {uc.analysisMeta?.evidenceMode === "deep-assist" ? <span>| Deep Assist</span> : null}
                        {uc.analysisMeta?.qualityGrade === "degraded" ? <span>| degraded quality</span> : null}
                        {uc.origin?.type === "discover" ? <span>| related</span> : null}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", display: "grid", gap: 3 }}>
                      {!ucIsMatrix && score
                        ? <TotalPill score={score} />
                        : uc.status === "analyzing"
                          ? <span style={{ color: "var(--ck-muted)", fontSize: 11 }}>{PHASE_LABEL_SHORT[uc.phase] || "..."}</span>
                          : ucIsMatrix
                            ? <span style={{ color: "var(--ck-muted)", fontSize: 11 }}>{matrixCoverage?.totalCells || 0} cells</span>
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
                              const value = String(resolvedFrameValues?.[field.id] || "unspecified");
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

                    {!ucIsMatrix ? (
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
                    ) : (
                      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
                        <div className="research-dimension-cell">
                          <div style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                            Subjects
                          </div>
                          <div style={{ fontSize: 12, color: "var(--ck-text)", marginTop: 4 }}>
                            {Array.isArray(uc.matrix?.subjects) ? uc.matrix.subjects.length : 0}
                          </div>
                        </div>
                        <div className="research-dimension-cell">
                          <div style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                            Attributes
                          </div>
                          <div style={{ fontSize: 12, color: "var(--ck-text)", marginTop: 4 }}>
                            {Array.isArray(uc.matrix?.attributes) ? uc.matrix.attributes.length : 0}
                          </div>
                        </div>
                        <div className="research-dimension-cell">
                          <div style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                            Low-confidence cells
                          </div>
                          <div style={{ fontSize: 12, color: "var(--ck-text)", marginTop: 4 }}>
                            {matrixCoverage?.lowConfidenceCells || 0}
                          </div>
                        </div>
                        <div className="research-dimension-cell">
                          <div style={{ fontSize: 10, color: "var(--ck-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                            Critic flags
                          </div>
                          <div style={{ fontSize: 12, color: "var(--ck-text)", marginTop: 4 }}>
                            {matrixCoverage?.criticFlags || 0}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {isExpanded && (
                    <ExpandedRow
                      uc={uc}
                      dims={ucDims}
                      fuInputs={fuInputs}
                      onFuInputChange={setFuInput}
                      fuLoading={fuLoading}
                      onFollowUp={onFollowUp}
                      onMatrixFollowUp={onMatrixFollowUp}
                      onDiscardArgument={onDiscardArgument}
                      onResolveFollowUpProposal={onResolveFollowUpProposal}
                      onAnalyzeRelated={(candidate) => onAnalyzeRelated(uc, candidate)}
                      globalAnalyzing={globalAnalyzing}
                      outputMode={ucMode}
                    />
                  )}
                </article>
              );
            })}
        </div>
      </div>
      </div>
      <SiteFooter onExportDebug={handleExportDebugLogs} />
    </div>
  );
}
