import { callOpenAI } from "@researchit/engine";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_DEEP_RESEARCH_AGENT = "deep-research-pro-preview-12-2025";
const GEMINI_DEEP_RESEARCH_POLL_MS = 8000;
const GEMINI_DEEP_RESEARCH_MAX_WAIT_MS = 20 * 60 * 1000;
const GEMINI_EMPTY_SUCCESS_REASON_CODE = "gemini_empty_success_response";
const ANTHROPIC_TIMEOUT_MS_DEFAULT = 120000;
const ANTHROPIC_TIMEOUT_MS_CRITIC = 240000;
const ANTHROPIC_TIMEOUT_MS_DEEP_RESEARCH = 20 * 60 * 1000;
const ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = 60000;

function cleanText(value) {
  return String(value || "").trim();
}

function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isAbortLikeError(err = {}) {
  const errName = String(err?.name || "").toLowerCase();
  const errCode = String(err?.code || "").toLowerCase();
  const errMessage = String(err?.message || "").toLowerCase();
  const errSource = String(err?.source || err?.cause?.source || "").toLowerCase();
  const causeName = String(err?.cause?.name || "").toLowerCase();
  const causeCode = String(err?.cause?.code || "").toLowerCase();
  return (
    errName === "aborterror"
    || errCode === "abort_err"
    || errCode === "und_err_aborted"
    || errSource === "provider_timeout"
    || causeName === "aborterror"
    || causeCode === "abort_err"
    || causeCode === "und_err_aborted"
    || errMessage.includes("aborted")
    || errMessage.includes("terminated")
  );
}

function providerTimeoutError(label = "Request", timeoutMs = 0, abortReason = {}) {
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  const timeoutErr = new Error(`${cleanText(label)} timed out after ${timeout}ms`);
  timeoutErr.status = 504;
  timeoutErr.code = "PROVIDER_TIMEOUT";
  timeoutErr.abortReason = {
    source: "provider_timeout",
    layer: cleanText(abortReason?.layer) || "provider_http",
    deadlineMs: timeout,
    ...(Number.isFinite(Number(abortReason?.elapsedMs)) ? { elapsedMs: Number(abortReason.elapsedMs) } : {}),
  };
  return timeoutErr;
}

function fetchWithTimeout(url, options = {}, timeoutMs = 0, label = "Request") {
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  if (!timeout) return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort({
        source: "provider_timeout",
        layer: "provider_http",
        deadlineMs: timeout,
      });
    } catch (_) {
      // no-op
    }
  }, timeout);
  return fetch(url, { ...(options || {}), signal: controller.signal })
    .catch((err) => {
      if (!isAbortLikeError(err)) throw err;
      throw providerTimeoutError(label, timeout, {
        layer: "provider_http",
      });
    })
    .finally(() => clearTimeout(timer));
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

function parseResetValueMs(raw) {
  const text = cleanText(raw);
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.max(0, Math.round(Number(text) * 1000));
  }
  const msMatch = text.match(/^(\d+)\s*ms$/i);
  if (msMatch) {
    return Math.max(0, Number(msMatch[1]));
  }
  const sMatch = text.match(/^(\d+)\s*s(ec(onds?)?)?$/i);
  if (sMatch) {
    return Math.max(0, Number(sMatch[1]) * 1000);
  }
  const parsedDate = Date.parse(text);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }
  return 0;
}

function extractRateLimitInfoFromHeaders(headers) {
  const get = (key) => cleanText(headers?.get?.(key));
  const retryAfter = get("retry-after");
  const requestReset = get("anthropic-ratelimit-requests-reset");
  const inputReset = get("anthropic-ratelimit-input-tokens-reset");
  const outputReset = get("anthropic-ratelimit-output-tokens-reset");
  const retryAfterMs = Math.max(
    parseResetValueMs(retryAfter),
    parseResetValueMs(requestReset),
    parseResetValueMs(inputReset),
    parseResetValueMs(outputReset),
  );
  return {
    retryAfterMs,
    retryAfter,
    requestsLimit: get("anthropic-ratelimit-requests-limit"),
    requestsRemaining: get("anthropic-ratelimit-requests-remaining"),
    requestsReset: requestReset,
    inputTokensLimit: get("anthropic-ratelimit-input-tokens-limit"),
    inputTokensRemaining: get("anthropic-ratelimit-input-tokens-remaining"),
    inputTokensReset: inputReset,
    outputTokensLimit: get("anthropic-ratelimit-output-tokens-limit"),
    outputTokensRemaining: get("anthropic-ratelimit-output-tokens-remaining"),
    outputTokensReset: outputReset,
  };
}

