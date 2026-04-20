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

function normalizeFinishReason(raw = "") {
  const value = cleanText(raw).toLowerCase();
  if (!value) return "unknown";
  if (["stop", "end_turn", "completed", "finish", "done"].includes(value)) return "stop";
  if (["length", "max_tokens", "max_output_tokens", "max_token", "max_tokens_reached", "max_tokens_exceeded"].includes(value)) return "length";
  if (["content_filter", "safety", "blocked"].includes(value)) return "content_filter";
  if (value.includes("tool")) return "tool_use";
  if (value.includes("error")) return "error";
  return "unknown";
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

function isHttpUrl(value = "") {
  const raw = cleanText(value);
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function extractHttpUrlsDeep(payload = {}) {
  const urls = [];
  const stack = [payload];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      node.forEach((item) => stack.push(item));
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && (key === "url" || key === "uri" || key.endsWith("_url"))) {
        if (isHttpUrl(value)) urls.push(cleanText(value));
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return urls;
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
  const sources = uniqueSourcesFromUrls(extractHttpUrlsDeep(data), "Anthropic source");
  const usage = normalizeUsage({
    inputTokens: data?.usage?.input_tokens,
    outputTokens: data?.usage?.output_tokens,
    totalTokens: (toFinite(data?.usage?.input_tokens, 0) + toFinite(data?.usage?.output_tokens, 0)),
  });
  const outputTokensCap = Math.max(256, Number(maxTokens) || 4000);
  return {
    text,
    sources,
    meta: {
      providerId: "anthropic",
      model: resolvedModel,
      liveSearchUsed: webSearchCalls > 0,
      webSearchCalls,
      finishReason: normalizeFinishReason(data?.stop_reason || data?.stopReason || data?.type),
      outputTokens: Number(usage?.outputTokens || 0),
      outputTokensCap,
      groundedSourcesResolved: {
        total: sources.length,
        resolved: sources.length,
        unresolved: 0,
      },
      usage,
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
  return urls;
}

function isGeminiGroundingRedirect(url = "") {
  const value = cleanText(url).toLowerCase();
  return value.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")
    || value.includes("grounding-api-redirect");
}

async function resolveCanonicalUrl(url = "", timeoutMs = 1800) {
  const input = cleanText(url);
  if (!isHttpUrl(input)) {
    return {
      originalRedirectUri: input,
      url: input,
      resolutionStatus: "invalid",
    };
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    try {
      controller.abort({
        source: "provider_timeout",
        layer: "canonical_url_resolution",
        deadlineMs: Math.max(250, Number(timeoutMs) || 1800),
        elapsedMs: Date.now() - startedAt,
      });
    } catch (_) {
      // no-op
    }
  }, Math.max(250, Number(timeoutMs) || 1800));

  const headers = {
    "User-Agent": "Researchit/1.0 (+https://github.com/ihvou/researchit)",
    Accept: "text/html, text/plain;q=0.9, application/json;q=0.7, */*;q=0.5",
  };

  try {
    let response;
    try {
      response = await fetch(input, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers,
      });
      if (response.status === 405 || response.status === 501) {
        response = await fetch(input, {
          method: "GET",
          redirect: "follow",
          signal: controller.signal,
          headers,
        });
      }
    } catch (_) {
      response = await fetch(input, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers,
      });
    }
    const resolved = cleanText(response?.url || input);
    const unresolved = !resolved || isGeminiGroundingRedirect(resolved);
    return {
      originalRedirectUri: input,
      url: unresolved ? input : resolved,
      resolutionStatus: unresolved ? "unresolved" : "resolved",
      responseStatus: Number(response?.status || 0),
    };
  } catch (_) {
    return {
      originalRedirectUri: input,
      url: input,
      resolutionStatus: "unresolved",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCanonicalGeminiSources(urls = [], { concurrency = 8, timeoutMs = 1800 } = {}) {
  const inputs = Array.isArray(urls) ? urls.filter((url) => isHttpUrl(url)) : [];
  if (!inputs.length) {
    return {
      sources: [],
      diagnostics: { total: 0, resolved: 0, unresolved: 0 },
    };
  }

  const uniqueInputs = [...new Set(inputs.map((url) => cleanText(url)).filter(Boolean))];
  const out = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 8, 16)) }, async () => {
    while (cursor < uniqueInputs.length) {
      const idx = cursor;
      cursor += 1;
      const raw = uniqueInputs[idx];
      const entry = await resolveCanonicalUrl(raw, timeoutMs);
      out.push({
        name: "Grounded source",
        quote: "",
        sourceType: "independent",
        originalRedirectUri: cleanText(entry?.originalRedirectUri || raw),
        url: cleanText(entry?.url || raw),
        resolutionStatus: cleanText(entry?.resolutionStatus || "unresolved"),
      });
    }
  });
  await Promise.all(workers);

  const deduped = [];
  const seen = new Set();
  out.forEach((source) => {
    const key = `${cleanText(source?.url)}|${cleanText(source?.originalRedirectUri)}`;
    if (!source?.url || seen.has(key)) return;
    seen.add(key);
    deduped.push(source);
  });

  const diagnostics = {
    total: deduped.length,
    resolved: deduped.filter((source) => cleanText(source?.resolutionStatus) === "resolved").length,
    unresolved: deduped.filter((source) => cleanText(source?.resolutionStatus) !== "resolved").length,
  };
  return { sources: deduped, diagnostics };
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
  const groundingUrls = extractGeminiGroundingSources(data);
  const grounded = await resolveCanonicalGeminiSources(groundingUrls, {
    concurrency: 8,
    timeoutMs: 1800,
  });
  const firstCandidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const usage = normalizeUsage({
    inputTokens: data?.usageMetadata?.promptTokenCount,
    outputTokens: data?.usageMetadata?.candidatesTokenCount,
    totalTokens: data?.usageMetadata?.totalTokenCount,
  });
  const outputTokensCap = Math.max(256, Number(maxTokens) || 4000);
  return {
    text,
    sources: grounded.sources,
    meta: {
      providerId: "gemini",
      model: cleanText(model),
      liveSearchUsed: webSearchCalls > 0,
      webSearchCalls,
      finishReason: normalizeFinishReason(firstCandidate?.finishReason || firstCandidate?.finish_reason),
      outputTokens: Number(usage?.outputTokens || 0),
      outputTokensCap,
      groundedSourcesResolved: grounded.diagnostics,
      usage,
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
