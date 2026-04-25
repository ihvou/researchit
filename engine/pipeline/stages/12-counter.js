import { clean, ensureArray, normalizeSources } from "./common.js";
import {
  CRITIC_COMPACT_RETRY_REASON,
  callCriticJsonWithFallback,
  serializeBoundedJsonArray,
} from "./critic-utils.js";

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

function buildClaimContext(state = {}, flags = [], options = {}) {
  const maxSources = Math.max(1, Number(options?.maxSourcesPerUnit || 8));
  const maxClaims = Math.max(1, Number(options?.maxClaimsPerSide || 8));
  const fullChars = Math.max(200, Number(options?.fullChars || 1200));
  const quoteChars = Math.max(80, Number(options?.quoteChars || 180));
  const detailChars = Math.max(120, Number(options?.claimDetailChars || 220));
  const compactSources = (sources = []) => normalizeSources(sources || [])
    .slice(0, maxSources)
    .map((source) => ({
      name: clean(source?.name),
      url: clean(source?.url),
      quote: clean(source?.quote).slice(0, quoteChars),
      sourceType: clean(source?.sourceType),
    }))
    .filter((source) => source.name || source.url || source.quote);
  const compactClaims = (items = []) => ensureArray(items).slice(0, maxClaims).map((item) => ({
    claim: clean(item?.claim),
    detail: clean(item?.detail).slice(0, detailChars),
  })).filter((item) => item.claim || item.detail);
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
        full: clean(cell?.full).slice(0, fullChars),
        confidence: clean(cell?.confidence),
        confidenceReason: clean(cell?.confidenceReason),
        sources: compactSources(cell?.sources),
        arguments: {
          supporting: compactClaims(cell?.arguments?.supporting),
          limiting: compactClaims(cell?.arguments?.limiting),
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
      full: clean(unit?.full).slice(0, fullChars),
      confidence: clean(unit?.confidence),
      confidenceReason: clean(unit?.confidenceReason),
      sources: compactSources(unit?.sources),
      arguments: {
        supporting: compactClaims(unit?.arguments?.supporting),
        limiting: compactClaims(unit?.arguments?.limiting),
      },
      risks: clean(unit?.risks),
      missingEvidence: clean(unit?.missingEvidence),
    };
  });
}

function buildPrompt({
  flags = [],
  claims = [],
  flagsMaxChars = 10000,
  claimsMaxChars = 16000,
} = {}) {
  const flagsSnapshot = serializeBoundedJsonArray(flags, flagsMaxChars);
  const claimsSnapshot = serializeBoundedJsonArray(claims, claimsMaxChars);
  return {
    prompt: `For each critic flag, find disconfirming evidence and hidden risks.
Use web search to find strongest disconfirming evidence when factual uncertainty exists.
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
${flagsSnapshot.json}
Original assessed claims:
${claimsSnapshot.json}`,
    diagnostics: {
      flags: flagsSnapshot.diagnostics,
      claims: claimsSnapshot.diagnostics,
    },
  };
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
  const primary = buildPrompt({
    flags,
    claims,
    flagsMaxChars: 9000,
    claimsMaxChars: 16000,
  });
  const compactClaims = buildClaimContext(state, flags, {
    maxSourcesPerUnit: 4,
    maxClaimsPerSide: 4,
    fullChars: 600,
    quoteChars: 120,
    claimDetailChars: 160,
  });
  const compact = buildPrompt({
    flags,
    claims: compactClaims,
    flagsMaxChars: 6000,
    claimsMaxChars: 9000,
  });

  const criticCall = await callCriticJsonWithFallback({
    state,
    runtime,
    stageId: STAGE_ID,
    systemPrompt: runtime?.prompts?.critic || "You provide counter-case evidence.",
    primaryPrompt: primary.prompt,
    compactPrompt: compact.prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 8000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 240000,
    liveSearch: true,
    searchMaxUses: 3,
    schemaHint: '{"counterEvidence":[{"flagId":"","unitKey":"","note":"","severityIfWrong":"medium","sources":[]}],"summary":""}',
  });
  const result = criticCall.result;
  const usedCompactRetry = criticCall.usedCompactRetry;
  const prompt = usedCompactRetry ? compact.prompt : primary.prompt;

  const counter = normalizeCounterPack(result?.parsed);
  const reasonCodes = [
    ...ensureArray(result.reasonCodes),
    ...(usedCompactRetry ? [CRITIC_COMPACT_RETRY_REASON] : []),
  ];

  return {
    stageStatus: "ok",
    reasonCodes: [...new Set(reasonCodes)],
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
      compactRetryUsed: usedCompactRetry,
      criticRetryAttempts: criticCall.attempts,
      promptSnapshot: usedCompactRetry ? compact.diagnostics : primary.diagnostics,
      primaryPromptSnapshot: primary.diagnostics,
      compactPromptSnapshot: compact.diagnostics,
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
