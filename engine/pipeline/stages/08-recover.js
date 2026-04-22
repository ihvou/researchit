import {
  annotateSourcesWithGrounding,
  callActorJson,
  clean,
  combineTokenDiagnostics,
  ensureArray,
  fabricationAssessmentFromSources,
  normalizeArguments,
  normalizeConfidence,
} from "./common.js";
import { REASON_CODES, normalizeReasonCodes } from "../contracts/reason-codes.js";
import {
  aggregateVerificationCounters,
  verifySourcesForUnit,
} from "../../lib/sources/verify-source.js";
import { runChunkPool } from "../../lib/runtime/chunk-pool.js";

export const STAGE_ID = "stage_08_recover";
export const STAGE_TITLE = "Targeted Recovery";
export const PROMPT_VERSION = "v2";
const STAGE_ROUTE_RETRIEVE_ID = "stage_08_recover_retrieve";
const STAGE_ROUTE_READ_ID = "stage_08_recover_read";

function nowIso() {
  return new Date().toISOString();
}

function isLikelyRequestBug(err = {}) {
  const status = Number(err?.status || err?.statusCode || 0);
  if (Number.isFinite(status) && status >= 400 && status < 500) return true;
  const message = clean(err?.message).toLowerCase();
  return (
    message.includes("function_declarations")
    || message.includes("function calling config")
    || message.includes("tool_config")
    || message.includes("invalid argument")
    || message.includes("invalid request")
  );
}

function buildOpenAiRetrieveFallbackRoute(runtime = {}) {
  const analystModel = runtime?.config?.models?.analyst || {};
  const provider = clean(analystModel?.provider || "openai").toLowerCase();
  const model = clean(analystModel?.model || "gpt-5.4");
  const webSearchModel = clean(analystModel?.webSearchModel || model);
  if (provider !== "openai" || !model || !webSearchModel) return null;
  return {
    provider: "openai",
    model,
    webSearchModel,
    baseUrl: clean(analystModel?.baseUrl),
  };
}

async function callRetrieveWithGeminiEmptyFallback(baseCall = {}, runtime = {}) {
  const attempts = [];
  const runAttempt = async ({ routeOverride = null, labelSuffix = "", fallback = false } = {}) => {
    const callContext = {
      ...(baseCall?.callContext || {}),
      chunkId: `${clean(baseCall?.callContext?.chunkId) || "retrieve"}${labelSuffix}`,
    };
    try {
      const result = await callActorJson({
        ...baseCall,
        ...(routeOverride ? { routeOverride } : {}),
        callContext,
      });
      attempts.push({
        ok: true,
        fallback,
        route: result?.route || null,
        tokenDiagnostics: result?.tokenDiagnostics || null,
        reasonCodes: ensureArray(result?.reasonCodes),
        noSearchPerformed: result?.meta?.noSearchPerformed === true,
      });
      return { ok: true, result };
    } catch (err) {
      attempts.push({
        ok: false,
        fallback,
        route: routeOverride || null,
        tokenDiagnostics: null,
        reasonCodes: ensureArray(err?.reasonCodes),
        errorMessage: clean(err?.message || "retrieve_failed"),
        errorReasonCode: clean(err?.reasonCode),
        noSearchPerformed: false,
      });
      return { ok: false, error: err };
    }
  };

  const first = await runAttempt();
  if (first.ok && first.result?.meta?.noSearchPerformed !== true) {
    return {
      resolved: true,
      result: first.result,
      fallbackUsed: false,
      attempts,
    };
  }
  if (!first.ok && isLikelyRequestBug(first.error)) throw first.error;

  const fallbackRoute = buildOpenAiRetrieveFallbackRoute(runtime);
  if (!fallbackRoute) {
    if (first.ok) {
      return {
        resolved: false,
        attempts,
        fallbackUsed: false,
        unresolvedReasonCode: REASON_CODES.STAGE_03B_NO_SEARCH_PERFORMED,
        unresolvedReasonMessage: "No google_search calls were performed for this recovery chunk.",
      };
    }
    throw first.error;
  }

  const second = await runAttempt({
    routeOverride: fallbackRoute,
    labelSuffix: "-openai-fallback",
    fallback: true,
  });
  if (second.ok && second.result?.meta?.noSearchPerformed !== true) {
    return {
      resolved: true,
      result: second.result,
      fallbackUsed: true,
      fallbackReasonCode: first.ok
        ? REASON_CODES.STAGE_03B_NO_SEARCH_PERFORMED
        : (clean(first?.error?.reasonCode) || REASON_CODES.GEMINI_EMPTY_SUCCESS_RESPONSE),
      fallbackReasonMessage: first.ok
        ? "No google_search calls were performed for this recovery chunk."
        : clean(first?.error?.message || "gemini_empty_success_response"),
      fallbackRoute,
      attempts,
    };
  }
  if (!second.ok && isLikelyRequestBug(second.error)) throw second.error;

  return {
    resolved: false,
    attempts,
    fallbackUsed: true,
    fallbackRoute,
    unresolvedReasonCode: REASON_CODES.STAGE_03B_NO_SEARCH_PERFORMED,
    unresolvedReasonMessage: "No web search content was returned by recovery retrieval providers for this chunk.",
  };
}

function computePressure(unit = {}, extra = {}) {
  let score = 0;
  if (extra?.hasContradiction) score += 5;
  if (clean(unit?.confidence).toLowerCase() === "low") score += 4;
  if (!ensureArray(unit?.sources).length) score += 4;
  if (ensureArray(unit?.sources).length <= 1) score += 2;
  if (extra?.staleHeavy) score += 2;
  return score;
}

function staleSourceCount(unit = {}) {
  return ensureArray(unit?.sources).filter((source) => (
    clean(source?.displayStatus).toLowerCase() === "excluded_stale"
  )).length;
}

function hasContradictionSignal(unit = {}) {
  const supporting = ensureArray(unit?.arguments?.supporting).length;
  const limiting = ensureArray(unit?.arguments?.limiting).length;
  return supporting > 0 && limiting > 0;
}

function buildPlanUnitMap(state = {}) {
  const map = new Map();
  ensureArray(state?.plan?.units).forEach((unit) => {
    const key = clean(unit?.unitId);
    if (!key) return;
    map.set(key, unit);
  });
  return map;
}

