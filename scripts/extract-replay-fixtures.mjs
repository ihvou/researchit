#!/usr/bin/env node
/**
 * Extract replay fixtures from a debug-bundle JSON.
 *
 * Reads a debug bundle, pairs up analyst/critic transport requests with their
 * responses (matched by chronological order within stage+chunk), and writes
 * one JSON file per (stageId, chunkId, callIndex) into the output directory.
 *
 * Each fixture file shape:
 *   {
 *     stageId, chunkId, callIndex, role, time,
 *     request: { provider, model, webSearchModel, liveSearch, deepResearch,
 *                searchMaxUses, systemPrompt, messages[], maxTokens,
 *                runId, promptVersion },
 *     response: { ok, status, text, meta: {...providerMeta...} }  // null on failure
 *     failure:  { error?, status?, ... }                          // present on failure
 *   }
 *
 * Manifest at <out>/manifest.json contains run-level metadata and per-stage counts.
 *
 * Usage:
 *   node scripts/extract-replay-fixtures.mjs <bundle.json> <out-dir>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";

function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }

function clean(v) { return String(v ?? "").trim(); }

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function main() {
  const [, , bundlePath, outDir] = process.argv;
  if (!bundlePath || !outDir) {
    die("usage: extract-replay-fixtures.mjs <bundle.json> <out-dir>");
  }
  if (!existsSync(bundlePath)) die(`bundle not found: ${bundlePath}`);

  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  const session = bundle.sessions?.[0];
  if (!session) die("bundle has no sessions[0]");

  const events = session.networkTrace?.events || [];
  const run = session.run || {};

  // Pair requests with responses by (role, stageId, chunkId) in chronological order.
  // Request events have payload.{stageId,chunkId,...}.
  // Response events have data.{text,meta:{...,stageId? not always}} at TOP level.
  // Pairing strategy: for each role, walk events in order, treat consecutive
  // request->response pairs from the same role as one transaction. This works
  // because the engine awaits each call before issuing the next per-stage,
  // and chunked calls are explicitly numbered.
  const pending = {}; // key: role -> array of pending request entries

  const fixtures = []; // collected (stageId, chunkId, callIndex, request, response)
  const callCounters = new Map(); // key: `${stageId}::${chunkId}` -> integer

  for (const ev of events) {
    const role = ev.role;
    if (role !== "analyst" && role !== "critic") continue;
    const direction = ev.direction;
    if (direction === "request") {
      const p = ev.payload || {};
      pending[role] = pending[role] || [];
      pending[role].push({
        time: ev.time,
        role,
        request: {
          provider: clean(p.provider),
          model: clean(p.model),
          webSearchModel: clean(p.webSearchModel),
          liveSearch: !!p.liveSearch,
          deepResearch: !!p.deepResearch,
          searchMaxUses: Number(p.searchMaxUses) || undefined,
          systemPrompt: p.systemPrompt || "",
          messages: Array.isArray(p.messages) ? p.messages : [],
          maxTokens: Number(p.maxTokens) || undefined,
          runId: clean(p.runId) || undefined,
          stageId: clean(p.stageId),
          chunkId: clean(p.chunkId) || "default",
          promptVersion: clean(p.promptVersion) || undefined,
        },
      });
    } else if (direction === "response" || direction === "error") {
      const queue = pending[role];
      if (!queue || queue.length === 0) {
        // Stray response with no matching request — skip
        continue;
      }
      const req = queue.shift();
      const stageId = req.request.stageId || "unknown";
      const chunkId = req.request.chunkId || "default";
      const counterKey = `${stageId}::${chunkId}`;
      const callIndex = callCounters.get(counterKey) || 0;
      callCounters.set(counterKey, callIndex + 1);

      let response = null;
      let failure = null;
      if (direction === "response") {
        const data = ev.data || {};
        response = {
          ok: ev.ok !== false,
          status: Number(ev.status) || undefined,
          text: data.text || "",
          meta: data.meta || {},
        };
      } else {
        // error event — the engine logged a transport-level fetch failure
        const data = ev.data || ev.payload || {};
        failure = {
          status: Number(ev.status || data.status) || undefined,
          error: clean(data.error || data.message) || undefined,
          reasonCode: clean(data.reasonCode) || undefined,
        };
      }

      fixtures.push({
        stageId,
        chunkId,
        callIndex,
        role,
        time: req.time,
        responseTime: ev.time,
        request: req.request,
        response,
        failure,
      });
    }
  }

  // Write fixtures: one file per (stageId, chunkId, callIndex)
  ensureDir(outDir);
  const perStage = new Map(); // stageId -> count
  const perStageBytes = new Map();

  for (const fx of fixtures) {
    const stageDir = join(outDir, fx.stageId);
    ensureDir(stageDir);
    // file name: <chunkId>__call-<index>[.failed].json
    const tag = fx.failure ? ".failed" : "";
    const fname = `${fx.chunkId}__call-${fx.callIndex}${tag}.json`;
    const filePath = join(stageDir, fname);
    const json = JSON.stringify(fx, null, 2);
    writeFileSync(filePath, json);
    perStage.set(fx.stageId, (perStage.get(fx.stageId) || 0) + 1);
    perStageBytes.set(fx.stageId, (perStageBytes.get(fx.stageId) || 0) + json.length);
  }

  // Manifest
  const manifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    sourceBundle: basename(bundlePath),
    sourceBundleSize: readFileSync(bundlePath).length,
    run: {
      runId: clean(run.id),
      mode: clean(run.mode),
      outputType: clean(run.outputType),
      configId: clean(run.configId),
      configName: clean(run.configName),
      startedAt: clean(run.startedAt),
      finishedAt: clean(run.finishedAt),
      status: clean(run.status),
      reasonCodes: Array.isArray(run.reasonCodes) ? run.reasonCodes : [],
    },
    stages: [...perStage.keys()].sort().map((sid) => ({
      stageId: sid,
      callCount: perStage.get(sid),
      totalBytes: perStageBytes.get(sid),
    })),
    notes: [
      "Each fixture is one (stageId, chunkId, callIndex) — request + response (or failure).",
      "response.text is the model's full output text. response.meta is the providerMeta.",
      "Use this with a stub transport that returns response.text/meta keyed by stageId/chunkId/callIndex.",
      "Failure fixtures (.failed.json) preserve transport-error shape for testing the failure path.",
    ],
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Summary
  console.log(`Wrote ${fixtures.length} fixtures to ${outDir}`);
  for (const sid of [...perStage.keys()].sort()) {
    console.log(`  ${sid.padEnd(38)} ${perStage.get(sid)} fixtures, ${(perStageBytes.get(sid)/1024).toFixed(1)} KB`);
  }
  console.log(`Manifest: ${join(outDir, "manifest.json")}`);
}

main();
