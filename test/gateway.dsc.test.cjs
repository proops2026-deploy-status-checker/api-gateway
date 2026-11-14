// DSC-05 / DSC-06: gateway edge behaviour — JSON errors, request ids, JWT expiry, log-write auth,
// AC-09 timeout timing, dashboard static files + security headers, token script.
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { describe, test, before, after } = require("node:test");
const jwt = require("jsonwebtoken");
const { createApp } = require("../dist/app.js");

const JWT_SECRET = "dsc-test-jwt-secret";
const CI_API_KEY = "dsc-test-ci-key";
const deployId = "3f1c2a4e-1111-4222-8333-444455556666";

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
const urlFor = (server) => `http://127.0.0.1:${server.address().port}`;
const close = (server) => new Promise((resolve) => server.close(resolve));
const bearer = (claims = { sub: "tien" }, options = { expiresIn: "5m" }) => ({
  authorization: `Bearer ${jwt.sign(claims, JWT_SECRET, { algorithm: "HS256", ...options })}`
});

describe("API Gateway (DSC-05/06)", () => {
  const received = [];
  let deployUpstream;
  let logUpstream;
  let gateway;
  let base;

  before(async () => {
    const record = (service) => (req, res) => {
      received.push({ service, method: req.method, url: req.url, requestId: req.headers["x-request-id"] });
      if (req.url.startsWith("/overview?hang")) return; // never answers: forces the timeout path
      res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service }));
    };
    deployUpstream = await listen(record("deploy"));
    logUpstream = await listen(record("log"));
    gateway = await listen(
      createApp({
        jwtSecret: JWT_SECRET,
        ciApiKey: CI_API_KEY,
        deployServiceUrl: urlFor(deployUpstream),
        logServiceUrl: urlFor(logUpstream)
      })
    );
    base = urlFor(gateway);
  });

  after(async () => {
    deployUpstream.closeAllConnections();
    await Promise.all([close(gateway), close(deployUpstream), close(logUpstream)]);
  });

  test("unknown route → 404 JSON; malformed JSON → 400 JSON", async () => {
    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    const bad = await fetch(`${base}/deploys`, {
      method: "POST",
      headers: { "x-api-key": CI_API_KEY, "content-type": "application/json" },
      body: "{oops"
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "INVALID_JSON");
  });

  test("x-request-id: valid inbound id is kept and forwarded; otherwise one is generated", async () => {
    const kept = await fetch(`${base}/overview`, { headers: { ...bearer(), "x-request-id": "ci-run-77.step-3" } });
    assert.equal(kept.headers.get("x-request-id"), "ci-run-77.step-3");
    assert.equal(received.at(-1).requestId, "ci-run-77.step-3");

    const generated = await fetch(`${base}/overview`, { headers: { ...bearer(), "x-request-id": "<script>" } });
    const id = generated.headers.get("x-request-id");
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(received.at(-1).requestId, id);
  });

  test("JWT must be HS256, correctly signed, and carry a future exp", async () => {
    const cases = {
      "no exp": `Bearer ${jwt.sign({ sub: "tien" }, JWT_SECRET, { algorithm: "HS256" })}`,
      expired: `Bearer ${jwt.sign({ sub: "tien", exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET, { algorithm: "HS256" })}`,
      "HS512": `Bearer ${jwt.sign({ sub: "tien" }, JWT_SECRET, { algorithm: "HS512", expiresIn: "5m" })}`,
      "wrong secret": `Bearer ${jwt.sign({ sub: "tien" }, "other-secret", { algorithm: "HS256", expiresIn: "5m" })}`,
      "alg none": `Bearer ${jwt.sign({ sub: "tien" }, null, { algorithm: "none", expiresIn: "5m" })}`
    };
    for (const [name, authorization] of Object.entries(cases)) {
      const res = await fetch(`${base}/overview`, { headers: { authorization } });
      assert.equal(res.status, 401, name);
      assert.equal((await res.json()).error.code, "UNAUTHORIZED", name);
    }
    assert.equal((await fetch(`${base}/overview`, { headers: bearer() })).status, 200);
  });

  test("log writes are CI-only (API key); log reads accept JWT or API key", async () => {
    const body = JSON.stringify({ level: "info", message: "x" });
    const json = { "content-type": "application/json" };

    for (const route of [`/deploys/${deployId}/logs`, `/deploys/${deployId}/logs/batch`]) {
      assert.equal((await fetch(`${base}${route}`, { method: "POST", headers: { ...json, ...bearer() }, body })).status, 401, `${route} with JWT`);
      assert.equal((await fetch(`${base}${route}`, { method: "POST", headers: json, body })).status, 401, `${route} anonymous`);
      const ok = await fetch(`${base}${route}`, { method: "POST", headers: { ...json, "x-api-key": CI_API_KEY }, body });
      assert.equal(ok.status, 201, `${route} with API key`);
      assert.deepEqual(received.at(-1).url, route);
      assert.equal(received.at(-1).service, "log");
    }

    assert.equal((await fetch(`${base}/deploys/${deployId}/logs`, { headers: bearer() })).status, 200);
    assert.equal((await fetch(`${base}/deploys/${deployId}/logs`, { headers: { "x-api-key": CI_API_KEY } })).status, 200);
    assert.equal((await fetch(`${base}/deploys/${deployId}/logs`)).status, 401);
  });

  test("AC-09: a hanging upstream returns 504 within 1 s of the 2 s /overview timeout", async () => {
    const started = performance.now();
    const res = await fetch(`${base}/overview?hang=1`, { headers: bearer() });
    const elapsed = performance.now() - started;
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error.code, "GATEWAY_TIMEOUT");
    assert.ok(elapsed >= 1_950 && elapsed < 3_000, `elapsed ${Math.round(elapsed)} ms`);
  });

  test("an unreachable upstream returns 502 BAD_GATEWAY JSON", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const dead = await listen(() => undefined);
    const deadUrl = urlFor(dead);
    await close(dead);
    const isolated = await listen(createApp({ jwtSecret: JWT_SECRET, ciApiKey: CI_API_KEY, deployServiceUrl: deadUrl, logServiceUrl: deadUrl }));
    const res = await fetch(`${urlFor(isolated)}/deploys`, { headers: bearer() });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "BAD_GATEWAY");
    await close(isolated);
  });

  test("GET / serves the dashboard with strict security headers; the API stays protected", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /Deploy Status Checker/);
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");

    for (const asset of ["/app.js", "/app.css"]) assert.equal((await fetch(`${base}${asset}`)).status, 200, asset);
    assert.equal((await fetch(`${base}/overview`)).status, 401);
    assert.equal((await fetch(`${base}/deploys`)).status, 401);
  });

  test("dashboard script never assigns API data through innerHTML", () => {
    const source = require("node:fs").readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe("scripts/issue-token.cjs (DSC-05)", () => {
  const script = path.join(__dirname, "..", "scripts", "issue-token.cjs");

  test("prints an HS256 token with sub and an exp within the requested TTL", () => {
    const token = execFileSync(process.execPath, [script, "--sub", "tien", "--ttl", "30m"], {
      env: { ...process.env, JWT_SECRET }
    })
      .toString()
      .trim();
    const claims = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    assert.equal(claims.sub, "tien");
    assert.equal(claims.exp - claims.iat, 1800);
  });

  test("refuses to run without JWT_SECRET, without --sub, or with a TTL over 24h", () => {
    const env = { ...process.env };
    delete env.JWT_SECRET;
    assert.equal(spawnSync(process.execPath, [script, "--sub", "tien"], { env }).status, 1);
    assert.equal(spawnSync(process.execPath, [script], { env: { ...env, JWT_SECRET } }).status, 1);
    assert.equal(spawnSync(process.execPath, [script, "--sub", "tien", "--ttl", "48h"], { env: { ...env, JWT_SECRET } }).status, 1);
  });
});
