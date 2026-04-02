function normalizeMessageContent(content) {
  return typeof content === "string" ? content : JSON.stringify(content);
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

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const text = extractResponsesText(data);
  if (!text) throw new Error("No text content in OpenAI responses output");

  return {
    text,
    meta: {
      model,
      liveSearchUsed: false,
      webSearchCalls: 0,
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

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const text = extractChatCompletionsText(data);
  if (!text) {
    const fallback = await callResponsesTextOnly({
      apiKey,
      model,
      messages,
      systemPrompt,
      maxTokens,
      baseUrl,
      extraMeta: {
        ...extraMeta,
        chatCompletionNoTextFallback: true,
      },
    });
    return fallback;
  }

  return {
    text,
    meta: {
      model,
      liveSearchUsed: false,
      webSearchCalls: 0,
      ...extraMeta,
    },
  };
}

async function callResponsesWithWebSearch({ apiKey, model, messages, systemPrompt, maxTokens, baseUrl }) {
  const toolTypes = ["web_search", "web_search_preview"];
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

    const data = await response.json();
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
      meta: {
        model,
        liveSearchUsed: true,
        webSearchCalls: countWebSearchCalls(data),
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
    try {
      return await callResponsesWithWebSearch({
        apiKey,
        model: searchModel,
        messages,
        systemPrompt,
        maxTokens,
        baseUrl,
      });
    } catch (webErr) {
      return callChatCompletions({
        apiKey,
        model: searchModel,
        messages,
        systemPrompt,
        maxTokens,
        baseUrl,
        extraMeta: {
          liveSearchRequested: true,
          liveSearchFallbackReason: webErr.message,
        },
      });
    }
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
