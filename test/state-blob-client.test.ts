import assert from "node:assert/strict";
import test from "node:test";

import { publishStateBlob } from "../dist/state-blob-client.js";

const webhookSecret = "state-blob-client-test-secret";

test("state blob client aborts a hung fetch after the per-attempt timeout", async () => {
  const originalTimeout = AbortSignal.timeout;
  let requestedTimeoutMs = 0;
  let attempts = 0;
  AbortSignal.timeout = ((ms: number) => {
    requestedTimeoutMs = ms;
    return originalTimeout(40);
  }) as typeof AbortSignal.timeout;

  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    attempts += 1;
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal, "state blob fetch must pass AbortSignal");
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      publishStateBlob({
        baseUrl: "https://worker.example",
        webhookSecret,
        path: "ledger/v1/events/2026/08/15/openclaw/clawsweeper/shard-000.jsonl",
        content: Buffer.from('{"event":"opened"}\n'),
        fetchImpl,
      }),
      (error: Error) => {
        assert.match(error.message, /aborted/i);
        assert.doesNotMatch(error.message, new RegExp(webhookSecret));
        return true;
      },
    );
    assert.equal(requestedTimeoutMs, 15_000);
    assert.equal(attempts, 4);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});
