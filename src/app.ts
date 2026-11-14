import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import jwt from "jsonwebtoken";

// API gateway: the only public entry point (IRD-003 Decision #1). Authenticates, routes to
// deploy-service / log-service with per-route timeouts, and serves the read-only dashboard UI.

export interface GatewayConfig {
  jwtSecret: string | undefined;
  ciApiKey: string | undefined;
  deployServiceUrl: string;
  logServiceUrl: string;
  defaultUpstreamTimeoutMs?: number;
  overviewTimeoutMs?: number;
  publicDir?: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const HOP_BY_HOP_REQUEST_HEADERS = ["authorization", "connection", "content-length", "host", "x-api-key", "x-request-id"];
const HOP_BY_HOP_RESPONSE_HEADERS = ["connection", "content-length", "transfer-encoding"];

// Applied to every response (UI and API). The UI loads nothing from other origins and uses no
// inline script/style, so the strictest CSP works and blunts XSS against the stored token.
const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
};

// Keeps a well-formed inbound x-request-id (or makes one), returns it to the client and forwards it
// upstream, so one id ties together the gateway's and the service's log lines.
const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.header("x-request-id");
  const id = inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
  res.locals.requestId = id;
  res.setHeader("x-request-id", id);
  next();
};

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

const notFound: RequestHandler = (req, res) => {
  res.status(404).json(errorBody("NOT_FOUND", `Route ${req.method} ${req.path} not found`));
};

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const parserError = err as { type?: string; status?: number };
  if (parserError.type === "entity.parse.failed") {
    res.status(400).json(errorBody("INVALID_JSON", "Request body is not valid JSON"));
    return;
  }
  if (parserError.type === "entity.too.large") {
    res.status(413).json(errorBody("PAYLOAD_TOO_LARGE", "Request body is too large"));
    return;
  }
  if (typeof parserError.status === "number" && parserError.status >= 400 && parserError.status < 500) {
    res.status(parserError.status).json(errorBody("BAD_REQUEST", "Bad request"));
    return;
  }
  console.error(
    JSON.stringify({ level: "error", msg: "unhandled error", request_id: res.locals.requestId, path: req.path, error: String(err) })
  );
  res.status(500).json(errorBody("INTERNAL", "Internal server error"));
};

export function createApp(config: GatewayConfig) {
  const defaultTimeoutMs = config.defaultUpstreamTimeoutMs ?? 5_000;
  const overviewTimeoutMs = config.overviewTimeoutMs ?? 2_000;

  function isValidApiKey(value: string | undefined): boolean {
    if (!value || !config.ciApiKey) return false;
    const received = Buffer.from(value);
    const expected = Buffer.from(config.ciApiKey);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  // HS256 only, and the token must expire: a leaked token without `exp` would be valid forever.
  function hasValidJwt(authorization: string | undefined): boolean {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token || !config.jwtSecret) return false;
    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
      return typeof payload === "object" && typeof payload.exp === "number";
    } catch {
      return false;
    }
  }

  const unauthorized: RequestHandler = (_req, res) => {
    res.status(401).json(errorBody("UNAUTHORIZED", "Missing or invalid credentials"));
  };

  const requireJwt: RequestHandler = (req, res, next) =>
    hasValidJwt(req.header("authorization")) ? next() : unauthorized(req, res, next);

  const requireApiKey: RequestHandler = (req, res, next) =>
    isValidApiKey(req.header("x-api-key")) ? next() : unauthorized(req, res, next);

  const requireJwtOrApiKey: RequestHandler = (req, res, next) =>
    hasValidJwt(req.header("authorization")) || isValidApiKey(req.header("x-api-key")) ? next() : unauthorized(req, res, next);

  function proxyTo(baseUrl: string, timeoutMs: number): RequestHandler {
    return async (req, res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string" && !HOP_BY_HOP_REQUEST_HEADERS.includes(name.toLowerCase())) {
          headers.set(name, value);
        }
      }
      headers.set("x-request-id", res.locals.requestId);

      const hasBody = !["GET", "HEAD"].includes(req.method) && req.body !== undefined;
      if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json");

      try {
        const upstreamResponse = await fetch(new URL(req.originalUrl, baseUrl), {
          method: req.method,
          headers,
          body: hasBody ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "manual"
        });
        const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());

        upstreamResponse.headers.forEach((value, name) => {
          if (!HOP_BY_HOP_RESPONSE_HEADERS.includes(name.toLowerCase())) res.setHeader(name, value);
        });
        res.setHeader("x-request-id", res.locals.requestId);
        res.status(upstreamResponse.status).send(responseBody);
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        console.error(
          JSON.stringify({
            level: "error",
            msg: timedOut ? "upstream timeout" : "upstream unreachable",
            request_id: res.locals.requestId,
            upstream: baseUrl,
            path: req.path
          })
        );
        if (timedOut) {
          res.status(504).json(errorBody("GATEWAY_TIMEOUT", "Upstream service did not respond in time"));
          return;
        }
        res.status(502).json(errorBody("BAD_GATEWAY", "Upstream service is unavailable"));
      }
    };
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(requestId);
  app.use(express.json({ limit: "1mb" }));

  // Handled locally: public and never forwarded upstream.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Dashboard UI (static, no secrets). Every data call it makes goes through the JWT-protected API below.
  app.use(express.static(config.publicDir ?? path.join(__dirname, "public"), { index: "index.html", maxAge: 0 }));

  // Deploy Service routes (IRD-003 §4).
  app.post("/deploys", requireApiKey, proxyTo(config.deployServiceUrl, defaultTimeoutMs));
  app.patch("/deploys/:id", requireApiKey, proxyTo(config.deployServiceUrl, defaultTimeoutMs));
  app.get("/deploys", requireJwt, proxyTo(config.deployServiceUrl, defaultTimeoutMs));
  app.get("/deploys/:id", requireJwt, proxyTo(config.deployServiceUrl, defaultTimeoutMs));
  app.get("/overview", requireJwt, proxyTo(config.deployServiceUrl, overviewTimeoutMs));

  // Log Service routes: CI writes (API key only), engineers and CI read (JWT or API key).
  app.post("/deploys/:id/logs", requireApiKey, proxyTo(config.logServiceUrl, defaultTimeoutMs));
  app.post("/deploys/:id/logs/batch", requireApiKey, proxyTo(config.logServiceUrl, defaultTimeoutMs));
  app.get("/deploys/:id/logs", requireJwtOrApiKey, proxyTo(config.logServiceUrl, defaultTimeoutMs));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
