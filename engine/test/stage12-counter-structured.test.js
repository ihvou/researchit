import test from "node:test";
import assert from "node:assert/strict";
import { runStage } from "../pipeline/stages/12-counter.js";

test("stage 12 embeds valid JSON flag and claim snapshots", async () => {
  let prompt = "";
  const transport = {
    callCritic: async (messages = [], _systemPrompt = "", _maxTokens = 0, options = {}) => {
      assert.equal(options?.retry?.maxRetries, 0);
      prompt = String(messages?.[0]?.content || "");
      return {
        text: JSON.stringify({
          counterEvidence: [{
            flagId: "flag-1",
            unitKey: "s1::a1",
            note: "Counter evidence note.",
            severityIfWrong: "medium",
            sources: [],
          }],
          summary: "ok",
        }),
        meta: {},
      };
    },
  };
  const context = {
    state: {
      outputType: "matrix",
      critique: {
        flags: Array.from({ length: 20 }, (_, idx) => ({
          id: `flag-${idx + 1}`,
          unitKey: `s${idx + 1}::a1`,
          severity: "medium",
          category: "overclaim",
          note: "flag note ".repeat(40),
        })),
      },
      assessment: {
        matrix: {
          cells: Array.from({ length: 20 }, (_, idx) => ({
            subjectId: `s${idx + 1}`,
            attributeId: "a1",
            value: "value ".repeat(25),
            full: "full evidence ".repeat(120),
            confidence: "medium",
            confidenceReason: "reason ".repeat(30),
            sources: Array.from({ length: 8 }, (__, sourceIdx) => ({
              name: `source-${sourceIdx}`,
              url: `https://example.com/${idx}/${sourceIdx}`,
              quote: "quote ".repeat(35),
            })),
            arguments: {
              supporting: Array.from({ length: 8 }, (__, claimIdx) => ({
                claim: `support-${claimIdx}`,
                detail: "detail ".repeat(30),
              })),
              limiting: [],
            },
          })),
        },
      },
    },
    runtime: {
      transport,
      prompts: { critic: "critic" },
      config: { models: { critic: { provider: "anthropic", model: "claude-sonnet-4-6" } } },
      budgets: {
        stage_12_counter_case: { tokenBudget: 8000, timeoutMs: 1000, retryMax: 0 },
      },
    },
  };

  const out = await runStage(context);
  const flags = prompt.match(/Flags:\n([\s\S]*?)\nOriginal assessed claims:/)?.[1];
  const claims = prompt.match(/Original assessed claims:\n([\s\S]*?)\n\nSchema:/)?.[1];

  assert.equal(out.stageStatus, "ok");
  assert.equal(out.diagnostics.promptSnapshot.flags.validJsonSnapshot, true);
  assert.equal(out.diagnostics.promptSnapshot.claims.validJsonSnapshot, true);
  assert.ok(flags);
  assert.ok(claims);
  assert.doesNotThrow(() => JSON.parse(flags));
  assert.doesNotThrow(() => JSON.parse(claims));
});