function truncateText(value, max = 800) {
  const text = clean(value).replace(/\s+/g, " ");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(120, max)).trimEnd()}...`;
}

function selectScorecardUnits(state = {}, budget = 8) {
  const dimensions = ensureArray(state?.request?.scorecard?.dimensions);
  const dimensionById = new Map(dimensions.map((dim) => [clean(dim?.id), dim]));
  const planByUnit = buildPlanUnitMap(state);
  const byId = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? state.assessment.scorecard.byId
    : {};
  const ranked = Object.values(byId).map((unit) => ({
    key: unit.id,
    type: "dimension",
    label: clean(dimensionById.get(clean(unit?.id))?.label || unit?.id),
    brief: clean(dimensionById.get(clean(unit?.id))?.brief),
    pressure: computePressure(unit, {
      hasContradiction: hasContradictionSignal(unit),
      staleHeavy: staleSourceCount(unit) > 0,
    }),
    reasons: {
      confidence: clean(unit?.confidence) || "low",
      sourceCount: ensureArray(unit?.sources).length,
      contradictionFlag: hasContradictionSignal(unit),
      staleSourceFlag: staleSourceCount(unit) > 0,
      gapHypothesis: clean(planByUnit.get(clean(unit?.id))?.gapHypothesis),
    },
    unit,
  }))
    .sort((a, b) => b.pressure - a.pressure);

  const selectedByKey = new Map();
  const floorSelected = [];
  ranked.forEach((item) => {
    const uncovered = clean(item?.unit?.confidence).toLowerCase() === "low"
      || ensureArray(item?.unit?.sources).length === 0;
    if (!uncovered || selectedByKey.has(item.key)) return;
    selectedByKey.set(item.key, item);
    floorSelected.push(item);
  });

  const requestedBudget = Math.max(0, Number(budget) || 0);
  const effectiveBudget = Math.max(requestedBudget, floorSelected.length);
  for (const item of ranked) {
    if (selectedByKey.size >= effectiveBudget) break;
    if (selectedByKey.has(item.key)) continue;
    selectedByKey.set(item.key, item);
  }

  return {
    selected: [...selectedByKey.values()],
    requestedBudget,
    effectiveBudget,
    floorReserved: floorSelected.length,
  };
}

function groupMatrixSelections(items = []) {
  const byAttr = new Map();
  ensureArray(items).forEach((item) => {
    const attr = clean(item?.unit?.attributeId);
    if (!byAttr.has(attr)) byAttr.set(attr, []);
    byAttr.get(attr).push(item);
  });

  const groups = [];
  let index = 0;
  byAttr.forEach((items) => {
    for (let i = 0; i < items.length; i += 2) {
      index += 1;
      groups.push({
        chunkId: `c${String(index).padStart(2, "0")}`,
        depth: 0,
        cells: items.slice(i, i + 2),
      });
    }
  });
  return groups;
}

function computeMatrixAdaptiveBudget(state = {}, runtime = {}) {
  const limits = runtime?.config?.limits || {};
  const cells = ensureArray(state?.assessment?.matrix?.cells);
  const totalCells = cells.length;
  if (!totalCells) {
    return {
      requestedBudget: 0,
      diagnostics: {
        totalCells: 0,
        lowConfidenceCells: 0,
        ratioTarget: 0,
        floorTarget: 0,
        configuredMax: 0,
        lowConfidenceDeficit: 0,
        criticalSourceDeficit: 0,
      },
    };
  }

  const ratioTarget = Math.max(0, Number(limits?.matrixAdaptiveTargetedRatio || 0.7));
  const floorTarget = Math.max(1, Number(limits?.matrixAdaptiveTargetedFloor || 12));
  const configuredMax = Math.max(1, Number(limits?.matrixAdaptiveTargetedMax || 36));
  const decisionGate = limits?.matrixDecisionGradeGate && typeof limits.matrixDecisionGradeGate === "object"
    ? limits.matrixDecisionGradeGate
    : {};

  const lowConfidenceCells = cells.filter((cell) => clean(cell?.confidence).toLowerCase() === "low").length;
  const maxLowRatio = Number(decisionGate?.maxLowConfidenceRatio);
  const maxAllowedLow = Number.isFinite(maxLowRatio)
    ? Math.max(0, Math.floor(totalCells * Math.max(0, maxLowRatio)))
    : 0;
  const lowConfidenceDeficit = Number.isFinite(maxLowRatio)
    ? Math.max(0, lowConfidenceCells - maxAllowedLow)
    : 0;

  const minSourcesPerCriticalCell = Math.max(
    1,
    Number(decisionGate?.minSourcesPerCriticalCell || decisionGate?.minSourcesPerCriticalUnit || 2)
  );
  const criticalAttributeIds = new Set(
    ensureArray(decisionGate?.criticalAttributeIds)
      .map((id) => clean(id))
      .filter(Boolean)
  );
  const criticalCells = criticalAttributeIds.size
    ? cells.filter((cell) => criticalAttributeIds.has(clean(cell?.attributeId)))
    : cells;
  const criticalSourceDeficit = criticalCells.filter((cell) => ensureArray(cell?.sources).length < minSourcesPerCriticalCell).length;

  const ratioBudget = Math.ceil(totalCells * ratioTarget);
  let requestedBudget = Math.max(floorTarget, ratioBudget, lowConfidenceDeficit, criticalSourceDeficit);
  if (state?.strictQuality) {
    requestedBudget = Math.max(requestedBudget, lowConfidenceCells, criticalSourceDeficit);
  }

  const cap = state?.strictQuality ? totalCells : configuredMax;
  requestedBudget = Math.max(1, Math.min(totalCells, Math.min(requestedBudget, cap)));

  return {
    requestedBudget,
    diagnostics: {
      totalCells,
      lowConfidenceCells,
      ratioTarget,
      floorTarget,
      configuredMax,
      strictQuality: !!state?.strictQuality,
      maxLowRatio: Number.isFinite(maxLowRatio) ? maxLowRatio : null,
      maxAllowedLow: Number.isFinite(maxLowRatio) ? maxAllowedLow : null,
      lowConfidenceDeficit,
      minSourcesPerCriticalCell,
      criticalSourceDeficit,
      criticalCellCount: criticalCells.length,
    },
  };
}

function selectMatrixUnits(state = {}, budget = 12) {
  const subjects = ensureArray(state?.request?.matrix?.subjects);
  const attributes = ensureArray(state?.request?.matrix?.attributes);
  const subjectById = new Map(subjects.map((subject) => [clean(subject?.id), subject]));
  const attributeById = new Map(attributes.map((attribute) => [clean(attribute?.id), attribute]));
  const planByUnit = buildPlanUnitMap(state);
  const cells = ensureArray(state?.assessment?.matrix?.cells);
  const ranked = cells
    .map((cell) => ({
      key: `${cell.subjectId}::${cell.attributeId}`,
      type: "cell",
      subjectLabel: clean(subjectById.get(clean(cell?.subjectId))?.label || cell?.subjectId),
      attributeLabel: clean(attributeById.get(clean(cell?.attributeId))?.label || cell?.attributeId),
      attributeBrief: clean(attributeById.get(clean(cell?.attributeId))?.brief),
      pressure: computePressure(cell, {
        hasContradiction: hasContradictionSignal(cell),
        staleHeavy: staleSourceCount(cell) > 0,
      }),
      reasons: {
        confidence: clean(cell?.confidence) || "low",
        sourceCount: ensureArray(cell?.sources).length,
        contradictionFlag: hasContradictionSignal(cell),
        staleSourceFlag: staleSourceCount(cell) > 0,
        gapHypothesis: clean(planByUnit.get(clean(cell?.attributeId))?.gapHypothesis),
      },
      unit: cell,
    }))
    .sort((a, b) => b.pressure - a.pressure);

  const byAttribute = new Map();
  ranked.forEach((item) => {
    const attr = clean(item?.unit?.attributeId);
    if (!attr) return;
    if (!byAttribute.has(attr)) byAttribute.set(attr, []);
    byAttribute.get(attr).push(item);
  });

  const selectedByKey = new Map();
  const floorSelected = [];
  byAttribute.forEach((items) => {
    const candidate = items.find((item) => (
      clean(item?.unit?.confidence).toLowerCase() === "low"
      || ensureArray(item?.unit?.sources).length === 0
    ));
    if (!candidate) return;
    selectedByKey.set(candidate.key, candidate);
    floorSelected.push(candidate);
  });

  const requestedBudget = Math.max(0, Number(budget) || 0);
  const effectiveBudget = Math.max(requestedBudget, floorSelected.length);
  for (const item of ranked) {
    if (selectedByKey.size >= effectiveBudget) break;
    if (selectedByKey.has(item.key)) continue;
    selectedByKey.set(item.key, item);
  }

  const selected = [...selectedByKey.values()];
  const groups = groupMatrixSelections(selected);
  return {
    selected,
    groups,
    requestedBudget,
    effectiveBudget,
    floorReserved: floorSelected.length,
  };
}

function normalizeScorecardPatch(parsed = {}, options = {}) {
  const groundedSources = ensureArray(options?.groundedSources || []);
  const confidenceStats = options?.confidenceStats || { coerced: 0 };
  const providerGroundedCount = groundedSources.length;
  const liveSearchUsed = options?.liveSearchUsed === true;
  const callFailedGrounding = options?.callFailedGrounding === true;
  return ensureArray(parsed?.dimensions).map((unit) => {
    const grounded = annotateSourcesWithGrounding(unit?.sources || [], groundedSources);
    const fabricationAssessment = fabricationAssessmentFromSources(grounded.sources, {
      liveSearchUsed,
      groundedSourceCount: providerGroundedCount,
      callFailedGrounding,
    });
    const sourcesWithSignal = grounded.sources.map((source) => ({
      ...source,
      groundingConfidence: source?.groundedByProvider === true ? "provider" : "model-emitted",
      fabricationSignal: fabricationAssessment.signal,
      fabricationSignalReason: fabricationAssessment.reason || undefined,
    }));
    return {
    id: clean(unit?.id || unit?.unitId),
    brief: clean(unit?.brief),
    full: clean(unit?.full),
    confidence: normalizeConfidence(unit?.confidence, confidenceStats),
    confidenceReason: clean(unit?.confidenceReason),
    sources: sourcesWithSignal,
    fabricationSignal: fabricationAssessment.signal,
    fabricationSignalReason: fabricationAssessment.reason,
    arguments: normalizeArguments(unit?.arguments || {}, `recover-${clean(unit?.id || unit?.unitId)}`),
    risks: clean(unit?.risks),
    missingEvidence: clean(unit?.missingEvidence),
  };
  }).filter((unit) => unit.id);
}

function computeGroundingCoverage(units = []) {
  let totalUrls = 0;
  let groundedUrls = 0;
  ensureArray(units).forEach((unit) => {
    ensureArray(unit?.sources).forEach((source) => {
      if (!clean(source?.url)) return;
      totalUrls += 1;
      if (source?.groundedByProvider === true) groundedUrls += 1;
    });
  });
  return {
    totalUrls,
    groundedUrls,
    groundedRatio: totalUrls > 0 ? groundedUrls / totalUrls : 1,
  };
}

function computeGroundingPropagation(units = []) {
  const distribution = {};
  let totalSources = 0;
  let groundedByProviderTrue = 0;
  let groundedByProviderFalse = 0;
  ensureArray(units).forEach((unit) => {
    ensureArray(unit?.sources).forEach((source) => {
      totalSources += 1;
      if (source?.groundedByProvider === true) groundedByProviderTrue += 1;
      else groundedByProviderFalse += 1;
      const confidence = clean(source?.groundingConfidence || "unspecified").toLowerCase();
      distribution[confidence] = Number(distribution[confidence] || 0) + 1;
    });
  });
  return {
    stage: STAGE_ID,
    totalSources,
    groundedByProviderTrue,
    groundedByProviderFalse,
    groundingConfidenceDistribution: distribution,
  };
}

function normalizeUrlKey(value = "") {
  const raw = clean(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const path = clean(parsed.pathname).replace(/\/+$/, "") || "/";
    return `${clean(parsed.hostname).toLowerCase()}${path}${clean(parsed.search)}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

