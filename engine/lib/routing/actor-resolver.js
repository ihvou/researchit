function clean(value) {
  return String(value || "").trim();
}

function detectFamily(model = "") {
  const value = clean(model).toLowerCase();
  if (!value) return "";
  if (value.includes("gpt") || value.includes("o1") || value.includes("o3") || value.includes("o4")) return "openai";
  if (value.includes("claude")) return "anthropic";
  if (value.includes("gemini") || value.startsWith("models/")) return "gemini";
  return "";
}

function normalizeProvider(value) {
  const provider = clean(value).toLowerCase();
  if (provider === "chatgpt") return "openai";
  return provider;
}

export function resolveActorRoute({ actor = "", stageId = "", config = {}, mode = "native", override = {} } = {}) {
  const models = config?.models && typeof config.models === "object" ? config.models : {};
  const actorKey = clean(actor).toLowerCase();

  const analystDefault = models?.analyst || {};
  const retrievalDefault = models?.retrieval || {};
  const criticDefault = models?.critic || {};
  const retrievalStages = new Set([
    "stage_01b_subject_discovery",
    "stage_03b_evidence_web",
    "stage_08_recover",
    "stage_14_synthesize",
  ]);

  let base;
  if (actorKey === "critic") {
    base = criticDefault;
  } else {
    base = retrievalStages.has(clean(stageId)) ? retrievalDefault : analystDefault;
  }

  const provider = normalizeProvider(override?.provider || base?.provider || "openai");
  const model = clean(override?.model || base?.model || "gpt-5.4-mini");
  const webSearchModel = clean(override?.webSearchModel || base?.webSearchModel || model);
  const family = normalizeProvider(detectFamily(model) || provider);

  return {
    actor: actorKey,
    stageId: clean(stageId),
    provider,
    model,
    webSearchModel,
    family,
    mode: clean(mode).toLowerCase() === "deep-assist" ? "deep-assist" : "native",
  };
}
