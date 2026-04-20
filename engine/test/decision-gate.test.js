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

test("decision gate fails citation coverage when strict-source citations are mostly unresolved", () => {
  const state = baseState();
  state.assessment.scorecard.byId.a.sources = [
    { sourceType: "research", verificationTier: "fabricated", citationStatus: "not_found" },
    { sourceType: "research", verificationTier: "unverifiable", citationStatus: "unverifiable" },
  ];
  state.assessment.scorecard.byId.b.sources = [
    { sourceType: "government", verificationTier: "verified", citationStatus: "verified" },
    { sourceType: "news", verificationTier: "fabricated", citationStatus: "not_found" },
  ];

  const result = evaluateDecisionGate(state, {
    minCoverageRatio: 0.5,
    maxLowConfidenceRatio: 0.8,
    minSourcesPerCriticalUnit: 1,
    minIndependentSourcesPerCriticalUnit: 0,
    maxUnresolvedCriticFlags: 0,
    maxUnverifiedSourceRatio: 0.9,
    maxFabricatedSourceRatio: 0.25,
  });

  assert.equal(result.passed, false);
  assert.equal(result.checks.fabrication, false);
  assert.ok(result.reasonCodes.includes("decision_gate_failed"));
  assert.ok(result.reasonCodes.includes("decision_gate_fabrication_flagged"));
});

test("decision gate does not fail on infrastructure-unreachable sources alone", () => {
  const state = baseState();
  state.assessment.scorecard.byId.a.sources = [
    { sourceType: "research", verificationTier: "unreachable_infrastructure", citationStatus: "unverifiable" },
    { sourceType: "research", verificationTier: "unreachable_infrastructure", citationStatus: "unverifiable" },
  ];
  state.assessment.scorecard.byId.b.sources = [
    { sourceType: "government", verificationTier: "verified", citationStatus: "verified" },
    { sourceType: "news", verificationTier: "unreachable_infrastructure", citationStatus: "unverifiable" },
  ];

  const result = evaluateDecisionGate(state, {
    minCoverageRatio: 0.5,
    maxLowConfidenceRatio: 0.8,
    minSourcesPerCriticalUnit: 1,
    minIndependentSourcesPerCriticalUnit: 0,
    maxUnresolvedCriticFlags: 0,
    maxUnverifiedSourceRatio: 0.1,
    maxFabricatedSourceRatio: 0.1,
  });

  assert.equal(result.checks.citationCoverage, true);
  assert.equal(result.checks.fabrication, true);
});
