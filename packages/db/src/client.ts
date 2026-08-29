/**
 * The database connection.
 *
 * Prisma 7 takes its runtime connection from a driver adapter rather than from the schema,
 * so the POOLED url is supplied here and the direct one lives only in prisma.config.ts,
 * where migration commands look. The two cannot be confused by accident because neither
 * file can see the other's value.
 *
 * Nothing here reads `process.env`. The connection string arrives as an argument, because
 * `packages/core/src/env.ts` is the only module allowed to touch the environment and
 * because a repository that reaches for a global is a repository that cannot be pointed at
 * a test branch.
 */

import { PrismaNeon } from "@prisma/adapter-neon";
import { DigestError } from "@ai-digest/core";
import { PrismaClient } from "./generated/client.js";

/** A database operation failed. Carries which connection was in use, because the two Neon
 *  URLs fail in different ways and "connection refused" alone does not say which was tried. */
export class DatabaseUnavailableError extends DigestError {
  constructor(
    readonly host: string,
    readonly purpose: "pooled (application)" | "direct (migrations)",
    cause: string,
  ) {
    super(
      `Database is unreachable over the ${purpose} connection to ${host}.\n` +
        `${cause}\n` +
        `Pooled queries use DATABASE_URL; migrations use DATABASE_URL_UNPOOLED. ` +
        `Swapping them is the usual cause, and it fails like this.`,
    );
  }
}

/** Host of a connection string, for error messages. Never returns credentials. */
export function hostOf(connectionString: string): string {
  try {
    return new URL(connectionString).host;
  } catch {
    return "<unparseable connection string>";
  }
}

/**
 * A pooled client.
 *
 * Refuses a connection string that carries `-pooler` in the wrong direction: the pooled
 * host contains it and the direct host does not, so a swap is detectable here rather than
 * three stages later as an unexplained hang.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  // By host, not by the whole string: a password, database name or query parameter
  // containing "-pooler" would otherwise wave a direct connection through.
  // scripts/db-status.mjs already did it this way; two implementations of one rule
  // had drifted apart.
  if (!hostOf(connectionString).includes("-pooler")) {
    throw new DatabaseUnavailableError(
      hostOf(connectionString),
      "pooled (application)",
      "This host has no `-pooler` segment, so it is the DIRECT connection. The application " +
        "must use the pooled one — a direct connection exhausts Neon's connection limit as " +
        "soon as more than one process runs.",
    );
  }
  return new PrismaClient({ adapter: new PrismaNeon({ connectionString }) });
}

export { PrismaClient };
