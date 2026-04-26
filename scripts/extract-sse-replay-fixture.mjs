#!/usr/bin/env node
/**
 * Convert a captured Anthropic SSE transcript + the originating bundle's request
 * payload into a single replay fixture file matching the schema produced by
 * extract-replay-fixtures.mjs.
 *
 * Reconstructs the non-streaming response shape (the same one callAnthropic's
 * downstream code consumes) by walking the SSE events. Also captures the raw
 * SSE transcript path for tests that exercise readAnthropicStream directly.
 *
 * Usage:
 *   node scripts/extract-sse-replay-fixture.mjs \
 *     --bundle <path-to-bundle-with-request> \
 *     --sse <path-to-timestamped-transcript> \
 *     --stage stage_10_coherence \
 *     --out <fixture-dir>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";

function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function ensureDir(path) { if (!existsSync(path)) mkdirSync(path, { recursive: true }); }

// Reconstruct the non-streaming response shape from a timestamped SSE transcript.
// This is essentially what readAnthropicStream does, but in a stateless one-pass form.
function reconstructFromSSE(transcriptText) {
  const lines = transcriptText.split("\n");
  const acc = {
    id: "", type: "message", role: "assistant", model: "",
    stop_reason: null, stop_sequence: null,
    usage: {},
    blocks: new Map(),
  };
  let curEvent = null;
  let curDataLines = [];
  const httpFooter = {};
  let firstEventTs = null;
  let lastEventTs = null;

  function mergeUsage(base, next) {
    const merged = { ...(base || {}) };
    for (const [k, v] of Object.entries(next || {})) {
      if (v == null) continue;
      if (typeof v === "number") merged[k] = Math.max(Number(merged[k] || 0), v);
      else if (v && typeof v === "object" && !Array.isArray(v)) merged[k] = { ...(merged[k] || {}), ...v };
      else merged[k] = v;
    }
    return merged;
  }

  function applyEvent(event, payload) {
    if (event === "ping" || !event) return;
    if (event === "error") return; // tests can capture from raw transcript if needed
    if (event === "message_start") {
      const m = payload?.message || {};
      acc.id = m.id || acc.id;
      acc.type = m.type || acc.type;
      acc.role = m.role || acc.role;
      acc.model = m.model || acc.model;
      if (m.stop_reason !== undefined) acc.stop_reason = m.stop_reason;
      if (m.stop_sequence !== undefined) acc.stop_sequence = m.stop_sequence;
      acc.usage = mergeUsage(acc.usage, m.usage);
      (m.content || []).forEach((b, i) => acc.blocks.set(i, { ...b }));
      return;
    }
    if (event === "content_block_start") {
      const idx = Number(payload?.index ?? acc.blocks.size);
      const b = payload?.content_block || {};
      acc.blocks.set(idx, { ...b });
      return;
    }
    if (event === "content_block_delta") {
      const idx = Number(payload?.index ?? 0);
      const ex = acc.blocks.get(idx) || {};
      const d = payload?.delta || {};
      if (d.type === "text_delta") {
        ex.type = ex.type || "text";
        ex.text = `${ex.text || ""}${d.text || ""}`;
      } else if (d.type === "input_json_delta") {
        ex.input_json = `${ex.input_json || ""}${d.partial_json || ""}`;
      }
      acc.blocks.set(idx, ex);
      return;
    }
    if (event === "message_delta") {
      const d = payload?.delta || {};
      if (d.stop_reason !== undefined) acc.stop_reason = d.stop_reason;
      if (d.stop_sequence !== undefined) acc.stop_sequence = d.stop_sequence;
      acc.usage = mergeUsage(acc.usage, payload?.usage);
      return;
    }
    if (event === "message_stop") return;
  }

  function flushFrame() {
    if (!curEvent && curDataLines.length === 0) return;
    const data = curDataLines.join("\n").trim();
    if (data && data !== "[DONE]") {
      try {
        applyEvent(curEvent, JSON.parse(data));
      } catch (_) { /* skip malformed */ }
    }
    curEvent = null;
    curDataLines = [];
  }

  for (const raw of lines) {
    if (!raw) { flushFrame(); continue; }
    // Strip leading timestamp (we wrote "<epoch>.<micro> <line>")
    const spaceIdx = raw.indexOf(" ");
    let ts = null;
    let rest = raw;
    if (spaceIdx > 0) {
      const tsCand = raw.slice(0, spaceIdx);
      if (/^\d+\.\d+$/.test(tsCand)) {
        ts = Number(tsCand);
        rest = raw.slice(spaceIdx + 1);
      }
    }
    if (ts !== null) {
      if (firstEventTs === null) firstEventTs = ts;
      lastEventTs = ts;
    }
    if (!rest.trim()) { flushFrame(); continue; }
    if (rest.startsWith("event:")) curEvent = rest.slice(6).trim();
    else if (rest.startsWith("data:")) curDataLines.push(rest.slice(5).trimStart());
    else {
      for (const tag of ["HTTP_STATUS", "TTFB_S", "TOTAL_S", "DOWNLOADED_BYTES"]) {
        if (rest.startsWith(tag + ":")) httpFooter[tag] = rest.slice(tag.length + 1).trim();
      }
    }
  }
  flushFrame();

  const content = [...acc.blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => {
      const out = { ...b };
      if (typeof out.input_json === "string") {
        try { out.input = JSON.parse(out.input_json || "{}"); }
        catch (_) { out.input = out.input_json; }
        delete out.input_json;
      }
      return out;
    })
    .filter((b) => b && b.type);

  return {
    response: {
      id: acc.id,
      type: acc.type,
      role: acc.role,
      content,
      model: acc.model,
      stop_reason: acc.stop_reason,
      stop_sequence: acc.stop_sequence,
      usage: acc.usage,
    },
    timing: {
      firstEventTs,
      lastEventTs,
      wallSeconds: firstEventTs && lastEventTs ? +(lastEventTs - firstEventTs).toFixed(3) : null,
      httpStatus: Number(httpFooter.HTTP_STATUS) || undefined,
      ttfbSeconds: Number(httpFooter.TTFB_S) || undefined,
      totalSeconds: Number(httpFooter.TOTAL_S) || undefined,
      downloadedBytes: Number(httpFooter.DOWNLOADED_BYTES) || undefined,
    },
  };
}

