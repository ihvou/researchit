export function buildDimRubrics(dims) {
  return dims.map(d =>
    `### ${d.label} [id: "${d.id}"]\nBrief: ${d.brief}\nDetailed Rubric:\n${d.fullDef}`
  ).join("\n\n");
}

function stripMarkdownFences(raw) {
  return raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
}

function extractFirstJsonObject(input) {
  const start = input.indexOf("{");
  if (start === -1) return "";

  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }

  return input.slice(start);
}

function removeTrailingCommas(input) {
  let prev = input;
  let next = input;
  do {
    prev = next;
    next = prev.replace(/,\s*([}\]])/g, "$1");
  } while (next !== prev);
  return next;
}

function normalizeStringLiterals(input) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (!inString) {
      if (ch === "\"") {
        inString = true;
      }
      out += ch;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      continue;
    }
    if (ch === "\t") {
      out += "\\t";
      continue;
    }

    if (ch === "\"") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j += 1;
      const next = input[j];
      const isTerminator = next == null || next === "," || next === "}" || next === "]" || next === ":";
      if (isTerminator) {
        inString = false;
        out += "\"";
      } else {
        out += "\\\"";
      }
      continue;
    }

    out += ch;
  }

  return out;
}

function balanceBrackets(input) {
  let out = input;
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      stack.push("{");
      continue;
    }
    if (ch === "[") {
      stack.push("[");
      continue;
    }
    if (ch === "}") {
      for (let j = stack.length - 1; j >= 0; j -= 1) {
        if (stack[j] === "{") {
          stack.splice(j, 1);
          break;
        }
      }
      continue;
    }
    if (ch === "]") {
      for (let j = stack.length - 1; j >= 0; j -= 1) {
        if (stack[j] === "[") {
          stack.splice(j, 1);
          break;
        }
      }
    }
  }

  if (inString) out += "\"";
  while (stack.length) {
    const opener = stack.pop();
    out += opener === "{" ? "}" : "]";
  }
  return out;
}

function parseErrorSnippet(text, message) {
  const match = message.match(/position (\d+)/i);
  if (!match) return "";
  const pos = Number(match[1]);
  if (!Number.isFinite(pos)) return "";
  const from = Math.max(0, pos - 120);
  const to = Math.min(text.length, pos + 120);
  return text.slice(from, to);
}

export function safeParseJSON(raw) {
  if (typeof raw !== "string") {
    throw new Error("Model response is not a string");
  }

  const clean = stripMarkdownFences(raw);
  const candidate = extractFirstJsonObject(clean);
  if (!candidate) throw new Error("No JSON object found in response");

  try {
    return JSON.parse(candidate);
  } catch (_) {
    // Continue to structural repair attempts.
  }

  let repaired = candidate
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\u00a0/g, " ");
  repaired = normalizeStringLiterals(repaired);
  repaired = removeTrailingCommas(repaired);
  repaired = balanceBrackets(repaired);

  try {
    return JSON.parse(repaired);
  } catch (e) {
    const snippet = parseErrorSnippet(repaired, e.message);
    const extra = snippet ? ` near: ${snippet}` : "";
    throw new Error(`JSON parse failed even after repair attempt: ${e.message}${extra}`);
  }
}
