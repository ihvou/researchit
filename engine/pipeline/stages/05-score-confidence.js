import {
  callActorJson,
  clean,
  compactText,
  ensureArray,
  normalizeCitationStatus,
  normalizeConfidence,
  normalizeConfidenceSource,
  normalizeSources,
  summarizeSourceUniverse,
} from "./common.js";
import { deriveDeterministicConfidence } from "../../lib/confidence-derived.js";

export const STAGE_ID = "stage_05_score_confidence";
export const STAGE_TITLE = "Score Confidence";

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function scoreFromEvidence(unit = {}) {
  const sourceCount = ensureArray(unit?.sources).length;
  const supporting = ensureArray(unit?.arguments?.supporting).length;
  const limiting = ensureArray(unit?.arguments?.limiting).length;
  const net = sourceCount + supporting - Math.floor(limiting / 2);
  if (net >= 6) return 5;
  if (net >= 4) return 4;
  if (net >= 2) return 3;
  if (net >= 1) return 2;
  return 1;
}

function confidenceFromEvidence(unit = {}) {
  const sourceCount = ensureArray(unit?.sources).length;
  if (sourceCount >= 4) return "high";
  if (sourceCount >= 2) return "medium";
  return "low";
}

function citationStatusFromSources(sources = []) {
  const list = normalizeSources(sources);
  if (!list.length) return "not_found";
  const statuses = list.map((source) => normalizeCitationStatus(source?.citationStatus));
  if (statuses.includes("verified")) return "verified";
  if (statuses.includes("unverifiable")) return "unverifiable";
  return "unverifiable";
}

function missingEvidenceFallback(unit = {}, confidence = "low") {
  const sourceCount = ensureArray(unit?.sources).length;
  if (clean(unit?.missingEvidence)) return clean(unit?.missingEvidence);
  if (sourceCount === 0) return "No credible sources were found for this unit yet.";
  if (clean(confidence) === "low") return "Evidence remains too thin or inconsistent for decision-grade confidence.";
  return "";
}

function scorecardEvidencePacket(evidence = {}, dimensions = []) {
  const units = ensureArray(evidence?.scorecard?.dimensions);
  const byId = new Map(units.map((unit) => [clean(unit?.id), unit]));
  return dimensions.map((dim) => {
    const unit = byId.get(dim.id) || {};
    return {
      unitId: dim.id,
      label: clean(dim?.label) || dim.id,
      brief: clean(dim?.brief),
      rubric: clean(dim?.rubric || dim?.fullDef),
      weight: Number(dim?.weight) || 0,
      evidence: {
        brief: clean(unit?.brief),
        full: compactText(unit?.full, 1400),
        priorConfidence: normalizeConfidence(unit?.confidence || confidenceFromEvidence(unit)),
        priorConfidenceReason: clean(unit?.confidenceReason),
        sourceCount: ensureArray(unit?.sources).length,
        sources: normalizeSources(unit?.sources || []).slice(0, 10).map((source) => ({
          name: clean(source?.name),
          url: clean(source?.url),
          quote: compactText(source?.quote, 180),
          sourceType: clean(source?.sourceType),
          publishedYear: Number.isFinite(Number(source?.publishedYear)) ? Number(source.publishedYear) : undefined,
          displayStatus: clean(source?.displayStatus),
        })),
        arguments: {
          supporting: ensureArray(unit?.arguments?.supporting).slice(0, 8).map((arg) => ({
            claim: clean(arg?.claim),
            detail: compactText(arg?.detail, 220),
          })),
          limiting: ensureArray(unit?.arguments?.limiting).slice(0, 8).map((arg) => ({
            claim: clean(arg?.claim),
            detail: compactText(arg?.detail, 220),
          })),
        },
        risks: clean(unit?.risks),
        missingEvidence: clean(unit?.missingEvidence),
      },
    };
  });
}

