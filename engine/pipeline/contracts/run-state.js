import { REASON_CODES } from "./reason-codes.js";

function clean(value) {
  return String(value || "").trim();
}

function deriveTitleFromInput(input = "") {
  const text = clean(input).replace(/^(product concept|research brief|context)\s*:\s*/i, "");
  if (!text) return "";
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, 14).join(" ").replace(/[,:;.\-]+$/g, "").trim();
}

function normalizeOutputType(value) {
  return clean(value).toLowerCase() === "matrix" ? "matrix" : "scorecard";
}

function normalizeEvidenceMode(value) {
  const v = clean(value).toLowerCase();
  return (v === "deep-research-x3" || v === "deep-assist") ? "deep-research-x3" : "native";
}

function slugify(value, fallback = "item") {
  const normalized = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeScorecardDimensions(config = {}) {
  const dims = Array.isArray(config?.dimensions) ? config.dimensions : [];
  return dims.map((dim, idx) => ({
    id: clean(dim?.id) || `dim-${idx + 1}`,
    label: clean(dim?.label) || `Dimension ${idx + 1}`,
    weight: Number.isFinite(Number(dim?.weight)) ? Number(dim.weight) : 0,
    rubric: clean(dim?.fullDef || dim?.rubric),
    brief: clean(dim?.brief || dim?.shortDef),
    enabled: dim?.enabled !== false,
  }));
}

function normalizeMatrixAttributes(config = {}) {
  const attrs = Array.isArray(config?.attributes) ? config.attributes : [];
  return attrs.map((attr, idx) => ({
    id: clean(attr?.id) || `attr-${idx + 1}`,
    label: clean(attr?.label) || `Attribute ${idx + 1}`,
    brief: clean(attr?.brief || attr?.description),
    derived: !!attr?.derived,
    enabled: attr?.enabled !== false,
  }));
}

function normalizeMatrixSubjectsFromList(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((item, idx) => {
      if (typeof item === "string") {
        const label = clean(item);
        return label ? { id: slugify(label, `subject-${idx + 1}`), label, aliases: [] } : null;
      }
      const label = clean(item?.label || item?.name || item?.id);
      if (!label) return null;
      const aliases = Array.isArray(item?.aliases)
        ? [...new Set(item.aliases.map((alias) => clean(alias)).filter(Boolean))]
        : [];
      return {
        id: clean(item?.id) || slugify(label, `subject-${idx + 1}`),
        label,
        aliases,
      };
    })
    .filter(Boolean);
}

function normalizeMatrixSubjects(input = {}, config = {}) {
  const direct = normalizeMatrixSubjectsFromList(input?.options?.matrixSubjects || []);
  if (direct.length) return direct;
  return normalizeMatrixSubjectsFromList(config?.subjects || []);
}

function normalizeResearchSetup(raw = {}) {
  const setup = raw && typeof raw === "object" ? raw : {};
  return {
    decisionContext: clean(setup.decisionContext),
    userRoleContext: clean(setup.userRoleContext),
  };
}

export function createNormalizedRequest(input = {}, config = {}) {
  const outputType = normalizeOutputType(config?.outputMode);
  const evidenceMode = normalizeEvidenceMode(input?.options?.evidenceMode);
  const setup = normalizeResearchSetup(input?.options?.researchSetup || {});

  const request = {
    outputType,
    evidenceMode,
    researchConfigId: clean(config?.id) || "default",
    titleHint: clean(config?.name),
    objective: clean(input?.description),
    decisionQuestion: setup.decisionContext || "",
    scopeContext: "",
    roleContext: setup.userRoleContext || "",
  };

  if (outputType === "matrix") {
    request.matrix = {
      subjects: normalizeMatrixSubjects(input, config),
      attributes: normalizeMatrixAttributes(config).filter((item) => item.enabled !== false),
    };
  } else {
    request.scorecard = {
      dimensions: normalizeScorecardDimensions(config).filter((item) => item.enabled !== false),
    };
  }

  return request;
}

function makeSourceUniverse() {
  return {
    cited: 0,
    corroborating: 0,
    unverified: 0,
    excludedMarketing: 0,
    excludedStale: 0,
    total: 0,
  };
}

export function createRunState({ input = {}, config = {}, runId = "" } = {}) {
  const request = createNormalizedRequest(input, config);
  const strictFromInput = input?.options?.strictQuality;
  const strictFromConfig = config?.quality?.strictFailFast;
  const strictQuality = strictFromInput != null
    ? ["true", "1", "yes", "on"].includes(clean(strictFromInput).toLowerCase())
    : !!strictFromConfig;

  return {
    runId: clean(runId) || clean(input?.id) || `run-${Date.now()}`,
    mode: request.evidenceMode,
    outputType: request.outputType,
    strictQuality,
    pipelineVersion: "v2-canonical",
    artifactVersion: 2,
    request,
    plan: null,
    evidence: null,
    assessment: null,
    critique: null,
    resolved: null,
    synthesis: null,
    chunkManifest: {},
    quality: {
      strictQuality,
      qualityGrade: "decision-grade",
      reasonCodes: [],
      failureCauses: [],
      safetyGuardrails: [],
      coverage: {
        totalUnits: 0,
        coveredUnits: 0,
        lowConfidenceUnits: 0,
        zeroEvidenceUnits: 0,
      },
      sourceUniverse: makeSourceUniverse(),
    },
    diagnostics: {
      run: {
        id: clean(runId) || clean(input?.id) || `run-${Date.now()}`,
        mode: request.evidenceMode,
        outputType: request.outputType,
        configId: clean(config?.id),
        configName: clean(config?.name),
        startedAt: new Date().toISOString(),
        finishedAt: "",
      },
      routing: [],
      stages: [],
      io: [],
      quality: {},
      cost: {
        currency: "USD",
        pricingVersion: "v1",
        estimatedByStage: {},
        stageCostByStage: {},
        estimatedByProvider: {},
        totalEstimated: 0,
      },
      progress: [],
      reasonCodes: [],
      cacheDiagnostics: {
        totalHits: 0,
        totalMisses: 0,
        totalBytes: 0,
        stagesCached: [],
        stagesMissed: [],
      },
    },
    ui: {
      rawInput: clean(input?.description),
      origin: input?.origin || null,
      researchSetup: normalizeResearchSetup(input?.options?.researchSetup || {}),
      status: "analyzing",
      phase: "stage_01_intake",
      errorMsg: null,
      followUps: {},
    },
    options: {
      downloadDebugLog: !!input?.options?.downloadDebugLog,
      deepAssist: input?.options?.deepAssist && typeof input.options.deepAssist === "object"
        ? input.options.deepAssist
        : {},
    },
    config,
  };
}

function scorecardDimScoresFromAssessment(assessment = {}, request = {}) {
  const dims = Array.isArray(request?.scorecard?.dimensions) ? request.scorecard.dimensions : [];
  const byId = assessment?.scorecard?.byId && typeof assessment.scorecard.byId === "object"
    ? assessment.scorecard.byId
    : {};
  const out = {};
  dims.forEach((dim) => {
    const unit = byId[dim.id] || {};
    out[dim.id] = {
      id: dim.id,
      score: Number.isFinite(Number(unit.score)) ? Number(unit.score) : null,
      confidence: clean(unit.confidence) || "low",
      confidenceSource: clean(unit?.confidenceSource || "model") || "model",
      confidenceReason: clean(unit.confidenceReason),
      citationStatus: clean(unit?.citationStatus || "not_found") || "not_found",
      brief: clean(unit.brief),
      full: clean(unit.full),
      sources: Array.isArray(unit.sources) ? unit.sources : [],
      arguments: unit.arguments && typeof unit.arguments === "object"
        ? unit.arguments
        : { supporting: [], limiting: [] },
      risks: clean(unit.risks),
      missingEvidence: clean(unit.missingEvidence),
      providerAgreement: clean(unit.providerAgreement),
    };
  });
  return out;
}

function scorecardFinalDimensionsFromResolved(resolved = {}, request = {}, critique = {}) {
  const dims = Array.isArray(request?.scorecard?.dimensions) ? request.scorecard.dimensions : [];
  const outcomes = Array.isArray(resolved?.flagOutcomes) ? resolved.flagOutcomes : [];
  const criticByUnit = critique?.flagsByUnit && typeof critique.flagsByUnit === "object"
    ? critique.flagsByUnit
    : {};
  const assessmentById = resolved?.assessment?.scorecard?.byId && typeof resolved.assessment.scorecard.byId === "object"
    ? resolved.assessment.scorecard.byId
    : {};

  const out = {};
  dims.forEach((dim) => {
    const unit = assessmentById[dim.id] || {};
    const relatedOutcomes = outcomes.filter((item) => clean(item?.flag?.unitKey) === dim.id);
    out[dim.id] = {
      score: Number.isFinite(Number(unit.score)) ? Number(unit.score) : null,
      confidence: clean(unit.confidence) || "low",
      confidenceSource: clean(unit?.confidenceSource || "model") || "model",
      confidenceReason: clean(unit.confidenceReason),
      citationStatus: clean(unit?.citationStatus || "not_found") || "not_found",
      brief: clean(unit.brief),
      response: clean(relatedOutcomes.map((item) => item?.analystNote).filter(Boolean).join("\n")),
      sources: Array.isArray(unit.sources) ? unit.sources : [],
      arguments: unit.arguments && typeof unit.arguments === "object"
        ? unit.arguments
        : { supporting: [], limiting: [] },
      critic: criticByUnit[dim.id] || null,
    };
  });
  return out;
}

function toCoverageSummary(cells = []) {
  const list = Array.isArray(cells) ? cells : [];
  const low = list.filter((cell) => clean(cell?.confidence).toLowerCase() === "low").length;
  return {
    totalCells: list.length,
    lowConfidenceCells: low,
    contestedCells: list.filter((cell) => clean(cell?.contested).toLowerCase() === "true").length,
  };
}

function enrichMatrixCellsWithDebate(cells = [], critique = {}, resolved = {}) {
  const flags = Array.isArray(critique?.flags) ? critique.flags : [];
  const outcomes = Array.isArray(resolved?.flagOutcomes) ? resolved.flagOutcomes : [];
  const flagsByKey = new Map();
  flags.forEach((flag) => {
    const key = clean(flag?.unitKey);
    if (!key) return;
    const existing = flagsByKey.get(key) || [];
    existing.push(flag);
    flagsByKey.set(key, existing);
  });
  const outcomesByKey = new Map();
  outcomes.forEach((outcome) => {
    const key = clean(outcome?.flag?.unitKey);
    if (!key) return;
    const existing = outcomesByKey.get(key) || [];
    existing.push(outcome);
    outcomesByKey.set(key, existing);
  });

  return (Array.isArray(cells) ? cells : []).map((cell) => {
    const key = `${cell.subjectId}::${cell.attributeId}`;
    const cellFlags = flagsByKey.get(key) || [];
    const cellOutcomes = outcomesByKey.get(key) || [];
    const criticNote = clean(cell?.criticNote)
      || clean(cellFlags.map((flag) => clean(flag?.note)).filter(Boolean).join(" | "));
    const analystNote = clean(cell?.analystNote)
      || clean(cellOutcomes.map((outcome) => clean(outcome?.analystNote)).filter(Boolean).join(" | "));
    const analystDecision = clean(cell?.analystDecision)
      || clean(cellOutcomes.slice(-1)?.[0]?.disposition || "");
    const mitigationNote = clean(cell?.mitigationNote)
      || clean(cellOutcomes.map((outcome) => clean(outcome?.mitigationNote)).filter(Boolean).join(" | "));
    const criticSources = cellFlags.flatMap((flag) => (Array.isArray(flag?.sources) ? flag.sources : []));
    const analystSources = cellOutcomes.flatMap((outcome) => (Array.isArray(outcome?.sources) ? outcome.sources : []));
    const contested = cell?.contested || cellFlags.length > 0;

    return {
      ...cell,
      contested: !!contested,
      criticNote,
      analystNote,
      analystDecision,
      mitigationNote,
      criticSources,
      analystSources,
    };
  });
}

function matrixFromState(state = {}) {
  const request = state?.request || {};
  const assessment = state?.resolved?.assessment || state?.assessment || {};
  const cellsRaw = Array.isArray(assessment?.matrix?.cells) ? assessment.matrix.cells : [];
  const cells = enrichMatrixCellsWithDebate(cellsRaw, state?.critique || {}, state?.resolved || {});
  const matrixExecutiveSummary = state?.synthesis?.matrixExecutiveSummary && typeof state.synthesis.matrixExecutiveSummary === "object"
    ? state.synthesis.matrixExecutiveSummary
    : {};
  return {
    layout: clean(state?.config?.matrixLayout) || "auto",
    subjects: Array.isArray(request?.matrix?.subjects) ? request.matrix.subjects : [],
    attributes: Array.isArray(request?.matrix?.attributes) ? request.matrix.attributes : [],
    cells,
    coverage: toCoverageSummary(cells),
    crossMatrixSummary: clean(state?.synthesis?.executiveSummary || state?.synthesis?.decisionImplication),
    subjectSummaries: Array.isArray(state?.synthesis?.subjectSummaries) ? state.synthesis.subjectSummaries : [],
    executiveSummary: {
      decisionAnswer: clean(matrixExecutiveSummary?.decisionAnswer || state?.synthesis?.executiveSummary),
      closestThreats: clean(matrixExecutiveSummary?.closestThreats),
      whitespace: clean(matrixExecutiveSummary?.whitespace),
      strategicClassification: clean(matrixExecutiveSummary?.strategicClassification),
      keyRisks: clean(matrixExecutiveSummary?.keyRisks),
      decisionImplication: clean(matrixExecutiveSummary?.decisionImplication || matrixExecutiveSummary?.decisionImplications || state?.synthesis?.decisionImplication),
      uncertaintyNotes: clean(matrixExecutiveSummary?.uncertaintyNotes || matrixExecutiveSummary?.dissent || state?.synthesis?.dissent),
      providerAgreementHighlights: clean(matrixExecutiveSummary?.providerAgreementHighlights),
    },
    discovery: state?.discovery || null,
    redTeam: state?.redTeam || {},
  };
}

function scorecardDebateFromState(state = {}) {
  const initialById = state?.assessment?.scorecard?.byId || {};
  const criticById = state?.critique?.flagsByUnit || {};
  const finalById = state?.resolved?.assessment?.scorecard?.byId || state?.assessment?.scorecard?.byId || {};
  return [
    {
      phase: "initial",
      content: {
        dimensions: initialById,
      },
    },
    {
      phase: "critique",
      content: {
        dimensions: criticById,
        overallFeedback: clean(state?.critique?.overallFeedback),
        sources: Array.isArray(state?.critique?.sources) ? state.critique.sources : [],
      },
    },
    {
      phase: "response",
      content: {
        dimensions: finalById,
        analystResponse: clean(state?.resolved?.analystSummary),
        sources: Array.isArray(state?.resolved?.responseSources) ? state.resolved.responseSources : [],
      },
    },
  ];
}

function matrixDebateFromState(state = {}) {
  const flags = Array.isArray(state?.critique?.flags) ? state.critique.flags : [];
  const outcomes = Array.isArray(state?.resolved?.flagOutcomes) ? state.resolved.flagOutcomes : [];

  const critiqueCells = {};
  flags.forEach((flag) => {
    const key = clean(flag?.unitKey);
    if (!key) return;
    critiqueCells[key] = {
      critique: clean(flag?.note),
      severity: clean(flag?.severity) || "medium",
      category: clean(flag?.category) || "other",
      sources: Array.isArray(flag?.sources) ? flag.sources : [],
    };
  });

  const responseCells = {};
  outcomes.forEach((outcome) => {
    const key = clean(outcome?.flag?.unitKey);
    if (!key) return;
    responseCells[key] = {
      response: clean(outcome?.analystNote),
      disposition: clean(outcome?.disposition),
      resolved: !!outcome?.resolved,
      mitigationNote: clean(outcome?.mitigationNote),
      sources: Array.isArray(outcome?.sources) ? outcome.sources : [],
    };
  });

  return [
    {
      phase: "initial",
      content: {
        note: "Initial matrix evidence and confidence assessment completed.",
      },
    },
    {
      phase: "critique",
      content: {
        overallFeedback: clean(state?.critique?.overallFeedback),
        cells: critiqueCells,
      },
    },
    {
      phase: "response",
      content: {
        analystResponse: clean(state?.resolved?.analystSummary),
        cells: responseCells,
        sources: Array.isArray(state?.resolved?.responseSources) ? state.resolved.responseSources : [],
      },
    },
  ];
}

function toSourceUniverseSummary(sourceUniverse = {}) {
  const summary = {
    cited: Number(sourceUniverse?.cited || 0),
    corroborating: Number(sourceUniverse?.corroborating || 0),
    unverified: Number(sourceUniverse?.unverified || 0),
    excludedMarketing: Number(sourceUniverse?.excludedMarketing || 0),
    excludedStale: Number(sourceUniverse?.excludedStale || 0),
  };
  summary.total = Object.values(summary).reduce((acc, value) => acc + Number(value || 0), 0);
  return summary;
}

function stageWebSearchCalls(stage = {}) {
  const tokens = stage?.tokens && typeof stage.tokens === "object" ? stage.tokens : {};
  const diagnostics = stage?.diagnostics && typeof stage.diagnostics === "object" ? stage.diagnostics : {};
  const tokenDiagnostics = diagnostics?.tokenDiagnostics && typeof diagnostics.tokenDiagnostics === "object"
    ? diagnostics.tokenDiagnostics
    : {};
  return Number(tokens?.webSearchCalls || tokenDiagnostics?.webSearchCalls || 0);
}

function collectWebSearchCounters(state = {}) {
  const stages = Array.isArray(state?.diagnostics?.stages) ? state.diagnostics.stages : [];
  const discoveryStages = new Set(["stage_01b_subject_discovery"]);
  const targetedStages = new Set(["stage_08_recover"]);
  const criticStages = new Set(["stage_10_coherence", "stage_11_challenge", "stage_12_counter_case"]);

  let total = 0;
  let critic = 0;
  let discovery = 0;
  let targeted = 0;

  stages.forEach((stage) => {
    const calls = stageWebSearchCalls(stage);
    if (!calls) return;
    total += calls;
    const stageId = clean(stage?.stage);
    if (criticStages.has(stageId)) critic += calls;
    if (discoveryStages.has(stageId)) discovery += calls;
    if (targetedStages.has(stageId)) targeted += calls;
  });

  return {
    total,
    critic,
    discovery,
    targeted,
    analyst: Math.max(0, total - critic - discovery - targeted),
  };
}

export function toUseCaseState(state = {}) {
  const outputMode = state?.outputType === "matrix" ? "matrix" : "scorecard";
  const title = deriveTitleFromInput(state?.ui?.rawInput) || clean(state?.request?.titleHint) || "Untitled research";
  const qualityGrade = clean(state?.quality?.qualityGrade) || "decision-grade";
  const sourceVerification = state?.quality?.sourceVerification && typeof state.quality.sourceVerification === "object"
    ? state.quality.sourceVerification
    : {};
  const failureCauses = Array.isArray(state?.quality?.failureCauses)
    ? state.quality.failureCauses
    : (Array.isArray(state?.decisionGateResult?.failureCauses) ? state.decisionGateResult.failureCauses : []);
  const safetyGuardrails = Array.isArray(state?.quality?.safetyGuardrails)
    ? state.quality.safetyGuardrails
    : (Array.isArray(state?.diagnostics?.quality?.safetyGuardrails) ? state.diagnostics.quality.safetyGuardrails : []);
  const webSearchCounts = collectWebSearchCounters(state);
  const cacheDiagnostics = state?.diagnostics?.cacheDiagnostics && typeof state.diagnostics.cacheDiagnostics === "object"
    ? state.diagnostics.cacheDiagnostics
    : {};
  const analysisMeta = {
    analysisMode: outputMode === "matrix"
      ? (state?.mode === "deep-research-x3" ? "matrix-deep-research-x3" : "matrix")
      : (state?.mode === "deep-research-x3" ? "deep-research-x3" : "hybrid"),
    evidenceMode: state?.mode,
    strictQuality: !!state?.strictQuality,
    qualityGrade: qualityGrade === "decision-grade" ? "standard" : qualityGrade,
    degradedReasons: (state?.quality?.reasonCodes || []).map((code) => ({ code, detail: code })),
    terminalReasonCodes: state?.quality?.reasonCodes || [],
    completionState: state?.ui?.status === "complete"
      ? (qualityGrade === "decision-grade" ? "complete" : "complete_with_gaps")
      : (state?.ui?.status === "error" ? "failed" : "running"),
    sourceUniverse: toSourceUniverseSummary(state?.quality?.sourceUniverse || {}),
    sourceVerificationChecked: Number(sourceVerification?.checked || 0),
    sourceVerificationVerified: Number(sourceVerification?.verified || 0),
    sourceVerificationNotFound: Number(sourceVerification?.notFound || 0),
    sourceVerificationFetchFailed: Number(sourceVerification?.fetchFailed || 0),
    sourceVerificationInvalidUrl: Number(sourceVerification?.invalidUrl || 0),
    sourceVerificationPartialMatch: Number(sourceVerification?.partial || 0),
    sourceVerificationNameOnly: Number(sourceVerification?.nameOnly || 0),
    sourceVerificationFabricated: Number(
      sourceVerification?.fabricated
      || sourceVerification?.verificationTierCounts?.fabricated
      || 0
    ),
    sourceVerificationUnreachableInfrastructure: Number(
      sourceVerification?.unreachableInfrastructure
      || sourceVerification?.verificationTierCounts?.unreachableInfrastructure
      || 0
    ),
    sourceVerificationUnreachableStale: Number(
      sourceVerification?.unreachableStale
      || sourceVerification?.verificationTierCounts?.unreachableStale
      || 0
    ),
    sourceVerificationUnverifiableTier: Number(
      sourceVerification?.unverifiableTier
      || sourceVerification?.verificationTierCounts?.unverifiable
      || 0
    ),
    criticFlagsRaised: Number(state?.critique?.flags?.length || 0),
    webSearchCalls: Number(webSearchCounts.analyst || 0),
    criticWebSearchCalls: Number(webSearchCounts.critic || 0),
    discoveryWebSearchCalls: Number(webSearchCounts.discovery || 0),
    lowConfidenceTargetedWebSearchCalls: Number(webSearchCounts.targeted || 0),
    totalWebSearchCalls: Number(webSearchCounts.total || 0),
    redTeamCallMade: Number(Object.keys(state?.redTeam?.cells || {}).length || 0) > 0,
    redTeamHighSeverityCount: Number(
      Object.values(state?.redTeam?.cells || {}).filter((entry) => String(entry?.severityIfWrong || "").toLowerCase() === "high").length
    ),
    synthesisCallMade: !!clean(state?.synthesis?.executiveSummary || state?.synthesis?.decisionImplication),
    synthesisModel: clean(state?.diagnostics?.stages?.find((entry) => entry?.stage === "stage_14_synthesize")?.modelRoute?.model || ""),
    synthesizerCallMade: !!clean(state?.synthesis?.executiveSummary || state?.synthesis?.decisionImplication),
    synthesizerModel: clean(state?.diagnostics?.stages?.find((entry) => entry?.stage === "stage_14_synthesize")?.modelRoute?.model || ""),
    decisionGradeGate: state?.decisionGate || null,
    decisionGradePassed: !!state?.decisionGradePassed,
    decisionGradeFailureReason: clean(state?.decisionGradeFailureReason),
    failureCauses: failureCauses.map((cause) => ({
      type: clean(cause?.type),
      detail: clean(cause?.detail),
    })).filter((cause) => cause.type),
    safetyGuardrails: safetyGuardrails
      .map((entry) => ({
        type: clean(entry?.type),
        stageId: clean(entry?.stageId),
        severity: clean(entry?.severity),
        status: clean(entry?.status),
        attempts: Number(entry?.attempts || 0),
        scopeReduced: entry?.scopeReduced === true,
        truncationSuspected: entry?.truncationSuspected === true,
        reasonCode: clean(entry?.reasonCode),
        detail: clean(entry?.detail),
      }))
      .filter((entry) => entry.type && entry.stageId),
    llmCostCurrency: clean(state?.diagnostics?.cost?.currency) || "USD",
    llmCostEstimatedUsd: Number(state?.diagnostics?.cost?.totalEstimated || 0),
    cacheHits: Number(cacheDiagnostics?.totalHits || 0),
    cacheMisses: Number(cacheDiagnostics?.totalMisses || 0),
    cacheStagesHit: Array.isArray(cacheDiagnostics?.stagesCached) ? cacheDiagnostics.stagesCached : [],
    cacheStagesMissed: Array.isArray(cacheDiagnostics?.stagesMissed) ? cacheDiagnostics.stagesMissed : [],
    pipelineVersion: state?.pipelineVersion,
    artifactVersion: state?.artifactVersion,
  };

  const base = {
    id: state?.runId,
    rawInput: state?.ui?.rawInput || "",
    status: state?.ui?.status || "analyzing",
    phase: state?.ui?.phase || "stage_01_intake",
    origin: state?.ui?.origin || null,
    researchSetup: state?.ui?.researchSetup || {},
    errorMsg: state?.ui?.errorMsg || null,
    followUps: state?.ui?.followUps || {},
    outputMode,
    analysisMeta,
    researchConfigId: clean(state?.request?.researchConfigId) || null,
    researchConfigName: clean(state?.config?.name) || null,
    diagnostics: state?.diagnostics || null,
  };

  if (outputMode === "matrix") {
    return {
      ...base,
      matrix: matrixFromState(state),
      attributes: {
        title,
      },
      dimScores: null,
      critique: state?.critique || null,
      finalScores: null,
      debate: matrixDebateFromState(state),
      discover: null,
    };
  }

  const dimScores = scorecardDimScoresFromAssessment(state?.assessment, state?.request);
  const finalDimensions = scorecardFinalDimensionsFromResolved(state?.resolved, state?.request, state?.critique);

  return {
    ...base,
    attributes: {
      title,
      inputFrame: {
        objective: state?.request?.objective || "",
        decisionQuestion: state?.request?.decisionQuestion || "",
        scopeContext: state?.request?.scopeContext || "",
        roleContext: state?.request?.roleContext || "",
      },
    },
    dimScores,
    critique: state?.critique || null,
    finalScores: {
      dimensions: finalDimensions,
      conclusion: clean(state?.synthesis?.executiveSummary || state?.synthesis?.decisionImplication),
      redTeam: state?.redTeam || {},
    },
    debate: scorecardDebateFromState(state),
    discover: state?.discovery || null,
    matrix: null,
  };
}

export function ensureRequiredRequestInputs(state = {}) {
  const request = state?.request || {};
  if (!clean(request?.objective)) {
    const err = new Error("Missing objective input.");
    err.reasonCode = REASON_CODES.MISSING_REQUIRED_INPUT;
    throw err;
  }
  if (request.outputType === "scorecard") {
    const dimensions = Array.isArray(request?.scorecard?.dimensions) ? request.scorecard.dimensions : [];
    if (!dimensions.length) {
      const err = new Error("No scorecard dimensions configured.");
      err.reasonCode = REASON_CODES.INVALID_CONFIG_SCHEMA;
      throw err;
    }
  } else {
    const attributes = Array.isArray(request?.matrix?.attributes) ? request.matrix.attributes : [];
    if (!attributes.length) {
      const err = new Error("No matrix attributes configured.");
      err.reasonCode = REASON_CODES.INVALID_CONFIG_SCHEMA;
      throw err;
    }
  }
}
