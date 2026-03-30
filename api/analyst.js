function normalizeMessageContent(content) {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function buildChatMessages(systemPrompt, messages) {
  return [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: normalizeMessageContent(m.content) })),
  ];
}

function buildResponsesInput(systemPrompt, messages) {
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

function extractResponsesText(data) {
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

function countWebSearchCalls(payload) {
  let count = 0;
  const stack = [payload];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (node.type === "web_search_call" || node.type === "web_search_preview_call") count++;
    for (const value of Object.values(node)) stack.push(value);
  }
  return count;
}

async function callChatCompletions(apiKey, systemPrompt, messages, maxTokens, extraMeta = {}) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      max_completion_tokens: maxTokens,
      messages: buildChatMessages(systemPrompt, messages),
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const text = extractChatCompletionsText(data);
  if (!text) {
    // Fallback for non-string/no-text chat payload variants.
    const fallback = await callResponsesTextOnly(apiKey, systemPrompt, messages, maxTokens, {
      ...extraMeta,
      chatCompletionNoTextFallback: true,
    });
    return fallback;
  }

  return {
    text,
    meta: {
      liveSearchUsed: false,
      webSearchCalls: 0,
      ...extraMeta,
    },
  };
}

async function callResponsesTextOnly(apiKey, systemPrompt, messages, maxTokens, extraMeta = {}) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      max_output_tokens: maxTokens,
      input: buildResponsesInput(systemPrompt, messages),
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const text = extractResponsesText(data);
  if (!text) throw new Error("No text content in OpenAI responses output");

  return {
    text,
    meta: {
      liveSearchUsed: false,
      webSearchCalls: 0,
      ...extraMeta,
    },
  };
}

async function callResponsesWithWebSearch(apiKey, systemPrompt, messages, maxTokens) {
  const toolTypes = ["web_search", "web_search_preview"];
  let lastErr;

  for (const toolType of toolTypes) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        max_output_tokens: maxTokens,
        input: buildResponsesInput(systemPrompt, messages),
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
        liveSearchUsed: true,
        webSearchCalls: countWebSearchCalls(data),
      },
    };
  }

  throw lastErr || new Error("Web search responses call failed");
}

// Analyst model configured for budget/quality balance.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { messages, systemPrompt, maxTokens = 5000, liveSearch = false } = req.body;

  if (!messages || !systemPrompt) {
    return res.status(400).json({ error: "Missing messages or systemPrompt" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
  }

  try {
    if (liveSearch) {
      try {
        const result = await callResponsesWithWebSearch(apiKey, systemPrompt, messages, maxTokens);
        return res.status(200).json(result);
      } catch (webErr) {
        const fallback = await callChatCompletions(apiKey, systemPrompt, messages, maxTokens, {
          liveSearchRequested: true,
          liveSearchFallbackReason: webErr.message,
        });
        return res.status(200).json(fallback);
      }
    }

    const result = await callChatCompletions(apiKey, systemPrompt, messages, maxTokens);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
