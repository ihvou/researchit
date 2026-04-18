import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDecisionGate } from "../lib/guards/decision-gate.js";

function baseState() {
  return {
    outputType: "scorecard",
    assessment: {
      scorecard: {
        byId: {
          a: {
            id: "a",
            confidence: "high",
            sources: [
              { sourceType: "independent", verificationStatus: "verified_in_page" },
              { sourceType: "research", verificationStatus: "verified_in_page" },
            ],
          },
          b: {
            id: "b",
            confidence: "medium",
            sources: [
              { sourceType: "independent", verificationStatus: "verified_in_page" },
              { sourceType: "research", verificationStatus: "verified_in_page" },
            ],
          },
        },
      },
    },
    resolved: {
      flagOutcomes: [],
      unresolvedHighSeverityCount: 0,
    },
  };
}

test("decision gate passes when all checks are satisfied", () => {
  const result = evaluateDecisionGate(baseState(), {
    minCoverageRatio: 0.5,
    maxLowConfidenceRatio: 0.5,
    minSourcesPerCriticalUnit: 2,
    minIndependentSourcesPerCriticalUnit: 1,
    maxUnresolvedCriticFlags: 0,
  });

  assert.equal(result.passed, true);
  assert.equal(result.reasonCodes.length, 0);
});

test("decision gate fails on unresolved high-severity flag without mitigation", () => {
  const state = baseState();
  state.resolved.flagOutcomes = [
    {
      resolved: false,
      mitigationNote: "",
      flag: { severity: "high" },
    },
  ];

  const result = evaluateDecisionGate(state, {
    minCoverageRatio: 0.5,
    maxLowConfidenceRatio: 0.5,
    minSourcesPerCriticalUnit: 1,
    minIndependentSourcesPerCriticalUnit: 0,
    maxUnresolvedCriticFlags: 5,
  });

  assert.equal(result.passed, false);
  assert.equal(result.checks.highSeverityCoverage, false);
  assert.ok(result.reasonCodes.includes("decision_gate_failed"));
});
