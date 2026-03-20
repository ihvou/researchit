async function callRoute(route, messages, systemPrompt, maxTokens) {
  const res = await fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, systemPrompt, maxTokens }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.text;
}

export function callAnalystAPI(messages, systemPrompt, maxTokens = 5000) {
  return callRoute("/api/analyst", messages, systemPrompt, maxTokens);
}

export function callCriticAPI(messages, systemPrompt, maxTokens = 5000) {
  return callRoute("/api/critic", messages, systemPrompt, maxTokens);
}
