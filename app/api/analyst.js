import { callOpenAI } from "@researchit/engine";

const DEFAULT_MODEL = process.env.OPENAI_ANALYST_MODEL || "gpt-5.4-mini";
const DEFAULT_WEBSEARCH_MODEL = process.env.OPENAI_ANALYST_WEBSEARCH_MODEL
  || process.env.OPENAI_WEBSEARCH_MODEL
  || DEFAULT_MODEL;
const DEFAULT_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";

function pickNonEmptyString(value) {
  if (typeof value !== "string") return "";
  const out = value.trim();
  return out;
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
    model,
    webSearchModel,
    apiKey,
    baseUrl,
  } = req.body || {};
  if (!messages || !systemPrompt) {
    return res.status(400).json({ error: "Missing messages or systemPrompt" });
  }

  const resolvedApiKey = pickNonEmptyString(apiKey) || process.env.OPENAI_API_KEY;
  if (!resolvedApiKey) {
    return res.status(500).json({ error: "No OpenAI API key provided. Set OPENAI_API_KEY or pass apiKey in request body for BYOK." });
  }
  const resolvedModel = pickNonEmptyString(model) || DEFAULT_MODEL;
  const resolvedWebSearchModel = pickNonEmptyString(webSearchModel) || DEFAULT_WEBSEARCH_MODEL;
  const resolvedBaseUrl = pickNonEmptyString(baseUrl) || DEFAULT_BASE_URL;

  try {
    const result = await callOpenAI({
      apiKey: resolvedApiKey,
      model: resolvedModel,
      webSearchModel: resolvedWebSearchModel,
      messages,
      systemPrompt,
      maxTokens,
      liveSearch,
      baseUrl: resolvedBaseUrl,
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "OpenAI request failed" });
  }
}
