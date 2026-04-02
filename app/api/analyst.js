import { callOpenAI } from "@researchit/engine";
import {
  resolveRoleProviderConfig,
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

  const resolved = resolveRoleProviderConfig({
    role: "analyst",
    requestedProvider: provider,
    requestedModel: model,
    requestedWebSearchModel: webSearchModel,
    requestedBaseUrl: baseUrl,
    defaultModel: ANALYST_DEFAULT_MODEL,
  });

  if (!resolved.apiKey) {
    return res.status(500).json({ error: missingApiKeyError("analyst") });
  }

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
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "OpenAI-compatible request failed" });
  }
}