function buildRetrievedCorpus(groundedSources = [], chunkId = "") {
  const dedup = new Map();
  ensureArray(groundedSources).forEach((source, idx) => {
    const url = clean(source?.url);
    if (!url) return;
    const key = normalizeUrlKey(url);
    if (!key || dedup.has(key)) return;
    const corpusId = `${clean(chunkId) || "chunk"}-src-${String(dedup.size + 1).padStart(2, "0")}`;
    dedup.set(key, {
      corpusId,
      url,
      canonicalUrl: url,
      title: clean(source?.title || source?.name || `Retrieved source ${idx + 1}`) || `Retrieved source ${idx + 1}`,
      query: clean(source?.query),
      rank: dedup.size + 1,
      retrievedAt: new Date().toISOString(),
    });
  });
  const entries = [...dedup.values()];
  const byId = new Map(entries.map((entry) => [entry.corpusId, entry]));
  return {
    entries,
    byId,
  };
}

function buildMatrixGroupContext(group = {}) {
  const cells = ensureArray(group?.cells);
  const uniqueSubjectLines = [...new Set(
    cells.map((item) => clean(item?.unit?.subjectId))
      .filter(Boolean)
      .map((subjectId) => `- ${subjectId}: ${clean(itemLabelForSubject(cells, subjectId)) || subjectId}`)
  )].join("\n");
  const uniqueAttributeLines = [...new Set(
    cells.map((item) => clean(item?.unit?.attributeId))
      .filter(Boolean)
      .map((attributeId) => `- ${attributeId}: ${clean(itemLabelForAttribute(cells, attributeId)) || attributeId}${clean(itemBriefForAttribute(cells, attributeId)) ? ` - ${clean(itemBriefForAttribute(cells, attributeId))}` : ""}`)
  )].join("\n");
  const cellLines = cells.map((item) => `- cellKey=${item.unit.subjectId}::${item.unit.attributeId}; subjectId=${item.unit.subjectId}; attributeId=${item.unit.attributeId} (${item.subjectLabel} x ${item.attributeLabel})
  attributeBrief: ${item.attributeBrief || "not provided"}
  existingEvidence: ${truncateText(item?.unit?.full || item?.unit?.value || "none", 800)}
  whySelected: pressure=${item.pressure}; confidence=${item.reasons.confidence}; sourceCount=${item.reasons.sourceCount}; contradictionFlag=${item.reasons.contradictionFlag}; staleSourceFlag=${item.reasons.staleSourceFlag}; gapHypothesis=${item.reasons.gapHypothesis || "not provided"}`).join("\n");
  return {
    uniqueSubjectLines,
    uniqueAttributeLines,
    cellLines,
  };
}

