import { callActorJson, clean, ensureArray, normalizeSources } from "./common.js";

export const STAGE_ID = "stage_13_defend";
export const STAGE_TITLE = "Concede Defend";

function normalizeOutcome(raw = {}, fallback = {}) {
  const flag = fallback?.flag || {};
  const resolved = raw?.resolved === true;
  const outcome = {
    flagId: clean(raw?.flagId || fallback?.flagId || flag?.id),
    flag: {
      ...flag,
      severity: clean(flag?.severity || "medium"),
      category: clean(flag?.category || "other"),
    },
    resolved,
    disposition: clean(raw?.disposition || (resolved ? "accepted" : "rejected_with_evidence")) || "rejected_with_evidence",
    analystNote: clean(raw?.analystNote || fallback?.flag?.note || "No analyst note provided."),
    mitigationNote: clean(raw?.mitigationNote || "") || undefined,
    sources: normalizeSources(raw?.sources || []),
  };
  return outcome;
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

  const prompt = `Resolve every critic flag using counter-case evidence.
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
Flags:
${JSON.stringify(flags).slice(0, 14000)}
Counter evidence:
${JSON.stringify(counterEntries).slice(0, 12000)}`;

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
    normalizedOutcomes.push(normalizeOutcome({}, { flagId: key, flag }));
  });

  const unresolvedHighSeverityCount = normalizedOutcomes.filter((outcome) => (
    !outcome.resolved
    && clean(outcome?.flag?.severity).toLowerCase() === "high"
  )).length;

  const adjustedAssessment = applyAcceptedAdjustments(state, normalizedOutcomes);

  return {
    stageStatus: "ok",
    reasonCodes: result.reasonCodes,
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
