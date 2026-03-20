import { callAnalystAPI, callCriticAPI } from "../lib/api";
import { safeParseJSON, buildDimRubrics } from "../lib/json";
import { SYS_ANALYST, SYS_CRITIC, SYS_ANALYST_RESPONSE } from "../prompts/system";

export async function runAnalysis(desc, dims, updateUC, id) {
  const dimJsonTemplate = dims.map(d =>
    `"${d.id}": {
      "score": <integer 1-5 based on rubric>,
      "brief": "<single sentence summary, max 25 words>",
      "full": "<detailed 3-5 paragraph analysis citing named companies with specific metrics, trends, and market context>",
      "sources": [
        {"name": "<source name>", "quote": "<paraphrased insight, max 15 words>", "url": "<real URL if known, else omit field>"}
      ],
      "risks": "<1-2 sentences on key risks or caveats for this dimension>"
    }`
  ).join(",\n    ");

  const phase1Prompt = `Analyze this AI use case for an outsourcing company that builds CUSTOM AI solutions for enterprise clients:

"${desc}"

SCORING DIMENSIONS \u2014 use the rubric below to score each one 1-5:
${buildDimRubrics(dims)}

Return ONLY this exact JSON structure, fully populated for ALL 11 dimension IDs (${dims.map(d => d.id).join(", ")}):

{
  "attributes": {
    "title": "<descriptive title, max 8 words>",
    "expandedDescription": "<2-3 sentences: what the AI does, how it creates value, why an outsourcer should care>",
    "vertical": "<primary industry vertical>",
    "buyerPersona": "<job title of primary decision maker>",
    "aiSolutionType": "<specific AI/ML technology type>",
    "typicalTimeline": "<realistic end-to-end delivery estimate>",
    "deliveryModel": "<how outsourcer engages: build-and-transfer, managed service, etc>"
  },
  "dimensions": {
    ${dimJsonTemplate}
  }
}`;

  const debate = [];

  // \u2500 Phase 1: Analyst \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  updateUC(id, u => ({ ...u, phase: "analyst" }));
  let r1, p1;
  try {
    r1 = await callAnalystAPI([{ role: "user", content: phase1Prompt }], SYS_ANALYST, 12000);
    p1 = safeParseJSON(r1);
  } catch (parseErr) {
    console.warn("Phase 1 parse failed, retrying with condensed prompt:", parseErr.message);
    const condensedDimTemplate = dims.map(d =>
      `"${d.id}": {"score": <1-5>, "brief": "<max 20 words>", "full": "<1 paragraph, max 80 words, cite 1-2 named companies>", "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}], "risks": "<max 20 words>"}`
    ).join(",\n    ");
    const condensedPrompt = `Analyze this AI use case for an outsourcing company building CUSTOM AI solutions:

"${desc}"

SCORING DIMENSIONS (score each 1-5 using these rubrics):
${buildDimRubrics(dims)}

Return ONLY this JSON (ALL 11 dimension IDs: ${dims.map(d => d.id).join(", ")}):
{
  "attributes": {"title": "<max 8 words>", "expandedDescription": "<2 sentences>", "vertical": "<industry>", "buyerPersona": "<role>", "aiSolutionType": "<AI/ML type>", "typicalTimeline": "<estimate>", "deliveryModel": "<engagement type>"},
  "dimensions": {
    ${condensedDimTemplate}
  }
}`;
    r1 = await callAnalystAPI([{ role: "user", content: condensedPrompt }], SYS_ANALYST, 8000);
    p1 = safeParseJSON(r1);
  }

  debate.push({ phase: "initial", content: p1 });
  updateUC(id, u => ({ ...u, attributes: p1.attributes, dimScores: p1.dimensions, phase: "critic", debate: [...debate] }));

  // \u2500 Phase 2: Critic (OpenAI o3) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const phase2Prompt = `Review this analyst assessment of the AI use case: "${p1.attributes?.title || desc}"

Analyst scores (outsourcing delivery context):
${dims.map(d => `\u2022 ${d.label} [${d.id}]: ${p1.dimensions?.[d.id]?.score}/5 \u2014 ${p1.dimensions?.[d.id]?.brief || ""}`).join("\n")}

Return ONLY this JSON:
{
  "overallFeedback": "<2-3 sentence overall critique \u2014 what is the analyst getting right and wrong?>",
  "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}],
  "dimensions": {
    ${dims.map(d => `"${d.id}": {
      "scoreJustified": <true if score is defensible, false if over/under-stated>,
      "suggestedScore": <your suggested score 1-5>,
      "critique": "<2-3 sentences: specific challenge with named incumbent vendors, SaaS products, or counter-evidence>",
      "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}]
    }`).join(",\n    ")}
  }
}`;

  const r2 = await callCriticAPI([{ role: "user", content: phase2Prompt }], SYS_CRITIC, 5000);
  const p2 = safeParseJSON(r2);

  debate.push({ phase: "critique", content: p2 });
  updateUC(id, u => ({ ...u, critique: p2, phase: "finalizing", debate: [...debate] }));

  // \u2500 Phase 3: Analyst responds \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const phase3Prompt = `You are the analyst who assessed "${p1.attributes?.title || desc}".

Your original scores:
${dims.map(d => `\u2022 ${d.label}: ${p1.dimensions?.[d.id]?.score}/5`).join("\n")}

Critic's overall feedback: ${p2.overallFeedback || ""}

Per-dimension critiques:
${dims.map(d => {
  const c = p2.dimensions?.[d.id];
  return `\u2022 ${d.label}: ${c?.scoreJustified ? "Score justified" : `Critic suggests ${c?.suggestedScore}/5`} \u2014 ${c?.critique || "no specific challenge"}`;
}).join("\n")}

Respond per dimension: defend your score with NEW evidence not previously cited, OR concede and revise with clear reasoning.

Return ONLY this JSON:
{
  "analystResponse": "<2-3 sentence overall response to the critique>",
  "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}],
  "dimensions": {
    ${dims.map(d => `"${d.id}": {
      "finalScore": <your final score 1-5 \u2014 may differ from original>,
      "scoreChanged": <true if you revised the score>,
      "response": "<3-4 sentences: concede or defend with new specific evidence>",
      "sources": [{"name": "...", "quote": "<max 15 words>", "url": "..."}]
    }`).join(",\n    ")}
  },
  "conclusion": "<2-3 sentence strategic recommendation: should the outsourcing company pursue this, and how?>"
}`;

  const r3 = await callAnalystAPI([{ role: "user", content: phase3Prompt }], SYS_ANALYST_RESPONSE, 6000);
  const p3 = safeParseJSON(r3);

  debate.push({ phase: "response", content: p3 });
  updateUC(id, u => ({ ...u, finalScores: p3, status: "complete", phase: "complete", debate: [...debate] }));
}
