/**
 * Prisma CLI configuration.
 *
 * The connection string here is the DIRECT one, and that is the whole point. Migration and
 * introspection commands read this file; the running application never does — it receives a
 * driver adapter built from the pooled URL instead (see src/client.ts). So the two
 * connections cannot be swapped by accident: they are not even reachable from the same
 * place.
 *
 * Why it matters: Neon's pooler multiplexes sessions, and a schema migration needs one
 * session it owns for its whole duration. Run through the pooler it hangs or half-applies,
 * and both failures look like a Prisma bug rather than a configuration mistake.
 *
 * `process.env` is read here rather than through packages/core/src/env.ts because this file
 * is executed by the Prisma CLI as a standalone config, outside our module graph and before
 * anything of ours is loaded. It is the one deliberate exception to the env rule, and the
 * ESLint override that permits it names this file explicitly.
 */

import { defineConfig, env } from "prisma/config";

/**
 * Prisma 7 no longer loads `.env` on its own, and this file sits two directories below the
 * one that holds it. Without this the CLI fails with "Cannot resolve environment variable",
 * which reads like a missing secret rather than a missing loader.
 *
 * Node's own loader is used because it does not overwrite variables that are already set:
 * in CI the value arrives as a real environment variable and there is no file at all, and
 * an absent file must stay a non-event.
 */
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url).pathname);
} catch {
  // No .env — CI, or a shell that already exported the value.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL_UNPOOLED"),
  },
});