function normalizeScorecardAssessment(evidence = {}, dimensions = [], parsed = {}) {
  const byId = {};
  const evidenceUnits = ensureArray(evidence?.scorecard?.dimensions);
  const evidenceMap = new Map(evidenceUnits.map((unit) => [clean(unit?.id), unit]));
  const scoredMap = new Map(ensureArray(parsed?.units).map((unit) => [clean(unit?.unitId || unit?.id), unit]));

  dimensions.forEach((dim) => {
    const unit = evidenceMap.get(dim.id) || {};
    const scored = scoredMap.get(dim.id) || {};
    const sources = normalizeSources(unit?.sources || []);
    const selfReportedConfidence = normalizeConfidence(scored?.confidence || unit?.confidence || confidenceFromEvidence(unit));
    const derivedConfidence = deriveDeterministicConfidence({
      confidence: selfReportedConfidence,
      confidenceReason: clean(scored?.confidenceReason || unit?.confidenceReason),
      sources,
      arguments: unit?.arguments || {},
    }, {
      allowModelFallback: true,
      minSourceCountForDerived: 2,
    });
    const score = clampScore(scored?.score || unit?.score || scoreFromEvidence(unit));
    byId[dim.id] = {
      id: dim.id,
      score,
      confidence: derivedConfidence.confidence,
      confidenceSelfReported: derivedConfidence.confidenceSelfReported,
      confidenceSource: normalizeConfidenceSource(derivedConfidence.confidenceSource || unit?.confidenceSource || "model"),
      confidenceReason: clean(derivedConfidence.confidenceReason) || clean(scored?.confidenceReason || unit?.confidenceReason) || `Based on ${ensureArray(unit?.sources).length} cited sources.`,
      brief: clean(scored?.brief || unit?.brief),
      full: clean(scored?.full || unit?.full),
      sources,
      citationStatus: citationStatusFromSources(sources),
      arguments: {
        supporting: ensureArray(unit?.arguments?.supporting),
        limiting: ensureArray(unit?.arguments?.limiting),
      },
      risks: clean(scored?.risks || unit?.risks),
      missingEvidence: clean(scored?.missingEvidence) || missingEvidenceFallback(unit, derivedConfidence.confidence),
      providerAgreement: clean(unit?.providerAgreement),
    };
  });

  return { scorecard: { byId } };
}

