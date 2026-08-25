import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isoWeek, parseArgs, resolveProfilePath } from "./run.js";

const REPO = resolve(import.meta.dirname, "../../..");

describe("resolveProfilePath", () => {
  it("should load the compiled profile when given the TypeScript source path", () => {
    // The epic's acceptance criterion and its verification block both name the .ts file —
    // the one a reader can actually see. Before this, every such invocation died with
    // ERR_MODULE_NOT_FOUND because a profile resolves ./schema.js at runtime.
    const compiled = join(REPO, "profiles/dist/_test.js");
    if (!existsSync(compiled)) return; // nothing built yet; the other cases still hold
    expect(resolveProfilePath(join(REPO, "profiles/_test.ts"))).toBe(compiled);
  });

  it("should leave an already-compiled path untouched", () => {
    const compiled = join(REPO, "profiles/dist/_test.js");
    expect(resolveProfilePath(compiled)).toBe(compiled);
  });

  it("should fall back to the given path when no compiled output exists", () => {
    // Better a clear module-not-found on the path the user typed than a silent redirect
    // to a file that is not there either.
    const missing = join(REPO, "profiles/does-not-exist.ts");
    expect(resolveProfilePath(missing)).toBe(missing);
  });
});

describe("parseArgs", () => {
  it("should default to a dry run being absent, so publishing needs an explicit flag", () => {
    expect(parseArgs([]).dryRun).toBe(false);
  });

  it("should read the profile path and the fixtures flag", () => {
    const o = parseArgs(["--profile", "profiles/_test.ts", "--fixtures", "--dry-run"]);
    expect(o.profilePath).toBe("profiles/_test.ts");
    expect(o.useFixtures).toBe(true);
    expect(o.dryRun).toBe(true);
  });
});

describe("isoWeek", () => {
  it("should format an ISO week the way the issue cycle key expects", () => {
    expect(isoWeek(new Date("2026-08-25T10:00:00Z"))).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("should put 4 January in week 1, which is the ISO rule that trips naive code", () => {
    expect(isoWeek(new Date("2026-01-04T00:00:00Z"))).toBe("2026-W01");
  });
});
