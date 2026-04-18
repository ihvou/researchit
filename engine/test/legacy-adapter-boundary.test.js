import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STAGES_DIR = new URL("../pipeline/stages/", import.meta.url);

test("pipeline stages do not import legacy-adapter", () => {
  const dirPath = STAGES_DIR.pathname;
  const files = readdirSync(dirPath).filter((file) => file.endsWith(".js"));

  files.forEach((file) => {
    const source = readFileSync(join(dirPath, file), "utf8");
    assert.equal(
      source.includes("legacy-adapter"),
      false,
      `legacy adapter import found in stage file: ${file}`
    );
  });
});
