const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_OPENAI_COMPAT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_PROVIDER_PREFERENCE = {
  analyst: ["openai", "anthropic", "gemini"],
  critic: ["anthropic", "openai", "gemini"],
  retrieval: ["gemini", "openai", "anthropic"],
};

function pickNonEmptyString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeProvider(value) {
  const raw = pickNonEmptyString(value).toLowerCase();
  if (!raw || raw === "openai") return "openai";
  if (raw === "anthropic") return "anthropic";
  if (raw === "gemini" || raw === "google") return "gemini";
  if (raw === "openai-compatible" || raw === "openai_compatible") return "openai_compatible";
  return "openai_compatible";
}

function rolePrefix(role) {
  return String(role || "").trim().toUpperCase();
}

function envValue(name) {
  return pickNonEmptyString(process.env[name]);
}

function providerPrefix(provider) {
  return String(provider || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function parseProviderList(value) {
  return String(value || "")
    .split(/[,;|]/g)
    .map((item) => normalizeProvider(item))
    .filter(Boolean);
}

function uniqueProviderOrder(list = []) {
  const out = [];
  list.forEach((provider) => {
    const normalized = normalizeProvider(provider);
    if (!normalized) return;
    if (!out.includes(normalized)) out.push(normalized);
  });
  return out;
}

function resolveProviderOrder(role, requestedProvider, liveSearch = false) {
  const roleKey = rolePrefix(role);
  const profile = liveSearch ? "retrieval" : (String(role || "").trim().toLowerCase() || "analyst");
  const envSpecific = parseProviderList(
    envValue(`RESEARCHIT_${roleKey}_PROVIDER_PREFERENCE`)
    || envValue(`RESEARCHIT_${roleKey}_PROVIDERS`)
  );
  const envGlobal = parseProviderList(
    envValue("RESEARCHIT_PROVIDER_PREFERENCE")
    || envValue("RESEARCHIT_PROVIDERS")
  );
  const requested = parseProviderList(requestedProvider);
  const defaults = DEFAULT_PROVIDER_PREFERENCE[profile] || DEFAULT_PROVIDER_PREFERENCE.analyst;
  return uniqueProviderOrder([...requested, ...envSpecific, ...envGlobal, ...defaults]);
}

function resolveApiKey(role, provider) {
  const roleKey = rolePrefix(role);
  const providerKey = providerPrefix(provider);
  const providerSpecific = (
    envValue(`RESEARCHIT_${roleKey}_${providerKey}_API_KEY`)
    || envValue(`RESEARCHIT_${providerKey}_API_KEY`)
    || envValue(`${providerKey}_API_KEY`)
    || envValue(`${providerKey}_${roleKey}_API_KEY`)
  );
  if (providerSpecific) return providerSpecific;
  if (provider === "openai") {
    return (
      envValue(`RESEARCHIT_${roleKey}_API_KEY`)
      || envValue("RESEARCHIT_API_KEY")
      || envValue(`OPENAI_${roleKey}_API_KEY`)
      || envValue("OPENAI_API_KEY")
    );
  }
  return (
    envValue(`RESEARCHIT_${roleKey}_API_KEY`)
    || envValue("RESEARCHIT_API_KEY")
  );
}

function resolveModel(role, provider, requestedModel, defaultModel) {
  const roleKey = rolePrefix(role);
  const providerKey = providerPrefix(provider);
  return (
    envValue(`RESEARCHIT_${roleKey}_${providerKey}_MODEL`)
    || envValue(`RESEARCHIT_${providerKey}_MODEL`)
    || envValue(`${providerKey}_${roleKey}_MODEL`)
    || envValue(`${providerKey}_MODEL`)
    || envValue(`RESEARCHIT_${roleKey}_MODEL`)
    || envValue("RESEARCHIT_MODEL")
    || envValue(`OPENAI_${roleKey}_MODEL`)
    || envValue("OPENAI_MODEL")
    || pickNonEmptyString(requestedModel)
    || defaultModel
  );
}

function resolveWebSearchModel(role, provider, requestedWebSearchModel, resolvedModel) {
  const roleKey = rolePrefix(role);
  const providerKey = providerPrefix(provider);
  return (
    envValue(`RESEARCHIT_${roleKey}_${providerKey}_WEBSEARCH_MODEL`)
    || envValue(`RESEARCHIT_${providerKey}_WEBSEARCH_MODEL`)
    || envValue(`${providerKey}_${roleKey}_WEBSEARCH_MODEL`)
    || envValue(`${providerKey}_WEBSEARCH_MODEL`)
    || envValue(`RESEARCHIT_${roleKey}_WEBSEARCH_MODEL`)
    || envValue(`OPENAI_${roleKey}_WEBSEARCH_MODEL`)
    || envValue("RESEARCHIT_WEBSEARCH_MODEL")
    || envValue("OPENAI_WEBSEARCH_MODEL")
    || pickNonEmptyString(requestedWebSearchModel)
    || resolvedModel
  );
}

function resolveProviderDefaultBaseUrl(provider) {
  if (provider === "openai") return OPENAI_BASE_URL;
  if (provider === "anthropic") return ANTHROPIC_BASE_URL;
  if (provider === "gemini") return GEMINI_OPENAI_COMPAT_BASE_URL;
  return "";
}

function resolveBaseUrl(role, provider, requestedBaseUrl) {
  const roleKey = rolePrefix(role);
  const providerKey = providerPrefix(provider);
  return (
    envValue(`RESEARCHIT_${roleKey}_${providerKey}_BASE_URL`)
    || envValue(`RESEARCHIT_${providerKey}_BASE_URL`)
    || envValue(`${providerKey}_${roleKey}_BASE_URL`)
    || envValue(`${providerKey}_BASE_URL`)
    || envValue(`RESEARCHIT_${roleKey}_BASE_URL`)
    || envValue("RESEARCHIT_BASE_URL")
    || envValue(`OPENAI_${roleKey}_BASE_URL`)
    || envValue("OPENAI_BASE_URL")
    || pickNonEmptyString(requestedBaseUrl)
    || resolveProviderDefaultBaseUrl(provider)
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

export function resolveRoleProviderCandidates({
  role,
  requestedProvider,
  requestedModel,
  requestedWebSearchModel,
  requestedBaseUrl,
  defaultModel,
  liveSearch = false,
}) {
  const providerOrder = resolveProviderOrder(role, requestedProvider, liveSearch);
  const candidates = providerOrder
    .map((providerId) => {
      const provider = normalizeProvider(providerId);
      const apiKey = resolveApiKey(role, provider);
      const model = resolveModel(role, provider, requestedModel, defaultModel);
      if (!apiKey || !model) return null;
      const baseUrl = resolveBaseUrl(role, provider, requestedBaseUrl);
      return {
        providerId: provider,
        provider,
        model,
        webSearchModel: resolveWebSearchModel(role, provider, requestedWebSearchModel, model),
        baseUrl,
        apiKey,
      };
    })
    .filter(Boolean);
  return candidates;
}

export function resolveRoleProviderConfig({
  role,
  requestedProvider,
  requestedModel,
  requestedWebSearchModel,
  requestedBaseUrl,
  defaultModel,
}) {
  const candidates = resolveRoleProviderCandidates({
    role,
    requestedProvider: resolveProvider(role, requestedProvider),
    requestedModel,
    requestedWebSearchModel,
    requestedBaseUrl,
    defaultModel,
    liveSearch: false,
  });
  if (candidates.length) return candidates[0];
  const fallbackProvider = resolveProvider(role, requestedProvider);
  const model = resolveModel(role, fallbackProvider, requestedModel, defaultModel);
  return {
    providerId: fallbackProvider,
    provider: fallbackProvider,
    model,
    webSearchModel: resolveWebSearchModel(role, fallbackProvider, requestedWebSearchModel, model),
    baseUrl: resolveBaseUrl(role, fallbackProvider, requestedBaseUrl),
    apiKey: resolveApiKey(role, fallbackProvider),
  };
}

export function missingApiKeyError(role) {
  const roleKey = rolePrefix(role);
  return `No provider API key configured for ${role}. Set OPENAI_API_KEY (default), or provider-specific keys such as RESEARCHIT_${roleKey}_OPENAI_API_KEY / RESEARCHIT_${roleKey}_ANTHROPIC_API_KEY / RESEARCHIT_${roleKey}_GEMINI_API_KEY.`;
}
