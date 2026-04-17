import assert from "node:assert/strict";
import test from "node:test";
import { __test__ as matrixTest } from "../pipeline/matrix.js";

function repeatPhrase(base, count = 40) {
  return Array.from({ length: count }, () => base).join(" ");
}

function makeSubjects(count = 18) {
  return Array.from({ length: count }, (_, idx) => ({
    id: `subject-${idx + 1}`,
    label: `Subject ${idx + 1}`,
  }));
}

function makeAttributes(count = 10) {
  return Array.from({ length: count }, (_, idx) => ({
    id: `attr-${idx + 1}`,
    label: `Attribute ${idx + 1}`,
    brief: repeatPhrase(`Attribute ${idx + 1} brief.`, 6),
  }));
}

function makeSources(count = 4, seed = "seed") {
  return Array.from({ length: count }, (_, idx) => ({
    name: `Source ${seed}-${idx + 1}`,
    url: `https://example.com/${seed}/${idx + 1}?utm_source=test&utm_campaign=budget`,
    quote: repeatPhrase(`Quote ${seed}-${idx + 1}`, 16),
    sourceType: idx % 3 === 0 ? "independent" : (idx % 3 === 1 ? "press" : "vendor"),
    verificationStatus: idx % 2 === 0 ? "verified_in_page" : "name_only_in_page",
    verificationNote: repeatPhrase(`Verification note ${seed}-${idx + 1}`, 6),
  }));
}

function makeArguments(seed = "seed") {
  return {
    supporting: [
      {
        id: `sup-${seed}-1`,
        claim: repeatPhrase(`Supporting claim ${seed}`, 12),
        detail: repeatPhrase(`Supporting detail ${seed}`, 14),
        sources: makeSources(2, `${seed}-sup`),
      },
    ],
    limiting: [
      {
        id: `lim-${seed}-1`,
        claim: repeatPhrase(`Limiting claim ${seed}`, 12),
        detail: repeatPhrase(`Limiting detail ${seed}`, 14),
        sources: makeSources(2, `${seed}-lim`),
      },
    ],
  };
}

function makeLargeMatrix(subjects, attributes) {
  const cells = [];
  for (const subject of subjects) {
    for (const attribute of attributes) {
      const seed = `${subject.id}-${attribute.id}`;
      cells.push({
        subjectId: subject.id,
        attributeId: attribute.id,
        value: repeatPhrase(`Value ${seed}`, 28),
        full: repeatPhrase(`Full ${seed}`, 54),
        confidence: "medium",
        confidenceReason: repeatPhrase(`Confidence reason ${seed}`, 18),
        risks: repeatPhrase(`Risk ${seed}`, 16),
        providerAgreement: "partial",
        sources: makeSources(4, seed),
        arguments: makeArguments(seed),
      });
    }
  }
  return {
    coverage: { totalCells: cells.length, lowConfidenceCells: Math.floor(cells.length * 0.35), contestedCells: Math.floor(cells.length * 0.25) },
    crossMatrixSummary: repeatPhrase("Cross-matrix summary", 40),
    subjectSummaries: subjects.map((subject) => ({
      subjectId: subject.id,
      summary: repeatPhrase(`Summary for ${subject.label}`, 18),
    })),
    cells,
  };
}

test("matrix critic prompt compacts under target token budget for oversized matrices", () => {
  const subjects = makeSubjects(18);
  const attributes = makeAttributes(10);
  const matrix = makeLargeMatrix(subjects, attributes); // 180 cells

  const payload = matrixTest.buildMatrixCriticPrompt({
    rawInput: repeatPhrase("Large matrix test input", 50),
    decisionQuestion: "Which subject should be selected for a high-stakes decision?",
    subjects,
    attributes,
    matrix,
    limits: { matrixCriticPromptTokenBudget: 12000 },
  });

  assert.ok(typeof payload?.promptText === "string" && payload.promptText.length > 0);
  assert.ok(payload?.compactionMeta);
  assert.ok(
    Number(payload.compactionMeta.estimatedTokens) <= Number(payload.compactionMeta.targetTokenBudget),
    `critic prompt exceeded budget: ${payload.compactionMeta.estimatedTokens} > ${payload.compactionMeta.targetTokenBudget}`
  );
});

test("matrix consistency prompt compacts under explicit strict budget", () => {
  const subjects = makeSubjects(20);
  const attributes = makeAttributes(12);
  const matrix = makeLargeMatrix(subjects, attributes); // 240 cells

  const payload = matrixTest.buildMatrixConsistencyPrompt({
    decisionQuestion: "Detect internal consistency contradictions in this large matrix.",
    subjects,
    attributes,
    matrix,
    limits: { matrixConsistencyPromptTokenBudget: 5000 },
  });

  assert.ok(typeof payload?.promptText === "string" && payload.promptText.length > 0);
  assert.ok(payload?.compactionMeta);
  assert.ok(
    Number(payload.compactionMeta.estimatedTokens) <= Number(payload.compactionMeta.targetTokenBudget),
    `consistency prompt exceeded budget: ${payload.compactionMeta.estimatedTokens} > ${payload.compactionMeta.targetTokenBudget}`
  );
});
