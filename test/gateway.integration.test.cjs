const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const test = require("node:test");
const jwt = require("jsonwebtoken");

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function urlFor(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitForGateway(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("gateway did not start");
}

test("TIE-9 authenticates and forwards the configured routes", async (t) => {
  const received = [];
  const deployServer = await listen((req, res) => {
    received.push({ service: "deploy", method: req.method, url: req.url });
    if (req.url.startsWith("/overview?delay=true")) {
      setTimeout(() => res.end("too late"), 2_500);
      return;
    }
    res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "deploy", path: req.url }));
  });
  const logServer = await listen((req, res) => {
    received.push({ service: "log", method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "log", path: req.url }));
  });
  const gatewayPort = 31_910;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const gateway = spawn(process.execPath, ["dist/index.js"], {
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      JWT_SECRET: "test-jwt-secret",
      CI_API_KEY: "test-ci-api-key",
      DEPLOY_SERVICE_URL: urlFor(deployServer),
      LOG_SERVICE_URL: urlFor(logServer)
    },
    stdio: "ignore"
  });

  t.after(async () => {
    gateway.kill();
    await once(gateway, "exit");
    await Promise.all([
      new Promise((resolve) => deployServer.close(resolve)),
      new Promise((resolve) => logServer.close(resolve))
    ]);
  });

  await waitForGateway(gatewayUrl);
  const validJwt = jwt.sign({ sub: "engineer-1" }, "test-jwt-secret", { algorithm: "HS256" });

  assert.equal((await fetch(`${gatewayUrl}/overview`)).status, 401);
  assert.equal((await fetch(`${gatewayUrl}/overview`, { headers: { authorization: "Bearer invalid" } })).status, 401);
  assert.equal((await fetch(`${gatewayUrl}/deploys`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${gatewayUrl}/deploys`, { method: "POST", headers: { "x-api-key": "invalid" } })).status, 401);

  assert.equal((await fetch(`${gatewayUrl}/overview`, { headers: { authorization: `Bearer ${validJwt}` } })).status, 200);
  assert.equal((await fetch(`${gatewayUrl}/deploys`, { method: "POST", headers: { "x-api-key": "test-ci-api-key" } })).status, 201);
  assert.equal((await fetch(`${gatewayUrl}/deploys/deploy-42/logs`, { headers: { authorization: `Bearer ${validJwt}` } })).status, 200);
  assert.equal((await fetch(`${gatewayUrl}/deploys/deploy-42/logs`, { method: "POST", headers: { "x-api-key": "test-ci-api-key" } })).status, 200);
  assert.equal((await fetch(`${gatewayUrl}/overview?delay=true`, { headers: { authorization: `Bearer ${validJwt}` } })).status, 504);

  assert.deepEqual(received.slice(0, 4), [
    { service: "deploy", method: "GET", url: "/overview" },
    { service: "deploy", method: "POST", url: "/deploys" },
    { service: "log", method: "GET", url: "/deploys/deploy-42/logs" },
    { service: "log", method: "POST", url: "/deploys/deploy-42/logs" }
  ]);

  // G4: PATCH /deploys/:id must still require the CI API key, and must actually
  // reach the deploy service (old route had no :id, so this 404'd before auth ran).
  assert.equal(
    (await fetch(`${gatewayUrl}/deploys/deploy-42`, { method: "PATCH" })).status,
    401
  );
  assert.equal(
    (
      await fetch(`${gatewayUrl}/deploys/deploy-42`, {
        method: "PATCH",
        headers: { "x-api-key": "test-ci-api-key" }
      })
    ).status,
    200
  );
  assert.deepEqual(received.at(-1), { service: "deploy", method: "PATCH", url: "/deploys/deploy-42" });
});
