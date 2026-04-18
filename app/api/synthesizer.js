import {
  resolveRoleProviderCandidates,
  missingApiKeyError,
} from "./providerConfig.js";
import { callProviderModel } from "./providerCalls.js";

const SYNTHESIZER_DEFAULT_MODEL = "gemini-2.5-pro";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    messages,
    systemPrompt,
    maxTokens = 5000,
    liveSearch = false,
    provider,
    model,
    webSearchModel,
    baseUrl,
  } = req.body || {};

  if (!messages || !systemPrompt) {
    return res.status(400).json({ error: "Missing messages or systemPrompt" });
  }

  const candidates = resolveRoleProviderCandidates({
    role: "synthesizer",
    requestedProvider: provider,
    requestedModel: model,
    requestedWebSearchModel: webSearchModel,
    requestedBaseUrl: baseUrl,
    defaultModel: SYNTHESIZER_DEFAULT_MODEL,
    liveSearch,
  });

  if (!candidates.length) {
    return res.status(500).json({ error: missingApiKeyError("synthesizer") });
  }

  const resolved = candidates[0];
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
      error: `Pinned synthesizer provider route failed (${resolved.providerId}): ${detail}`,
    });
  }
}
