function clean(value) {
  return String(value || "").trim();
}

function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const PROVIDER_DEFAULT_PRICING_USD_PER_1M = {
  openai: { input: 2.0, output: 8.0 },
  anthropic: { input: 3.0, output: 15.0 },
  gemini: { input: 1.0, output: 4.0 },
  default: { input: 2.0, output: 8.0 },
};

const MODEL_PRICING_USD_PER_1M = [
  {
    provider: "openai",
    pattern: /o3-deep-research/i,
    input: 10.0,
    output: 40.0,
    key: "openai:o3-deep-research",
  },
  {
    provider: "openai",
    pattern: /o4-mini-deep-research/i,
    input: 2.0,
    output: 8.0,
    key: "openai:o4-mini-deep-research",
  },
  {
    provider: "openai",
    pattern: /gpt-5(?:\.4)?-mini/i,
    input: 0.8,
    output: 3.2,
    key: "openai:gpt-5.4-mini",
  },
  {
    provider: "openai",
    pattern: /gpt-5(?:\.4)?/i,
    input: 3.0,
    output: 12.0,
    key: "openai:gpt-5.4",
  },
  {
    provider: "anthropic",
    pattern: /claude-sonnet-4/i,
    input: 3.0,
    output: 15.0,
    key: "anthropic:claude-sonnet-4",
  },
  {
    provider: "gemini",
    pattern: /gemini-2\.5-pro/i,
    input: 1.25,
    output: 5.0,
    key: "gemini:gemini-2.5-pro",
  },
  {
    provider: "gemini",
    pattern: /gemini-2\.5-flash/i,
    input: 0.35,
    output: 1.5,
    key: "gemini:gemini-2.5-flash",
  },
];

function normalizePricingValue(value) {
  if (!value || typeof value !== "object") return null;
  const input = toFinite(value.inputPer1M ?? value.input ?? value.prompt, NaN);
  const output = toFinite(value.outputPer1M ?? value.output ?? value.completion, NaN);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return {
    input,
    output,
  };
}

function configOverrides(config = {}) {
  const pricing = config?.cost?.pricing;
  if (!pricing || typeof pricing !== "object") {
    return {
      byModel: {},
      byProvider: {},
      defaultPricing: null,
    };
  }

  const byModelRaw = pricing.models && typeof pricing.models === "object" ? pricing.models : {};
  const byProviderRaw = pricing.providers && typeof pricing.providers === "object" ? pricing.providers : {};
  const byModel = {};
  const byProvider = {};

  Object.entries(byModelRaw).forEach(([model, value]) => {
    const normalized = normalizePricingValue(value);
    if (!normalized) return;
    byModel[clean(model).toLowerCase()] = normalized;
  });

  Object.entries(byProviderRaw).forEach(([provider, value]) => {
    const normalized = normalizePricingValue(value);
    if (!normalized) return;
    byProvider[clean(provider).toLowerCase()] = normalized;
  });

  return {
    byModel,
    byProvider,
    defaultPricing: normalizePricingValue(pricing.default || pricing.fallback || null),
  };
}

function resolveRates({ provider = "", model = "", config = {} } = {}) {
  const normalizedProvider = clean(provider).toLowerCase();
  const normalizedModel = clean(model).toLowerCase();
  const overrides = configOverrides(config);

  if (normalizedModel && overrides.byModel[normalizedModel]) {
    return {
      ...overrides.byModel[normalizedModel],
      source: "config_model",
      key: normalizedModel,
    };
  }

  if (normalizedProvider && overrides.byProvider[normalizedProvider]) {
    return {
      ...overrides.byProvider[normalizedProvider],
      source: "config_provider",
      key: normalizedProvider,
    };
  }

  if (normalizedModel) {
    const matched = MODEL_PRICING_USD_PER_1M.find((entry) => (
      (!entry.provider || entry.provider === normalizedProvider)
      && entry.pattern.test(normalizedModel)
    ));
    if (matched) {
      return {
        input: matched.input,
        output: matched.output,
        source: "model_catalog",
        key: matched.key,
      };
    }
  }

  if (normalizedProvider && PROVIDER_DEFAULT_PRICING_USD_PER_1M[normalizedProvider]) {
    return {
      ...PROVIDER_DEFAULT_PRICING_USD_PER_1M[normalizedProvider],
      source: "provider_default",
      key: normalizedProvider,
    };
  }

  if (overrides.defaultPricing) {
    return {
      ...overrides.defaultPricing,
      source: "config_default",
      key: "config_default",
    };
  }

  return {
    ...PROVIDER_DEFAULT_PRICING_USD_PER_1M.default,
    source: "fallback_default",
    key: "default",
  };
}

