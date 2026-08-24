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
});
