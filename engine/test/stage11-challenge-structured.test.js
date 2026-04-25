import test from "node:test";
import assert from "node:assert/strict";
import { runStage } from "../pipeline/stages/11-challenge.js";

test("stage 11 embeds valid JSON assessment and coherence snapshots", async () => {
  let prompt = "";
  const transport = {
    callCritic: async (messages = [], _systemPrompt = "", _maxTokens = 0, options = {}) => {
      assert.equal(options?.retry?.maxRetries, 0);
      prompt = String(messages?.[0]?.content || "");
      return { text: "{\"flags\":[]}", meta: {} };
    },
  };
  const context = {
    state: {
      outputType: "matrix",
      assessment: {
        matrix: {
          cells: Array.from({ length: 30 }, (_, idx) => ({
            subjectId: `s${idx + 1}`,
            attributeId: "a1",
            value: "value ".repeat(20),
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
      critique: {
        coherenceFindings: Array.from({ length: 12 }, (_, idx) => ({
          id: `coherence-${idx + 1}`,
          unitKey: `s${idx + 1}::a1`,
          severity: "medium",
          note: "coherence note ".repeat(30),
        })),
      },
    },
    runtime: {
      transport,
      prompts: { critic: "critic" },
      config: { models: { critic: { provider: "anthropic", model: "claude-sonnet-4-6" } } },
      budgets: {
        stage_11_challenge: { tokenBudget: 8000, timeoutMs: 1000, retryMax: 0 },
      },
    },
  };

  const out = await runStage(context);
  const assessment = prompt.match(/Assessment:\n([\s\S]*?)\nCoherence findings:/)?.[1];
  const coherence = prompt.match(/Coherence findings:\n([\s\S]*?)\n\nSchema:/)?.[1];

  assert.equal(out.stageStatus, "ok");
  assert.equal(out.diagnostics.promptSnapshot.assessment.validJsonSnapshot, true);
  assert.equal(out.diagnostics.promptSnapshot.coherence.validJsonSnapshot, true);
  assert.ok(assessment);
  assert.ok(coherence);
  assert.doesNotThrow(() => JSON.parse(assessment));
  assert.doesNotThrow(() => JSON.parse(coherence));
});
