const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_OPENAI_COMPAT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_PROVIDER_PREFERENCE = {
  analyst: ["openai", "anthropic", "gemini"],
  critic: ["anthropic", "openai", "gemini"],
  synthesizer: ["anthropic", "openai", "gemini"],
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

function detectModelFamily(model) {
  const raw = pickNonEmptyString(model).toLowerCase();
  if (!raw) return "";
  if (raw.includes("claude")) return "anthropic";
  if (raw.includes("gemini") || raw.startsWith("models/")) return "gemini";
  if (raw.includes("gpt") || /^o[1-9]/.test(raw) || raw.includes("chatgpt")) return "openai";
  return "";
}

function isModelCompatibleWithProvider(provider, model) {
  const family = detectModelFamily(model);
  if (!family) return true;
  const normalized = normalizeProvider(provider);
  if (normalized === "openai_compatible") return true;
  return family === normalized;
}

function providerDefaultModel(role, provider, fallbackModel = "") {
  const roleKey = String(role || "").trim().toLowerCase();
  if (provider === "anthropic") {
    if (roleKey === "retrieval") return "claude-sonnet-4-20250514";
    return "claude-sonnet-4-20250514";
  }
  if (provider === "gemini") {
    if (roleKey === "retrieval") return "gemini-2.5-flash";
    return "gemini-2.5-pro";
  }
  return pickNonEmptyString(fallbackModel) || "gpt-5.4-mini";
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
  const ordered = uniqueProviderOrder([...requested, ...envSpecific, ...envGlobal, ...defaults]);
  return ordered.length ? [ordered[0]] : [];
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

function resolveProviderSpecificModel(role, provider, defaultModel) {
  const roleKey = rolePrefix(role);
  const providerKey = providerPrefix(provider);
  return (
    envValue(`RESEARCHIT_${roleKey}_${providerKey}_MODEL`)
    || envValue(`RESEARCHIT_${providerKey}_MODEL`)
    || envValue(`${providerKey}_${roleKey}_MODEL`)
    || envValue(`${providerKey}_MODEL`)
    || providerDefaultModel(role, provider, defaultModel)
  );
}

function resolveProviderSpecificWebSearchModel(role, provider, resolvedModel) {
  const roleKey = rolePrefix(role);
  const providerKey = providerPrefix(provider);
  return (
    envValue(`RESEARCHIT_${roleKey}_${providerKey}_WEBSEARCH_MODEL`)
    || envValue(`RESEARCHIT_${providerKey}_WEBSEARCH_MODEL`)
    || envValue(`${providerKey}_${roleKey}_WEBSEARCH_MODEL`)
    || envValue(`${providerKey}_WEBSEARCH_MODEL`)
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
  const requestedProviders = parseProviderList(requestedProvider);
  const primaryRequestedProvider = requestedProviders[0] || "";
  const candidates = providerOrder
    .map((providerId) => {
      const provider = normalizeProvider(providerId);
      const apiKey = resolveApiKey(role, provider);
      const allowRequestedOverrides = !primaryRequestedProvider || primaryRequestedProvider === provider;
      let model = resolveModel(
        role,
        provider,
        allowRequestedOverrides ? requestedModel : "",
        defaultModel
      );
      if (!isModelCompatibleWithProvider(provider, model)) {
        model = resolveProviderSpecificModel(role, provider, defaultModel);
      }
      if (!apiKey || !model) return null;
      const baseUrl = resolveBaseUrl(
        role,
        provider,
        allowRequestedOverrides ? requestedBaseUrl : ""
      );
      let webSearchModel = resolveWebSearchModel(
        role,
        provider,
        allowRequestedOverrides ? requestedWebSearchModel : "",
        model
      );
      if (!isModelCompatibleWithProvider(provider, webSearchModel)) {
        webSearchModel = resolveProviderSpecificWebSearchModel(role, provider, model);
      }
      return {
        providerId: provider,
        provider,
        model,
        webSearchModel,
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
  const pinnedProvider = resolveProvider(role, requestedProvider);
  const model = resolveModel(role, pinnedProvider, requestedModel, defaultModel);
  return {
    providerId: pinnedProvider,
    provider: pinnedProvider,
    model,
    webSearchModel: resolveWebSearchModel(role, pinnedProvider, requestedWebSearchModel, model),
    baseUrl: resolveBaseUrl(role, pinnedProvider, requestedBaseUrl),
    apiKey: resolveApiKey(role, pinnedProvider),
  };
}

export function missingApiKeyError(role) {
  const roleKey = rolePrefix(role);
  return `No provider API key configured for ${role}. Set OPENAI_API_KEY (default), or provider-specific keys such as RESEARCHIT_${roleKey}_OPENAI_API_KEY / RESEARCHIT_${roleKey}_ANTHROPIC_API_KEY / RESEARCHIT_${roleKey}_GEMINI_API_KEY.`;
}
