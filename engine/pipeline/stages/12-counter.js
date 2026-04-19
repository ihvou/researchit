import { callActorJson, clean, ensureArray, normalizeSources } from "./common.js";

export const STAGE_ID = "stage_12_counter_case";
export const STAGE_TITLE = "Counter Case";

function normalizeCounterPack(parsed = {}) {
  const entries = ensureArray(parsed?.counterEvidence).map((entry) => ({
    flagId: clean(entry?.flagId),
    unitKey: clean(entry?.unitKey),
    note: clean(entry?.note),
    sources: normalizeSources(entry?.sources || []),
    severityIfWrong: clean(entry?.severityIfWrong).toLowerCase() || "medium",
  })).filter((entry) => entry.unitKey || entry.flagId);

  const byUnit = {};
  entries.forEach((entry) => {
    if (!byUnit[entry.unitKey]) byUnit[entry.unitKey] = [];
    byUnit[entry.unitKey].push(entry);
  });

  return {
    entries,
    byUnit,
    summary: clean(parsed?.summary),
  };
}

function toRedTeam(counter = {}) {
  const cells = {};
  ensureArray(counter?.entries).forEach((entry) => {
    const key = clean(entry?.unitKey);
    if (!key) return;
    if (!cells[key]) {
      cells[key] = {
        threat: clean(entry?.note),
        missedRisk: clean(entry?.note),
        severityIfWrong: clean(entry?.severityIfWrong) || "medium",
      };
    }
  });

  return {
    redTeamVerdict: clean(counter?.summary),
    cells,
  };
}

function buildClaimContext(state = {}, flags = []) {
  const unitKeys = [...new Set(ensureArray(flags).map((flag) => clean(flag?.unitKey)).filter(Boolean))];
  if (clean(state?.outputType).toLowerCase() === "matrix") {
    const byKey = new Map(ensureArray(state?.assessment?.matrix?.cells).map((cell) => [
      `${clean(cell?.subjectId)}::${clean(cell?.attributeId)}`,
      cell,
    ]));
    return unitKeys.map((unitKey) => {
      const cell = byKey.get(unitKey) || {};
      return {
        unitKey,
        value: clean(cell?.value),
        full: clean(cell?.full).slice(0, 1200),
        confidence: clean(cell?.confidence),
        confidenceReason: clean(cell?.confidenceReason),
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
      };
    });
  }

  const byId = state?.assessment?.scorecard?.byId && typeof state.assessment.scorecard.byId === "object"
    ? state.assessment.scorecard.byId
    : {};
  return unitKeys.map((unitKey) => {
    const unit = byId[unitKey] || {};
    return {
      unitKey,
      score: Number.isFinite(Number(unit?.score)) ? Number(unit.score) : null,
      brief: clean(unit?.brief),
      full: clean(unit?.full).slice(0, 1200),
      confidence: clean(unit?.confidence),
      confidenceReason: clean(unit?.confidenceReason),
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
      missingEvidence: clean(unit?.missingEvidence),
    };
  });
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const flags = ensureArray(state?.critique?.flags);
  if (!flags.length) {
    return {
      stageStatus: "ok",
      reasonCodes: [],
      statePatch: {
        ui: { phase: STAGE_ID },
        critique: {
          ...(state?.critique || {}),
          counterCase: { entries: [], byUnit: {}, summary: "No critic flags raised." },
        },
      },
      diagnostics: { skipped: true, reason: "no_flags" },
    };
  }
  const claims = buildClaimContext(state, flags);

  const prompt = `For each critic flag, find disconfirming evidence and hidden risks.
Return JSON:
{
  "counterEvidence": [{
    "flagId": "",
    "unitKey": "",
    "note": "",
    "severityIfWrong": "high|medium|low",
    "sources": []
  }],
  "summary": ""
}
Flags:
${JSON.stringify(flags).slice(0, 14000)}
Original assessed claims:
${JSON.stringify(claims).slice(0, 18000)}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "critic",
    systemPrompt: runtime?.prompts?.critic || "You provide counter-case evidence.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 8000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 90000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 1,
    liveSearch: true,
    schemaHint: '{"counterEvidence":[{"flagId":"","unitKey":"","note":"","severityIfWrong":"medium","sources":[]}],"summary":""}',
  });

  const counter = normalizeCounterPack(result?.parsed);

  return {
    stageStatus: "ok",
    reasonCodes: result.reasonCodes,
    statePatch: {
      ui: { phase: STAGE_ID },
      critique: {
        ...(state?.critique || {}),
        counterCase: counter,
      },
      redTeam: toRedTeam(counter),
    },
    diagnostics: {
      counterEntries: counter.entries.length,
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
