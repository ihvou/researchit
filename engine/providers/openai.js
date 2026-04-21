function normalizeMessageContent(content) {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeUsage(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const inputTokens = toFinite(
    raw.input_tokens
    ?? raw.prompt_tokens
    ?? raw.promptTokens
    ?? raw.inputTokens,
    0
  );
  const outputTokens = toFinite(
    raw.output_tokens
    ?? raw.completion_tokens
    ?? raw.outputTokens
    ?? raw.completionTokens,
    0
  );
  const totalTokens = toFinite(
    raw.total_tokens
    ?? raw.totalTokens
    ?? (inputTokens + outputTokens),
    0
  );
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens || (inputTokens + outputTokens),
  };
}

function normalizeFinishReason(raw = "") {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "unknown";
  if (["stop", "completed"].includes(value)) return "stop";
  if (["length", "max_output_tokens", "max_tokens", "incomplete"].includes(value)) return "length";
  if (["content_filter"].includes(value)) return "content_filter";
  if (value.includes("tool")) return "tool_use";
  if (value.includes("error")) return "error";
  return "unknown";
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { error: { message: text } };
  }
}

async function ensureOkResponse(response, fallbackMessage = "OpenAI request failed") {
  if (response.ok) return readJson(response);
  const data = await readJson(response);
  const message = String(
    data?.error?.message
    || data?.error
    || data?.message
    || `${fallbackMessage} (${response.status})`
  ).trim() || fallbackMessage;
  const err = new Error(message);
  err.status = response.status;
  throw err;
}

export function buildChatMessages(messages, systemPrompt) {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: normalizeMessageContent(m.content) })),
  ];
}

function buildResponsesInput(messages, systemPrompt) {
  return [
    {
      role: "system",
      content: [{ type: "input_text", text: systemPrompt }],
    },
    ...messages.map((m) => ({
      role: m.role,
      content: [{ type: "input_text", text: normalizeMessageContent(m.content) }],
    })),
  ];
}

export function extractResponsesText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function extractChatCompletionsText(data) {
  const choices = Array.isArray(data?.choices) ? data.choices : [];

  for (const choice of choices) {
    const message = choice?.message || {};

    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }

    if (Array.isArray(message.content)) {
      const parts = [];
      for (const content of message.content) {
        if (typeof content === "string" && content.trim()) {
          parts.push(content.trim());
          continue;
        }
        if (!content || typeof content !== "object") continue;
        if (typeof content.text === "string" && content.text.trim()) {
          parts.push(content.text.trim());
        } else if (typeof content.output_text === "string" && content.output_text.trim()) {
          parts.push(content.output_text.trim());
        } else if (typeof content.content === "string" && content.content.trim()) {
          parts.push(content.content.trim());
        } else if (typeof content.refusal === "string" && content.refusal.trim()) {
          parts.push(`Refusal: ${content.refusal.trim()}`);
        }
      }
      const joined = parts.join("\n").trim();
      if (joined) return joined;
    }

    if (typeof message.refusal === "string" && message.refusal.trim()) {
      return `Refusal: ${message.refusal.trim()}`;
    }

    if (typeof choice?.text === "string" && choice.text.trim()) {
      return choice.text.trim();
    }
  }

  return "";
}

export function countWebSearchCalls(payload) {
  let count = 0;
  const stack = [payload];

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (node.type === "web_search_call" || node.type === "web_search_preview_call") count += 1;
    for (const value of Object.values(node)) stack.push(value);
  }

  return count;
}

function isHttpUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function extractWebSearchUrls(payload = {}) {
  const urls = [];
  const stack = [payload];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && (key === "url" || key === "uri" || key.endsWith("_url"))) {
        if (isHttpUrl(value)) urls.push(String(value).trim());
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return [...new Set(urls)];
}

function sourcesFromUrls(urls = []) {
  return (Array.isArray(urls) ? urls : [])
    .map((url, idx) => {
      const value = String(url || "").trim();
      if (!value) return null;
      return {
        name: `OpenAI source ${idx + 1}`,
        quote: "",
        url: value,
        sourceType: "independent",
      };
    })
    .filter(Boolean);
}

