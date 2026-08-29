import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertPlausibleYield, SourceDriftError, SourceUnavailableError } from "@ai-digest/core";
import type { ConnectorContext, HttpResponse } from "@ai-digest/core";
import { rssConnector, type RssConfig, type RssCursor } from "./index.js";

const FIXTURE = join(import.meta.dirname, "../../../../fixtures/rss/simonwillison.atom.xml");
const feed = readFileSync(FIXTURE, "utf8");

function ctx(
  body: string,
  overrides: Partial<ConnectorContext<RssConfig, RssCursor>> = {},
): ConnectorContext<RssConfig, RssCursor> {
  const response: HttpResponse = { status: 200, body, notModified: false, etag: '"abc"' };
  return {
    sourceKey: "rss:simonwillison",
    config: { feedUrl: "https://simonwillison.net/atom/entries/", sourceName: "Simon Willison" },
    cursor: null,
    since: new Date("2000-01-01T00:00:00Z"),
    now: new Date("2026-08-25T10:00:00Z"),
    http: { get: () => Promise.resolve(response) },
    log: { debug: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

async function collect(c: ConnectorContext<RssConfig, RssCursor>) {
  const pages = [];
  for await (const page of rssConnector.fetch(c)) pages.push(page);
  return pages;
}

describe("rss connector", () => {
  it("should turn a recorded Atom feed into raw items", async () => {
    const [page] = await collect(ctx(feed));
    expect(page?.items.length).toBe(6);
    const first = page?.items[0];
    expect(first?.externalId).toBeTruthy();
    expect(first?.url).toMatch(/^https?:\/\//);
    expect(first?.title).toBeTruthy();
    expect(first?.bodyFormat).toBe("html");
  });

  it("should resolve an Atom alternate link rather than the self link", async () => {
    // Atom carries several <link> elements; taking the first one yields the feed's own
    // URL for every entry, which looks plausible and is silently wrong.
    const [page] = await collect(ctx(feed));
    for (const item of page?.items ?? []) {
      expect(item.url).not.toBe("http://simonwillison.net/atom/entries/");
    }
  });

  it("should carry an ISO published date when the feed has one", async () => {
    const [page] = await collect(ctx(feed));
    expect(page?.items[0]?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("should stop at the entry seen on the previous run", async () => {
    const [first] = await collect(ctx(feed));
    const thirdId = first?.items[2]?.externalId;
    const [page] = await collect(ctx(feed, { cursor: { lastEntryId: thirdId } }));
    // Walks back from newest and stops when it recognises the cursor: only what is new.
    expect(page?.items.length).toBe(2);
  });

  it("should skip entries older than the window", async () => {
    const [page] = await collect(ctx(feed, { since: new Date("2030-01-01T00:00:00Z") }));
    expect(page?.items.length).toBe(0);
  });

  it("should return an empty page but keep the cursor on 304", async () => {
    // "Nothing new" and "nothing there" must not look the same to the runner.
    const cursor = { etag: '"abc"', lastEntryId: "x" };
    const notModified: HttpResponse = { status: 304, body: "", notModified: true };
    const [page] = await collect(
      ctx("", { cursor, http: { get: () => Promise.resolve(notModified) } }),
    );
    expect(page?.items).toEqual([]);
    expect(page?.cursor).toEqual(cursor);
  });

  // ── the gate this connector must prove, red on the defect it names (DoD #4) ──

  it("should raise SourceDriftError naming the field when an entry loses its link", async () => {
    // The failure mode this replaces: a renamed field yields zero items, which reads as a
    // quiet week and goes unnoticed for months.
    const broken = feed.replace(/<link href=/g, "<lnk href=");
    await expect(collect(ctx(broken))).rejects.toThrow(SourceDriftError);
    await expect(collect(ctx(broken))).rejects.toThrow(/url/);
  });

  it("should raise SourceDriftError when the document is not a feed at all", async () => {
    await expect(collect(ctx("<html><body>404</body></html>"))).rejects.toThrow(SourceDriftError);
    await expect(collect(ctx("<html><body>404</body></html>"))).rejects.toThrow(/channel|feed/);
  });

  it("should raise SourceUnavailableError when a source yields implausibly little", () => {
    // A source answering 200 with nothing is indistinguishable from a dead one.
    expect(() => {
      assertPlausibleYield("rss:simonwillison", 0, rssConnector.policy);
    }).toThrow(SourceUnavailableError);
    expect(() => {
      assertPlausibleYield("rss:simonwillison", 1, rssConnector.policy);
    }).not.toThrow();
  });

  it("should resolve a relative href against the feed URL", async () => {
    // A relative href is legal Atom under xml:base and is emitted by several static-site
    // generators. Before this it travelled on as a relative string and detonated two
    // stages later, in extract, after the model call had been billed.
    const relative = feed.replace(
      /<link href="https:\/\/simonwillison\.net(\/[^"]+)"/g,
      '<link href="$1"',
    );
    const [page] = await collect(ctx(relative));
    expect(page?.items.length).toBeGreaterThan(0);
    for (const item of page?.items ?? []) {
      expect(item.url).toMatch(/^https:\/\/simonwillison\.net\//);
    }
  });
});
