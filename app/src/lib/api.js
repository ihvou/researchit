import { createTransport } from "@researchit/engine";

async function callRoute(role, payload) {
  const res = await fetch(`/api/${role}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!res.ok || data?.error) {
    throw new Error(data?.error || `Request failed: /api/${role}`);
  }
  return data;
}

export const appTransport = createTransport(callRoute);

export async function callAnalystAPI(messages, systemPrompt, maxTokens = 5000, options = {}) {
  return appTransport.callAnalyst(messages, systemPrompt, maxTokens, options);
}

export async function callCriticAPI(messages, systemPrompt, maxTokens = 5000, options = {}) {
  return appTransport.callCritic(messages, systemPrompt, maxTokens, options);
}

export async function fetchSourceSnapshot(url) {
  return appTransport.fetchSource(url);
}
