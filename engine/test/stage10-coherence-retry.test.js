import test from "node:test";
import assert from "node:assert/strict";
import { runStage } from "../pipeline/stages/10-coherence.js";

test("stage 10 retries with compact prompt after timeout/504-like critic failure", async () => {
  const prompts = [];
  let calls = 0;
  const transport = {
    callCritic: async (messages = []) => {
      calls += 1;
      const prompt = String(messages?.[0]?.content || "");
      prompts.push(prompt);
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
  assert.ok(prompts[1].length < prompts[0].length, "fallback prompt should be compacted");
});
