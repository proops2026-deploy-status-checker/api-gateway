import { createApp } from "./app";

// Process wiring only: read configuration from the environment (IRD-003 §3.2), start HTTP,
// shut down cleanly. Routing, auth and the UI live in app.ts. (CI: cicd-platform reusable-app-ci@v1)
const port = Number(process.env.PORT ?? 3000);
const shutdownTimeoutMs = 10_000;

const app = createApp({
  jwtSecret: process.env.JWT_SECRET,
  ciApiKey: process.env.CI_API_KEY,
  deployServiceUrl: process.env.DEPLOY_SERVICE_URL ?? "http://deploy-service:3001",
  logServiceUrl: process.env.LOG_SERVICE_URL ?? "http://log-service:3002"
});

const server = app.listen(port, () => {
  console.log(`api-gateway listening on port ${port}`);
});

// Kubernetes sends SIGTERM before killing the Pod: stop accepting connections,
// let in-flight requests finish, then exit cleanly (force-exit if they hang).
function shutdown(signal: NodeJS.Signals): void {
  console.log(`api-gateway received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), shutdownTimeoutMs).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
