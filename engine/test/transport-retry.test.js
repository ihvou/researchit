import assert from "node:assert/strict";
import test from "node:test";
import { createTransport } from "../lib/transport.js";

test("transport retries critic rate-limit errors and succeeds without real provider calls", async () => {
  let attempts = 0;
  const transport = createTransport(
    async (role) => {
      attempts += 1;
      if (role !== "critic") throw new Error(`unexpected role ${role}`);
      if (attempts < 3) {
        const err = new Error("rate limit exceeded");
        err.status = 429;
        throw err;
      }
      return { text: "ok" };
    },
    {
      retry: {
        critic: {
          maxRetries: 2,
          initialBackoffMs: 1,
          maxBackoffMs: 2,
          rateLimitInitialBackoffMs: 1,
          rateLimitMaxBackoffMs: 2,
          rateLimitBackoffFactor: 1.2,
        },
      },
    }
  );

  const out = await transport.callCritic(
    [{ role: "user", content: "hello" }],
    "system",
    200
  );

  assert.equal(out, "ok");
  assert.equal(attempts, 3);
});

test("transport stops after retry budget is exhausted", async () => {
  let attempts = 0;
  const transport = createTransport(
    async () => {
      attempts += 1;
      const err = new Error("rate limit exceeded");
      err.status = 429;
      throw err;
    },
    {
      retry: {
        critic: {
          maxRetries: 1,
          initialBackoffMs: 1,
          maxBackoffMs: 2,
          rateLimitInitialBackoffMs: 1,
          rateLimitMaxBackoffMs: 2,
          rateLimitBackoffFactor: 1.2,
        },
      },
    }
  );

  await assert.rejects(
    () => transport.callCritic([{ role: "user", content: "hello" }], "system", 200),
    /attempt 2\/2/i
  );
  assert.equal(attempts, 2);
});
