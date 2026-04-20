import { callActorJson, clean, ensureArray, normalizeSources } from "./common.js";
import { REASON_CODES, normalizeReasonCodes } from "../contracts/reason-codes.js";

export const STAGE_ID = "stage_13_defend";
export const STAGE_TITLE = "Concede Defend";

function normalizeOutcome(raw = {}, fallback = {}) {
  const flag = fallback?.flag || {};
  const generatedFallback = fallback?.generatedFallback === true;
  const rawDisposition = clean(raw?.disposition).toLowerCase();
  const validDisposition = rawDisposition === "accepted" || rawDisposition === "rejected_with_evidence"
    ? rawDisposition
    : "";
  const analystNote = clean(raw?.analystNote);
  const resolved = raw?.resolved === true;
  const noteMissing = resolved && !analystNote;
  const disposition = validDisposition
    || (generatedFallback ? "no_response" : (resolved ? "accepted" : "rejected_with_evidence"));
  const outcome = {
    flagId: clean(raw?.flagId || fallback?.flagId || flag?.id),
    flag: {
      ...flag,
      severity: clean(flag?.severity || "medium"),
      category: clean(flag?.category || "other"),
    },
    resolved,
    disposition,
    analystNote: analystNote
      || (generatedFallback
        ? "No analyst response returned for this flag."
        : (noteMissing ? "Model returned resolution without note." : "")),
    mitigationNote: clean(raw?.mitigationNote || "") || undefined,
    sources: normalizeSources(raw?.sources || []),
    responseMissing: generatedFallback,
    noteMissing,
  };
  return outcome;
}

function buildFlagContexts(state = {}, flags = [], counterEntries = []) {
  const counterByFlagId = new Map();
  ensureArray(counterEntries).forEach((entry) => {
    const key = clean(entry?.flagId);
    if (!key) return;
    if (!counterByFlagId.has(key)) counterByFlagId.set(key, []);
    counterByFlagId.get(key).push(entry);
  });

  if (clean(state?.outputType).toLowerCase() === "matrix") {
    const byKey = new Map(ensureArray(state?.assessment?.matrix?.cells).map((cell) => [
      `${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`,
      cell,
    ]));
    return ensureArray(flags).map((flag) => {
      const unitKey = clean(flag?.unitKey);
      const cell = byKey.get(unitKey) || {};
      return {
        flagId: clean(flag?.id),
        unitKey,
        flag,
        assessedUnit: {
          value: clean(cell?.value),
          full: clean(cell?.full).slice(0, 1200),
          confidence: clean(cell?.confidence),
          confidenceReason: clean(cell?.confidenceReason),
          missingEvidence: clean(cell?.missingEvidence),
          sources: normalizeSources(cell?.sources || []).slice(0, 8),
          arguments: {
            supporting: ensureArray(cell?.arguments?.supporting).slice(0, 8).map((item) => ({
              claim: clean(item?.claim),
              detail: clean(item?.detail).slice(0, 220),
            })),
            limiting: ensureArray(cell?.arguments?.limiting).slice(0, 8).map((item) => ({
              claim: clean(item?.claim),
              detail: clean(item?.detail).slice(0, 220),
            })),
          },
          risks: clean(cell?.risks),
        },
        counterEntries: counterByFlagId.get(clean(flag?.id)) || [],
      };
    });
  }

  const byId = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? state.assessment.scorecard.byId
    : {};
  return ensureArray(flags).map((flag) => {
    const unitKey = clean(flag?.unitKey);
    const unit = byId[unitKey] || {};
    return {
      flagId: clean(flag?.id),
      unitKey,
      flag,
      assessedUnit: {
        score: Number.isFinite(Number(unit?.score)) ? Number(unit.score) : null,
        brief: clean(unit?.brief),
        full: clean(unit?.full).slice(0, 1200),
        confidence: clean(unit?.confidence),
        confidenceReason: clean(unit?.confidenceReason),
        missingEvidence: clean(unit?.missingEvidence),
        sources: normalizeSources(unit?.sources || []).slice(0, 8),
        arguments: {
          supporting: ensureArray(unit?.arguments?.supporting).slice(0, 8).map((item) => ({
            claim: clean(item?.claim),
            detail: clean(item?.detail).slice(0, 220),
          })),
          limiting: ensureArray(unit?.arguments?.limiting).slice(0, 8).map((item) => ({
            claim: clean(item?.claim),
            detail: clean(item?.detail).slice(0, 220),
          })),
        },
        risks: clean(unit?.risks),
      },
      counterEntries: counterByFlagId.get(clean(flag?.id)) || [],
    };
  });
}

