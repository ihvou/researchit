import {
  resolveRoleProviderCandidates,
  resolveStrictRoute,
  missingApiKeyError,
} from "./providerConfig.js";
import { callProviderModel } from "./providerCalls.js";

const ANALYST_DEFAULT_MODEL = "gpt-5.4";
const ROUTE_MISMATCH_REASON_CODE = "route_mismatch_preflight";

function clean(value) {
  return String(value || "").trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    messages,
    systemPrompt,
    maxTokens = 5000,
    liveSearch = false,
    deepResearch = false,
    provider,
    model,
    webSearchModel,
    baseUrl, // per-request model routing only (not API key BYOK)
    stageId,
  } = req.body || {};

  if (!messages || !systemPrompt) {
    return res.status(400).json({ error: "Missing messages or systemPrompt" });
  }

  const strictRouteRequested = clean(provider) && clean(model);
  const resolved = strictRouteRequested
    ? resolveStrictRoute({
      role: "analyst",
      provider,
      model,
      webSearchModel,
      baseUrl,
    })
    : (resolveRoleProviderCandidates({
      role: "analyst",
      requestedProvider: provider,
      requestedModel: model,
      requestedWebSearchModel: webSearchModel,
      requestedBaseUrl: baseUrl,
      defaultModel: ANALYST_DEFAULT_MODEL,
      liveSearch,
    })?.[0] || null);

  if (!resolved?.apiKey) {
    if (strictRouteRequested) {
      const stageLabel = clean(stageId) || "unknown_stage";
      const declaredProvider = clean(provider).toLowerCase();
      const declaredModel = clean(model);
      return res.status(500).json({
        error: `route_mismatch_preflight: ${stageLabel} declared ${declaredProvider}/${declaredModel} but no API key found for ${declaredProvider}. Set ${declaredProvider.toUpperCase()}_API_KEY.`,
        reasonCode: ROUTE_MISMATCH_REASON_CODE,
      });
    }
    return res.status(500).json({ error: missingApiKeyError("analyst") });
  }

  try {
    const result = await callProviderModel({
      providerId: resolved.providerId,
      apiKey: resolved.apiKey,
      model: resolved.model,
      webSearchModel: resolved.webSearchModel,
      messages,
      systemPrompt,
      maxTokens,
      liveSearch,
      deepResearch,
      baseUrl: resolved.baseUrl,
    });
    return res.status(200).json({
      ...result,
      meta: {
        ...(result?.meta || {}),
        providerId: result?.meta?.providerId || resolved.providerId,
        providerFallbackUsed: false,
        providerAttemptCount: 1,
        providerRoutePinned: true,
      },
    });
  } catch (err) {
    const detail = err?.message || "Unknown provider error";
    return res.status(500).json({
      error: `Pinned analyst provider route failed (${resolved.providerId}): ${detail}`,
    });
  }
}
