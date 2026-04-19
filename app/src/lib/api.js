import { createTransport, DEFAULT_RETRYABLE_STATUS } from "@researchit/engine";
import { appendRunDebugNetworkEvent } from "./debug";

async function callRoute(role, payload, runtime = {}) {
  appendRunDebugNetworkEvent({
    channel: "transport",
    direction: "request",
    role,
    payload,
  });

  let res;
  try {
    res = await fetch(`/api/${role}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: runtime?.signal,
    });
  } catch (err) {
    appendRunDebugNetworkEvent({
      channel: "transport",
      direction: "error",
      role,
      error: err?.message || String(err),
      stage: "fetch",
    });
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

  appendRunDebugNetworkEvent({
    channel: "transport",
    direction: "response",
    role,
    status: res.status,
    ok: res.ok,
    data,
  });

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed: /api/${role} (${res.status})`);
    err.status = res.status;
    err.role = role;
    err.retryable = DEFAULT_RETRYABLE_STATUS.includes(res.status);
    if (typeof data?.reasonCode === "string" && data.reasonCode.trim()) {
      err.reasonCode = data.reasonCode.trim();
    }
    throw err;
  }

  if (data?.error) {
    const err = new Error(data.error || `Request failed: /api/${role}`);
    err.status = Number(data?.status || data?.sourceFetchStatus) || 500;
    err.role = role;
    err.retryable = DEFAULT_RETRYABLE_STATUS.includes(err.status);
    if (data?.sourceFetchStatus != null) err.sourceFetchStatus = String(data.sourceFetchStatus);
    if (data?.resolvedUrl != null) err.resolvedUrl = String(data.resolvedUrl || "");
    if (data?.url != null) err.url = String(data.url || "");
    if (typeof data?.reasonCode === "string" && data.reasonCode.trim()) {
      err.reasonCode = data.reasonCode.trim();
    }
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
