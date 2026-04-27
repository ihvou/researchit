function normalizeMessageContent(content) {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const OPENAI_DEEP_RESEARCH_POLL_MS = Math.max(
  1000,
  Number(process.env.RESEARCHIT_OPENAI_DEEP_RESEARCH_POLL_MS || 8000) || 8000
);
const OPENAI_DEEP_RESEARCH_MAX_WAIT_MS = Math.max(
  OPENAI_DEEP_RESEARCH_POLL_MS,
  Number(process.env.RESEARCHIT_OPENAI_DEEP_RESEARCH_MAX_WAIT_MS || (20 * 60 * 1000)) || (20 * 60 * 1000)
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
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
  err.payload = data;
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

function parseSseFrame(frame = "") {
  const out = { event: "", data: "" };
  const dataLines = [];
  String(frame || "").split("\n").forEach((line) => {
    if (!line || line.startsWith(":")) return;
    if (line.startsWith("event:")) {
      out.event = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  });
  out.data = dataLines.join("\n").trim();
  return out;
}

function openAIStreamError(payload = {}) {
  const errorPayload = payload?.error && typeof payload.error === "object" ? payload.error : payload;
  const message = String(errorPayload?.message || payload?.message || "OpenAI stream error").trim();
  const err = new Error(message);
  err.status = Number(errorPayload?.status || payload?.status || 0) || 502;
  err.payload = payload;
  err.providerEventType = String(errorPayload?.type || payload?.type || "stream_error").trim();
  err.streamEvent = "error";
  return err;
}

export async function readOpenAIResponsesStream(response) {
  if (!response?.body?.getReader) {
    throw new Error("OpenAI stream response body is not readable.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse = null;
  let accumulatedText = "";
  const output = [];
  const rawEvents = [];

  const applyEvent = (eventName = "", payload = {}) => {
    const event = String(eventName || payload?.type || "").trim();
    if (!event) return;
    rawEvents.push({ event, payload });
    if (event === "error" || event === "response.error" || event === "response.failed") {
      throw openAIStreamError(payload);
    }
    if (event === "response.output_text.delta" && typeof payload?.delta === "string") {
      accumulatedText += payload.delta;
      return;
    }
    if (event === "response.output_item.added" && payload?.item && typeof payload.item === "object") {
      output.push(payload.item);
      return;
    }
    if (event === "response.completed") {
      finalResponse = payload?.response && typeof payload.response === "object" ? payload.response : payload;
      return;
    }
    if (payload?.response && typeof payload.response === "object") {
      finalResponse = payload.response;
    }
  };

  const flushFrame = (frame) => {
    const parsed = parseSseFrame(frame);
    if (!parsed.data || parsed.data === "[DONE]") return;
    let payload = {};
    try {
      payload = JSON.parse(parsed.data);
    } catch (err) {
      const parseErr = new Error(`OpenAI stream emitted invalid JSON: ${err?.message || "parse failed"}`);
      parseErr.status = 502;
      parseErr.payload = { event: parsed.event, data: parsed.data };
      throw parseErr;
    }
    applyEvent(parsed.event, payload);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      flushFrame(frame);
      sep = buffer.indexOf("\n\n");
    }
  }
  const tail = `${buffer}${decoder.decode()}`.trim();
  if (tail) flushFrame(tail);

  if (finalResponse) return finalResponse;
  if (accumulatedText) {
    return {
      status: "completed",
      output_text: accumulatedText,
      output,
      stream_events: rawEvents,
    };
  }
  return {
    status: "completed",
    output,
    stream_events: rawEvents,
  };
}

function buildResponsesWebSearchTools(toolType, { deepResearch = false } = {}) {
  const tools = [{ type: toolType }];
  if (deepResearch) {
    tools.push({ type: "code_interpreter", container: { type: "auto" } });
  }
  return tools;
}

async function fetchOpenAIResponse({ endpoint, apiKey, method = "POST", body = null, fallbackMessage = "OpenAI request failed" }) {
  const response = await fetch(endpoint, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: body?.stream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (body?.stream && response.ok) {
    return readOpenAIResponsesStream(response);
  }
  return ensureOkResponse(response, fallbackMessage);
}

async function pollOpenAIBackgroundResponse({ apiKey, baseUrl, responseId }) {
  const startedAt = Date.now();
  let pollCount = 0;
  let latest = null;
  const terminal = new Set(["completed", "failed", "cancelled", "canceled", "expired", "incomplete"]);

  while (Date.now() - startedAt < OPENAI_DEEP_RESEARCH_MAX_WAIT_MS) {
    await sleep(OPENAI_DEEP_RESEARCH_POLL_MS);
    pollCount += 1;
    latest = await fetchOpenAIResponse({
      endpoint: `${baseUrl}/v1/responses/${encodeURIComponent(responseId)}`,
      apiKey,
      method: "GET",
      fallbackMessage: "OpenAI background response poll failed",
    });
    const status = String(latest?.status || "").trim().toLowerCase();
    if (terminal.has(status)) {
      return {
        response: latest,
        diagnostics: {
          pollCount,
          finalStatus: status,
          totalWaitMs: Date.now() - startedAt,
        },
      };
    }
  }

  const err = new Error("OpenAI Deep Research polling timed out.");
  err.status = 504;
  err.reasonCode = "openai_deep_research_poll_timeout";
  err.payload = latest;
  err.nonFallbackFatal = true;
  err.diagnostics = {
    pollCount,
    finalStatus: String(latest?.status || "timeout").trim().toLowerCase(),
    totalWaitMs: Date.now() - startedAt,
  };
  throw err;
}

function openAIBackgroundTerminalError(data = {}, diagnostics = {}) {
  const status = String(data?.status || diagnostics?.finalStatus || "unknown").trim().toLowerCase();
  const message = String(
    data?.error?.message
    || data?.incomplete_details?.reason
    || `OpenAI Deep Research ended with terminal status: ${status || "unknown"}`
  ).trim();
  const err = new Error(message);
  err.status = 502;
  err.reasonCode = `openai_deep_research_${status || "terminal"}`
    .replace(/[^a-z0-9_]+/gi, "_")
    .toLowerCase();
  err.payload = data;
  err.nonFallbackFatal = true;
  err.diagnostics = diagnostics;
  return err;
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
  // Deep research parity prefers ChatGPT-style web_search_preview plus
  // code_interpreter, while retaining web_search as an explicit compatibility
  // fallback with a diagnostic reason code.
  const toolTypes = deepResearch
    ? ["web_search_preview", "web_search"]
    : ["web_search", "web_search_preview"];
  let lastErr;

  for (const [toolIndex, toolType] of toolTypes.entries()) {
    const tools = buildResponsesWebSearchTools(toolType, { deepResearch });
    const requestBody = {
      model,
      max_output_tokens: maxTokens,
      input: buildResponsesInput(messages, systemPrompt),
      tools,
      ...(deepResearch ? { background: true, store: true } : { stream: true }),
    };

    let data;
    let openaiDeepResearchDiagnostics = null;
    try {
      data = await fetchOpenAIResponse({
        endpoint: `${baseUrl}/v1/responses`,
        apiKey,
        body: requestBody,
        fallbackMessage: "OpenAI web-search responses request failed",
      });
      if (deepResearch) {
        let final = data;
        let pollDiagnostics = {
          pollCount: 0,
          finalStatus: String(data?.status || "").trim().toLowerCase(),
          totalWaitMs: 0,
        };
        const status = String(data?.status || "").trim().toLowerCase();
        if (["queued", "in_progress"].includes(status)) {
          if (!data?.id) {
            const err = new Error("OpenAI background response did not return an id.");
            err.status = 502;
            err.payload = data;
            throw err;
          }
          const polled = await pollOpenAIBackgroundResponse({
            apiKey,
            baseUrl,
            responseId: data.id,
          });
          final = polled.response;
          pollDiagnostics = polled.diagnostics;
        }
        data = final;
        openaiDeepResearchDiagnostics = {
          ...pollDiagnostics,
          requestBackground: true,
          requestStore: true,
          toolType,
          toolsEnabled: tools.map((tool) => tool.type),
          toolFallbackUsed: toolIndex > 0,
        };
        if (["failed", "cancelled", "canceled", "expired", "incomplete"].includes(String(data?.status || "").trim().toLowerCase())) {
          throw openAIBackgroundTerminalError(data, openaiDeepResearchDiagnostics);
        }
      }
    } catch (err) {
      if (err?.nonFallbackFatal) throw err;
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
        reasonCodes: deepResearch && toolIndex > 0 ? ["openai_deep_research_tool_fallback"] : [],
        ...(openaiDeepResearchDiagnostics ? { openaiDeepResearch: openaiDeepResearchDiagnostics } : {}),
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