function findPrimaryCriticRequest(bundlePath, stageId) {
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  const events = bundle.sessions?.[0]?.networkTrace?.events || [];
  for (const ev of events) {
    if (ev.role !== "critic" || ev.direction !== "request") continue;
    const p = ev.payload || {};
    if (String(p.stageId || "").trim() === stageId) return { ev, payload: p, run: bundle.sessions[0].run || {} };
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bundle || !args.sse || !args.stage || !args.out) {
    die("usage: --bundle <path> --sse <path> --stage <stageId> --out <dir>");
  }
  if (!existsSync(args.bundle)) die(`bundle not found: ${args.bundle}`);
  if (!existsSync(args.sse)) die(`SSE transcript not found: ${args.sse}`);

  const reqInfo = findPrimaryCriticRequest(args.bundle, args.stage);
  if (!reqInfo) die(`no ${args.stage} primary critic request found in bundle`);
  const transcriptText = readFileSync(args.sse, "utf8");
  const reconstructed = reconstructFromSSE(transcriptText);

  ensureDir(args.out);
  const stageDir = join(args.out, args.stage);
  ensureDir(stageDir);

  // Compose the final fixture.
  // text reconstruction: join all text-block .text fields (matches callAnthropic's behavior)
  const textBlocks = (reconstructed.response.content || []).filter((b) => b.type === "text" && typeof b.text === "string");
  const reconstructedText = textBlocks.map((b) => b.text.trim()).filter(Boolean).join("\n").trim();

  const fixture = {
    stageId: args.stage,
    chunkId: "default",
    callIndex: 0,
    role: "critic",
    time: reqInfo.ev.time,
    sourceBundle: basename(args.bundle),
    captureMethod: "manual_curl_with_stream_true",
    request: {
      provider: reqInfo.payload.provider,
      model: reqInfo.payload.model,
      webSearchModel: reqInfo.payload.webSearchModel,
      liveSearch: !!reqInfo.payload.liveSearch,
      deepResearch: !!reqInfo.payload.deepResearch,
      searchMaxUses: Number(reqInfo.payload.searchMaxUses) || undefined,
      systemPrompt: reqInfo.payload.systemPrompt || "",
      messages: reqInfo.payload.messages || [],
      maxTokens: Number(reqInfo.payload.maxTokens) || undefined,
      runId: String(reqInfo.payload.runId || "").trim() || undefined,
      stageId: args.stage,
      promptVersion: String(reqInfo.payload.promptVersion || "").trim() || undefined,
    },
    response: {
      ok: true,
      status: 200,
      // The text the engine consumes (joined across text blocks)
      text: reconstructedText,
      // Reconstructed Anthropic response object as readAnthropicStream would produce
      anthropicResponse: reconstructed.response,
      meta: {
        providerId: "anthropic",
        model: reconstructed.response.model || reqInfo.payload.model,
        liveSearchUsed: true,
        webSearchCalls: Number(reconstructed.response.usage?.server_tool_use?.web_search_requests || 0),
        usage: reconstructed.response.usage || {},
        finishReason: String(reconstructed.response.stop_reason || "").toLowerCase().includes("end_turn") ? "stop" : "unknown",
        stopReason: reconstructed.response.stop_reason,
        outputTokens: Number(reconstructed.response.usage?.output_tokens || 0),
        outputTokensCap: Number(reqInfo.payload.maxTokens) || 8000,
        providerFallbackUsed: false,
        providerAttemptCount: 1,
        providerRoutePinned: true,
      },
    },
    timing: reconstructed.timing,
  };

  const fixturePath = join(stageDir, "default__call-0.json");
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

  // Also copy the raw SSE transcript so tests that exercise readAnthropicStream
  // directly can use the real wire data.
  const sseDest = join(stageDir, "default__call-0.raw-sse.txt");
  copyFileSync(args.sse, sseDest);

  // Manifest
  const manifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    sourceBundle: basename(args.bundle),
    sourceTranscript: basename(args.sse),
    notes: [
      "Stage 10 critic SUCCESS path. Prompt from bundle T17-19 (which failed at stage 10);",
      "response captured by manually re-issuing the same prompt directly to Anthropic with stream:true.",
      "Useful for: (a) testing the success path of critic stages without API spend,",
      "(b) testing readAnthropicStream against real SSE wire data (raw-sse.txt is the timestamped feed).",
    ],
    request: {
      stageId: args.stage,
      model: fixture.request.model,
      promptChars: (fixture.request.messages?.[0]?.content || "").length,
      systemChars: (fixture.request.systemPrompt || "").length,
    },
    response: {
      stopReason: fixture.response.meta.stopReason,
      outputTokens: fixture.response.meta.outputTokens,
      inputTokens: fixture.response.meta.usage?.input_tokens,
      webSearchCalls: fixture.response.meta.webSearchCalls,
      textChars: fixture.response.text.length,
      contentBlocks: fixture.response.anthropicResponse.content.length,
    },
    timing: fixture.timing,
  };
  writeFileSync(join(args.out, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`Wrote ${fixturePath} (${(JSON.stringify(fixture).length/1024).toFixed(1)} KB)`);
  console.log(`Wrote ${sseDest} (${(transcriptText.length/1024).toFixed(1)} KB raw SSE)`);
  console.log(`Manifest: ${join(args.out, "manifest.json")}`);
}

main();
