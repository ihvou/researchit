import { createTransport } from "@researchit/engine";

async function callRoute(role, payload) {
  let res;
  try {
    res = await fetch(`/api/${role}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
  } catch (err) {
    const networkErr = new Error(err?.message || `Network error: /api/${role}`);
    networkErr.role = role;
    networkErr.retryable = true;
    throw networkErr;
  }

  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed: /api/${role} (${res.status})`);
    err.status = res.status;
    err.role = role;
    err.retryable = [408, 409, 425, 429, 500, 502, 503, 504].includes(res.status);
    throw err;
  }

  if (data?.error) {
    const err = new Error(data.error || `Request failed: /api/${role}`);
    err.status = Number(data?.status) || 500;
    err.role = role;
    err.retryable = [408, 409, 425, 429, 500, 502, 503, 504].includes(err.status);
    throw err;
  }

  if (!data || typeof data !== "object") {
    const err = new Error(`Invalid JSON response: /api/${role}`);
    err.role = role;
    err.retryable = true;
    throw err;
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
