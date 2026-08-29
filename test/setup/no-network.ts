/**
 * Hard network ban for the test run.
 *
 * A test that is green only when the internet is up is a weather report, not a gate
 * (.claude/rules/testing.md). Connectors are exercised against recorded fixtures; the
 * only place that talks to live sources is `pnpm connector:check`, which is a report.
 *
 * This file fails the test that reaches out, naming the URL, instead of letting it hang
 * until a CI timeout — a timeout looks like flakiness and gets retried, a thrown error
 * gets fixed.
 *
 * Two doors, not one. `fetch` is the obvious one; the database is the other. PrismaNeon
 * reaches Postgres over a WebSocket, and `@neondatabase/serverless` 1.1.0 opens it as
 * `new this.webSocketConstructor(url)` falling back to the global `new WebSocket(url)` —
 * never through `fetch`. Until 2026-08-29 only `fetch` was stubbed here, so a test that
 * touched a real Prisma client would have connected to a real database and this file would
 * have said nothing (found in the review of E-007, closed by E-013).
 */
import { beforeAll } from "vitest";

export class NetworkAccessInTestError extends Error {
  constructor(target: string) {
    super(
      `Network access from a test is forbidden: ${target}\n` +
        `Record a fixture instead: pnpm fixtures:record <connector>. See .claude/rules/testing.md.`,
    );
    this.name = "NetworkAccessInTestError";
  }
}

beforeAll(() => {
  globalThis.fetch = (input: unknown) => {
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as { url?: string })?.url ?? "<unknown>");
    throw new NetworkAccessInTestError(target);
  };

  // Throwing from the constructor, not from `send`: the socket is opened by `new`, so
  // anything later is already too late to call it "no connection was opened".
  class ForbiddenWebSocket {
    constructor(url: string | URL) {
      throw new NetworkAccessInTestError(typeof url === "string" ? url : url.href);
    }
  }
  globalThis.WebSocket = ForbiddenWebSocket as unknown as typeof WebSocket;
});
