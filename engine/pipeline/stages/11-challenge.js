import { callActorJson, clean, ensureArray, normalizeSources } from "./common.js";

export const STAGE_ID = "stage_11_challenge";
export const STAGE_TITLE = "Challenge";

function normalizeSeverity(value) {
  const level = clean(value).toLowerCase();
  if (level === "high" || level === "medium" || level === "low") return level;
  return "medium";
}

function normalizeCategory(value) {
  const category = clean(value).toLowerCase();
  const allowed = new Set(["overclaim", "missing_evidence", "contradiction", "stale_source", "missed_risk", "other"]);
  return allowed.has(category) ? category : "other";
}

function normalizeFlags(parsed = {}, state = {}) {
  const raw = ensureArray(parsed?.flags);
  const flags = raw.map((flag, idx) => ({
    id: clean(flag?.id) || `flag-${idx + 1}`,
    unitKey: clean(flag?.unitKey),
    flagged: flag?.flagged !== false,
    severity: normalizeSeverity(flag?.severity),
    category: normalizeCategory(flag?.category),
    note: clean(flag?.note),
    suggestedScore: Number.isFinite(Number(flag?.suggestedScore)) ? Number(flag.suggestedScore) : undefined,
    suggestedValue: clean(flag?.suggestedValue) || undefined,
    suggestedConfidence: clean(flag?.suggestedConfidence) ? clean(flag.suggestedConfidence).toLowerCase() : undefined,
    sources: normalizeSources(flag?.sources || []),
  })).filter((flag) => flag.unitKey && flag.note);

  const byUnit = {};
  flags.forEach((flag) => {
    if (!byUnit[flag.unitKey]) byUnit[flag.unitKey] = { flags: [] };
    byUnit[flag.unitKey].flags.push(flag);
  });

  return {
    flags,
    flagsByUnit: byUnit,
  };
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  const coherence = ensureArray(state?.critique?.coherenceFindings);

  const prompt = `Challenge overclaims and confidence calibration. Use coherence findings and current assessment.
Return JSON:
{
  "flags": [{
    "id":"",
    "unitKey":"",
    "flagged": true,
    "severity":"high|medium|low",
    "category":"overclaim|missing_evidence|contradiction|stale_source|missed_risk|other",
    "note":"",
    "suggestedScore": 1,
    "suggestedValue": "",
    "suggestedConfidence": "high|medium|low",
    "sources": []
  }]
}
Coherence findings:
${JSON.stringify(coherence).slice(0, 12000)}`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "critic",
    systemPrompt: runtime?.prompts?.critic || "You challenge overclaims.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 8000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 75000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 1,
    liveSearch: false,
    schemaHint: '{"flags":[{"id":"","unitKey":"","severity":"medium","category":"other","note":""}]}' ,
  });

  const normalized = normalizeFlags(result?.parsed, state);

  return {
    stageStatus: "ok",
    reasonCodes: result.reasonCodes,
    statePatch: {
      ui: { phase: STAGE_ID },
      critique: {
        ...(state?.critique || {}),
        flags: normalized.flags,
        flagsByUnit: normalized.flagsByUnit,
      },
    },
    diagnostics: {
      flags: normalized.flags.length,
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
