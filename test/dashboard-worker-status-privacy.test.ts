import assert from "node:assert/strict";
import test from "node:test";

import worker, { publicStatusProjection } from "../dashboard/worker.ts";

test("public status projection is fail-closed for nested identity-bearing metadata", () => {
  const input = {
    schema_version: 1,
    generated_at: "2026-08-15T12:00:00.000Z",
    fleet: {
      active_codex_jobs: 2,
      worker_detail_runs: 3,
    },
    workers: [
      {
        id: 42,
        name: "synthetic worker title",
        repository: "synthetic-owner/synthetic-repository",
        item_number: 42,
        workflow_title: "synthetic workflow title",
        failure_key: "synthetic failure key",
        run_url: "https://example.invalid/private?token=synthetic",
        token: "synthetic-token-value",
        status: "in_progress",
        mode: "assist",
        work_kind: "other",
        stage: "reviewing",
        current_step: "synthetic step title",
        progress: { completed: 1, total: 2 },
        steps: [
          {
            name: "synthetic nested step title",
            status: "in_progress",
            conclusion: null,
          },
        ],
      },
    ],
    bay: {
      terminal_count: 1,
      terminal_buffer: [
        {
          item_key: "synthetic-owner/synthetic-repository#42",
          workflow_title: "synthetic nested workflow title",
        },
      ],
    },
    diagnostics: {
      errors: ["synthetic error containing a private URL https://example.invalid/private"],
    },
  };

  const projected = publicStatusProjection(input);
  const serialized = JSON.stringify(projected);

  for (const forbidden of [
    "synthetic worker title",
    "synthetic-owner/synthetic-repository",
    "synthetic workflow title",
    "synthetic failure key",
    "example.invalid/private",
    "synthetic-token-value",
    "synthetic nested step title",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(projected.workers, [
    {
      status: "in_progress",
      mode: "assist",
      work_kind: "other",
      stage: "reviewing",
      progress: { completed: 1, total: 2 },
      steps: [{ status: "in_progress", conclusion: null }],
    },
  ]);
  assert.equal(projected.fleet.active_codex_jobs, 2);
  assert.equal(projected.fleet.worker_detail_runs, 3);
  assert.equal(projected.bay.terminal_count, 1);
  assert.deepEqual(projected.diagnostics, {
    errors: ["telemetry_unavailable"],
    error_count: 1,
  });
});

test("public status projection drops over-depth values and retains closed health enums", () => {
  const overDepth = { token: "synthetic-over-depth-token" };
  let nested = overDepth;
  for (let index = 0; index < 13; index += 1) nested = { nested };

  const projected = publicStatusProjection({
    schema_version: 1,
    dashboard_health: { conclusion: "needs_attention", severity: "red" },
    nested,
  });

  assert.deepEqual(projected.dashboard_health, {
    conclusion: "needs_attention",
    severity: "red",
  });
  assert.equal(JSON.stringify(projected).includes("synthetic-over-depth-token"), false);
});

test("public status projection retains every closed Bay stage count", () => {
  const projected = publicStatusProjection({
    exact_review_queue: {
      bay_projection: {
        stages: {
          arriving: 1,
          "setting-up": 2,
          reviewing: 3,
          publishing: 4,
          applying: 5,
          repairing: 6,
        },
      },
    },
  });
  assert.deepEqual(projected.exact_review_queue.bay_projection.stages, {
    arriving: 1,
    "setting-up": 2,
    reviewing: 3,
    publishing: 4,
    applying: 5,
    repairing: 6,
  });
});

test("public status projection drops malformed and unrecognized text while retaining bounded counts", () => {
  const projected = publicStatusProjection({
    schema_version: 1,
    workers: [
      {
        status: "unexpected-free-text",
        mode: "unknown-mode",
        progress: { completed: 3, total: 5 },
        nested: { opaque_value: "must not escape" },
      },
    ],
  });

  assert.deepEqual(projected.workers, [{ progress: { completed: 3, total: 5 }, nested: {} }]);
});

test("public status filters a legacy cached body before it can be served", async () => {
  const originalCaches = globalThis.caches;
  const entries = new Map<string, Response>();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        async match(request: Request) {
          return entries.get(request.url)?.clone();
        },
        async put(request: Request, response: Response) {
          entries.set(request.url, response.clone());
        },
      },
    },
  });

  try {
    await globalThis.caches.default.put(
      new Request("https://clawsweeper.openclaw.ai/api/status-cache/v4/fresh"),
      new Response(
        JSON.stringify({
          schema_version: 1,
          workers: [
            {
              workflow_title: "synthetic cache title",
              failure_key: "synthetic cache failure key",
              run_url: "https://example.invalid/cache?credential=synthetic",
              status: "queued",
              progress: { completed: 0, total: 1 },
            },
          ],
          diagnostics: { errors: ["synthetic cache error"] },
        }),
      ),
    );

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {},
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.headers.get("x-clawsweeper-cache"), "fresh");
    assert.equal(serialized.includes("synthetic cache title"), false);
    assert.equal(serialized.includes("synthetic cache failure key"), false);
    assert.equal(serialized.includes("example.invalid/cache"), false);
    assert.deepEqual(body.workers, [{ status: "queued", progress: { completed: 0, total: 1 } }]);
    assert.deepEqual(body.diagnostics, {
      errors: ["telemetry_unavailable"],
      error_count: 1,
    });
  } finally {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});
