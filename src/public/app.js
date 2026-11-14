// Deploy Status Checker — read-only on-call dashboard (DSC-06).
// Security rules for this file: data from the API is only ever inserted as text nodes (no HTML-string
// APIs at all — a test enforces it), links are only built from http(s) URLs, and the token lives in sessionStorage.
"use strict";

(() => {
  const TOKEN_KEY = "dsc.token";
  const ENVIRONMENTS = ["dev", "staging", "prod"];
  const STATUSES = ["STARTED", "SUCCESS", "FAILED", "ROLLED_BACK"];
  const LEVELS = ["info", "warn", "error"];
  const HISTORY_PAGE = 25;
  const LOG_PAGE = 100;
  const OVERVIEW_REFRESH_MS = 30_000;

  const view = document.getElementById("view");
  const tokenForm = document.getElementById("token-form");
  const tokenInput = document.getElementById("token-input");
  const tokenClear = document.getElementById("token-clear");
  const tokenStatus = document.getElementById("token-status");

  // ---------- token (sessionStorage may throw in private mode: always guarded) ----------
  const storage = {
    get() {
      try {
        return sessionStorage.getItem(TOKEN_KEY);
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        sessionStorage.setItem(TOKEN_KEY, value);
      } catch {}
    },
    clear() {
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {}
    }
  };
  let token = storage.get();

  // Display only: the gateway is what actually verifies the token.
  function tokenClaims(value) {
    try {
      const payload = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(payload));
    } catch {
      return {};
    }
  }

  function updateTokenUi() {
    tokenClear.hidden = !token;
    if (!token) {
      tokenStatus.textContent = "Not signed in";
      return;
    }
    const { sub, exp } = tokenClaims(token);
    const expired = typeof exp === "number" && exp * 1000 < Date.now();
    const who = typeof sub === "string" ? sub : "token";
    tokenStatus.textContent = expired
      ? `${who} · token expired`
      : `${who}${typeof exp === "number" ? ` · until ${new Date(exp * 1000).toLocaleTimeString()}` : ""}`;
  }

  tokenForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = tokenInput.value.trim();
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) {
      tokenStatus.textContent = "That does not look like a JWT";
      return;
    }
    token = value;
    storage.set(value);
    tokenInput.value = "";
    updateTokenUi();
    route();
  });

  tokenClear.addEventListener("click", () => {
    token = null;
    storage.clear();
    updateTokenUi();
    route();
  });

  // ---------- DOM helpers ----------
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "className") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const notice = (text, isError) => h("div", { className: isError ? "notice error" : "notice" }, text);
  const badge = (status) => h("span", { className: `badge badge-${STATUSES.includes(status) ? status : "STARTED"}` }, status.replace("_", " "));
  const safeHttpUrl = (url) => (typeof url === "string" && /^https?:\/\//i.test(url) ? url : null);

  function timeAgo(iso) {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86_400)}d ago`;
  }
  const fullTime = (iso) => new Date(iso).toLocaleString();
  const logTime = (iso) => {
    const t = new Date(iso);
    return `${t.toLocaleTimeString([], { hour12: false })}.${String(t.getMilliseconds()).padStart(3, "0")}`;
  };

  function viewHead(title, meta, ...actions) {
    return h("div", { className: "view-head" }, h("div", null, h("h1", null, title), meta ? h("div", { className: "meta" }, meta) : null), h("div", null, actions));
  }

  function clickableRow(href, cells) {
    const go = () => {
      location.hash = href;
    };
    return h(
      "tr",
      {
        className: "clickable",
        tabindex: 0,
        onclick: go,
        onkeydown: (event) => {
          if (event.key === "Enter") go();
        }
      },
      cells
    );
  }

  // ---------- API ----------
  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function api(path) {
    if (!token) throw new ApiError(401, "Paste an access token (JWT) above to load data. Ask the platform team, or run scripts/issue-token.cjs in a lab.");
    const response = await fetch(path, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    let body = null;
    try {
      body = await response.json();
    } catch {}
    if (!response.ok) {
      if (response.status === 401) throw new ApiError(401, "Your token is invalid or has expired. Paste a new one above.");
      if (response.status === 504) throw new ApiError(504, "The service took too long to answer. Try again in a moment.");
      throw new ApiError(response.status, (body && body.error && body.error.message) || `Request failed (HTTP ${response.status})`);
    }
    return body;
  }

  // Each navigation gets an id; async work from an older navigation never touches the page.
  let renderId = 0;
  let refreshTimer;
  const isCurrent = (id) => id === renderId;

  async function load(id, container, work) {
    try {
      await work();
    } catch (error) {
      if (isCurrent(id)) container.replaceChildren(notice(error.message, true));
    }
  }

  // ---------- Overview ----------
  function overviewCell(deploy) {
    if (!deploy) return h("td", { className: "cell empty-cell" }, "—");
    const failed = deploy.status === "FAILED" || deploy.status === "ROLLED_BACK";
    return h(
      "td",
      { className: "cell" },
      h(
        "a",
        { className: "cell-link", href: `#/deploys/${deploy.id}`, title: `Started ${fullTime(deploy.created_at)}` },
        badge(deploy.status),
        " ",
        h("span", { className: "meta" }, timeAgo(deploy.updated_at)),
        h("span", { className: "version" }, deploy.version),
        failed && deploy.reason ? h("span", { className: "reason", title: deploy.reason }, deploy.reason) : null
      )
    );
  }

  async function renderOverview(id) {
    const card = h("div", { className: "card" }, notice("Loading…"));
    const meta = h("span", null, "Latest deploy per service and environment");
    view.replaceChildren(viewHead("Overview", meta, h("button", { className: "btn btn-quiet", type: "button", onclick: route }, "Refresh")), card);

    await load(id, card, async () => {
      const { items } = await api("/overview");
      if (!isCurrent(id)) return;
      if (items.length === 0) {
        card.replaceChildren(notice("No deploys recorded yet. CI reports them with POST /deploys."));
        return;
      }
      const byKey = new Map(items.map((d) => [`${d.service}|${d.environment}`, d]));
      const services = [...new Set(items.map((d) => d.service))].sort();
      const failing = items.filter((d) => d.status === "FAILED").length;

      meta.textContent = `${services.length} services · ${failing} failing · refreshed ${new Date().toLocaleTimeString()}`;
      card.replaceChildren(
        h(
          "div",
          { className: "table-wrap" },
          h(
            "table",
            { className: "matrix" },
            h("thead", null, h("tr", null, h("th", null, "Service"), ENVIRONMENTS.map((env) => h("th", null, env)))),
            h(
              "tbody",
              null,
              services.map((service) =>
                h("tr", null, h("td", { className: "mono" }, service), ENVIRONMENTS.map((env) => overviewCell(byKey.get(`${service}|${env}`))))
              )
            )
          )
        )
      );
    });

    if (isCurrent(id)) {
      refreshTimer = setTimeout(() => {
        if (isCurrent(id) && document.visibilityState === "visible") route();
      }, OVERVIEW_REFRESH_MS);
    }
  }

  // ---------- History ----------
  function select(name, label, options, current) {
    return h(
      "select",
      { name, "aria-label": label },
      h("option", { value: "" }, `All ${label.toLowerCase()}`),
      options.map((value) => h("option", { value, selected: value === current }, value))
    );
  }

  async function renderHistory(id, params) {
    const filters = {
      service: params.get("service") || "",
      environment: params.get("environment") || "",
      status: params.get("status") || ""
    };
    const form = h(
      "form",
      {
        className: "filters",
        onsubmit: (event) => {
          event.preventDefault();
          const data = new FormData(event.target);
          const query = new URLSearchParams();
          for (const [key, value] of data) if (String(value).trim()) query.set(key, String(value).trim());
          location.hash = `#/history${query.size ? `?${query}` : ""}`;
        }
      },
      h("input", { name: "service", placeholder: "Service", value: filters.service, "aria-label": "Service" }),
      select("environment", "Environments", ENVIRONMENTS, filters.environment),
      select("status", "Statuses", STATUSES, filters.status),
      h("button", { className: "btn", type: "submit" }, "Apply")
    );
    const tbody = h("tbody");
    const meta = h("span", null, "Every reported deploy, newest first");
    const more = h("button", { className: "btn btn-quiet", type: "button" }, "Load more");
    const moreRow = h("div", { className: "more", hidden: true }, more);
    const results = h("div", null, notice("Loading…"));
    view.replaceChildren(viewHead("History", meta), h("div", { className: "card" }, form, results));

    let cursor = null;
    let shown = 0;
    const loadPage = () =>
      load(id, results, async () => {
        more.disabled = true;
        const query = new URLSearchParams({ limit: String(HISTORY_PAGE) });
        for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
        if (cursor) query.set("cursor", cursor);
        const page = await api(`/deploys?${query}`);
        if (!isCurrent(id)) return;

        for (const d of page.items) {
          tbody.append(
            clickableRow(`#/deploys/${d.id}`, [
              h("td", { title: fullTime(d.created_at) }, timeAgo(d.created_at)),
              h("td", { className: "mono" }, d.service),
              h("td", null, d.environment),
              h("td", { className: "mono" }, d.version),
              h("td", null, badge(d.status)),
              h("td", { className: "mono" }, d.ci_run_id)
            ])
          );
        }
        shown += page.items.length;
        cursor = page.next_cursor;
        meta.textContent = `Showing ${shown} of ${page.total_count}`;
        moreRow.hidden = !cursor;
        more.disabled = false;
        if (shown === 0) {
          results.replaceChildren(notice("No deploys match these filters."));
        } else if (!results.contains(tbody)) {
          const head = ["Started", "Service", "Env", "Version", "Status", "CI run"].map((t) => h("th", null, t));
          results.replaceChildren(h("div", { className: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, head)), tbody)), moreRow);
        }
      });

    more.addEventListener("click", loadPage);
    await loadPage();
  }

  // ---------- Deploy detail + logs ----------
  function field(label, value) {
    return [h("dt", null, label), h("dd", null, value === null || value === undefined || value === "" ? "—" : value)];
  }

  async function renderDetail(id, deployId) {
    const card = h("div", { className: "card" }, notice("Loading…"));
    const logsCard = h("div", { className: "card" });
    view.replaceChildren(h("p", null, h("a", { href: "#/overview" }, "← Overview"), " · ", h("a", { href: "#/history" }, "History")), card, logsCard);

    await load(id, card, async () => {
      const d = await api(`/deploys/${encodeURIComponent(deployId)}`);
      if (!isCurrent(id)) return;
      const runUrl = safeHttpUrl(d.ci_run_url);

      const head = viewHead(`${d.service} → ${d.environment}`, `Deploy of ${d.version}`, badge(d.status));
      head.classList.add("detail-head");
      card.replaceChildren(
        head,
        h(
          "dl",
          { className: "detail-grid" },
          field("Service", h("span", { className: "mono" }, d.service)),
          field("Environment", d.environment),
          field("Version", h("span", { className: "mono" }, d.version)),
          field("Status", badge(d.status)),
          field("Started", fullTime(d.created_at)),
          field("Last update", `${fullTime(d.updated_at)} (${timeAgo(d.updated_at)})`),
          field("Commit", d.commit_sha ? h("span", { className: "mono" }, d.commit_sha) : null),
          field("Triggered by", d.triggered_by),
          field("CI run", runUrl ? h("a", { href: runUrl, target: "_blank", rel: "noopener noreferrer" }, d.ci_run_id) : h("span", { className: "mono" }, d.ci_run_id)),
          field("Deploy id", h("span", { className: "mono" }, d.id))
        ),
        d.reason ? h("div", { className: "detail-reason" }, h("strong", null, d.status === "ROLLED_BACK" ? "Rollback reason: " : "Failure reason: "), d.reason) : null
      );
    });

    if (!isCurrent(id)) return;
    await renderLogs(id, deployId, logsCard, "");
  }

  async function renderLogs(id, deployId, container, level) {
    const list = h("ol", { className: "logs" });
    const more = h("button", { className: "btn btn-quiet", type: "button" }, "Load more");
    const moreRow = h("div", { className: "more", hidden: true }, more);
    const body = h("div", null, notice("Loading logs…"));
    const levelSelect = h(
      "select",
      { "aria-label": "Log level", onchange: (event) => renderLogs(id, deployId, container, event.target.value) },
      h("option", { value: "" }, "All levels"),
      LEVELS.map((value) => h("option", { value, selected: value === level }, value))
    );
    container.replaceChildren(h("div", { className: "filters" }, h("strong", null, "Logs"), levelSelect), body);

    let cursor = null;
    let shown = 0;
    const loadPage = () =>
      load(id, body, async () => {
        more.disabled = true;
        const query = new URLSearchParams({ limit: String(LOG_PAGE) });
        if (level) query.set("level", level);
        if (cursor) query.set("cursor", cursor);
        const page = await api(`/deploys/${encodeURIComponent(deployId)}/logs?${query}`);
        if (!isCurrent(id) || !container.contains(body)) return;

        for (const log of page.items) {
          list.append(
            h(
              "li",
              null,
              h("span", { className: "log-time", title: fullTime(log.timestamp) }, logTime(log.timestamp)),
              h("span", { className: `log-level-${LEVELS.includes(log.level) ? log.level : "info"}` }, log.level.toUpperCase()),
              h("span", { className: "log-message" }, log.message)
            )
          );
        }
        shown += page.items.length;
        cursor = page.next_cursor;
        moreRow.hidden = !cursor;
        more.disabled = false;
        if (shown === 0) body.replaceChildren(notice(level ? `No ${level} logs for this deploy.` : "No logs were attached to this deploy."));
        else if (!body.contains(list)) body.replaceChildren(list, moreRow);
      });

    more.addEventListener("click", loadPage);
    await loadPage();
  }

  // ---------- router ----------
  const DEPLOY_ROUTE = /^\/deploys\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

  async function route() {
    const id = ++renderId;
    clearTimeout(refreshTimer);
    const raw = location.hash.replace(/^#/, "") || "/overview";
    const [path, query = ""] = raw.split("?");
    const deployMatch = DEPLOY_ROUTE.exec(path);
    const tab = path === "/history" || deployMatch ? "history" : "overview";
    for (const link of document.querySelectorAll("[data-tab]")) {
      if (link.dataset.tab === tab) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }

    if (deployMatch) await renderDetail(id, deployMatch[1]);
    else if (path === "/history") await renderHistory(id, new URLSearchParams(query));
    else await renderOverview(id);
  }

  window.addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !location.hash.startsWith("#/deploys") && !location.hash.startsWith("#/history")) route();
  });
  updateTokenUi();
  route();
})();