function itemLabelForSubject(cells = [], subjectId = "") {
  const match = ensureArray(cells).find((item) => clean(item?.unit?.subjectId) === clean(subjectId));
  return clean(match?.subjectLabel);
}

function itemLabelForAttribute(cells = [], attributeId = "") {
  const match = ensureArray(cells).find((item) => clean(item?.unit?.attributeId) === clean(attributeId));
  return clean(match?.attributeLabel);
}

function itemBriefForAttribute(cells = [], attributeId = "") {
  const match = ensureArray(cells).find((item) => clean(item?.unit?.attributeId) === clean(attributeId));
  return clean(match?.attributeBrief);
}

function buildMatrixRecoveryRetrievePrompt(state = {}, group = {}) {
  const context = buildMatrixGroupContext(group);
  return `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Stage 08 retrieve pass. Propose targeted web-search queries for these weak matrix cells.
Subjects in this group:
${context.uniqueSubjectLines || "- none"}
Attributes in this group:
${context.uniqueAttributeLines || "- none"}
Cells to recover:
${context.cellLines || "- none"}

Rules:
- Return queries only; do not return evidence, confidence, or sources.
- You must call google_search while generating this output.
- Provide 1-2 precise queries per cellKey focused on the identified weakness.

Return JSON {"queries":[{"cellKey":"","query":"","rationale":""}]}`;
}

