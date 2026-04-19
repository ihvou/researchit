import { callOpenAI } from "@researchit/engine";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function cleanText(value) {
  return String(value || "").trim();
}

function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeUsage({ inputTokens = 0, outputTokens = 0, totalTokens = 0 } = {}) {
  const input = toFinite(inputTokens, 0);
  const output = toFinite(outputTokens, 0);
  const total = toFinite(totalTokens, input + output) || (input + output);
  if (!input && !output && !total) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
  };
}

function normalizeMessageContent(content) {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

function normalizeMessages(messages = []) {
  return Array.isArray(messages) ? messages : [];
}

function toJsonBody(response, fallbackMessage) {
  return response.json()
    .catch(() => ({}))
    .then((data) => {
      if (!response.ok) {
        const message = cleanText(
          data?.error?.message
          || data?.error
          || data?.message
          || `${fallbackMessage} (${response.status})`
        );
        const err = new Error(message || fallbackMessage);
        err.status = response.status;
        err.payload = data;
        throw err;
      }
      return data || {};
    });
}

function uniqueSourcesFromUrls(urls = [], labelPrefix = "Web source") {
  if (!Array.isArray(urls)) return [];
  const seen = new Set();
  const out = [];
  urls.forEach((url, idx) => {
    const value = cleanText(url);
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({
      name: `${labelPrefix} ${idx + 1}`,
      quote: "",
      url: value,
      sourceType: "independent",
    });
  });
  return out;
}

async function callAnthropic({
  apiKey,
  model,
  messages,
  systemPrompt,
  maxTokens,
  liveSearch = false,
  deepResearch = false,
  baseUrl = "",
}) {
  if (!apiKey) throw new Error("Anthropic API key is required");
  const resolvedModel = cleanText(model);
  if (!resolvedModel) throw new Error("Anthropic model is required");
  const endpoint = `${cleanText(baseUrl) || ANTHROPIC_BASE_URL}/v1/messages`;
  const anthropicMessages = normalizeMessages(messages).map((m) => ({
    role: cleanText(m?.role).toLowerCase() === "assistant" ? "assistant" : "user",
    content: normalizeMessageContent(m?.content),
  }));
  if (!anthropicMessages.length) {
    anthropicMessages.push({ role: "user", content: "Continue." });
  }

  // Deep Research uses more search iterations to match Claude's Research mode.
  const searchMaxUses = deepResearch ? 20 : 6;

  const makeRequest = async (withSearch) => {
    const body = {
      model: resolvedModel,
      max_tokens: Math.max(256, Number(maxTokens) || 4000),
      system: cleanText(systemPrompt),
      messages: anthropicMessages,
      ...(withSearch
        ? {
          tools: [{
            type: "web_search_20250305",
            name: "web_search",
            max_uses: searchMaxUses,
          }],
        }
        : {}),
    };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    return toJsonBody(response, "Anthropic request failed");
  };

  const data = liveSearch
    ? await makeRequest(true)
    : await makeRequest(false);

  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks
    .filter((block) => block?.type === "text" && typeof block?.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("No text content in Anthropic response.");
  }

  const webSearchCalls = Number(data?.usage?.server_tool_use?.web_search_requests || 0);
  return {
    text,
    sources: [],
    meta: {
      providerId: "anthropic",
      model: resolvedModel,
      liveSearchUsed: webSearchCalls > 0,
      webSearchCalls,
      usage: normalizeUsage({
        inputTokens: data?.usage?.input_tokens,
        outputTokens: data?.usage?.output_tokens,
        totalTokens: (toFinite(data?.usage?.input_tokens, 0) + toFinite(data?.usage?.output_tokens, 0)),
      }),
    },
  };
}

function normalizeGeminiModel(model) {
  const raw = cleanText(model);
  if (!raw) return "";
  return raw.startsWith("models/") ? raw : `models/${raw}`;
}

function buildGeminiContents(messages = []) {
  const normalized = normalizeMessages(messages);
  if (!normalized.length) {
    return [{ role: "user", parts: [{ text: "Continue." }] }];
  }
  return normalized.map((m) => ({
    role: cleanText(m?.role).toLowerCase() === "assistant" ? "model" : "user",
    parts: [{ text: normalizeMessageContent(m?.content) }],
  }));
}

function extractGeminiText(data = {}) {
  const parts = [];
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  candidates.forEach((candidate) => {
    const candidateParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    candidateParts.forEach((part) => {
      if (typeof part?.text === "string" && part.text.trim()) {
        parts.push(part.text.trim());
      }
    });
  });
  return parts.join("\n").trim();
}

function countGeminiSearchCalls(data = {}) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  let calls = 0;
  candidates.forEach((candidate) => {
    const grounding = candidate?.groundingMetadata || {};
    const queries = Array.isArray(grounding?.webSearchQueries) ? grounding.webSearchQueries : [];
    calls += queries.length;
  });
  return calls;
}

