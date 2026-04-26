import test from "node:test";
import assert from "node:assert/strict";

process.env.RESEARCHIT_GEMINI_DEEP_RESEARCH_POLL_MS = "1000";
process.env.RESEARCHIT_GEMINI_DEEP_RESEARCH_MAX_WAIT_MS = "1200";
delete process.env.RESEARCHIT_GEMINI_DEEP_RESEARCH_AGENT;
delete process.env.GEMINI_DEEP_RESEARCH_AGENT;

const { callProviderModel } = await import("../../app/api/providerCalls.js");

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Gemini Deep Research uses Deep Research Max agent with UI-parity capabilities", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options?.method || "GET",
      body: options?.body ? JSON.parse(options.body) : null,
    });
    if (calls.length === 1) {
      return jsonResponse({ name: "interactions/gemini-test", state: "running" });
    }
    return jsonResponse({
      name: "interactions/gemini-test",
      state: "completed",
      responseText: "{\"cells\":[]}",
      output: [{ type: "google_search" }],
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 7,
        totalTokenCount: 18,
      },
    });
  };

  try {
    const result = await callProviderModel({
      providerId: "gemini",
      apiKey: "AIza-test",
      model: "deep-research-max-preview-04-2026",
      webSearchModel: "deep-research-max-preview-04-2026",
      messages: [{ role: "user", content: "research this" }],
      systemPrompt: "system",
      maxTokens: 1000,
      liveSearch: true,
      deepResearch: true,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(calls[0].body.agent, "deep-research-max-preview-04-2026");
    assert.equal(calls[0].body.background, true);
    assert.equal(calls[0].body.store, true);
    assert.deepEqual(calls[0].body.agent_config, {
      type: "deep-research",
      thinking_summaries: "auto",
      visualization: "auto",
      collaborative_planning: false,
    });
    assert.equal(calls[1].url, "https://generativelanguage.googleapis.com/v1beta/interactions/gemini-test");
    assert.equal(result.text, "{\"cells\":[]}");
    assert.equal(result.meta.geminiDeepResearch.agent, "deep-research-max-preview-04-2026");
    assert.equal(result.meta.geminiDeepResearch.pollIntervalMs, 1000);
    assert.equal(result.meta.geminiDeepResearch.maxWaitMs, 1200);
    assert.equal(result.meta.geminiDeepResearch.capabilitiesEnabled.visualization, "auto");
    assert.equal(result.meta.geminiDeepResearch.capabilitiesEnabled.thinking_summaries, "auto");
    assert.equal(result.meta.geminiDeepResearch.capabilitiesEnabled.collaborative_planning, false);
    assert.equal(result.meta.deepResearchParity.geminiAgent, "deep-research-max-preview-04-2026");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini Deep Research retries with minimal agent_config if preview fields are rejected", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options?.method || "GET",
      body: options?.body ? JSON.parse(options.body) : null,
    });
    if (calls.length === 1) {
      return jsonResponse({ error: { message: "Unknown field: visualization in agent_config" } }, 400);
    }
    if (calls.length === 2) {
      return jsonResponse({ name: "interactions/gemini-fallback", state: "running" });
    }
    return jsonResponse({
      name: "interactions/gemini-fallback",
      state: "completed",
      responseText: "{\"cells\":[]}",
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 7,
        totalTokenCount: 18,
      },
    });
  };

  try {
    const result = await callProviderModel({
      providerId: "gemini",
      apiKey: "AIza-test",
      model: "deep-research-max-preview-04-2026",
      webSearchModel: "deep-research-max-preview-04-2026",
      messages: [{ role: "user", content: "research this" }],
      systemPrompt: "system",
      maxTokens: 1000,
      liveSearch: true,
      deepResearch: true,
    });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].body.agent_config, {
      type: "deep-research",
      thinking_summaries: "auto",
    });
    assert.equal(result.meta.geminiDeepResearch.agentConfigFallbackUsed, true);
    assert.deepEqual(result.meta.reasonCodes, ["gemini_deep_research_agent_config_fallback"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
