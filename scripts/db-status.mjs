#!/usr/bin/env node
/**
 * What the database configuration looks like, without connecting to it.
 *
 * Deliberately offline. Everything that would open a session — applying migrations, asking
 * Postgres which ones it has — is blocked from an agent session by
 * .claude/hooks/live-effects-guard.sh, and correctly so. So this reports what can be known
 * from the repository and the environment, and then prints the exact command the owner runs
 * for the half that needs a connection.
 *
 * The check it exists for: the two Neon URLs are easy to swap, and a swap does not fail
 * loudly. It hangs, or half-applies a migration, and looks like a Prisma bug.
 *
 * Run: pnpm db:status
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vectorOrderingProblem } from "./lib/migration-checks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "packages/db/prisma/migrations");

// Read .env the same way the application does: values already in the environment win,
// because an explicit export is a deliberate override.
const env = { ...process.env };
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

let problems = 0;
const fail = (message) => {
  problems += 1;
  console.log(`  ✗ ${message}`);
};
const ok = (message) => console.log(`  ✓ ${message}`);

console.log("\nConnection strings");

const pooled = env.DATABASE_URL;
const direct = env.DATABASE_URL_UNPOOLED;

if (!pooled) {
  fail("DATABASE_URL is not set. The pipeline falls back to MemoryRepo under --fixtures, so");
  console.log("    offline runs still work; a live run needs this.");
} else if (!hostOf(pooled)) {
  fail("DATABASE_URL is not a parseable URL.");
} else if (!hostOf(pooled).includes("-pooler")) {
  fail(`DATABASE_URL points at ${hostOf(pooled)}, which has no "-pooler" segment.`);
  console.log("    That is the DIRECT connection. The application must use the pooled one, or");
  console.log("    it exhausts Neon's connection limit as soon as two processes run.");
} else {
  ok(`DATABASE_URL  → ${hostOf(pooled)} (pooled, for the application)`);
}

if (!direct) {
  fail("DATABASE_URL_UNPOOLED is not set. Migrations have nowhere to run.");
} else if (!hostOf(direct)) {
  fail("DATABASE_URL_UNPOOLED is not a parseable URL.");
} else if (hostOf(direct).includes("-pooler")) {
  fail(`DATABASE_URL_UNPOOLED points at ${hostOf(direct)}, which IS the pooled host.`);
  console.log("    A migration needs a session it owns for its whole duration; through the");
  console.log("    pooler it hangs or half-applies, and the failure looks like a Prisma bug.");
} else {
  ok(`DATABASE_URL_UNPOOLED → ${hostOf(direct)} (direct, for migrations only)`);
}

if (pooled && direct && hostOf(pooled) && hostOf(direct)) {
  const same = hostOf(pooled).replace("-pooler", "") === hostOf(direct);
  if (same) ok("both point at the same Neon endpoint, as they should");
  else fail("the two URLs point at DIFFERENT endpoints — one of them is from another branch");
}

console.log("\nMigrations on disk");
if (!existsSync(MIGRATIONS)) {
  fail(`${MIGRATIONS} does not exist.`);
} else {
  const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (dirs.length === 0) fail("no migrations found.");
  for (const dir of dirs) {
    const sql = join(MIGRATIONS, dir, "migration.sql");
    if (!existsSync(sql)) {
      fail(`${dir} has no migration.sql`);
      continue;
    }
    const body = readFileSync(sql, "utf8");
    const problem = vectorOrderingProblem(body);
    if (problem) fail(`${dir}: ${problem}`);
    else ok(`${dir} (${body.split("\n").length} lines)`);
  }
}

console.log("\nWhat this cannot tell you");
console.log("  Which migrations the database has actually applied. That needs a connection,");
console.log("  which is blocked from an agent session on purpose. Run it yourself:");
console.log("    cd packages/db && ./node_modules/.bin/prisma migrate status\n");

process.exit(problems === 0 ? 0 : 1);