function extractGeminiGroundingSources(data = {}) {
  const urls = [];
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  candidates.forEach((candidate) => {
    const chunks = Array.isArray(candidate?.groundingMetadata?.groundingChunks)
      ? candidate.groundingMetadata.groundingChunks
      : [];
    chunks.forEach((chunk) => {
      const url = cleanText(chunk?.web?.uri || chunk?.web?.url);
      if (url) urls.push(url);
    });
  });
  return uniqueSourcesFromUrls(urls, "Grounded source");
}

async function callGemini({
  apiKey,
  model,
  messages,
  systemPrompt,
  maxTokens,
  liveSearch = false,
  deepResearch = false,
  baseUrl = "",
}) {
  if (!apiKey) throw new Error("Gemini API key is required");
  const resolvedModel = normalizeGeminiModel(model);
  if (!resolvedModel) throw new Error("Gemini model is required");
  const resolvedBase = cleanText(baseUrl).replace(/\/+$/, "");
  const root = resolvedBase && !resolvedBase.includes("/openai")
    ? resolvedBase
    : GEMINI_API_BASE_URL;
  const endpoint = `${root}/${resolvedModel}:generateContent`;

  const makeRequest = async (withSearch) => {
    const body = {
      contents: buildGeminiContents(messages),
      ...(cleanText(systemPrompt)
        ? { systemInstruction: { parts: [{ text: cleanText(systemPrompt) }] } }
        : {}),
      generationConfig: {
        maxOutputTokens: Math.max(256, Number(maxTokens) || 4000),
        // Deep Research: enable extended thinking (thinkingBudget: -1 = unlimited).
        // This activates Gemini 2.5 Pro's multi-step reasoning loop, matching
        // the behaviour of Gemini Deep Research in the UI.
        ...(deepResearch ? { thinkingConfig: { thinkingBudget: -1 } } : {}),
      },
      ...(withSearch ? { tools: [{ google_search: {} }] } : {}),
    };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
    return toJsonBody(response, "Gemini request failed");
  };

  const data = liveSearch
    ? await makeRequest(true)
    : await makeRequest(false);

  const text = extractGeminiText(data);
  if (!text) {
    throw new Error("No text content in Gemini response.");
  }

  const webSearchCalls = countGeminiSearchCalls(data);
  return {
    text,
    sources: extractGeminiGroundingSources(data),
    meta: {
      providerId: "gemini",
      model: cleanText(model),
      liveSearchUsed: webSearchCalls > 0,
      webSearchCalls,
      usage: normalizeUsage({
        inputTokens: data?.usageMetadata?.promptTokenCount,
        outputTokens: data?.usageMetadata?.candidatesTokenCount,
        totalTokens: data?.usageMetadata?.totalTokenCount,
      }),
    },
  };
}

export async function callProviderModel({
  providerId,
  apiKey,
  model,
  webSearchModel,
  messages,
  systemPrompt,
  maxTokens = 5000,
  liveSearch = false,
  deepResearch = false,
  baseUrl = "",
}) {
  const provider = cleanText(providerId).toLowerCase();
  if (provider === "anthropic") {
    return callAnthropic({
      apiKey,
      model: liveSearch ? (cleanText(webSearchModel) || cleanText(model)) : model,
      messages,
      systemPrompt,
      maxTokens,
      liveSearch,
      deepResearch,
      baseUrl,
    });
  }
  if (provider === "gemini") {
    return callGemini({
      apiKey,
      model: liveSearch ? (cleanText(webSearchModel) || cleanText(model)) : model,
      messages,
      systemPrompt,
      maxTokens,
      liveSearch,
      deepResearch,
      baseUrl,
    });
  }
  return callOpenAI({
    apiKey,
    model: cleanText(model),
    webSearchModel: cleanText(webSearchModel) || cleanText(model),
    messages,
    systemPrompt,
    maxTokens,
    liveSearch,
    deepResearch,
    baseUrl,
  });
}
