#!/usr/bin/env node
// Issues a short-lived HS256 JWT for an engineer to use the dashboard / read APIs (IRD-003 §3.2).
// Lab/dev stop-gap until an OIDC provider issues tokens (DOP-001 §13). The secret is read from the
// environment, never from argv (argv shows up in `ps` and shell history).
//
//   JWT_SECRET=... node scripts/issue-token.cjs --sub tien [--ttl 8h]
//
// Prints only the token on stdout so it can be piped: TOKEN=$(node scripts/issue-token.cjs --sub tien)
const jwt = require("jsonwebtoken");

const MAX_TTL_SECONDS = 24 * 60 * 60;

function parseArgs(argv) {
  const args = { sub: undefined, ttl: "8h" };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--sub") args.sub = value;
    else if (flag === "--ttl") args.ttl = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function ttlToSeconds(ttl) {
  const match = /^(\d+)([smh])$/.exec(ttl ?? "");
  if (!match) throw new Error("--ttl must look like 30m, 8h or 3600s");
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2]];
  if (seconds < 60 || seconds > MAX_TTL_SECONDS) throw new Error("--ttl must be between 60s and 24h");
  return seconds;
}

function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set in the environment");
  const { sub, ttl } = parseArgs(process.argv.slice(2));
  if (!sub || !/^[A-Za-z0-9._@-]{1,100}$/.test(sub)) throw new Error("--sub <name> is required (letters, digits, . _ @ -)");

  process.stdout.write(`${jwt.sign({ sub }, secret, { algorithm: "HS256", expiresIn: ttlToSeconds(ttl) })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`issue-token: ${error.message}\n`);
  process.exit(1);
}