function buildMatrixRecoveryReadPrompt(state = {}, group = {}, corpus = []) {
  const context = buildMatrixGroupContext(group);
  const corpusLines = ensureArray(corpus).map((entry) => (
    `- corpusId=${entry.corpusId}; url=${entry.url}; title=${entry.title}${clean(entry?.query) ? `; query=${clean(entry.query)}` : ""}`
  )).join("\n");
  return `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Stage 08 read pass. Recover weak matrix cells using ONLY the retrieved corpus.
Subjects in this group:
${context.uniqueSubjectLines || "- none"}
Attributes in this group:
${context.uniqueAttributeLines || "- none"}
Cells to recover:
${context.cellLines || "- none"}
Retrieved corpus:
${corpusLines || "- none"}

Rules:
- Cover every listed cell exactly once.
- Use only retrieved corpus entries for citations.
- Every source item MUST include corpusId that exists in Retrieved corpus.
- If no corpus entry supports a claim, keep sources empty and explain in missingEvidence.
- Return confidence as one of these strings only: high, medium, low. Do not return numbers.
- sourceType must be one of: independent, research, news, analyst, government, registry, vendor, press_release, marketing.

Return JSON {"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[{"corpusId":"","name":"","quote":"","sourceType":""}],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;
}

function normalizeMatrixRecoveryReadPatch(parsed = {}, group = {}, corpusById = new Map(), confidenceStats = { coerced: 0 }, diagnostics = {}) {
  const byKey = new Map(ensureArray(parsed?.cells).map((item) => [`${clean(item?.subjectId)}::${clean(item?.attributeId)}`, item]));
  const corpusByUrlKey = new Map(
    [...(corpusById?.values ? corpusById.values() : [])]
      .map((entry) => [normalizeUrlKey(entry?.url), entry])
      .filter(([key]) => !!key)
  );
  return ensureArray(group?.cells).map((item) => {
    const subjectId = clean(item?.unit?.subjectId);
    const attributeId = clean(item?.unit?.attributeId);
    const patch = byKey.get(`${subjectId}::${attributeId}`) || {};
    const rawSources = ensureArray(patch?.sources);
    const sources = [];
    rawSources.forEach((source) => {
      const corpusId = clean(source?.corpusId);
      let corpus = corpusById.get(corpusId);
      if (!corpus) {
        corpus = corpusByUrlKey.get(normalizeUrlKey(source?.url));
      }
      if (!corpus) {
        diagnostics.sourceAbsentFromCorpus = Number(diagnostics.sourceAbsentFromCorpus || 0) + 1;
        return;
      }
      sources.push({
        name: clean(source?.name || corpus?.title) || "Retrieved source",
        url: clean(corpus?.url),
        quote: clean(source?.quote),
        sourceType: clean(source?.sourceType).toLowerCase() || "independent",
        corpusId: clean(corpus?.corpusId || corpusId),
        groundedByProvider: true,
        groundedSetAvailable: true,
        groundingConfidence: "provider",
      });
    });
    const fabricationAssessment = fabricationAssessmentFromSources(sources, {
      liveSearchUsed: true,
      groundedSourceCount: Math.max(1, sources.length),
      callFailedGrounding: false,
    });
    const sourcesWithSignal = sources.map((source) => ({
      ...source,
      fabricationSignal: fabricationAssessment.signal,
      fabricationSignalReason: fabricationAssessment.reason || undefined,
    }));

    return {
      subjectId,
      attributeId,
      value: clean(patch?.value),
      full: clean(patch?.full),
      confidence: normalizeConfidence(patch?.confidence, confidenceStats),
      confidenceReason: clean(patch?.confidenceReason),
      sources: sourcesWithSignal,
      fabricationSignal: fabricationAssessment.signal,
      fabricationSignalReason: fabricationAssessment.reason,
      arguments: normalizeArguments(patch?.arguments || {}, `recover-${subjectId}-${attributeId}`),
      risks: clean(patch?.risks),
      missingEvidence: clean(patch?.missingEvidence),
    };
  });
}

function computeStage08RecoveryMetrics(units = []) {
  const verificationTierCounts = {
    verified: 0,
    fabricated: 0,
    unreachable_infrastructure: 0,
    unreachable_stale: 0,
    unverifiable: 0,
    unknown: 0,
  };
  let sourcesAdded = 0;
  let groundedByProviderTrue = 0;
  let groundedByProviderFalse = 0;
  ensureArray(units).forEach((unit) => {
    ensureArray(unit?.sources).forEach((source) => {
      sourcesAdded += 1;
      if (source?.groundedByProvider === true) groundedByProviderTrue += 1;
      else groundedByProviderFalse += 1;
      const tier = clean(source?.verificationTier).toLowerCase();
      if (!tier) verificationTierCounts.unknown += 1;
      else if (Object.prototype.hasOwnProperty.call(verificationTierCounts, tier)) verificationTierCounts[tier] += 1;
      else verificationTierCounts.unknown += 1;
    });
  });
  const fabricatedRatio = sourcesAdded > 0
    ? Number(verificationTierCounts.fabricated || 0) / sourcesAdded
    : 0;
  return {
    sourcesAdded,
    groundedByProviderTrue,
    groundedByProviderFalse,
    verificationTierCounts,
    fabricatedRatio,
  };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const reasonCodes = [];
  const fetchSource = runtime?.transport?.fetchSource;
  const verifyBudget = runtime?.budgets?.stage_06_source_verify || {};
  const verifyTimeoutMs = Math.max(4000, Number(verifyBudget?.sourceTimeoutMs || 12000));
  const verifyResolveTimeoutMs = Math.max(2500, Number(verifyBudget?.resolveTimeoutMs || 9000));

  if (state?.outputType === "matrix") {
    const subjects = ensureArray(state?.request?.matrix?.subjects);
    const attributes = ensureArray(state?.request?.matrix?.attributes);
    const budgetPlan = computeMatrixAdaptiveBudget(state, runtime);
    const selection = selectMatrixUnits(state, budgetPlan.requestedBudget);
    const { selected, groups } = selection;
    if (!selected.length) {
      reasonCodes.push(REASON_CODES.RECOVERY_BUDGET_STARVED);
      return {
        stageStatus: "recovered",
        reasonCodes,
        statePatch: {
          ui: { phase: STAGE_ID },
          recoveredPatch: { matrix: { cells: [] } },
        },
        diagnostics: { selected: 0, groups: 0 },
      };
    }

    const chunkTrace = [];
    const subjectIndex = new Map(subjects.map((subject, idx) => [clean(subject?.id), idx]));
    const attributeIndex = new Map(attributes.map((attribute, idx) => [clean(attribute?.id), idx]));
    const chunkManifest = groups.map((group) => ({
      chunkId: group.chunkId,
      parentId: null,
      depth: Number(group?.depth || 0),
      cells: ensureArray(group?.cells).map((item) => ({
        subjectId: clean(item?.unit?.subjectId),
        attributeId: clean(item?.unit?.attributeId),
        subjectIdx: Number.isFinite(subjectIndex.get(clean(item?.unit?.subjectId)))
          ? Number(subjectIndex.get(clean(item?.unit?.subjectId)))
          : null,
        attributeIdx: Number.isFinite(attributeIndex.get(clean(item?.unit?.attributeId)))
          ? Number(attributeIndex.get(clean(item?.unit?.attributeId)))
          : null,
      })),
    }));

    const envConcurrency = Number(globalThis?.process?.env?.RESEARCHIT_STAGE_08_CHUNK_CONCURRENCY || 0);
    const chunkConcurrency = Math.max(
      1,
      Number(runtime?.budgets?.[STAGE_ID]?.chunkConcurrency || envConcurrency || 3)
    );

    const pool = await runChunkPool({
      initialChunks: groups,
      concurrency: chunkConcurrency,
      processChunk: async (group) => {
        chunkTrace.push({
          chunkId: group.chunkId,
          event: "started",
          timestamp: nowIso(),
          depth: Number(group?.depth || 0),
          cellCount: ensureArray(group?.cells).length,
        });
        try {
          const retrievePrompt = buildMatrixRecoveryRetrievePrompt(state, group);
          const retrieveCall = await callRetrieveWithGeminiEmptyFallback({
            state,
            runtime,
            stageId: STAGE_ID,
            routeStageId: STAGE_ROUTE_RETRIEVE_ID,
            actor: "analyst",
            systemPrompt: runtime?.prompts?.analyst || "You produce retrieval query plans for targeted recovery.",
            userPrompt: retrievePrompt,
            tokenBudget: Math.max(3000, Math.floor((runtime?.budgets?.[STAGE_ID]?.tokenBudget || 16000) * 0.35)),
            timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 90000,
            maxRetries: 1,
            liveSearch: true,
            searchMaxUses: 4,
            callContext: {
              chunkId: `${group.chunkId}-retrieve`,
              promptVersion: PROMPT_VERSION,
            },
            schemaHint: '{"queries":[{"cellKey":"","query":"","rationale":""}]}',
          }, runtime);
          const retrieveAttemptCodes = normalizeReasonCodes([
            ...retrieveCall.attempts.flatMap((attempt) => ensureArray(attempt?.reasonCodes)),
            ...retrieveCall.attempts
              .filter((attempt) => attempt?.noSearchPerformed === true)
              .map(() => REASON_CODES.STAGE_03B_NO_SEARCH_PERFORMED),
            ...retrieveCall.attempts
              .filter((attempt) => clean(attempt?.errorReasonCode) === REASON_CODES.GEMINI_EMPTY_SUCCESS_RESPONSE)
              .map(() => REASON_CODES.GEMINI_EMPTY_SUCCESS_RESPONSE),
            ...(retrieveCall?.fallbackUsed === true
              && clean(retrieveCall?.fallbackReasonCode) === REASON_CODES.GEMINI_EMPTY_SUCCESS_RESPONSE
              ? [REASON_CODES.STAGE_03B_GEMINI_EMPTY_FALLBACK_USED]
              : []),
            ...(clean(retrieveCall?.fallbackReasonCode) ? [clean(retrieveCall?.fallbackReasonCode)] : []),
            ...((retrieveCall?.resolved === false && clean(retrieveCall?.unresolvedReasonCode))
              ? [clean(retrieveCall?.unresolvedReasonCode)]
              : []),
          ]);
          const retrieveAttemptTokenDiagnostics = combineTokenDiagnostics(
            retrieveCall.attempts.map((attempt) => attempt?.tokenDiagnostics).filter(Boolean)
          ) || null;

          if (retrieveCall?.resolved !== true || !retrieveCall?.result) {
            const unresolvedReasonCode = clean(retrieveCall?.unresolvedReasonCode) || REASON_CODES.STAGE_03B_NO_SEARCH_PERFORMED;
            const unresolvedReason = clean(retrieveCall?.unresolvedReasonMessage || "Recovery retrieval unresolved for this chunk.");
            chunkTrace.push({
              chunkId: group.chunkId,
              event: "unresolved",
              timestamp: nowIso(),
              depth: Number(group?.depth || 0),
              reasonCode: unresolvedReasonCode,
              reason: unresolvedReason,
            });
            return {
              result: {
                chunkId: group.chunkId,
                depth: Number(group?.depth || 0),
                cellCount: ensureArray(group?.cells).length,
                patches: [],
                reasonCodes: retrieveAttemptCodes,
                tokenDiagnostics: retrieveAttemptTokenDiagnostics,
                retrieveTokenDiagnostics: retrieveAttemptTokenDiagnostics,
                readTokenDiagnostics: null,
                citations: computeGroundingCoverage([]),
                retrieveRoute: retrieveCall?.attempts?.find((attempt) => attempt?.ok === true)?.route || null,
                readRoute: null,
                route: retrieveCall?.attempts?.find((attempt) => attempt?.ok === true)?.route || null,
                retries: Number(retrieveAttemptTokenDiagnostics?.retries || 0),
                groundedSourcesResolved: null,
                retrievedCorpusCount: 0,
                sourceAbsentFromCorpus: 0,
                unresolved: true,
                unresolvedReasonCode,
                unresolvedReason,
              },
            };
          }
          const retrieveResult = retrieveCall.result;

          const retrievedCorpus = buildRetrievedCorpus(retrieveResult?.meta?.groundedSources || [], group.chunkId);
          const readPrompt = buildMatrixRecoveryReadPrompt(state, group, retrievedCorpus.entries);
          const readResult = await callActorJson({
            state,
            runtime,
            stageId: STAGE_ID,
            routeStageId: STAGE_ROUTE_READ_ID,
            actor: "analyst",
            systemPrompt: runtime?.prompts?.analyst || "You recover targeted evidence from a fixed corpus.",
            userPrompt: readPrompt,
            tokenBudget: Math.max(6000, Math.floor((runtime?.budgets?.[STAGE_ID]?.tokenBudget || 16000) * 0.75)),
            timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 90000,
            maxRetries: 1,
            liveSearch: false,
            callContext: {
              chunkId: `${group.chunkId}-read`,
              promptVersion: PROMPT_VERSION,
            },
            schemaHint: '{"cells":[{"subjectId":"","attributeId":"","value":"","full":"","confidence":"","confidenceReason":"","sources":[{"corpusId":"","name":"","quote":"","sourceType":""}],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
          });
          const confidenceStats = { coerced: 0 };
          const corpusDiagnostics = { sourceAbsentFromCorpus: 0 };
          const patches = normalizeMatrixRecoveryReadPatch(
            readResult?.parsed,
            group,
            retrievedCorpus.byId,
            confidenceStats,
            corpusDiagnostics
          );
          const tokenDiagnostics = combineTokenDiagnostics([
            retrieveResult?.tokenDiagnostics,
            readResult?.tokenDiagnostics,
          ]) || {};
          tokenDiagnostics.confidenceScaleCoerced = Number(confidenceStats.coerced || 0);
          const chunkReasonCodes = [
            ...retrieveAttemptCodes,
            ...ensureArray(retrieveResult?.reasonCodes),
            ...ensureArray(readResult?.reasonCodes),
            ...(confidenceStats.coerced > 0 ? [REASON_CODES.CONFIDENCE_SCALE_COERCED] : []),
            ...(Number(corpusDiagnostics?.sourceAbsentFromCorpus || 0) > 0 ? [REASON_CODES.SOURCE_ABSENT_FROM_CORPUS] : []),
          ];
          const retryCount = Number(retrieveResult?.retries || 0) + Number(readResult?.retries || 0);
          for (let retryIndex = 1; retryIndex <= retryCount; retryIndex += 1) {
            chunkTrace.push({
              chunkId: group.chunkId,
              event: "retried",
              timestamp: nowIso(),
              retryIndex,
              reason: "call_retry",
              depth: Number(group?.depth || 0),
            });
          }
          chunkTrace.push({
            chunkId: group.chunkId,
            event: "completed",
            timestamp: nowIso(),
            depth: Number(group?.depth || 0),
            outputSize: patches.length,
            outputTokens: Number(tokenDiagnostics?.outputTokens || 0),
            finishReason: clean(tokenDiagnostics?.finishReason) || "unknown",
          });
          return {
            result: {
              chunkId: group.chunkId,
              depth: Number(group?.depth || 0),
              cellCount: ensureArray(group?.cells).length,
              patches,
              reasonCodes: chunkReasonCodes,
              tokenDiagnostics,
              retrieveTokenDiagnostics: retrieveResult?.tokenDiagnostics || null,
              readTokenDiagnostics: readResult?.tokenDiagnostics || null,
              citations: computeGroundingCoverage(patches),
              retrieveRoute: retrieveResult?.route || null,
              readRoute: readResult?.route || null,
              route: readResult?.route || retrieveResult?.route || null,
              retries: retryCount,
              groundedSourcesResolved: retrieveResult?.meta?.groundedSourcesResolved || null,
              retrievedCorpusCount: retrievedCorpus.entries.length,
              sourceAbsentFromCorpus: Number(corpusDiagnostics?.sourceAbsentFromCorpus || 0),
              unresolved: false,
            },
          };
        } catch (err) {
          chunkTrace.push({
            chunkId: group.chunkId,
            event: "failed",
            timestamp: nowIso(),
            depth: Number(group?.depth || 0),
            error: clean(err?.message || "chunk_failure"),
            abortReason: err?.abortReason || null,
            finishReason: clean(err?.finishReason) || "unknown",
          });
          if (isLikelyRequestBug(err)) throw err;
          const unresolvedReasonCode = clean(err?.reasonCode || REASON_CODES.RETRY_EXHAUSTED);
          const unresolvedReason = clean(err?.message || "chunk_failure");
          chunkTrace.push({
            chunkId: group.chunkId,
            event: "unresolved",
            timestamp: nowIso(),
            depth: Number(group?.depth || 0),
            reasonCode: unresolvedReasonCode,
            reason: unresolvedReason,
          });
          return {
            result: {
              chunkId: group.chunkId,
              depth: Number(group?.depth || 0),
              cellCount: ensureArray(group?.cells).length,
              patches: [],
              reasonCodes: [unresolvedReasonCode],
              tokenDiagnostics: null,
              retrieveTokenDiagnostics: null,
              readTokenDiagnostics: null,
              citations: computeGroundingCoverage([]),
              retrieveRoute: null,
              readRoute: null,
              route: null,
              retries: Number(err?.attempts || 0),
              groundedSourcesResolved: null,
              retrievedCorpusCount: 0,
              sourceAbsentFromCorpus: 0,
              unresolved: true,
              unresolvedReasonCode,
              unresolvedReason,
            },
          };
        }
      },
    });
    const groupResults = ensureArray(pool?.results);

    const patches = groupResults.flatMap((r) => r.patches);
    let recoveryVerification = null;
    if (typeof fetchSource === "function") {
      const verifyCache = new Map();
      const unitsNeedingVerify = patches.filter((cell) => (
        ensureArray(cell?.sources).some((source) => !clean(source?.verificationTier))
      ));
      if (unitsNeedingVerify.length) {
        const countersByUnit = await Promise.all(unitsNeedingVerify.map((cell) => (
          verifySourcesForUnit(cell, {
            fetchSource,
            cache: verifyCache,
            timeoutMs: verifyTimeoutMs,
            resolveTimeoutMs: verifyResolveTimeoutMs,
          })
        )));
        recoveryVerification = aggregateVerificationCounters(countersByUnit);
      }
    }

    let missingTierSourceCount = 0;
    const missingTierSampleCellIds = [];
    patches.forEach((cell) => {
      const cellKey = `${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`;
      ensureArray(cell?.sources).forEach((source) => {
        if (clean(source?.verificationTier)) return;
        missingTierSourceCount += 1;
        if (missingTierSampleCellIds.length < 6 && cellKey) {
          missingTierSampleCellIds.push(cellKey);
        }
        source.verificationTier = "unverifiable";
        source.citationStatus = clean(source?.citationStatus || "unverifiable") || "unverifiable";
      });
    });
    if (missingTierSourceCount > 0) {
      reasonCodes.push(REASON_CODES.SOURCE_MISSING_VERIFICATION_TIER);
    }

    const matrixReasonCodes = groupResults.flatMap((r) => r.reasonCodes);
    const unresolvedGroups = groupResults
      .filter((r) => r?.unresolved === true)
      .map((r) => ({
        chunkId: clean(r?.chunkId),
        reasonCode: clean(r?.unresolvedReasonCode),
        reason: clean(r?.unresolvedReason),
      }))
      .filter((r) => r.chunkId);
    const tokenDiagnosticsList = groupResults.map((r) => r.tokenDiagnostics);
    const modelRoutes = groupResults.map((r) => r.route).filter(Boolean);
    const retrieveWebSearchCalls = groupResults.reduce((sum, row) => (
      sum + Number(row?.retrieveTokenDiagnostics?.webSearchCalls || 0)
    ), 0);
    const readWebSearchCalls = groupResults.reduce((sum, row) => (
      sum + Number(row?.readTokenDiagnostics?.webSearchCalls || 0)
    ), 0);
    const totalRetries = groupResults.reduce((sum, r) => sum + r.retries, 0);
    const aggregatedTokens = combineTokenDiagnostics(tokenDiagnosticsList);
    const citations = groupResults.reduce((acc, row) => {
      const stats = row?.citations || {};
      acc.totalUrls += Number(stats?.totalUrls || 0);
      acc.groundedUrls += Number(stats?.groundedUrls || 0);
      return acc;
    }, { totalUrls: 0, groundedUrls: 0 });
    citations.groundedRatio = citations.totalUrls > 0 ? (citations.groundedUrls / citations.totalUrls) : 1;
    const groundedSourcesResolved = groupResults.reduce((acc, row) => {
      const stats = row?.groundedSourcesResolved || {};
      acc.total += Number(stats?.total || 0);
      acc.resolved += Number(stats?.resolved || 0);
      acc.unresolved += Number(stats?.unresolved || 0);
      return acc;
    }, { total: 0, resolved: 0, unresolved: 0 });
    const retrievedCorpusCount = groupResults.reduce((sum, row) => sum + Number(row?.retrievedCorpusCount || 0), 0);
    const sourceAbsentFromCorpus = groupResults.reduce((sum, row) => sum + Number(row?.sourceAbsentFromCorpus || 0), 0);
    if (sourceAbsentFromCorpus > 0) {
      reasonCodes.push(REASON_CODES.SOURCE_ABSENT_FROM_CORPUS);
    }
    groupResults.sort((a, b) => String(a?.chunkId || "").localeCompare(String(b?.chunkId || "")));
    chunkTrace.sort((a, b) => {
      const chunkCmp = String(a?.chunkId || "").localeCompare(String(b?.chunkId || ""));
      if (chunkCmp !== 0) return chunkCmp;
      return String(a?.event || "").localeCompare(String(b?.event || ""));
    });
    const modelRoute = modelRoutes[0] || null;
    const groundingPropagation = computeGroundingPropagation(patches);
    const stage08Recovery = computeStage08RecoveryMetrics(patches);

    return {
      stageStatus: "ok",
      reasonCodes: normalizeReasonCodes([...reasonCodes, ...matrixReasonCodes]),
      statePatch: {
        ui: { phase: STAGE_ID },
        chunkManifest: {
          ...(state?.chunkManifest || {}),
          [STAGE_ID]: chunkManifest,
        },
        recoveredPatch: {
          matrix: {
            cells: patches,
          },
        },
      },
      diagnostics: {
        selectedUnits: selected.length,
        groupedCalls: groups.length,
        patchedCells: patches.length,
        chunkTrace,
        chunkManifest,
        requestedBudget: selection.requestedBudget,
        effectiveBudget: selection.effectiveBudget,
        attributeCoverageFloorReserved: selection.floorReserved,
        adaptiveBudget: budgetPlan.diagnostics,
        citations,
        groundedSourcesResolved,
        groundingPropagation,
        retrievedCorpusCount,
        sourceAbsentFromCorpus,
        retrieveCalls: groupResults.length,
        readCalls: groupResults.length,
        retrieveWebSearchCalls,
        readWebSearchCalls,
        retries: totalRetries,
        chunkRetriesTotal: chunkTrace.filter((entry) => entry?.event === "retried").length,
        chunkSplitDepthMax: chunkTrace.reduce((maxDepth, entry) => {
          const depth = Number(entry?.depth || 0);
          return depth > maxDepth ? depth : maxDepth;
        }, 0),
        chunksStarted: chunkTrace.filter((entry) => entry?.event === "started").length,
        chunksCompleted: chunkTrace.filter((entry) => entry?.event === "completed").length,
        chunksFailed: chunkTrace.filter((entry) => entry?.event === "failed").length,
        chunksUnresolved: chunkTrace.filter((entry) => entry?.event === "unresolved").length,
        chunkTruncationRate: Number(aggregatedTokens?.outputTruncatedRate || 0),
        tokenDiagnostics: aggregatedTokens,
        modelRoute,
        chunkConcurrency,
        peakWorkerCount: Number(pool?.peakWorkerCount || 1),
        unresolvedGroupCount: unresolvedGroups.length,
        unresolvedGroups: unresolvedGroups.slice(0, 40),
        recoveryVerification,
        stage08Recovery,
        missingTierSourceCount,
        missingTierSampleCellIds,
      },
      modelRoute,
      tokens: aggregatedTokens,
      retries: totalRetries,
    };
  }

  const budget = Number(runtime?.config?.limits?.lowConfidenceBudgetUnits || 8);
  const selection = selectScorecardUnits(state, budget);
  const selected = selection.selected;
  if (!selected.length) {
    reasonCodes.push(REASON_CODES.RECOVERY_BUDGET_STARVED);
    return {
      stageStatus: "recovered",
      reasonCodes,
      statePatch: {
        ui: { phase: STAGE_ID },
        recoveredPatch: { scorecard: { dimensions: [] } },
      },
      diagnostics: { selected: 0 },
    };
  }

  const prompt = `Objective: ${clean(state?.request?.objective)}
Decision question: ${clean(state?.request?.decisionQuestion) || "not provided"}
Scope context: ${clean(state?.request?.scopeContext) || "not provided"}
Role context: ${clean(state?.request?.roleContext) || "not provided"}
Recover evidence for these scorecard dimensions.
Targets:
${selected.map((item) => `- ${item.key}: ${item.label}
  brief: ${item.brief || "not provided"}
  existingEvidence: ${truncateText(item?.unit?.full || item?.unit?.brief || "none", 800)}
  whySelected: pressure=${item.pressure}; confidence=${item.reasons.confidence}; sourceCount=${item.reasons.sourceCount}; contradictionFlag=${item.reasons.contradictionFlag}; staleSourceFlag=${item.reasons.staleSourceFlag}; gapHypothesis=${item.reasons.gapHypothesis || "not provided"}`).join("\n")}

Rules:
- Focus on closing the specific weakness for each target.
- Use high-quality sources whenever possible; prefer independent evidence (government, research, analyst, reputable news).
- Return confidence as one of these strings only: high, medium, low. Do not return numbers.
- Example: {"confidence":"high"}
- For each non-empty source, include a valid canonical public https URL, concise quote/snippet, and "sourceType".
- Never return temporary grounding redirect links (for example vertexaisearch.cloud.google.com/grounding-api-redirect/...).
- If you are not certain the canonical public URL is correct, omit the URL instead of guessing.
- sourceType must be one of: independent, research, news, analyst, government, registry, vendor, press_release, marketing.
- If reliable evidence is still unavailable, keep "sources" empty and state what remains missing in "missingEvidence".

Return JSON {"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"risks":"","missingEvidence":""}]}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: runtime?.prompts?.analyst || "You recover targeted evidence.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 8000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 90000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 2,
    liveSearch: true,
    callContext: {
      chunkId: "scorecard",
      promptVersion: PROMPT_VERSION,
    },
    schemaHint: '{"dimensions":[{"unitId":"","brief":"","full":"","confidence":"","confidenceReason":"","sources":[],"arguments":{"supporting":[],"limiting":[]},"missingEvidence":""}]}',
  });

  const confidenceStats = { coerced: 0 };
  const patch = normalizeScorecardPatch(result?.parsed, {
    groundedSources: result?.meta?.groundedSources || [],
    liveSearchUsed: result?.tokenDiagnostics?.liveSearchUsed === true,
    callFailedGrounding: result?.meta?.callFailedGrounding === true,
    confidenceStats,
  });
  let recoveryVerification = null;
  if (typeof fetchSource === "function") {
    const verifyCache = new Map();
    const unitsNeedingVerify = patch.filter((unit) => (
      ensureArray(unit?.sources).some((source) => !clean(source?.verificationTier))
    ));
    if (unitsNeedingVerify.length) {
      const countersByUnit = await Promise.all(unitsNeedingVerify.map((unit) => (
        verifySourcesForUnit(unit, {
          fetchSource,
          cache: verifyCache,
          timeoutMs: verifyTimeoutMs,
          resolveTimeoutMs: verifyResolveTimeoutMs,
        })
      )));
      recoveryVerification = aggregateVerificationCounters(countersByUnit);
    }
  }

  let missingTierSourceCount = 0;
  const missingTierSampleUnitIds = [];
  patch.forEach((unit) => {
    const unitId = clean(unit?.id);
    ensureArray(unit?.sources).forEach((source) => {
      if (clean(source?.verificationTier)) return;
      missingTierSourceCount += 1;
      if (missingTierSampleUnitIds.length < 6 && unitId) {
        missingTierSampleUnitIds.push(unitId);
      }
      source.verificationTier = "unverifiable";
      source.citationStatus = clean(source?.citationStatus || "unverifiable") || "unverifiable";
    });
  });
  if (missingTierSourceCount > 0) {
    reasonCodes.push(REASON_CODES.SOURCE_MISSING_VERIFICATION_TIER);
  }

  const scorecardReasonCodes = [
    ...reasonCodes,
    ...ensureArray(result?.reasonCodes),
    ...(confidenceStats.coerced > 0 ? [REASON_CODES.CONFIDENCE_SCALE_COERCED] : []),
  ];
  const tokenDiagnostics = {
    ...(result?.tokenDiagnostics || {}),
    confidenceScaleCoerced: Number(confidenceStats.coerced || 0),
  };

  return {
    stageStatus: "ok",
    reasonCodes: normalizeReasonCodes(scorecardReasonCodes),
    statePatch: {
      ui: { phase: STAGE_ID },
      recoveredPatch: {
        scorecard: {
          dimensions: patch,
        },
      },
    },
    diagnostics: {
      selectedUnits: selected.length,
      patchedDimensions: patch.length,
      requestedBudget: selection.requestedBudget,
      effectiveBudget: selection.effectiveBudget,
      coverageFloorReserved: selection.floorReserved,
      citations: computeGroundingCoverage(patch),
      groundingPropagation: computeGroundingPropagation(patch),
      groundedSourcesResolved: result?.meta?.groundedSourcesResolved || null,
      retries: result.retries,
      modelRoute: result.route,
      tokenDiagnostics,
      recoveryVerification,
      missingTierSourceCount,
      missingTierSampleUnitIds,
    },
    io: {
      prompt,
      response: result.text,
    },
    modelRoute: result.route,
    tokens: tokenDiagnostics,
    retries: result.retries,
  };
}
