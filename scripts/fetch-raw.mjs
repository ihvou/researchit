import fs from "node:fs/promises";
import path from "node:path";

function clean(value) {
  return String(value || "").trim();
}

async function main() {
  const runId = clean(process.argv[2]);
  const stageId = clean(process.argv[3]);
  if (!runId || !stageId) {
    console.error("Usage: npm run fetch-raw -- <runId> <stageId>");
    process.exit(1);
  }

  const baseUrl = clean(process.env.RESEARCHIT_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
  const sessionCookie = clean(process.env.RESEARCHIT_SESSION_COOKIE);
  const url = `${baseUrl}/api/account/raw-calls/${encodeURIComponent(runId)}/${encodeURIComponent(stageId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to fetch raw calls (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json().catch(() => ({}));
  const calls = Array.isArray(data?.calls) ? data.calls : [];
  const outDir = path.join(process.cwd(), "tmp", "raw-calls", runId, stageId);
  await fs.mkdir(outDir, { recursive: true });
  for (const call of calls) {
    const chunkId = clean(call?.chunkId || "default").replace(/[^a-zA-Z0-9._-]+/g, "_");
    const callIndex = Number(call?.callIndex || 0);
    const fileName = `${chunkId}-${callIndex}.json`;
    const payload = {
      key: call?.key,
      runId,
      stageId,
      chunkId: call?.chunkId,
      callIndex: call?.callIndex,
      provider: call?.provider,
      model: call?.model,
      requestHash: call?.requestHash,
      promptVersion: call?.promptVersion,
      storedAt: call?.storedAt,
      rawResponse: call?.rawResponse,
    };
    await fs.writeFile(path.join(outDir, fileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  console.log(`Saved ${calls.length} raw call(s) to ${outDir}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
