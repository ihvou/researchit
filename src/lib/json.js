export function buildDimRubrics(dims) {
  return dims.map(d =>
    `### ${d.label} [id: "${d.id}"]\nBrief: ${d.brief}\nDetailed Rubric:\n${d.fullDef}`
  ).join("\n\n");
}

export function safeParseJSON(raw) {
  const clean = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const start = clean.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in response");

  const end = clean.lastIndexOf("}");
  if (end !== -1) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) { /* fall through to repair */ }
  }

  // Response was truncated mid-JSON - attempt structural repair
  let s = clean.slice(start);
  const quoteCount = (s.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) s += '"';

  let opens = 0, openArr = 0;
  for (const ch of s) {
    if (ch === "{") opens++;
    else if (ch === "}") opens--;
    else if (ch === "[") openArr++;
    else if (ch === "]") openArr--;
  }
  s += "]".repeat(Math.max(0, openArr));
  s += "}".repeat(Math.max(0, opens));

  try { return JSON.parse(s); }
  catch (e) { throw new Error(`JSON parse failed even after repair attempt: ${e.message}`); }
}
