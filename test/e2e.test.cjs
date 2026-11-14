// DSC-07: end-to-end release flow through the gateway against a LIVE stack
// (gateway → deploy-service + log-service → PostgreSQL / Redis). Skipped unless E2E_GATEWAY_URL is set,
// so `npm test` and CI are unaffected.
//
//   E2E_GATEWAY_URL=http://localhost:3100 E2E_CI_API_KEY=... E2E_JWT_SECRET=... node --test test/e2e.test.cjs
const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const jwt = require("jsonwebtoken");

const base = process.env.E2E_GATEWAY_URL;
const apiKey = process.env.E2E_CI_API_KEY;
const jwtSecret = process.env.E2E_JWT_SECRET;

describe("E2E release flow through the gateway", { skip: !base && "E2E_GATEWAY_URL not set" }, () => {
  const runId = Date.now();
  const service = `e2e-svc-${runId}`;
  const ci = { "x-api-key": apiKey, "content-type": "application/json" };
  const engineer = () => ({ authorization: `Bearer ${jwt.sign({ sub: "e2e" }, jwtSecret, { algorithm: "HS256", expiresIn: "5m" })}` });
  let deployId;

  async function call(path, init = {}) {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }
  const send = (method, headers, body) => ({ method, headers, body: JSON.stringify(body) });

  test("1. CI reports a deploy; a retry with the same ci_run_id is idempotent (AC-07)", async () => {
    const payload = {
      service,
      environment: "prod",
      version: "2.3.0",
      ci_run_id: `e2e-run-${runId}`,
      commit_sha: "3770d7d",
      ci_run_url: "https://github.com/proops2026-deploy-status-checker/api-gateway/actions/runs/1",
      triggered_by: "e2e"
    };
    const first = await call("/deploys", send("POST", ci, payload));
    assert.equal(first.status, 201);
    assert.equal(first.body.status, "STARTED");
    assert.ok(first.headers.get("x-request-id"));
    deployId = first.body.id;

    const retry = await call("/deploys", send("POST", ci, payload));
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, deployId);
  });

  test("2. CI attaches 120 log lines in one batch; engineers cannot write logs", async () => {
    const entries = Array.from({ length: 120 }, (_, i) => ({
      level: i === 117 ? "error" : i % 10 === 0 ? "warn" : "info",
      message: i === 117 ? "readiness probe failed: GET /health 503" : `step ${i}`
    }));
    const batch = await call(`/deploys/${deployId}/logs/batch`, send("POST", ci, { entries }));
    assert.equal(batch.status, 201);
    assert.deepEqual(batch.body, { count: 120 });

    const asEngineer = await call(`/deploys/${deployId}/logs`, send("POST", { ...engineer(), "content-type": "application/json" }, { level: "info", message: "x" }));
    assert.equal(asEngineer.status, 401);
    assert.equal((await call("/overview")).status, 401, "anonymous read rejected");
  });

  test("3. release flow: FAILED needs a reason, then FAILED → SUCCESS is refused", async () => {
    const noReason = await call(`/deploys/${deployId}`, send("PATCH", ci, { status: "FAILED" }));
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error.code, "VALIDATION_ERROR");

    const failed = await call(`/deploys/${deployId}`, send("PATCH", ci, { status: "FAILED", reason: "readiness probe failed after 3 retries" }));
    assert.equal(failed.status, 200);
    assert.equal(failed.body.status, "FAILED");

    const late = await call(`/deploys/${deployId}`, send("PATCH", ci, { status: "SUCCESS" }));
    assert.equal(late.status, 409);
    assert.equal(late.body.error.current_status, "FAILED");
  });

  test("4. engineer finds it in history, detail and overview", async () => {
    const history = await call(`/deploys?service=${service}&status=FAILED`, { headers: engineer() });
    assert.equal(history.status, 200);
    assert.equal(history.body.total_count, 1);
    assert.equal(history.body.items[0].id, deployId);

    const detail = await call(`/deploys/${deployId}`, { headers: engineer() });
    assert.equal(detail.body.reason, "readiness probe failed after 3 retries");
    assert.equal(detail.body.commit_sha, "3770d7d");

    const overview = await call("/overview", { headers: engineer() });
    assert.equal(overview.status, 200);
    const mine = overview.body.items.find((d) => d.service === service && d.environment === "prod");
    assert.ok(mine, "overview reflects the write (cache invalidated)");
    assert.equal(mine.status, "FAILED");
  });

  test("5. logs come back in order across pages, and filter by level", async () => {
    const first = await call(`/deploys/${deployId}/logs?limit=100`, { headers: engineer() });
    assert.equal(first.body.items.length, 100);
    assert.ok(first.body.next_cursor);
    const second = await call(`/deploys/${deployId}/logs?limit=100&cursor=${first.body.next_cursor}`, { headers: engineer() });
    assert.equal(second.body.items.length, 20);
    assert.equal(second.body.next_cursor, null);

    const messages = [...first.body.items, ...second.body.items].map((l) => l.message);
    assert.equal(messages[0], "step 0");
    assert.equal(messages[116], "step 116");
    assert.equal(messages[117], "readiness probe failed: GET /health 503");
    assert.equal(messages[119], "step 119");

    const errors = await call(`/deploys/${deployId}/logs?level=error`, { headers: { "x-api-key": apiKey } });
    assert.deepEqual(errors.body.items.map((l) => l.message), ["readiness probe failed: GET /health 503"]);
  });

  test("6. on-call rolls back with a reason", async () => {
    const rolledBack = await call(`/deploys/${deployId}`, send("PATCH", ci, { status: "ROLLED_BACK", reason: "reverted to 2.2.9" }));
    assert.equal(rolledBack.status, 200);
    assert.equal(rolledBack.body.status, "ROLLED_BACK");
    assert.equal(rolledBack.body.reason, "reverted to 2.2.9");
  });
});