function normalizeMatrixAssessment(evidence = {}, request = {}) {
  const cells = ensureArray(evidence?.matrix?.cells).map((cell) => ({
    ...(function buildConfidencePatch() {
      const selfReportedConfidence = normalizeConfidence(cell?.confidence || confidenceFromEvidence(cell));
      const derivedConfidence = deriveDeterministicConfidence({
        confidence: selfReportedConfidence,
        confidenceReason: clean(cell?.confidenceReason),
        sources: normalizeSources(cell?.sources || []),
        arguments: cell?.arguments || {},
      }, {
        allowModelFallback: true,
        minSourceCountForDerived: 2,
      });
      return {
        confidence: derivedConfidence.confidence,
        confidenceSelfReported: derivedConfidence.confidenceSelfReported,
        confidenceSource: normalizeConfidenceSource(derivedConfidence.confidenceSource || cell?.confidenceSource || "model"),
        confidenceReason: clean(derivedConfidence.confidenceReason) || clean(cell?.confidenceReason) || `Based on ${ensureArray(cell?.sources).length} cited sources.`,
      };
    }()),
    subjectId: clean(cell?.subjectId),
    attributeId: clean(cell?.attributeId),
    value: clean(cell?.value),
    full: clean(cell?.full),
    sources: normalizeSources(cell?.sources || []),
    citationStatus: citationStatusFromSources(cell?.sources || []),
    arguments: {
      supporting: ensureArray(cell?.arguments?.supporting),
      limiting: ensureArray(cell?.arguments?.limiting),
    },
    risks: clean(cell?.risks),
    providerAgreement: clean(cell?.providerAgreement),
  }));

  const expectedKeys = new Set();
  ensureArray(request?.matrix?.subjects).forEach((subject) => {
    ensureArray(request?.matrix?.attributes).forEach((attribute) => {
      expectedKeys.add(`${subject.id}::${attribute.id}`);
    });
  });
  const byKey = new Map(cells.map((cell) => [`${cell.subjectId}::${cell.attributeId}`, cell]));
  expectedKeys.forEach((key) => {
    if (byKey.has(key)) return;
    const [subjectId, attributeId] = key.split("::");
    cells.push({
      subjectId,
      attributeId,
      value: "insufficient evidence",
      full: "No reliable evidence collected yet.",
      confidence: "low",
      confidenceSelfReported: "low",
      confidenceSource: "model",
      confidenceReason: "No sources available.",
      sources: [],
      citationStatus: "not_found",
      arguments: { supporting: [], limiting: [] },
      risks: "",
      providerAgreement: "none",
    });
  });

  return { matrix: { cells } };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const evidence = state?.evidence || {};
  const request = state?.request || {};

  if (state?.outputType === "matrix") {
    const assessment = normalizeMatrixAssessment(evidence, request);
    const units = ensureArray(assessment?.matrix?.cells);
    const sourceUniverse = summarizeSourceUniverse(units);

    return {
      stageStatus: "ok",
      reasonCodes: [],
      statePatch: {
        ui: { phase: STAGE_ID },
        assessment,
        quality: {
          sourceUniverse,
        },
      },
      diagnostics: {
        outputType: state?.outputType,
        assessedUnits: units.length,
        sourceUniverse,
      },
    };
  }

  const dimensions = ensureArray(request?.scorecard?.dimensions);
  const packet = scorecardEvidencePacket(evidence, dimensions);
  if (!runtime?.transport) {
    const assessment = normalizeScorecardAssessment(evidence, dimensions, {});
    const units = Object.values(assessment?.scorecard?.byId || {});
    const sourceUniverse = summarizeSourceUniverse(units);
    return {
      stageStatus: "ok",
      reasonCodes: [],
      statePatch: {
        ui: { phase: STAGE_ID },
        assessment,
        quality: {
          sourceUniverse,
        },
      },
      diagnostics: {
        outputType: state?.outputType,
        assessedUnits: units.length,
        sourceUniverse,
        fallback: "heuristic_no_transport",
      },
    };
  }
  const prompt = `Calibrate score and confidence for each scorecard dimension using rubric anchors.
Objective: ${clean(request?.objective)}
Decision question: ${clean(request?.decisionQuestion) || "not provided"}
Scope context: ${clean(request?.scopeContext) || "not provided"}
Role context: ${clean(request?.roleContext) || "not provided"}

Rules:
- Evaluate each unit strictly against its rubric anchors (1 to 5).
- Use only the provided evidence package; do not invent sources.
- Confidence must reflect evidence quality, source depth, and contradiction risk.
- If evidence is weak or missing, score conservatively and set low confidence.
- Fill "missingEvidence" with specific unresolved evidence gaps when applicable.

Return JSON:
{
  "units": [{
    "unitId": "",
    "score": 1,
    "confidence": "high|medium|low",
    "confidenceReason": "",
    "brief": "",
    "full": "",
    "risks": "",
    "missingEvidence": ""
  }]
}
Evidence package:
${JSON.stringify(packet).slice(0, 32000)}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: runtime?.prompts?.analyst || "You score scorecard dimensions using rubric anchors.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 8000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 60000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 1,
    liveSearch: false,
    schemaHint: '{"units":[{"unitId":"","score":1,"confidence":"medium","confidenceReason":"","brief":"","full":"","missingEvidence":""}]}',
  });

  const assessment = normalizeScorecardAssessment(evidence, dimensions, result?.parsed || {});

  const units = Object.values(assessment?.scorecard?.byId || {});

  const sourceUniverse = summarizeSourceUniverse(units);

  return {
    stageStatus: "ok",
    reasonCodes: result.reasonCodes,
    statePatch: {
      ui: { phase: STAGE_ID },
      assessment,
      quality: {
        sourceUniverse,
      },
    },
    diagnostics: {
      outputType: state?.outputType,
      assessedUnits: units.length,
      sourceUniverse,
      retries: result.retries,
      modelRoute: result.route,
      tokenDiagnostics: result.tokenDiagnostics,
    },
    io: {
      prompt,
      response: result.text,
    },
    modelRoute: result.route,
    tokens: result.tokenDiagnostics,
    retries: result.retries,
  };
}