async function callResponsesTextOnly({ apiKey, model, messages, systemPrompt, maxTokens, baseUrl, extraMeta = {} }) {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_output_tokens: maxTokens,
      input: buildResponsesInput(messages, systemPrompt),
    }),
  });

  const data = await ensureOkResponse(response, "OpenAI responses request failed");
  if (data.error) throw new Error(data.error.message);

  const text = extractResponsesText(data);
  if (!text) throw new Error("No text content in OpenAI responses output");

  return {
    text,
    rawResponse: data,
    meta: {
      model,
      liveSearchUsed: false,
      webSearchCalls: 0,
      usage: normalizeUsage(data?.usage),
      finishReason: normalizeFinishReason(data?.incomplete_details?.reason || data?.status),
      outputTokens: Number(data?.usage?.output_tokens || 0),
      outputTokensCap: Math.max(256, Number(maxTokens) || 5000),
      ...extraMeta,
    },
  };
}

async function callChatCompletions({ apiKey, model, messages, systemPrompt, maxTokens, baseUrl, extraMeta = {} }) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      messages: buildChatMessages(messages, systemPrompt),
    }),
  });

  const data = await ensureOkResponse(response, "OpenAI chat completions request failed");
  if (data.error) throw new Error(data.error.message);

  const text = extractChatCompletionsText(data);
  if (!text) throw new Error("No text content in OpenAI chat completions output");

  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  return {
    text,
    rawResponse: data,
    meta: {
      model,
      liveSearchUsed: false,
      webSearchCalls: 0,
      usage: normalizeUsage(data?.usage),
      finishReason: normalizeFinishReason(choice?.finish_reason || data?.finish_reason),
      outputTokens: Number(data?.usage?.completion_tokens || data?.usage?.output_tokens || 0),
      outputTokensCap: Math.max(256, Number(maxTokens) || 5000),
      ...extraMeta,
    },
  };
}

async function callResponsesWithWebSearch({ apiKey, model, messages, systemPrompt, maxTokens, baseUrl, deepResearch = false }) {
  // Deep Research: prefer web_search_preview first — this is the tool used by
  // ChatGPT Deep Research with o-series models (o3, o4-mini). The o-series model
  // + web_search_preview combination is what powers the ChatGPT Deep Research product.
  // Regular liveSearch: try web_search first (stable), fall back to web_search_preview.
  const toolTypes = deepResearch
    ? ["web_search_preview", "web_search"]
    : ["web_search", "web_search_preview"];
  let lastErr;

  for (const toolType of toolTypes) {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_output_tokens: maxTokens,
        input: buildResponsesInput(messages, systemPrompt),
        tools: [{ type: toolType }],
      }),
    });

    let data;
    try {
      data = await ensureOkResponse(response, "OpenAI web-search responses request failed");
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (data.error) {
      lastErr = new Error(data.error.message);
      continue;
    }

    const text = extractResponsesText(data);
    if (!text) {
      lastErr = new Error("No text content in OpenAI responses output");
      continue;
    }

    return {
      text,
      rawResponse: data,
      sources: sourcesFromUrls(extractWebSearchUrls(data)),
      meta: {
        model,
        liveSearchUsed: true,
        webSearchCalls: countWebSearchCalls(data),
        usage: normalizeUsage(data?.usage),
        finishReason: normalizeFinishReason(data?.incomplete_details?.reason || data?.status),
        outputTokens: Number(data?.usage?.output_tokens || 0),
        outputTokensCap: Math.max(256, Number(maxTokens) || 5000),
      },
    };
  }

  throw lastErr || new Error("Web search responses call failed");
}

export async function callOpenAI({
  apiKey,
  model,
  webSearchModel,
  messages,
  systemPrompt,
  maxTokens = 5000,
  liveSearch = false,
  deepResearch = false,
  baseUrl = "https://api.openai.com",
}) {
  if (!apiKey) throw new Error("OpenAI API key is required");
  if (!Array.isArray(messages) || !systemPrompt) {
    throw new Error("Missing messages or systemPrompt");
  }

  const standardModel = String(model || "").trim();
  const searchModel = String(webSearchModel || standardModel || "").trim();
  if (!standardModel) throw new Error("OpenAI model is required");

  if (liveSearch) {
    return callResponsesWithWebSearch({
      apiKey,
      model: searchModel,
      messages,
      systemPrompt,
      maxTokens,
      baseUrl,
      deepResearch,
    });
  }

  return callChatCompletions({
    apiKey,
    model: standardModel,
    messages,
    systemPrompt,
    maxTokens,
    baseUrl,
  });
}
