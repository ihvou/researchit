import test from "node:test";
import assert from "node:assert/strict";
import { readAnthropicStream } from "../../app/api/providerCalls.js";

function streamResponse(frames, headers = {}) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        frames.forEach((frame) => controller.enqueue(encoder.encode(frame)));
        controller.close();
      },
    }),
  };
}

function event(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("readAnthropicStream reconstructs text, tool blocks, usage, and URLs", async () => {
  const response = streamResponse([
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        usage: { input_tokens: 123, output_tokens: 1 },
      },
    }),
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello " },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "world" },
    }),
    event("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "server_tool_use", id: "srv_1", name: "web_search" },
    }),
    event("content_block_start", {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "web_search_tool_result",
        content: [{ url: "https://example.com/source", title: "Source" }],
      },
    }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 9, server_tool_use: { web_search_requests: 1 } },
    }),
    event("message_stop", { type: "message_stop" }),
  ]);

  const out = await readAnthropicStream(response, { idleTimeoutMs: 1000, totalTimeoutMs: 5000 });

  assert.equal(out.id, "msg_1");
  assert.equal(out.model, "claude-sonnet-4-6");
  assert.equal(out.stop_reason, "end_turn");
  assert.equal(out.usage.input_tokens, 123);
  assert.equal(out.usage.output_tokens, 9);
  assert.equal(out.usage.server_tool_use.web_search_requests, 1);
  assert.equal(out.content[0].text, "Hello world");
  assert.equal(out.content[1].type, "server_tool_use");
  assert.equal(out.content[2].content[0].url, "https://example.com/source");
});

test("readAnthropicStream converts mid-stream error events into structured errors", async () => {
  const response = streamResponse([
    event("message_start", {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", content: [] },
    }),
    event("error", {
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    }),
  ]);

  await assert.rejects(
    () => readAnthropicStream(response, { idleTimeoutMs: 1000, totalTimeoutMs: 5000 }),
    (err) => {
      assert.equal(err.streamEvent, "error");
      assert.equal(err.providerEventType, "overloaded_error");
      assert.equal(err.status, 529);
      assert.match(err.message, /Overloaded/);
      return true;
    }
  );
});

test("readAnthropicStream classifies undici terminated streams as provider timeouts", async () => {
  const response = {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream({
      pull(controller) {
        const err = new TypeError("terminated");
        err.cause = { name: "AbortError", code: "UND_ERR_ABORTED" };
        controller.error(err);
      },
    }),
  };

  await assert.rejects(
    () => readAnthropicStream(response, { idleTimeoutMs: 1000, totalTimeoutMs: 5000 }),
    (err) => {
      assert.equal(err.status, 504);
      assert.equal(err.code, "PROVIDER_TIMEOUT");
      assert.match(err.message, /timed out after/);
      return true;
    }
  );
});