function hasAnyRateLimitInfo(info = {}) {
  return Object.values(info).some((value) => !!cleanText(value));
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
        const rateLimitInfo = extractRateLimitInfoFromHeaders(response?.headers);
        if (Number(rateLimitInfo?.retryAfterMs || 0) > 0) {
          err.retryAfterMs = Number(rateLimitInfo.retryAfterMs);
        }
        if (hasAnyRateLimitInfo(rateLimitInfo)) {
          err.rateLimitInfo = rateLimitInfo;
        }
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

function anthropicStreamErrorStatus(type = "") {
  const value = cleanText(type).toLowerCase();
  if (value.includes("rate_limit")) return 429;
  if (value.includes("overload")) return 529;
  if (value.includes("timeout")) return 504;
  if (value.includes("authentication") || value.includes("permission")) return 401;
  if (value.includes("invalid_request")) return 400;
  return 500;
}

function mergeAnthropicUsage(base = {}, next = {}) {
  const merged = { ...(base || {}) };
  Object.entries(next || {}).forEach(([key, value]) => {
    if (value == null) return;
    if (typeof value === "number") {
      merged[key] = Math.max(Number(merged[key] || 0), value);
      return;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = {
        ...(merged[key] && typeof merged[key] === "object" ? merged[key] : {}),
        ...value,
      };
      return;
    }
    merged[key] = value;
  });
  return merged;
}

function finalizeAnthropicBlock(block = {}) {
  if (!block || typeof block !== "object") return block;
  const out = { ...block };
  if (typeof out.input_json === "string") {
    try {
      out.input = JSON.parse(out.input_json || "{}");
      delete out.input_json;
    } catch (_) {
      out.input = out.input_json;
      delete out.input_json;
    }
  }
  return out;
}

function applyAnthropicStreamEvent(acc, eventName = "", payload = {}, response = null) {
  const event = cleanText(eventName) || cleanText(payload?.type);
  if (!event || event === "ping") return;
  if (event === "error") {
    const errorPayload = payload?.error && typeof payload.error === "object" ? payload.error : payload;
    const type = cleanText(errorPayload?.type || payload?.type || "stream_error");
    const err = new Error(cleanText(errorPayload?.message) || `Anthropic stream error: ${type}`);
    err.status = Number(errorPayload?.status || payload?.status || 0) || anthropicStreamErrorStatus(type);
    err.payload = payload;
    err.streamEvent = "error";
    err.providerEventType = type;
    const rateLimitInfo = extractRateLimitInfoFromHeaders(response?.headers);
    if (Number(rateLimitInfo?.retryAfterMs || 0) > 0) err.retryAfterMs = Number(rateLimitInfo.retryAfterMs);
    if (hasAnyRateLimitInfo(rateLimitInfo)) err.rateLimitInfo = rateLimitInfo;
    throw err;
  }

  if (event === "message_start") {
    const message = payload?.message && typeof payload.message === "object" ? payload.message : {};
    acc.id = cleanText(message?.id) || acc.id;
    acc.type = cleanText(message?.type) || acc.type || "message";
    acc.role = cleanText(message?.role) || acc.role || "assistant";
    acc.model = cleanText(message?.model) || acc.model;
    acc.stop_reason = message?.stop_reason ?? acc.stop_reason;
    acc.stop_sequence = message?.stop_sequence ?? acc.stop_sequence;
    acc.usage = mergeAnthropicUsage(acc.usage, message?.usage || {});
    (Array.isArray(message?.content) ? message.content : []).forEach((block, idx) => {
      acc.blocks.set(idx, { ...(block || {}) });
    });
    return;
  }

  if (event === "content_block_start") {
    const idx = Number(payload?.index ?? acc.blocks.size);
    const block = payload?.content_block && typeof payload.content_block === "object"
      ? payload.content_block
      : {};
    acc.blocks.set(idx, { ...(block || {}) });
    return;
  }

  if (event === "content_block_delta") {
    const idx = Number(payload?.index ?? 0);
    const existing = acc.blocks.get(idx) || {};
    const delta = payload?.delta && typeof payload.delta === "object" ? payload.delta : {};
    const deltaType = cleanText(delta?.type);
    if (deltaType === "text_delta") {
      existing.type = existing.type || "text";
      existing.text = `${existing.text || ""}${delta.text || ""}`;
    } else if (deltaType === "input_json_delta") {
      existing.input_json = `${existing.input_json || ""}${delta.partial_json || ""}`;
    } else if (typeof delta?.text === "string") {
      existing.type = existing.type || "text";
      existing.text = `${existing.text || ""}${delta.text}`;
    } else {
      existing.deltas = [...(Array.isArray(existing.deltas) ? existing.deltas : []), delta];
    }
    acc.blocks.set(idx, existing);
    return;
  }

  if (event === "content_block_stop") {
    return;
  }

  if (event === "message_delta") {
    const delta = payload?.delta && typeof payload.delta === "object" ? payload.delta : {};
    if (delta?.stop_reason != null) acc.stop_reason = delta.stop_reason;
    if (delta?.stop_sequence != null) acc.stop_sequence = delta.stop_sequence;
    acc.usage = mergeAnthropicUsage(acc.usage, payload?.usage || {});
    return;
  }

  if (event === "message_stop") {
    acc.stopped = true;
    return;
  }

  if (payload && typeof payload === "object") {
    acc.rawEvents.push({ event, payload });
  }
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

export async function readAnthropicStream(response, {
  idleTimeoutMs = ANTHROPIC_STREAM_IDLE_TIMEOUT_MS,
  totalTimeoutMs = ANTHROPIC_TIMEOUT_MS_CRITIC,
} = {}) {
  if (!response?.body?.getReader) {
    throw new Error("Anthropic stream response body is not readable.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = "";
  const acc = {
    id: "",
    type: "message",
    role: "assistant",
    model: "",
    stop_reason: null,
    stop_sequence: null,
    usage: {},
    blocks: new Map(),
    rawEvents: [],
    stopped: false,
  };

  const readWithIdleTimeout = async () => {
    const idle = Math.max(1000, Number(idleTimeoutMs) || ANTHROPIC_STREAM_IDLE_TIMEOUT_MS);
    let timer;
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(providerTimeoutError("Anthropic stream", idle, {
              layer: "provider_stream_idle",
              elapsedMs: Date.now() - startedAt,
            }));
          }, idle);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const flushFrame = (frame) => {
    const parsed = parseSseFrame(frame);
    if (!parsed.data || parsed.data === "[DONE]") return;
    let payload = {};
    try {
      payload = JSON.parse(parsed.data);
    } catch (err) {
      const parseErr = new Error(`Anthropic stream emitted invalid JSON: ${err?.message || "parse failed"}`);
      parseErr.status = 502;
      parseErr.payload = { event: parsed.event, data: parsed.data };
      throw parseErr;
    }
    applyAnthropicStreamEvent(acc, parsed.event, payload, response);
  };

  try {
    while (true) {
      const totalTimeout = Math.max(1000, Number(totalTimeoutMs) || ANTHROPIC_TIMEOUT_MS_CRITIC);
      if (Date.now() - startedAt > totalTimeout) {
        throw providerTimeoutError("Anthropic stream", totalTimeout, {
          layer: "provider_stream_total",
          elapsedMs: Date.now() - startedAt,
        });
      }
      const { value, done } = await readWithIdleTimeout();
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
  } catch (err) {
    try {
      await reader.cancel();
    } catch (_) {
      // no-op
    }
    if (isAbortLikeError(err)) {
      throw providerTimeoutError("Anthropic stream", Number(totalTimeoutMs) || ANTHROPIC_TIMEOUT_MS_CRITIC, {
        layer: "provider_stream",
        elapsedMs: Date.now() - startedAt,
      });
    }
    throw err;
  }

  const content = [...acc.blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => finalizeAnthropicBlock(block))
    .filter((block) => block && typeof block === "object" && cleanText(block.type));

  return {
    id: acc.id,
    type: acc.type || "message",
    role: acc.role || "assistant",
    content,
    model: acc.model,
    stop_reason: acc.stop_reason,
    stop_sequence: acc.stop_sequence,
    usage: acc.usage || {},
    ...(acc.rawEvents.length ? { stream_events: acc.rawEvents } : {}),
  };
}

async function callAnthropic({
  apiKey,
  model,
  messages,
  systemPrompt,
  maxTokens,
  liveSearch = false,
  searchMaxUses = 0,
  deepResearch = false,
  baseUrl = "",
  stageId = "",
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

  // For extended Claude research lanes, allow higher search iteration caps.
  const resolvedSearchMaxUses = Number.isFinite(Number(searchMaxUses)) && Number(searchMaxUses) > 0
    ? Math.max(1, Math.min(20, Math.floor(Number(searchMaxUses))))
    : (deepResearch ? 20 : 6);
  const webSearchToolType = cleanText(process.env.ANTHROPIC_WEB_SEARCH_TOOL) || "web_search_20260209";
  const envTimeout = Number(process.env.ANTHROPIC_REQUEST_TIMEOUT_MS || 0);
  const stage = cleanText(stageId).toLowerCase();
  const criticStage = stage.startsWith("stage_10") || stage.startsWith("stage_11") || stage.startsWith("stage_12");
  const deepAssistStage = stage.startsWith("stage_03c");
  const shouldStream = !!liveSearch || !!deepResearch || criticStage || deepAssistStage;
  const anthropicTimeoutMs = Number.isFinite(envTimeout) && envTimeout > 0
    ? envTimeout
    : (deepResearch || deepAssistStage
      ? ANTHROPIC_TIMEOUT_MS_DEEP_RESEARCH
      : (criticStage ? ANTHROPIC_TIMEOUT_MS_CRITIC : ANTHROPIC_TIMEOUT_MS_DEFAULT));

  const makeRequest = async (withSearch) => {
    const body = {
      model: resolvedModel,
      max_tokens: Math.max(256, Number(maxTokens) || 4000),
      system: cleanText(systemPrompt),
      messages: anthropicMessages,
      ...(shouldStream ? { stream: true } : {}),
      ...(withSearch
        ? {
          tools: [{
            type: webSearchToolType,
            name: "web_search",
            max_uses: resolvedSearchMaxUses,
          }],
        }
        : {}),
    };
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(shouldStream ? { accept: "text/event-stream" } : {}),
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    }, anthropicTimeoutMs, "Anthropic request");
    if (shouldStream && response.ok) {
      return readAnthropicStream(response, {
        idleTimeoutMs: Number(process.env.ANTHROPIC_STREAM_IDLE_TIMEOUT_MS || 0) || ANTHROPIC_STREAM_IDLE_TIMEOUT_MS,
        totalTimeoutMs: anthropicTimeoutMs,
      });
    }
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
    rawResponse: data,
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

function buildGeminiDeepResearchPrompt(messages = [], systemPrompt = "") {
  const sections = [];
  const systemText = cleanText(systemPrompt);
  if (systemText) {
    sections.push("System instructions:");
    sections.push(systemText);
  }
  normalizeMessages(messages).forEach((message) => {
    const role = cleanText(message?.role).toLowerCase() === "assistant" ? "assistant" : "user";
    const content = cleanText(normalizeMessageContent(message?.content));
    if (!content) return;
    sections.push(`${role.toUpperCase()}:`);
    sections.push(content);
  });
  const merged = cleanText(sections.join("\n\n"));
  return merged || "Continue.";
}

function extractGeminiDeepResearchText(payload = {}) {
  const out = [];
  const seenNodes = new Set();
  const queue = [payload];
  const push = (value = "") => {
    const text = cleanText(value);
    if (!text) return;
    out.push(text);
  };

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;
    if (seenNodes.has(node)) continue;
    seenNodes.add(node);

    if (Array.isArray(node)) {
      node.forEach((item) => queue.push(item));
      continue;
    }

    if (typeof node?.text === "string") push(node.text);
    if (typeof node?.output_text === "string") push(node.output_text);
    if (typeof node?.responseText === "string") push(node.responseText);
    if (typeof node?.content === "string") push(node.content);

    const parts = Array.isArray(node?.parts) ? node.parts : [];
    parts.forEach((part) => {
      if (typeof part?.text === "string") push(part.text);
      queue.push(part);
    });

    const content = Array.isArray(node?.content) ? node.content : [];
    content.forEach((part) => {
      if (typeof part === "string") push(part);
      if (typeof part?.text === "string") push(part.text);
      if (typeof part?.output_text === "string") push(part.output_text);
      queue.push(part);
    });

    ["output", "outputs", "response", "result", "message", "messages", "turns", "candidates"].forEach((key) => {
      const value = node?.[key];
      if (value && typeof value === "object") queue.push(value);
    });
  }

  return [...new Set(out)].join("\n").trim();
}

function countGeminiDeepResearchSearchCalls(payload = {}) {
  let calls = 0;
  const seenNodes = new Set();
  const queue = [payload];

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;
    if (seenNodes.has(node)) continue;
    seenNodes.add(node);
    if (Array.isArray(node)) {
      node.forEach((item) => queue.push(item));
      continue;
    }
    const type = cleanText(node?.type || node?.name).toLowerCase();
    if (type.includes("web_search") || type.includes("google_search")) calls += 1;
    const searchQueries = Array.isArray(node?.webSearchQueries) ? node.webSearchQueries : [];
    calls += searchQueries.length;
    Object.values(node).forEach((value) => {
      if (value && typeof value === "object") queue.push(value);
    });
  }
  return calls;
}

function extractGeminiDeepResearchUsage(payload = {}) {
  return normalizeUsage({
    inputTokens: payload?.usageMetadata?.promptTokenCount || payload?.usage?.input_tokens,
    outputTokens: payload?.usageMetadata?.candidatesTokenCount || payload?.usage?.output_tokens,
    totalTokens: payload?.usageMetadata?.totalTokenCount || payload?.usage?.total_tokens,
  });
}

function extractUrlsFromRenderedContent(value = "") {
  const text = cleanText(value);
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return matches.map((item) => cleanText(item)).filter(Boolean);
}

function collectGroundingMetadataKeys(data = {}) {
  const keys = new Set();
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  candidates.forEach((candidate) => {
    const grounding = candidate?.groundingMetadata;
    if (!grounding || typeof grounding !== "object") return;
    Object.keys(grounding).forEach((key) => {
      if (!key) return;
      keys.add(String(key));
    });
  });
  return [...keys];
}

function extractGeminiGroundingSources(data = {}) {
  const entries = [];
  const seen = new Set();
  const push = (url, title = "Grounded source", anchor = "") => {
    const normalizedUrl = cleanText(url);
    if (!normalizedUrl || !isHttpUrl(normalizedUrl)) return;
    const key = normalizedUrl.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      url: normalizedUrl,
      title: cleanText(title) || "Grounded source",
      anchor: cleanText(anchor),
    });
  };
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  candidates.forEach((candidate) => {
    const groundingMetadata = candidate?.groundingMetadata || {};
    const chunks = Array.isArray(groundingMetadata?.groundingChunks)
      ? groundingMetadata.groundingChunks
      : [];
    chunks.forEach((chunk, idx) => {
      const url = cleanText(chunk?.web?.uri || chunk?.web?.url);
      const title = cleanText(chunk?.web?.title || chunk?.web?.snippet || `Grounded source ${idx + 1}`);
      push(url, title);
    });

    const supports = Array.isArray(groundingMetadata?.groundingSupports)
      ? groundingMetadata.groundingSupports
      : [];
    supports.forEach((support) => {
      const indices = Array.isArray(support?.groundingChunkIndices)
        ? support.groundingChunkIndices
        : (Number.isFinite(Number(support?.groundingChunkIndex))
          ? [Number(support.groundingChunkIndex)]
          : []);
      const anchor = cleanText(support?.segment?.text || support?.supportText);
      indices.forEach((idx) => {
        const chunk = chunks[idx];
        if (!chunk) return;
        const url = cleanText(chunk?.web?.uri || chunk?.web?.url);
        const title = cleanText(chunk?.web?.title || chunk?.web?.snippet || "Grounded source");
        push(url, title, anchor);
      });
    });

    const renderedContentUrls = extractUrlsFromRenderedContent(groundingMetadata?.searchEntryPoint?.renderedContent);
    renderedContentUrls.forEach((url, idx) => {
      push(url, `Grounded source ${idx + 1}`);
    });
  });
  return entries;
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

async function resolveCanonicalGeminiSources(items = [], { concurrency = 8, timeoutMs = 1800 } = {}) {
  const inputs = Array.isArray(items)
    ? items
      .map((item) => (typeof item === "string" ? { url: item, title: "Grounded source" } : item))
      .filter((item) => isHttpUrl(item?.url))
    : [];
  if (!inputs.length) {
    return {
      sources: [],
      diagnostics: { total: 0, resolved: 0, unresolved: 0 },
    };
  }

  const byUrl = new Map();
  inputs.forEach((item) => {
    const url = cleanText(item?.url);
    if (!url) return;
    if (!byUrl.has(url)) byUrl.set(url, item);
  });
  const uniqueInputs = [...byUrl.values()];
  const out = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 8, 16)) }, async () => {
    while (cursor < uniqueInputs.length) {
      const idx = cursor;
      cursor += 1;
      const raw = uniqueInputs[idx];
      const rawUrl = cleanText(raw?.url);
      const entry = await resolveCanonicalUrl(rawUrl, timeoutMs);
      out.push({
        name: cleanText(raw?.title) || "Grounded source",
        quote: "",
        sourceType: "independent",
        originalRedirectUri: cleanText(entry?.originalRedirectUri || rawUrl),
        url: cleanText(entry?.url || rawUrl),
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

async function callGeminiDeepResearch({
  apiKey,
  messages,
  systemPrompt,
  maxTokens,
  baseUrl = "",
}) {
  const resolvedBase = cleanText(baseUrl).replace(/\/+$/, "");
  const root = resolvedBase && !resolvedBase.includes("/openai")
    ? resolvedBase
    : GEMINI_API_BASE_URL;
  const createEndpoint = `${root}/interactions`;
  const prompt = buildGeminiDeepResearchPrompt(messages, systemPrompt);
  const createBody = {
    agent: GEMINI_DEEP_RESEARCH_AGENT,
    input: prompt,
    background: true,
    store: true,
  };
  const createResponse = await fetch(createEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(createBody),
  });
  const createData = await toJsonBody(createResponse, "Gemini Deep Research create interaction failed");
  const interactionId = cleanText(createData?.name || createData?.id || createData?.interaction?.name);
  if (!interactionId) {
    const err = new Error("Gemini Deep Research did not return an interaction ID.");
    err.status = 502;
    err.payload = createData;
    throw err;
  }

  const pollPath = interactionId.startsWith("interactions/") || interactionId.startsWith("projects/")
    ? interactionId
    : `interactions/${interactionId}`;
  const pollEndpoint = `${root}/${pollPath}`;
  const deadlineAt = Date.now() + GEMINI_DEEP_RESEARCH_MAX_WAIT_MS;
  let latest = createData;
  while (Date.now() < deadlineAt) {
    const state = cleanText(latest?.state || latest?.status || latest?.interaction?.state).toLowerCase();
    if (["succeeded", "complete", "completed", "done"].includes(state)) break;
    if (["failed", "error", "cancelled", "canceled", "expired"].includes(state)) {
      const err = new Error(`Gemini Deep Research interaction failed (${state || "unknown"}).`);
      err.status = 502;
      err.payload = latest;
      throw err;
    }
    await sleep(GEMINI_DEEP_RESEARCH_POLL_MS);
    const pollResponse = await fetch(pollEndpoint, {
      method: "GET",
      headers: {
        "x-goog-api-key": apiKey,
      },
    });
    latest = await toJsonBody(pollResponse, "Gemini Deep Research poll failed");
  }
  const finalState = cleanText(latest?.state || latest?.status || latest?.interaction?.state).toLowerCase();
  if (!["succeeded", "complete", "completed", "done"].includes(finalState)) {
    const err = new Error("Gemini Deep Research polling timed out.");
    err.status = 504;
    err.payload = latest;
    throw err;
  }

  const text = extractGeminiDeepResearchText(latest);
  const usage = extractGeminiDeepResearchUsage(latest) || extractGeminiDeepResearchUsage(createData);
  const outputTokensCap = Math.max(256, Number(maxTokens) || 4000);
  if (!text) {
    const err = new Error("No text content in Gemini Deep Research response.");
    err.reasonCode = GEMINI_EMPTY_SUCCESS_REASON_CODE;
    err.status = 200;
    err.providerId = "gemini";
    err.providerMeta = {
      providerId: "gemini",
      model: GEMINI_DEEP_RESEARCH_AGENT,
      finishReason: normalizeFinishReason(finalState),
      outputTokens: Number(usage?.outputTokens || 0),
      outputTokensCap,
      usage,
    };
    throw err;
  }

  const rawUrls = [
    ...extractHttpUrlsDeep(latest),
    ...extractUrlsFromRenderedContent(text),
  ];
  const grounded = await resolveCanonicalGeminiSources(
    uniqueSourcesFromUrls(rawUrls, "Gemini source").map((source) => ({
      url: source?.url,
      title: source?.name || "Gemini source",
    })),
    {
      concurrency: 8,
      timeoutMs: 1800,
    }
  );
  const webSearchCalls = countGeminiDeepResearchSearchCalls(latest);
  return {
    text,
    sources: grounded.sources,
    rawResponse: {
      interactionCreate: createData,
      interactionFinal: latest,
    },
    meta: {
      providerId: "gemini",
      model: GEMINI_DEEP_RESEARCH_AGENT,
      liveSearchUsed: webSearchCalls > 0,
      webSearchCalls,
      finishReason: normalizeFinishReason(finalState),
      outputTokens: Number(usage?.outputTokens || 0),
      outputTokensCap,
      groundedSourcesResolved: grounded.diagnostics,
      noSearchPerformed: webSearchCalls === 0,
      callFailedGrounding: webSearchCalls > 0 && grounded.sources.length === 0,
      reasonCodes: [],
      usage,
    },
  };
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
  if (deepResearch) {
    return callGeminiDeepResearch({
      apiKey,
      messages,
      systemPrompt,
      maxTokens,
      baseUrl,
    });
  }

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
      },
      ...(withSearch
        ? {
          tools: [{ google_search: {} }],
        }
        : {}),
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
  const firstCandidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const usage = normalizeUsage({
    inputTokens: data?.usageMetadata?.promptTokenCount,
    outputTokens: data?.usageMetadata?.candidatesTokenCount,
    totalTokens: data?.usageMetadata?.totalTokenCount,
  });
  const outputTokensCap = Math.max(256, Number(maxTokens) || 4000);
  if (!text) {
    const err = new Error("No text content in Gemini response.");
    err.reasonCode = GEMINI_EMPTY_SUCCESS_REASON_CODE;
    err.status = 200;
    err.providerId = "gemini";
    err.providerMeta = {
      providerId: "gemini",
      model: cleanText(model),
      finishReason: normalizeFinishReason(firstCandidate?.finishReason || firstCandidate?.finish_reason),
      outputTokens: Number(usage?.outputTokens || 0),
      outputTokensCap,
      usage,
      groundingMetadataKeys: collectGroundingMetadataKeys(data),
    };
    throw err;
  }

  const webSearchCalls = countGeminiSearchCalls(data);
  const groundingSources = extractGeminiGroundingSources(data);
  const grounded = await resolveCanonicalGeminiSources(groundingSources, {
    concurrency: 8,
    timeoutMs: 1800,
  });
  const noSearchPerformed = liveSearch === true && webSearchCalls === 0;
  const callFailedGrounding = liveSearch === true && webSearchCalls > 0 && grounded.sources.length === 0;
  const reasonCodes = [
    ...(noSearchPerformed ? ["stage_03b_no_search_performed"] : []),
    ...(callFailedGrounding ? ["grounding_extraction_failed"] : []),
  ];
  return {
    text,
    sources: grounded.sources,
    rawResponse: data,
    meta: {
      providerId: "gemini",
      model: cleanText(model),
      liveSearchUsed: webSearchCalls > 0,
      webSearchCalls,
      finishReason: normalizeFinishReason(firstCandidate?.finishReason || firstCandidate?.finish_reason),
      outputTokens: Number(usage?.outputTokens || 0),
      outputTokensCap,
      groundedSourcesResolved: grounded.diagnostics,
      noSearchPerformed,
      callFailedGrounding,
      reasonCodes,
      groundingMetadataKeys: collectGroundingMetadataKeys(data),
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
  searchMaxUses = 0,
  deepResearch = false,
  baseUrl = "",
  stageId = "",
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
      searchMaxUses,
      deepResearch,
      baseUrl,
      stageId,
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
      searchMaxUses,
      deepResearch,
      baseUrl,
      stageId,
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
