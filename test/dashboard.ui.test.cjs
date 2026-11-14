// DSC-96: behaviour tests for the on-call dashboard (src/public/app.js).
// app.js is a plain browser script. Each test builds a fresh jsdom page from index.html, exposes its
// window objects as globals, and loads the script into this Node process (so c8 measures its coverage).
// The API is a stubbed fetch; setTimeout is mocked so the 30 s overview refresh can be tested instantly.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test, beforeEach, afterEach } = require("node:test");
const { JSDOM } = require("jsdom");

const APP_JS = path.join(__dirname, "..", "src", "public", "app.js");
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "src", "public", "index.html"), "utf8").replace(/<script[^>]*><\/script>/, "");
const ORIGIN = "http://dashboard.test";
const DEPLOY_ID = "3f1c2a4e-1111-4222-8333-444455556666";
const GLOBALS = ["window", "document", "location", "sessionStorage", "Node", "FormData", "fetch"];

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fakeJwt = (claims) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.signature`;
const futureToken = () => fakeJwt({ sub: "tien", exp: Math.floor(Date.now() / 1000) + 3600 });
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function deploy(overrides = {}) {
  return {
    id: DEPLOY_ID,
    service: "api-gateway",
    environment: "prod",
    version: "1.4.2",
    status: "SUCCESS",
    reason: null,
    ci_run_id: "run-42",
    ci_run_url: "https://github.com/acme/api-gateway/actions/runs/42",
    commit_sha: "abc1234",
    triggered_by: "tien",
    created_at: ago(120_000),
    updated_at: ago(90_000),
    ...overrides
  };
}

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

// Minimal fake API: routes by pathname, records every call.
function fakeApi(routes) {
  const calls = [];
  const fetch = async (target, options) => {
    const url = new URL(target, ORIGIN);
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: options.headers });
    const handler = routes[url.pathname];
    if (!handler) return json(404, { error: { code: "NOT_FOUND", message: "no route" } });
    return handler(url.searchParams, calls.length);
  };
  return { fetch, calls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(check, label) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await flush();
  }
  assert.fail(`timed out waiting for: ${label}`);
}

let dom;
function openDashboard({ hash = "#/overview", token = null, routes = {}, storage } = {}) {
  dom = new JSDOM(INDEX_HTML, { url: `${ORIGIN}/${hash}`, pretendToBeVisual: true });
  const api = fakeApi(routes);
  if (token) dom.window.sessionStorage.setItem("dsc.token", token);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    sessionStorage: storage || dom.window.sessionStorage,
    Node: dom.window.Node,
    FormData: dom.window.FormData,
    fetch: api.fetch
  });
  delete require.cache[APP_JS];
  require(APP_JS);
  return { api, doc: dom.window.document, $: (sel) => dom.window.document.querySelector(sel) };
}

const text = (node) => (node ? node.textContent.replace(/\s+/g, " ").trim() : "");
// jsdom queues `hashchange` on a timer, and timers are mocked here, so the event is dispatched directly.
const navigate = (hash) => {
  dom.window.location.hash = hash;
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
};

describe("dashboard UI (DSC-96)", () => {
  const saved = {};
  beforeEach((t) => {
    for (const key of GLOBALS) saved[key] = globalThis[key];
    t.mock.timers.enable({ apis: ["setTimeout"] });
  });
  afterEach(() => {
    dom.window.close();
    for (const key of GLOBALS) {
      if (saved[key] === undefined) delete globalThis[key];
      else globalThis[key] = saved[key];
    }
  });

  describe("token", () => {
    test("without a token the page asks for one and calls no API", async () => {
      const { api, $ } = openDashboard();
      await until(() => /Paste an access token/.test(text($("#view"))), "token notice");
      assert.equal(text($("#token-status")), "Not signed in");
      assert.equal($("#token-clear").hidden, true);
      assert.equal(api.calls.length, 0);
    });

    test("rejects input that is not shaped like a JWT", async () => {
      const { $ } = openDashboard();
      $("#token-input").value = "not a token";
      $("#token-form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      assert.equal(text($("#token-status")), "That does not look like a JWT");
      assert.equal(dom.window.sessionStorage.getItem("dsc.token"), null);
    });

    test("a pasted JWT is kept in sessionStorage, shown with its subject and sent as a Bearer token", async () => {
      const token = futureToken();
      const { api, $ } = openDashboard({ routes: { "/overview": () => json(200, { items: [] }) } });
      $("#token-input").value = `  ${token}  `;
      $("#token-form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));

      assert.equal(dom.window.sessionStorage.getItem("dsc.token"), token);
      assert.equal($("#token-input").value, "");
      assert.match(text($("#token-status")), /^tien · until /);
      assert.equal($("#token-clear").hidden, false);
      await until(() => api.calls.length === 1, "overview fetch");
      assert.equal(api.calls[0].headers.authorization, `Bearer ${token}`);
    });

    test("shows an expired token as expired, and a token without claims as 'token'", () => {
      let page = openDashboard({ token: fakeJwt({ sub: "ana", exp: 1 }), routes: { "/overview": () => json(200, { items: [] }) } });
      assert.equal(text(page.$("#token-status")), "ana · token expired");
      dom.window.close();
      page = openDashboard({ token: "aaa.bbb.ccc", routes: { "/overview": () => json(200, { items: [] }) } });
      assert.equal(text(page.$("#token-status")), "token");
    });

    test("sign out forgets the token", async () => {
      const { $ } = openDashboard({ token: futureToken(), routes: { "/overview": () => json(200, { items: [] }) } });
      $("#token-clear").click();
      assert.equal(dom.window.sessionStorage.getItem("dsc.token"), null);
      assert.equal(text($("#token-status")), "Not signed in");
      await until(() => /Paste an access token/.test(text($("#view"))), "token notice after sign out");
    });

    test("still works when sessionStorage throws (private mode)", async () => {
      const throwing = {
        getItem() {
          throw new Error("denied");
        },
        setItem() {
          throw new Error("denied");
        },
        removeItem() {
          throw new Error("denied");
        }
      };
      const { $ } = openDashboard({ storage: throwing, routes: { "/overview": () => json(200, { items: [] }) } });
      assert.equal(text($("#token-status")), "Not signed in");
      $("#token-input").value = futureToken();
      $("#token-form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      assert.match(text($("#token-status")), /^tien/);
      $("#token-clear").click();
      assert.equal(text($("#token-status")), "Not signed in");
    });
  });

  describe("overview", () => {
    const items = [
      deploy({ service: "log-service", environment: "dev", status: "FAILED", reason: "migration timeout", updated_at: ago(30_000) }),
      deploy({ service: "api-gateway", environment: "prod", status: "SUCCESS", updated_at: ago(5 * 3_600_000) }),
      deploy({ service: "api-gateway", environment: "staging", status: "ROLLED_BACK", reason: "smoke test failed", updated_at: ago(3 * 86_400_000) }),
      deploy({ service: "deploy-service", environment: "dev", status: "STARTED", updated_at: ago(10 * 60_000) })
    ];

    test("renders a service × environment matrix, sorted, with failing count and reasons", async () => {
      const { api, $, doc } = openDashboard({ token: futureToken(), routes: { "/overview": () => json(200, { items }) } });
      await until(() => $("table.matrix"), "matrix");

      const rows = [...doc.querySelectorAll("table.matrix tbody tr")].map((tr) => text(tr.firstChild));
      assert.deepEqual(rows, ["api-gateway", "deploy-service", "log-service"]);
      assert.match(text($(".view-head .meta")), /^3 services · 1 failing · refreshed /);
      assert.equal(doc.querySelectorAll("td.empty-cell").length, 5);
      // FAILED and ROLLED_BACK cells show their reason; others do not.
      assert.deepEqual([...doc.querySelectorAll(".reason")].map(text).sort(), ["migration timeout", "smoke test failed"]);
      const ages = [...doc.querySelectorAll("a.cell-link .meta")].map(text).sort();
      assert.deepEqual(ages, ["10m ago", "30s ago", "3d ago", "5h ago"]);
      assert.equal($("a.cell-link").getAttribute("href"), `#/deploys/${DEPLOY_ID}`);
      assert.equal($('[data-tab="overview"]').getAttribute("aria-current"), "page");
      assert.equal(api.calls[0].path, "/overview");
    });

    test("empty system shows a hint", async () => {
      const { $ } = openDashboard({ token: futureToken(), routes: { "/overview": () => json(200, { items: [] }) } });
      await until(() => /No deploys recorded yet/.test(text($("#view"))), "empty notice");
    });

    test("refreshes every 30 s while visible, and on the Refresh button", async (t) => {
      const { api, doc } = openDashboard({ token: futureToken(), routes: { "/overview": () => json(200, { items }) } });
      await until(() => api.calls.length === 1, "first load");
      await until(() => doc.querySelector("table.matrix"), "matrix");
      t.mock.timers.tick(30_000);
      await until(() => api.calls.length === 2, "auto refresh");
      await until(() => doc.querySelector("table.matrix"), "matrix after refresh");
      doc.querySelector(".view-head button").click();
      await until(() => api.calls.length === 3, "manual refresh");
    });

    test("re-renders when the tab becomes visible again", async () => {
      const { api, doc } = openDashboard({ token: futureToken(), routes: { "/overview": () => json(200, { items }) } });
      await until(() => api.calls.length === 1, "first load");
      doc.dispatchEvent(new dom.window.Event("visibilitychange"));
      await until(() => api.calls.length === 2, "reload on visible");
    });

    for (const [status, body, expected] of [
      [401, { error: { message: "x" } }, /invalid or has expired/],
      [504, null, /took too long/],
      [500, { error: { code: "INTERNAL", message: "database unavailable" } }, /database unavailable/],
      [502, undefined, /Request failed \(HTTP 502\)/]
    ]) {
      test(`API ${status} is shown as a readable error`, async () => {
        const routes = {
          "/overview": () =>
            body === undefined
              ? {
                  ok: false,
                  status,
                  json: async () => {
                    throw new SyntaxError("not json");
                  }
                }
              : json(status, body)
        };
        const { $ } = openDashboard({ token: futureToken(), routes });
        await until(() => $(".notice.error"), "error notice");
        assert.match(text($(".notice.error")), expected);
      });
    }
  });

  describe("history", () => {
    const pageOne = {
      items: [deploy({ id: "aaaaaaaa-1111-4222-8333-444455556666", status: "FAILED" }), deploy({ service: "log-service", environment: "dev" })],
      next_cursor: "CURSOR-2",
      total_count: 3
    };
    const pageTwo = { items: [deploy({ id: "cccccccc-1111-4222-8333-444455556666", status: "ROLLED_BACK" })], next_cursor: null, total_count: 3 };

    test("loads filtered history, pages with Load more, and links rows to the detail view", async () => {
      const { api, $, doc } = openDashboard({
        token: futureToken(),
        hash: "#/history?service=api-gateway&environment=prod&status=FAILED",
        routes: { "/deploys": (params) => json(200, params.get("cursor") ? pageTwo : pageOne) }
      });
      await until(() => doc.querySelectorAll("tbody tr").length === 2, "first page");

      assert.deepEqual(api.calls[0].query, { limit: "25", service: "api-gateway", environment: "prod", status: "FAILED" });
      assert.equal(text($(".view-head .meta")), "Showing 2 of 3");
      assert.equal($('select[name="status"]').value, "FAILED");
      assert.equal($('input[name="service"]').value, "api-gateway");
      assert.equal($('[data-tab="history"]').getAttribute("aria-current"), "page");
      assert.equal($(".more").hidden, false);

      $(".more button").click();
      await until(() => doc.querySelectorAll("tbody tr").length === 3, "second page");
      assert.equal(api.calls[1].query.cursor, "CURSOR-2");
      assert.equal(text($(".view-head .meta")), "Showing 3 of 3");
      assert.equal($(".more").hidden, true);

      doc.querySelector("tbody tr").click();
      assert.equal(dom.window.location.hash, "#/deploys/aaaaaaaa-1111-4222-8333-444455556666");
      doc.querySelectorAll("tbody tr")[2].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));
      assert.equal(dom.window.location.hash, "#/deploys/cccccccc-1111-4222-8333-444455556666");
    });

    test("no match shows a notice", async () => {
      const { $ } = openDashboard({
        token: futureToken(),
        hash: "#/history",
        routes: { "/deploys": () => json(200, { items: [], next_cursor: null, total_count: 0 }) }
      });
      await until(() => /No deploys match these filters/.test(text($("#view"))), "no match notice");
    });

    test("applying the filter form writes the filters into the URL", async () => {
      const { $ } = openDashboard({
        token: futureToken(),
        hash: "#/history",
        routes: { "/deploys": () => json(200, { items: [], next_cursor: null, total_count: 0 }) }
      });
      await until(() => $("form.filters"), "filters");
      $('input[name="service"]').value = "  log-service ";
      $('select[name="environment"]').value = "dev";
      $("form.filters").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      assert.equal(dom.window.location.hash, "#/history?service=log-service&environment=dev");

      $('input[name="service"]').value = "";
      $('select[name="environment"]').value = "";
      $("form.filters").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      assert.equal(dom.window.location.hash, "#/history");
    });
  });

  describe("deploy detail", () => {
    const logsPage = (items, next_cursor = null) => ({ items, next_cursor });
    const log = (level, message, i = 0) => ({ id: `l${i}`, deploy_id: DEPLOY_ID, timestamp: ago(60_000 - i), level, message });

    test("shows every field, the failure reason, a CI link, and logs in pages", async () => {
      const failed = deploy({ status: "FAILED", reason: "health check failed" });
      const { api, $, doc } = openDashboard({
        token: futureToken(),
        hash: `#/deploys/${DEPLOY_ID}`,
        routes: {
          [`/deploys/${DEPLOY_ID}`]: () => json(200, failed),
          [`/deploys/${DEPLOY_ID}/logs`]: (params) =>
            json(200, params.get("cursor") ? logsPage([log("info", "rolled back", 3)]) : logsPage([log("info", "pulling image", 1), log("error", "probe failed", 2)], "LOG-2"))
        }
      });
      await until(() => doc.querySelectorAll("ol.logs li").length === 2, "first log page");

      assert.equal(text($(".view-head h1")), "api-gateway → prod");
      assert.equal(text($(".detail-reason")), "Failure reason: health check failed");
      const ciLink = $('.detail-grid a[target="_blank"]');
      assert.equal(ciLink.getAttribute("href"), failed.ci_run_url);
      assert.equal(ciLink.getAttribute("rel"), "noopener noreferrer");
      const fields = Object.fromEntries([...doc.querySelectorAll(".detail-grid dt")].map((dt) => [text(dt), text(dt.nextElementSibling)]));
      assert.equal(fields.Commit, "abc1234");
      assert.equal(fields["Triggered by"], "tien");
      assert.equal(fields.Status, "FAILED");
      assert.equal(doc.querySelector(".log-level-error").textContent, "ERROR");
      assert.equal(api.calls[1].query.limit, "100");

      $(".more button").click();
      await until(() => doc.querySelectorAll("ol.logs li").length === 3, "second log page");
      assert.equal(api.calls[2].query.cursor, "LOG-2");
      assert.equal($(".more").hidden, true);
    });

    test("filters logs by level and explains an empty result", async () => {
      const { api, $ } = openDashboard({
        token: futureToken(),
        hash: `#/deploys/${DEPLOY_ID}`,
        routes: {
          [`/deploys/${DEPLOY_ID}`]: () => json(200, deploy()),
          [`/deploys/${DEPLOY_ID}/logs`]: () => json(200, logsPage([]))
        }
      });
      await until(() => /No logs were attached/.test(text($("#view"))), "no logs notice");

      const levelSelect = $('select[aria-label="Log level"]');
      levelSelect.value = "error";
      levelSelect.dispatchEvent(new dom.window.Event("change"));
      await until(() => /No error logs for this deploy/.test(text($("#view"))), "no error logs notice");
      assert.equal(api.calls.at(-1).query.level, "error");
    });

    test("a rollback shows its reason; a non-http CI URL is not turned into a link; missing fields show a dash", async () => {
      const rolledBack = deploy({ status: "ROLLED_BACK", reason: "bad config", ci_run_url: "javascript:alert(1)", commit_sha: null, triggered_by: "" });
      const { $, doc } = openDashboard({
        token: futureToken(),
        hash: `#/deploys/${DEPLOY_ID}`,
        routes: {
          [`/deploys/${DEPLOY_ID}`]: () => json(200, rolledBack),
          [`/deploys/${DEPLOY_ID}/logs`]: () => json(200, logsPage([log("warn", "slow start")]))
        }
      });
      await until(() => doc.querySelectorAll("ol.logs li").length === 1, "logs");
      assert.equal(text($(".detail-reason")), "Rollback reason: bad config");
      assert.equal($('.detail-grid a[target="_blank"]'), null);
      const fields = Object.fromEntries([...doc.querySelectorAll(".detail-grid dt")].map((dt) => [text(dt), text(dt.nextElementSibling)]));
      assert.equal(fields.Commit, "—");
      assert.equal(fields["Triggered by"], "—");
    });

    test("a missing deploy shows the API error and loads no logs", async () => {
      const { api, $ } = openDashboard({ token: futureToken(), hash: `#/deploys/${DEPLOY_ID}` });
      await until(() => $(".notice.error"), "error notice");
      assert.match(text($(".notice.error")), /no route/);
      await flush();
      assert.ok(api.calls.length >= 1);
    });

    test("navigating away mid-load never lets the old view overwrite the new one", async () => {
      let release;
      const slow = new Promise((resolve) => {
        release = resolve;
      });
      const { $ } = openDashboard({
        token: futureToken(),
        hash: `#/deploys/${DEPLOY_ID}`,
        routes: {
          [`/deploys/${DEPLOY_ID}`]: () => slow,
          "/overview": () => json(200, { items: [] })
        }
      });
      navigate("#/overview");
      await until(() => /No deploys recorded yet/.test(text($("#view"))), "overview rendered");
      release(json(200, deploy()));
      await flush();
      await flush();
      assert.match(text($("#view")), /No deploys recorded yet/);
      assert.equal($(".detail-grid"), null);
    });
  });

  test("unknown routes fall back to the overview", async () => {
    const { api } = openDashboard({ token: futureToken(), hash: "#/nope", routes: { "/overview": () => json(200, { items: [] }) } });
    await until(() => api.calls.length === 1, "overview fetch");
    assert.equal(api.calls[0].path, "/overview");
  });
});
