import { describe, expect, it } from "vitest";
import { createPrismaClient, DatabaseUnavailableError, hostOf } from "./client.js";

const POOLED = "postgresql://u:p@ep-lingering-wind-auykbv0q-pooler.c-10.aws.neon.tech/db";
const DIRECT = "postgresql://u:p@ep-lingering-wind-auykbv0q.c-10.aws.neon.tech/db";

describe("hostOf", () => {
  it("returns the host without credentials", () => {
    expect(hostOf(POOLED)).toBe("ep-lingering-wind-auykbv0q-pooler.c-10.aws.neon.tech");
    expect(hostOf(POOLED)).not.toContain("p@");
  });

  it("says so rather than throwing when the string is not a URL", () => {
    expect(hostOf("not a url")).toBe("<unparseable connection string>");
  });
});

describe("createPrismaClient", () => {
  // The defect this exists for. Handing the application the direct URL does not fail
  // loudly — it works until a second process starts, then exhausts Neon's connection
  // limit, and the symptom looks like the database being down rather than like a swapped
  // variable. Refusing at construction turns a production mystery into a startup error.
  it("refuses the direct connection string", () => {
    expect(() => createPrismaClient(DIRECT)).toThrow(DatabaseUnavailableError);
    expect(() => createPrismaClient(DIRECT)).toThrow(/DIRECT connection/);
  });

  it("names the host it refused, so the message says which variable was wrong", () => {
    expect(() => createPrismaClient(DIRECT)).toThrow(/ep-lingering-wind-auykbv0q\./);
  });

  // Constructing a client opens no socket: the adapter connects on first query. If that
  // ever changes, the no-network guard in test/setup fails this and names the URL.
  it("accepts the pooled connection string without connecting", () => {
    expect(() => createPrismaClient(POOLED)).not.toThrow();
  });
});
