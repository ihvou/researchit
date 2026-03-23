async function callRoute(route, messages, systemPrompt, maxTokens, extra = {}) {
  const res = await fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, systemPrompt, maxTokens, ...extra }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function callAnalystAPI(messages, systemPrompt, maxTokens = 5000, options = {}) {
  const data = await callRoute("/api/analyst", messages, systemPrompt, maxTokens, {
    liveSearch: !!options.liveSearch,
  });
  if (options.includeMeta) return data;
  return data.text;
}

export async function callCriticAPI(messages, systemPrompt, maxTokens = 5000, options = {}) {
  const data = await callRoute("/api/critic", messages, systemPrompt, maxTokens, {
    liveSearch: !!options.liveSearch,
  });
  if (options.includeMeta) return data;
  return data.text;
}
