import { describe, expect, it } from "vitest";
import { vectorOrderingProblem } from "./migration-checks.mjs";

describe("vectorOrderingProblem", () => {
  it("accepts a migration that creates the extension before the column", () => {
    const sql = [
      "CREATE EXTENSION IF NOT EXISTS vector;",
      'CREATE TABLE "candidates" ("embedding" vector(384));',
    ].join("\n");
    expect(vectorOrderingProblem(sql)).toBeNull();
  });

  // The defect this check exists for. Postgres refuses the whole migration, and the failure
  // arrives when someone applies it to a fresh branch — long after the diff was reviewed.
  it("rejects a column declared before the extension", () => {
    const sql = [
      'CREATE TABLE "candidates" ("embedding" vector(384));',
      "CREATE EXTENSION IF NOT EXISTS vector;",
    ].join("\n");
    expect(vectorOrderingProblem(sql)).toMatch(/before CREATE EXTENSION/);
  });

  it("rejects a column with no extension statement at all", () => {
    expect(vectorOrderingProblem('CREATE TABLE "c" ("e" vector(384));')).toMatch(
      /never creates the vector extension/,
    );
  });

  it("ignores a migration that uses no vector column", () => {
    expect(vectorOrderingProblem('CREATE TABLE "topics" ("id" TEXT);')).toBeNull();
  });

  // Measured on the real file: the header comment explains the ordering and names
  // vector(384) while doing so, which made the first version of this check report the
  // correct migration as broken. Prose about a rule must not trip the rule.
  it("does not read a comment as a column declaration", () => {
    const sql = [
      "-- Two tables below declare vector(384) columns, so the extension comes first.",
      "CREATE EXTENSION IF NOT EXISTS vector;",
      'CREATE TABLE "candidates" ("embedding" vector(384));',
    ].join("\n");
    expect(vectorOrderingProblem(sql)).toBeNull();
  });
});
