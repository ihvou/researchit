const OPENAI_BASE_URL = "https://api.openai.com";

function pickNonEmptyString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeProvider(value) {
  const raw = pickNonEmptyString(value).toLowerCase();
  if (!raw || raw === "openai") return "openai";
  if (raw === "openai-compatible" || raw === "openai_compatible") return "openai_compatible";
  return "openai_compatible";
}

function rolePrefix(role) {
  return String(role || "").trim().toUpperCase();
}

function envValue(name) {
  return pickNonEmptyString(process.env[name]);
}

function resolveApiKey(role) {
  const roleKey = rolePrefix(role);
  return (
    envValue(`RESEARCHIT_${roleKey}_API_KEY`)
    || envValue("RESEARCHIT_API_KEY")
    || envValue(`OPENAI_${roleKey}_API_KEY`)
    || envValue("OPENAI_API_KEY")
  );
}

function resolveModel(role, requestedModel, defaultModel) {
  const roleKey = rolePrefix(role);
  return (
    envValue(`RESEARCHIT_${roleKey}_MODEL`)
    || envValue("RESEARCHIT_MODEL")
    || envValue(`OPENAI_${roleKey}_MODEL`)
    || envValue("OPENAI_MODEL")
    || pickNonEmptyString(requestedModel)
    || defaultModel
  );
}

function resolveWebSearchModel(role, requestedWebSearchModel, resolvedModel) {
  const roleKey = rolePrefix(role);
  return (
    envValue(`RESEARCHIT_${roleKey}_WEBSEARCH_MODEL`)
    || envValue(`OPENAI_${roleKey}_WEBSEARCH_MODEL`)
    || envValue("RESEARCHIT_WEBSEARCH_MODEL")
    || envValue("OPENAI_WEBSEARCH_MODEL")
    || pickNonEmptyString(requestedWebSearchModel)
    || resolvedModel
  );
}

function resolveBaseUrl(role, requestedBaseUrl) {
  const roleKey = rolePrefix(role);
  return (
    envValue(`RESEARCHIT_${roleKey}_BASE_URL`)
    || envValue("RESEARCHIT_BASE_URL")
    || envValue(`OPENAI_${roleKey}_BASE_URL`)
    || envValue("OPENAI_BASE_URL")
    || pickNonEmptyString(requestedBaseUrl)
    || OPENAI_BASE_URL
  );
}

function resolveProvider(role, requestedProvider) {
  const roleKey = rolePrefix(role);
  return normalizeProvider(
    envValue(`RESEARCHIT_${roleKey}_PROVIDER`)
    || envValue("RESEARCHIT_PROVIDER")
    || pickNonEmptyString(requestedProvider)
  );
}

export function resolveRoleProviderConfig({
  role,
  requestedProvider,
  requestedModel,
  requestedWebSearchModel,
  requestedBaseUrl,
  defaultModel,
}) {
  const model = resolveModel(role, requestedModel, defaultModel);

  return {
    provider: resolveProvider(role, requestedProvider),
    model,
    webSearchModel: resolveWebSearchModel(role, requestedWebSearchModel, model),
    baseUrl: resolveBaseUrl(role, requestedBaseUrl),
    apiKey: resolveApiKey(role),
  };
}

export function missingApiKeyError(role) {
  const roleKey = rolePrefix(role);
  return `No provider API key configured. Set OPENAI_API_KEY (default) or RESEARCHIT_API_KEY / RESEARCHIT_${roleKey}_API_KEY.`;
}

