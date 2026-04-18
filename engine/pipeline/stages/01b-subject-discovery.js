import { callActorJson, clean, uniqBy } from "./common.js";

export const STAGE_ID = "stage_01b_subject_discovery";
export const STAGE_TITLE = "Subject Discovery";

function normalizeSubjects(raw = []) {
  const list = Array.isArray(raw) ? raw : [];
  return uniqBy(
    list
      .map((item, idx) => {
        const label = clean(item?.label || item?.name || item);
        if (!label) return null;
        const id = clean(item?.id) || label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `subject-${idx + 1}`;
        const aliases = Array.isArray(item?.aliases)
          ? [...new Set(item.aliases.map((alias) => clean(alias)).filter(Boolean))]
          : [];
        return { id, label, aliases };
      })
      .filter(Boolean),
    (subject) => clean(subject.label).toLowerCase()
  );
}

export async function runStage(context = {}) {
  const { state, runtime } = context;
  if (state?.outputType !== "matrix") {
    return {
      stageStatus: "ok",
      reasonCodes: [],
      statePatch: { ui: { phase: STAGE_ID } },
      diagnostics: { skipped: true, reason: "scorecard_mode" },
    };
  }

  const existing = Array.isArray(state?.request?.matrix?.subjects) ? state.request.matrix.subjects : [];
  const shouldDiscover = state?.discovery?.autoDiscoverSubjects || !existing.length;
  if (!shouldDiscover) {
    return {
      stageStatus: "ok",
      reasonCodes: [],
      statePatch: {
        ui: { phase: STAGE_ID },
        discovery: {
          ...(state?.discovery || {}),
          autoDiscoverSubjects: false,
          usedSubjectDiscovery: false,
        },
      },
      diagnostics: { skipped: true, reason: "subjects_provided", subjectCount: existing.length },
    };
  }

  const attrs = Array.isArray(state?.request?.matrix?.attributes) ? state.request.matrix.attributes : [];
  const prompt = `Decision objective:\n${clean(state?.request?.objective)}\n\nSuggest 4 to 8 concrete comparison subjects for this matrix.
Return JSON:
{
  "subjects": [{"label":"", "aliases":[""]}],
  "notes": ""
}
Rules:
- Use specific real entities when possible.
- No duplicates or near-duplicates.
- Keep aliases short.`;

  const result = await callActorJson({
    state,
    runtime,
    stageId: STAGE_ID,
    actor: "analyst",
    systemPrompt: runtime?.prompts?.analyst || "You suggest matrix subjects.",
    userPrompt: prompt,
    tokenBudget: runtime?.budgets?.[STAGE_ID]?.tokenBudget || 4000,
    timeoutMs: runtime?.budgets?.[STAGE_ID]?.timeoutMs || 60000,
    maxRetries: runtime?.budgets?.[STAGE_ID]?.retryMax || 1,
    liveSearch: true,
    schemaHint: '{"subjects":[{"label":"", "aliases":[""]}],"notes":""}',
  });

  const discovered = normalizeSubjects(result?.parsed?.subjects || []);
  const merged = normalizeSubjects([...existing, ...discovered]);
  const suggestedAttributes = attrs
    .filter((attr) => attr?.derived)
    .map((attr) => ({ id: attr.id, label: attr.label }));

  return {
    stageStatus: "ok",
    reasonCodes: result.reasonCodes,
    statePatch: {
      ui: { phase: STAGE_ID },
      request: {
        matrix: {
          subjects: merged,
        },
      },
      discovery: {
        ...(state?.discovery || {}),
        usedSubjectDiscovery: true,
        suggestedSubjects: discovered,
        suggestedAttributes,
        notes: clean(result?.parsed?.notes),
      },
    },
    diagnostics: {
      discoveredCount: discovered.length,
      mergedCount: merged.length,
      retries: result.retries,
      modelRoute: result.route,
      tokenDiagnostics: result.tokenDiagnostics,
    },
    io: {
      prompt: prompt,
      response: result.text,
    },
    modelRoute: result.route,
    tokens: result.tokenDiagnostics,
    retries: result.retries,
  };
}
