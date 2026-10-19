import { timingSafeEqual } from "node:crypto";
import express, { type RequestHandler } from "express";
import jwt from "jsonwebtoken";

const app = express();
const port = process.env.PORT ?? 3000;
const deployServiceUrl = process.env.DEPLOY_SERVICE_URL ?? "http://deploy-service:3001";
const logServiceUrl = process.env.LOG_SERVICE_URL ?? "http://log-service:3002";
const defaultUpstreamTimeoutMs = 5_000;
const overviewTimeoutMs = 2_000;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

function isValidApiKey(value: string | undefined): boolean {
  const expectedApiKey = process.env.CI_API_KEY;

  if (!value || !expectedApiKey) {
    return false;
  }

  const received = Buffer.from(value);
  const expected = Buffer.from(expectedApiKey);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function hasValidJwt(authorization: string | undefined): boolean {
  const jwtSecret = process.env.JWT_SECRET;
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token || !jwtSecret) {
    return false;
  }

  try {
    jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}

const requireJwt: RequestHandler = (req, res, next) => {
  if (!hasValidJwt(req.header("authorization"))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
};

const requireApiKey: RequestHandler = (req, res, next) => {
  if (!isValidApiKey(req.header("x-api-key"))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
};

const requireJwtOrApiKey: RequestHandler = (req, res, next) => {
  if (!hasValidJwt(req.header("authorization")) && !isValidApiKey(req.header("x-api-key"))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
};

function proxyTo(baseUrl: string, timeoutMs: number): RequestHandler {
  return async (req, res) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        typeof value === "string" &&
        !["authorization", "connection", "content-length", "host", "x-api-key"].includes(name.toLowerCase())
      ) {
        headers.set(name, value);
      }
    }

    const hasBody = !["GET", "HEAD"].includes(req.method) && req.body !== undefined;
    if (hasBody && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

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
        if (!["connection", "content-length", "transfer-encoding"].includes(name.toLowerCase())) {
          res.setHeader(name, value);
        }
      });
      res.status(upstreamResponse.status).send(responseBody);
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        res.status(504).json({ error: "Gateway Timeout" });
        return;
      }

      res.status(502).json({ error: "Bad Gateway" });
    }
  };
}

// Handled locally: public and never forwarded upstream.
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Deploy Service routes.
app.post("/deploys", requireApiKey, proxyTo(deployServiceUrl, defaultUpstreamTimeoutMs));
app.patch("/deploys/:id", requireApiKey, proxyTo(deployServiceUrl, defaultUpstreamTimeoutMs));
app.get("/deploys", requireJwt, proxyTo(deployServiceUrl, defaultUpstreamTimeoutMs));
app.get("/deploys/:id", requireJwt, proxyTo(deployServiceUrl, defaultUpstreamTimeoutMs));
app.get("/overview", requireJwt, proxyTo(deployServiceUrl, overviewTimeoutMs));

// Log Service routes accept either CI API-key or user JWT credentials.
app.get("/deploys/:id/logs", requireJwtOrApiKey, proxyTo(logServiceUrl, defaultUpstreamTimeoutMs));
app.post("/deploys/:id/logs", requireJwtOrApiKey, proxyTo(logServiceUrl, defaultUpstreamTimeoutMs));

app.listen(port, () => {
  console.log(`api-gateway listening on port ${port}`);
});
