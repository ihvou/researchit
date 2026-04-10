import { callOpenAI } from "@researchit/engine";
import {
  resolveRoleProviderCandidates,
  missingApiKeyError,
} from "./providerConfig.js";

const ANALYST_DEFAULT_MODEL = "gpt-5.4-mini";

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
    baseUrl, // per-request model routing only (not API key BYOK)
  } = req.body || {};

  if (!messages || !systemPrompt) {
    return res.status(400).json({ error: "Missing messages or systemPrompt" });
  }

  const candidates = resolveRoleProviderCandidates({
    role: "analyst",
    requestedProvider: provider,
    requestedModel: model,
    requestedWebSearchModel: webSearchModel,
    requestedBaseUrl: baseUrl,
    defaultModel: ANALYST_DEFAULT_MODEL,
    liveSearch,
  });

  if (!candidates.length) {
    return res.status(500).json({ error: missingApiKeyError("analyst") });
  }

  const failures = [];
  for (let idx = 0; idx < candidates.length; idx += 1) {
    const resolved = candidates[idx];
    try {
      const result = await callOpenAI({
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
          providerId: resolved.providerId,
          providerFallbackUsed: idx > 0,
          providerAttemptCount: idx + 1,
        },
      });
    } catch (err) {
      failures.push({
        providerId: resolved.providerId,
        message: err?.message || "Unknown provider error",
      });
    }
  }

  const detail = failures.map((entry) => `${entry.providerId}: ${entry.message}`).join(" | ");
  return res.status(500).json({
    error: detail ? `All analyst provider routes failed. ${detail}` : "OpenAI-compatible request failed",
  });
}
