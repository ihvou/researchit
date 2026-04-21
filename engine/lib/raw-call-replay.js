function clean(value) {
  return String(value || "").trim();
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeUsage(input = {}) {
  const usage = input && typeof input === "object" ? input : {};
  const inputTokens = toFinite(
    usage?.inputTokens
    ?? usage?.input_tokens
    ?? usage?.promptTokenCount
    ?? usage?.prompt_tokens,
    0
  );
  const outputTokens = toFinite(
    usage?.outputTokens
    ?? usage?.output_tokens
    ?? usage?.candidatesTokenCount
    ?? usage?.completion_tokens,
    0
  );
  const totalTokens = toFinite(
    usage?.totalTokens
    ?? usage?.total_token_count
    ?? usage?.totalTokenCount
    ?? usage?.total_tokens
    ?? (inputTokens + outputTokens),
    inputTokens + outputTokens
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function extractGeminiText(data = {}) {
  const parts = [];
  const candidates = ensureArray(data?.candidates);
  candidates.forEach((candidate) => {
    ensureArray(candidate?.content?.parts).forEach((part) => {
      if (typeof part?.text === "string" && part.text.trim()) {
        parts.push(part.text.trim());
      }
    });
  });
  return parts.join("\n").trim();
}

function extractGeminiGroundingSources(data = {}) {
  const out = [];
  const seen = new Set();
  const push = (url, title = "Grounded source") => {
    const value = clean(url);
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: clean(title) || "Grounded source",
      quote: "",
      url: value,
      sourceType: "independent",
    });
  };
  ensureArray(data?.candidates).forEach((candidate) => {
    const grounding = candidate?.groundingMetadata || {};
    ensureArray(grounding?.groundingChunks).forEach((chunk, idx) => {
      push(chunk?.web?.uri || chunk?.web?.url, chunk?.web?.title || `Grounded source ${idx + 1}`);
    });
  });
  return out;
}

function countGeminiSearchCalls(data = {}) {
  let calls = 0;
  ensureArray(data?.candidates).forEach((candidate) => {
    calls += ensureArray(candidate?.groundingMetadata?.webSearchQueries).length;
  });
  return calls;
}

function extractOpenAIResponsesText(data = {}) {
  const output = ensureArray(data?.output);
  const parts = [];
  output.forEach((entry) => {
    const content = ensureArray(entry?.content);
    content.forEach((item) => {
      if (typeof item?.text === "string" && item.text.trim()) {
        parts.push(item.text.trim());
      }
      if (item?.text && typeof item.text?.value === "string" && item.text.value.trim()) {
        parts.push(item.text.value.trim());
      }
    });
  });
  if (!parts.length && typeof data?.output_text === "string") return clean(data.output_text);
  return parts.join("\n").trim();
}

function extractOpenAIChatText(data = {}) {
  const choice = ensureArray(data?.choices)[0] || {};
  return clean(choice?.message?.content || "");
}

function extractAnthropicText(data = {}) {
  return ensureArray(data?.content)
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function normalizeRawCallForReplay(rawCall = {}) {
  const provider = clean(rawCall?.provider).toLowerCase();
  const model = clean(rawCall?.model);
  const rawResponse = rawCall?.rawResponse && typeof rawCall.rawResponse === "object"
    ? rawCall.rawResponse
    : {};

  if (provider === "gemini") {
    const text = extractGeminiText(rawResponse);
    const groundedSources = extractGeminiGroundingSources(rawResponse);
    const webSearchCalls = countGeminiSearchCalls(rawResponse);
    const noSearchPerformed = webSearchCalls === 0;
    const callFailedGrounding = webSearchCalls > 0 && groundedSources.length === 0;
    return {
      text,
      sources: groundedSources,
      meta: {
        providerId: "gemini",
        model,
        liveSearchUsed: webSearchCalls > 0,
        webSearchCalls,
        groundedSources,
        noSearchPerformed,
        callFailedGrounding,
        groundedSourcesResolved: {
          total: groundedSources.length,
          resolved: groundedSources.length,
          unresolved: 0,
        },
        usage: normalizeUsage(rawResponse?.usageMetadata),
      },
    };
  }

  if (provider === "anthropic") {
    const text = extractAnthropicText(rawResponse);
    const webSearchCalls = toFinite(rawResponse?.usage?.server_tool_use?.web_search_requests, 0);
    return {
      text,
      sources: [],
      meta: {
        providerId: "anthropic",
        model,
        liveSearchUsed: webSearchCalls > 0,
        webSearchCalls,
        usage: normalizeUsage({
          input_tokens: rawResponse?.usage?.input_tokens,
          output_tokens: rawResponse?.usage?.output_tokens,
        }),
      },
    };
  }

  const responsesText = extractOpenAIResponsesText(rawResponse);
  const chatText = extractOpenAIChatText(rawResponse);
  const text = responsesText || chatText;
  const usage = normalizeUsage(rawResponse?.usage || {});
  return {
    text,
    sources: [],
    meta: {
      providerId: "openai",
      model,
      liveSearchUsed: false,
      webSearchCalls: 0,
      usage,
    },
  };
}

