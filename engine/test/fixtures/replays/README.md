# Replay fixtures

Real captured prompts + responses from production debug bundles, ready to replay
through the engine without provider API calls. Used by the FR-02 replay regression
suite.

## Layout

```
replays/
  <run-id-or-tag>/
    manifest.json                          # run metadata, per-stage counts
    <stageId>/
      <chunkId>__call-<N>.json             # one fixture per (stage, chunk, call)
      <chunkId>__call-<N>.failed.json      # fixture for transport-failure path
      <chunkId>__call-<N>.raw-sse.txt      # optional raw provider wire data
```

## Fixture file shape

Each fixture file:

```json
{
  "stageId": "stage_03b_evidence_web",
  "chunkId": "c01-retrieve",
  "callIndex": 0,
  "role": "analyst",
  "time": "2026-04-23T17:50:16.299Z",
  "request": {
    "provider": "gemini",
    "model": "gemini-2.5-pro",
    "liveSearch": true,
    "searchMaxUses": 3,
    "systemPrompt": "...",
    "messages": [{ "role": "user", "content": "..." }],
    "maxTokens": 32000,
    "stageId": "stage_03b_evidence_web",
    "chunkId": "c01-retrieve"
  },
  "response": {
    "ok": true,
    "status": 200,
    "text": "<the model's full output text>",
    "meta": {
      "providerId": "gemini",
      "model": "gemini-2.5-pro",
      "liveSearchUsed": true,
      "webSearchCalls": 5,
      "usage": { "inputTokens": 1234, "outputTokens": 5678, "totalTokens": 6912 },
      "finishReason": "stop",
      "outputTokens": 5678,
      "outputTokensCap": 32000,
      "providerRoutePinned": true,
      "rawResponseKey": "ri:user:.../rawcall:stage_03b_evidence_web:c01:0"
    }
  },
  "failure": null
}
```

For transport-failure fixtures (`.failed.json`), `response: null` and `failure`
holds `{ status, error, reasonCode }`.

## Available packs

### `2026-04-23T18-45_partial/` — Native-mode matrix run, partial coverage

Source: `analysis-debug-bundle-2026-04-23T18-45-58-292Z.json` (1.9 MB).
This run completed stages 02 → 08, then failed at stage 10 (critic timeout —
the same class of failure we're investigating).

89 fixtures across 5 stages:

| Stage | Calls | Provider/Model |
|---|---|---|
| `stage_02_plan` | 1 | OpenAI gpt-5.4 |
| `stage_03a_evidence_memory` | 12 | OpenAI gpt-5.4 |
| `stage_03b_evidence_web` | 17 | Gemini 2.5-pro (retrieve) + OpenAI gpt-5.4 (read) — RETR-01 retrieve+read split |
| `stage_08_recover` | 56 | Gemini + OpenAI |
| `stage_10_coherence` | 3 | Anthropic claude-sonnet-4-6 (all FAILED — `.failed.json`) |

Total ~1.5 MB on disk.

**Use cases**:
- Replay stages 02/03a/03b/08 with deterministic, real responses (no API spend)
- Test stage 10 critic transport-failure handling (CR-03's compact-fallback path,
  retry classification, error propagation)

### `2026-04-25T17-19_stage10_manual_success/` — Stage 10 critic success path

Source: prompt from `analysis-debug-bundle-2026-04-25T17-19-17-666Z.json`
(stage 10 primary attempt, 26,448 chars). Response captured 2026-04-25 by
manually re-issuing the same prompt directly to Anthropic Messages API with
`stream: true` (302 KB SSE wire response, 9,026 timestamped lines).

1 fixture in `stage_10_coherence/`:
- `default__call-0.json` — request + reconstructed response + timing + raw response object
- `default__call-0.raw-sse.txt` — full timestamped SSE feed for reader-level tests

**Notable measurements**:
- TTFB: 1.22s
- Wall clock: 313.7s (5 min 14 s)
- 3 web_search calls, 25 server-side tool invocations (16 code_execution + 5 bash + 1 text_editor)
- Input tokens billed: 365,589 (60× the prompt sent — agentic loop expansion)
- Output tokens: 10,277
- Stop reason: `end_turn` (clean completion)
- 57 content blocks reconstructed (text + tool_use + tool_result)

**Use cases**:
- Replay stage 10 critic SUCCESS path (no API spend, no 5-min wait)
- Test `readAnthropicStream` against real wire data (the raw SSE has all the
  edge cases: ping events, multi-line data frames, `input_json_delta` chunks,
  growing context across 25 tool turns, mid-stream `message_delta` usage updates)

## How to capture more fixtures

### From a debug bundle

```bash
node scripts/extract-replay-fixtures.mjs <bundle.json> engine/test/fixtures/replays/<tag>
```

Pairs every analyst/critic transport request with its response by chronological
order within the bundle. Writes one fixture per (stageId, chunkId, callIndex).

### From a manual provider replay

If a stage failed in production but you want a success-path fixture, replay
the bundle's request directly to the provider with `stream: true`, capture the
SSE feed, then:

```bash
node scripts/extract-sse-replay-fixture.mjs \
  --bundle <bundle.json> \
  --sse <transcript.sse> \
  --stage <stageId> \
  --out engine/test/fixtures/replays/<tag>
```

Currently only the Anthropic SSE shape is supported by the SSE-replay script;
extend for OpenAI / Gemini SSE formats as needed.

## Redaction

Fixtures are committed to the repo. Before adding a new pack, verify there are
no API keys (none should appear in bundles), no PII in evidence content, and
that the customer is OK with the prompts being committed. The redaction pass is
manual today; FR-02 follow-up to add an automated redaction step.

## Fixture refresh discipline

- Tag each pack with the source bundle's date (`YYYY-MM-DDTHH-MM`) so age is visible.
- When prompt versions bump (`promptVersion: "v1" → "v2"`), the pack drifts —
  fixtures still parse but no longer represent current production prompts.
  CI can warn when fixture `manifest.run.startedAt` is older than N days.
- LLM responses are non-deterministic. Tests assert structure + transport
  behavior (retries, fallbacks, parsing, normalization, cache key shape, decision
  gate triggers, export schema), NOT output content equality.