function applyAcceptedAdjustments(state = {}, outcomes = []) {
  if (state?.outputType === "matrix") {
    const cells = ensureArray(state?.assessment?.matrix?.cells).map((cell) => ({ ...cell }));
    const byKey = new Map(cells.map((cell) => [`${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`, cell]));
    outcomes.forEach((outcome) => {
      if (!outcome?.resolved) return;
      const key = clean(outcome?.flag?.unitKey);
      const cell = byKey.get(key);
      if (!cell) return;
      if (clean(outcome?.flag?.suggestedValue)) {
        cell.value = clean(outcome.flag.suggestedValue);
      }
      if (clean(outcome?.flag?.suggestedConfidence)) {
        cell.confidence = clean(outcome.flag.suggestedConfidence);
      }
      cell.contested = true;
    });
    return { matrix: { cells } };
  }

  const byId = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? { ...state.assessment.scorecard.byId }
    : {};
  outcomes.forEach((outcome) => {
    if (!outcome?.resolved) return;
    const key = clean(outcome?.flag?.unitKey);
    const unit = byId[key];
    if (!unit) return;
    if (Number.isFinite(Number(outcome?.flag?.suggestedScore))) {
      unit.score = Number(outcome.flag.suggestedScore);
    }
    if (clean(outcome?.flag?.suggestedConfidence)) {
      unit.confidence = clean(outcome.flag.suggestedConfidence).toLowerCase();
    }
  });
  return { scorecard: { byId } };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const flags = ensureArray(state?.critique?.flags);
  const counterEntries = ensureArray(state?.critique?.counterCase?.entries);

  if (!flags.length) {
    return {
      stageStatus: "ok",
      reasonCodes: [],
      statePatch: {
        ui: { phase: STAGE_ID },
        resolved: {
          assessment: state?.assessment || null,
          flagOutcomes: [],
          unresolvedHighSeverityCount: 0,
          analystSummary: "No critic flags to resolve.",
          responseSources: [],
        },
      },
      diagnostics: { skipped: true, reason: "no_flags" },
    };
  }
  const flagContexts = buildFlagContexts(state, flags, counterEntries);

  const prompt = `Resolve every critic flag using counter-case evidence.
You must respond to every listed flagId exactly once.

Rules:
- analystNote is required for every flag.
- If resolved=true, explain the exact correction/defense and cite sources.
- If resolved=false and severity is high, mitigationNote is required.
- Do not invent sources that are not in evidence or counter entries.

Return JSON:
{
  "outcomes": [{
    "flagId":"",
    "resolved": true,
    "disposition": "accepted|rejected_with_evidence",
    "analystNote":"",
    "mitigationNote":"",
    "sources": []
  }],
  "analystSummary": ""
}
Flag contexts:
${JSON.stringify(flagContexts).slice(0, 28000)}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: runtime?.prompts?.analystResponse || runtime?.prompts?.analyst || "You defend or concede each critic flag.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 8000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 75000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 1,
    liveSearch: false,
    schemaHint: '{"outcomes":[{"flagId":"","resolved":true,"disposition":"accepted","analystNote":"","mitigationNote":"","sources":[]}],"analystSummary":""}',
  });

  const outcomesRaw = ensureArray(result?.parsed?.outcomes);
  const byFlagId = new Map(flags.map((flag) => [clean(flag?.id), { flagId: clean(flag?.id), flag }]));
  const normalizedOutcomes = outcomesRaw.map((raw) => normalizeOutcome(raw, byFlagId.get(clean(raw?.flagId)) || {}));
  flags.forEach((flag) => {
    const key = clean(flag?.id);
    if (normalizedOutcomes.some((outcome) => clean(outcome?.flagId) === key)) return;
    normalizedOutcomes.push(normalizeOutcome({}, { flagId: key, flag, generatedFallback: true }));
  });

  const unresolvedHighSeverityCount = normalizedOutcomes.filter((outcome) => (
    !outcome.resolved
    && clean(outcome?.flag?.severity).toLowerCase() === "high"
  )).length;
  const noteMissingCount = normalizedOutcomes.filter((outcome) => outcome?.noteMissing).length;

  const adjustedAssessment = applyAcceptedAdjustments(state, normalizedOutcomes);
  const stageReasonCodes = normalizeReasonCodes([
    ...ensureArray(result?.reasonCodes),
    ...(noteMissingCount > 0 ? [REASON_CODES.DEFEND_NOTE_MISSING] : []),
  ]);

  return {
    stageStatus: "ok",
    reasonCodes: stageReasonCodes,
    statePatch: {
      ui: { phase: STAGE_ID },
      resolved: {
        assessment: adjustedAssessment,
        flagOutcomes: normalizedOutcomes,
        unresolvedHighSeverityCount,
        analystSummary: clean(result?.parsed?.analystSummary),
        responseSources: normalizeSources(normalizedOutcomes.flatMap((outcome) => ensureArray(outcome?.sources))),
      },
    },
    diagnostics: {
      outcomes: normalizedOutcomes.length,
      unresolvedHighSeverityCount,
      missingResponses: normalizedOutcomes.filter((outcome) => outcome?.responseMissing).length,
      noteMissingCount,
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
