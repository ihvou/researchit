import test from "node:test";
import assert from "node:assert/strict";

process.env.RESEARCHIT_OPENAI_DEEP_RESEARCH_POLL_MS = "1000";
process.env.RESEARCHIT_OPENAI_DEEP_RESEARCH_MAX_WAIT_MS = "1200";

const { callOpenAI, readOpenAIResponsesStream } = await import("../providers/openai.js");

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(frames) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      frames.forEach((frame) => controller.enqueue(encoder.encode(frame)));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function event(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("OpenAI Deep Research uses background mode and polls to completion", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options?.method || "GET",
      headers: options?.headers || {},
      body: options?.body ? JSON.parse(options.body) : null,
    });
    if (calls.length === 1) {
      return jsonResponse({ id: "resp_123", status: "in_progress" });
    }
    return jsonResponse({
      id: "resp_123",
      status: "completed",
      output_text: "{\"ok\":true}",
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    });
  };

  try {
    const result = await callOpenAI({
      apiKey: "sk-test",
      model: "o3-deep-research",
      webSearchModel: "o3-deep-research",
      messages: [{ role: "user", content: "research this" }],
      systemPrompt: "system",
      maxTokens: 1000,
      liveSearch: true,
      deepResearch: true,
      baseUrl: "https://mock.openai.test",
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://mock.openai.test/v1/responses");
    assert.equal(calls[0].body.background, true);
    assert.equal(calls[0].body.store, true);
    assert.deepEqual(calls[0].body.tools, [
      { type: "web_search_preview" },
      { type: "code_interpreter", container: { type: "auto" } },
    ]);
    assert.equal(calls[1].url, "https://mock.openai.test/v1/responses/resp_123");
    assert.equal(result.text, "{\"ok\":true}");
    assert.equal(result.meta.openaiDeepResearch.requestBackground, true);
    assert.equal(result.meta.openaiDeepResearch.finalStatus, "completed");
    assert.equal(result.meta.openaiDeepResearch.pollCount, 1);
    assert.deepEqual(result.meta.openaiDeepResearch.toolsEnabled, ["web_search_preview", "code_interpreter"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI Deep Research terminal failure throws with payload preserved", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    if (calls.length === 1) {
      return jsonResponse({ id: "resp_failed", status: "queued" });
    }
    return jsonResponse({
      id: "resp_failed",
      status: "failed",
      error: { message: "background job failed" },
    });
  };

  try {
    await assert.rejects(
      () => callOpenAI({
        apiKey: "sk-test",
        model: "o3-deep-research",
        webSearchModel: "o3-deep-research",
        messages: [{ role: "user", content: "research this" }],
        systemPrompt: "system",
        maxTokens: 1000,
        liveSearch: true,
        deepResearch: true,
        baseUrl: "https://mock.openai.test",
      }),
      (err) => {
        assert.equal(err.status, 502);
        assert.equal(err.payload.status, "failed");
        assert.match(err.reasonCode, /openai_deep_research_failed/);
        return true;
      }
    );
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI live-search SSE stream reconstructs a Responses-like payload", async () => {
  const response = streamResponse([
    event("response.output_text.delta", { type: "response.output_text.delta", delta: "Hello " }),
    event("response.output_text.delta", { type: "response.output_text.delta", delta: "world" }),
    event("response.completed", {
      type: "response.completed",
      response: {
        status: "completed",
        output_text: "Hello world",
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    }),
  ]);

  const parsed = await readOpenAIResponsesStream(response);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.output_text, "Hello world");
  assert.equal(parsed.usage.total_tokens, 6);
});

test("OpenAI non-deep live search requests SSE transport", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      headers: options?.headers || {},
      body: options?.body ? JSON.parse(options.body) : null,
    });
    return streamResponse([
      event("response.completed", {
        type: "response.completed",
        response: {
          status: "completed",
          output_text: "{\"ok\":true}",
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      }),
    ]);
  };

  try {
    const result = await callOpenAI({
      apiKey: "sk-test",
      model: "gpt-5.4",
      webSearchModel: "gpt-5.4",
      messages: [{ role: "user", content: "search this" }],
      systemPrompt: "system",
      maxTokens: 1000,
      liveSearch: true,
      deepResearch: false,
      baseUrl: "https://mock.openai.test",
    });

    assert.equal(calls[0].headers.Accept, "text/event-stream");
    assert.equal(calls[0].body.stream, true);
    assert.equal(result.text, "{\"ok\":true}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