function normalizeTokenInput(tokens = {}) {
  const inputTokens = toFinite(tokens?.inputTokens, 0);
  const outputTokens = toFinite(tokens?.outputTokens, 0);
  const totalTokens = toFinite(tokens?.totalTokens, inputTokens + outputTokens) || (inputTokens + outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function estimateCostUsd({ inputTokens = 0, outputTokens = 0, rates = null } = {}) {
  if (!rates) return 0;
  return (
    (toFinite(inputTokens, 0) / 1_000_000) * toFinite(rates.input, 0)
    + (toFinite(outputTokens, 0) / 1_000_000) * toFinite(rates.output, 0)
  );
}

function normalizeBreakdownEntry(entry = {}, modelRoute = {}, config = {}) {
  const provider = clean(entry?.provider || modelRoute?.provider).toLowerCase();
  const model = clean(entry?.model || modelRoute?.model);
  const tokens = normalizeTokenInput(entry);
  const rates = resolveRates({ provider, model, config });
  const estimatedCostUsd = estimateCostUsd({
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    rates,
  });

  return {
    provider: provider || "unknown",
    model: model || "unknown",
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
    inputRatePer1MUsd: rates.input,
    outputRatePer1MUsd: rates.output,
    estimatedCostUsd,
    pricingSource: rates.source,
  };
}

export function estimateStageCost({ tokens = null, modelRoute = null, config = {} } = {}) {
  if (!tokens || typeof tokens !== "object") return null;

  const breakdown = Array.isArray(tokens?.breakdown) ? tokens.breakdown.filter(Boolean) : [];
  const tokenSource = clean(tokens?.tokenSource).toLowerCase() || "estimated_text";

  if (breakdown.length) {
    const entries = breakdown.map((entry) => normalizeBreakdownEntry(entry, modelRoute || {}, config));
    const inputTokens = entries.reduce((sum, entry) => sum + toFinite(entry.inputTokens, 0), 0);
    const outputTokens = entries.reduce((sum, entry) => sum + toFinite(entry.outputTokens, 0), 0);
    const totalTokens = entries.reduce((sum, entry) => sum + toFinite(entry.totalTokens, 0), 0) || (inputTokens + outputTokens);
    const estimatedCostUsd = entries.reduce((sum, entry) => sum + toFinite(entry.estimatedCostUsd, 0), 0);
    return {
      currency: "USD",
      priced: true,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd,
      blendedRatePer1MUsd: totalTokens > 0 ? (estimatedCostUsd / totalTokens) * 1_000_000 : 0,
      inputRatePer1MUsd: null,
      outputRatePer1MUsd: null,
      pricingSource: "mixed_breakdown",
      tokenSource,
      breakdown: entries,
    };
  }

  const provider = clean(tokens?.provider || modelRoute?.provider).toLowerCase();
  const model = clean(tokens?.model || modelRoute?.model);
  const normalizedTokens = normalizeTokenInput(tokens);
  const rates = resolveRates({ provider, model, config });
  const estimatedCostUsd = estimateCostUsd({
    inputTokens: normalizedTokens.inputTokens,
    outputTokens: normalizedTokens.outputTokens,
    rates,
  });

  return {
    currency: "USD",
    priced: true,
    provider: provider || "unknown",
    model: model || "unknown",
    inputTokens: normalizedTokens.inputTokens,
    outputTokens: normalizedTokens.outputTokens,
    totalTokens: normalizedTokens.totalTokens,
    estimatedCostUsd,
    blendedRatePer1MUsd: normalizedTokens.totalTokens > 0
      ? (estimatedCostUsd / normalizedTokens.totalTokens) * 1_000_000
      : 0,
    inputRatePer1MUsd: rates.input,
    outputRatePer1MUsd: rates.output,
    pricingSource: rates.source,
    tokenSource,
    breakdown: null,
  };
}
