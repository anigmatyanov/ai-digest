import { describe, expect, it, vi } from "vitest";
import { canonicaliseUrl, normalizeStage } from "./normalize.js";
import type { RunContext } from "../stage.js";
import type { RawItem } from "../../types.js";

function ctx(): RunContext {
  return {
    runId: "r", cycleId: "2026-W35", now: new Date("2026-08-29T00:00:00Z"), dryRun: true,
    repo: {} as RunContext["repo"], llm: {} as RunContext["llm"],
    log: { debug: vi.fn(), warn: vi.fn() }, profile: {},
  };
}
const item = (url: string): RawItem => ({
  id: "raw-1", sourceKey: "rss:probe", externalId: "1", url,
  bodyFormat: "html", signals: {}, fetchedAt: "2026-08-29T00:00:00Z",
  title: "t", body: "<p>text long enough to matter</p>",
});

describe("URL at the boundary", () => {
  it("should refuse to canonicalise a relative URL instead of returning it unchanged", () => {
    // The defect this replaces: canonicaliseUrl swallowed the new URL() failure and
    // returned the input, so a relative href travelled through normalize and prefilter
    // and detonated two stages later in extract — after the model call was billed.
    expect(canonicaliseUrl("/2026/Aug/25/some-post")).toBeNull();
    expect(canonicaliseUrl("not a url at all")).toBeNull();
  });

  it("should still canonicalise an absolute URL", () => {
    expect(canonicaliseUrl("https://Example.com/a/?utm_source=x")).toBe("https://example.com/a");
  });

  it("should drop a candidate whose URL cannot be made absolute, and keep the rest", async () => {
    // A bad item from a source is the source's problem, not a reason to lose the run.
    const out = await normalizeStage.run(
      [item("/relative/path"), item("https://example.com/good")],
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.canonicalUrl).toBe("https://example.com/good");
  });

  it("should say which source and which value were dropped", async () => {
    // Captured through a local spy rather than by reading ctx.log.warn back off the
    // object: a silently shorter funnel is how a broken source hides, so the message has
    // to name the source and the value.
    const warnings: { message: string; data?: unknown }[] = [];
    const c = ctx();
    c.log.warn = (message, data) => warnings.push({ message, data });

    await normalizeStage.run([item("/relative/path")], c);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("rss:probe");
    expect(JSON.stringify(warnings[0]?.data)).toContain("/relative/path");
  });
});
