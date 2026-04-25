import test from "node:test";
import assert from "node:assert/strict";
import { runStage } from "../pipeline/stages/10-coherence.js";

test("stage 10 retries with compact prompt after timeout/504-like critic failure", async () => {
  const prompts = [];
  const optionsSeen = [];
  let calls = 0;
  const transport = {
    callCritic: async (messages = [], _systemPrompt = "", _maxTokens = 0, options = {}) => {
      calls += 1;
      const prompt = String(messages?.[0]?.content || "");
      prompts.push(prompt);
      optionsSeen.push(options);
      if (calls === 1) {
        const err = new Error("Request failed: /api/critic (504)");
        err.status = 504;
        throw err;
      }
      return { text: "{\"findings\":[],\"overallFeedback\":\"ok\"}", meta: {} };
    },
  };

  const context = {
    state: {
      outputType: "matrix",
      assessment: {
        matrix: {
          cells: Array.from({ length: 20 }, (_, idx) => ({
            subjectId: `s-${idx + 1}`,
            attributeId: "attr-a",
            value: "value ".repeat(40),
            full: "full text ".repeat(180),
            confidence: "medium",
            confidenceReason: "reason ".repeat(20),
            sources: Array.from({ length: 8 }, (__, sIdx) => ({
              name: `source-${sIdx + 1}`,
              url: `https://example.com/${idx + 1}/${sIdx + 1}`,
              quote: "quote ".repeat(50),
              sourceType: "independent",
            })),
            arguments: {
              supporting: Array.from({ length: 8 }, (__, aIdx) => ({
                claim: `support-${aIdx + 1}`,
                detail: "detail ".repeat(40),
              })),
              limiting: [],
            },
            risks: "risk ".repeat(30),
            missingEvidence: "missing ".repeat(30),
          })),
        },
      },
    },
    runtime: {
      transport,
      prompts: { critic: "critic" },
      config: { models: { critic: { provider: "anthropic", model: "claude-sonnet-4-6" } } },
      budgets: {
        stage_10_coherence: { tokenBudget: 8000, timeoutMs: 1000, retryMax: 0 },
      },
    },
  };

  const out = await runStage(context);

  assert.equal(out.stageStatus, "ok");
  assert.equal(calls, 2);
  assert.equal(out.diagnostics.compactRetryUsed, true);
  assert.ok(out.reasonCodes.includes("critic_compact_retry_used"));
  assert.equal(optionsSeen.every((options) => options?.retry?.maxRetries === 0), true);
  assert.ok(prompts[1].length < prompts[0].length, "fallback prompt should be compacted");
});

test("stage 10 retries full prompt once after rate limit before compact fallback", async () => {
  const attempts = [];
  let calls = 0;
  const transport = {
    callCritic: async (messages = []) => {
      calls += 1;
      attempts.push(String(messages?.[0]?.content || ""));
      if (calls === 1) {
        const err = new Error("rate limit");
        err.status = 429;
        err.retryAfterMs = 1;
        throw err;
      }
      return { text: "{\"findings\":[],\"overallFeedback\":\"ok\"}", meta: {} };
    },
  };

  const context = {
    state: {
      outputType: "matrix",
      assessment: {
        matrix: {
          cells: [{
            subjectId: "s1",
            attributeId: "a1",
            value: "value",
            full: "full text",
            confidence: "medium",
            confidenceReason: "reason",
            sources: [],
            arguments: { supporting: [], limiting: [] },
          }],
        },
      },
    },
    runtime: {
      transport,
      prompts: { critic: "critic" },
      config: { models: { critic: { provider: "anthropic", model: "claude-sonnet-4-6" } } },
      budgets: {
        stage_10_coherence: {
          tokenBudget: 8000,
          timeoutMs: 1000,
          retryMax: 0,
          rateLimitInitialBackoffMs: 1,
          rateLimitMaxBackoffMs: 1,
          rateLimitRetrySkewMs: 0,
        },
      },
    },
  };

  const out = await runStage(context);

  assert.equal(out.stageStatus, "ok");
  assert.equal(calls, 2);
  assert.equal(out.diagnostics.compactRetryUsed, false);
  assert.deepEqual(out.diagnostics.criticRetryAttempts, ["primary", "primary_rate_limit_retry"]);
  assert.equal(attempts[0], attempts[1]);
});

test("stage 10 uses compact fallback after Anthropic stream error event", async () => {
  const prompts = [];
  let calls = 0;
  const transport = {
    callCritic: async (messages = []) => {
      calls += 1;
      prompts.push(String(messages?.[0]?.content || ""));
      if (calls === 1) {
        const err = new Error("Overloaded");
        err.status = 529;
        err.streamEvent = "error";
        err.providerEventType = "overloaded_error";
        throw err;
      }
      return { text: "{\"findings\":[],\"overallFeedback\":\"ok\"}", meta: {} };
    },
  };

  const context = {
    state: {
      outputType: "matrix",
      assessment: {
        matrix: {
          cells: Array.from({ length: 12 }, (_, idx) => ({
            subjectId: `s${idx}`,
            attributeId: "a1",
            value: "value ".repeat(20),
            full: "full text ".repeat(80),
            confidence: "medium",
            confidenceReason: "reason",
            sources: [],
            arguments: { supporting: [], limiting: [] },
          })),
        },
      },
    },
    runtime: {
      transport,
      prompts: { critic: "critic" },
      config: { models: { critic: { provider: "anthropic", model: "claude-sonnet-4-6" } } },
      budgets: {
        stage_10_coherence: { tokenBudget: 8000, timeoutMs: 1000, retryMax: 0 },
      },
    },
  };

  const out = await runStage(context);

  assert.equal(calls, 2);
  assert.equal(out.diagnostics.compactRetryUsed, true);
  assert.ok(out.reasonCodes.includes("critic_compact_retry_used"));
  assert.ok(prompts[1].length < prompts[0].length);
});

test("stage 10 embeds a valid JSON assessment snapshot", async () => {
  let prompt = "";
  const transport = {
    callCritic: async (messages = []) => {
      prompt = String(messages?.[0]?.content || "");
      return { text: "{\"findings\":[],\"overallFeedback\":\"ok\"}", meta: {} };
    },
  };

  const context = {
    state: {
      outputType: "matrix",
      assessment: {
        matrix: {
          cells: Array.from({ length: 30 }, (_, idx) => ({
            subjectId: `s-${idx}`,
            attributeId: "a1",
            value: "value ".repeat(15),
            full: "full ".repeat(100),
            confidence: "medium",
            confidenceReason: "verified ".repeat(30),
            sources: Array.from({ length: 6 }, (__, sourceIdx) => ({
              name: `source-${sourceIdx}`,
              url: `https://example.com/${idx}/${sourceIdx}`,
              quote: "quote ".repeat(30),
            })),
            arguments: { supporting: [], limiting: [] },
          })),
        },
      },
    },
    runtime: {
      transport,
      prompts: { critic: "critic" },
      config: { models: { critic: { provider: "anthropic", model: "claude-sonnet-4-6" } } },
      budgets: {
        stage_10_coherence: { tokenBudget: 8000, timeoutMs: 1000, retryMax: 0 },
      },
    },
  };

  const out = await runStage(context);
  const snapshot = prompt.match(/Assessment snapshot:\n([\s\S]*?)\n\nSchema:/)?.[1];

  assert.equal(out.diagnostics.promptSnapshot.validJsonSnapshot, true);
  assert.ok(snapshot);
  assert.doesNotThrow(() => JSON.parse(snapshot));
});
