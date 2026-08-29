/**
 * HOW THE FIXTURES WERE RECORDED (2026-08-29, live, no key):
 *
 *   https://hn.algolia.com/api/v1/search_by_date
 *     ?tags=story&hitsPerPage=50
 *     &numericFilters=created_at_i>1787000000,created_at_i<1787600000,points>=2
 *     &page=0        -> fixtures/hn/search-by-date.page-0.json
 *     &page=1        -> fixtures/hn/search-by-date.page-1.json
 *
 * Two deliberate differences from the request the connector builds, both recording
 * devices rather than edits: an UPPER bound on `created_at_i`, which freezes a slice of a
 * firehose that would otherwise be different every time it was re-recorded, and
 * `points>=2` where a profile supplies its own threshold. The files are otherwise byte
 * for byte what Algolia answered — nothing was trimmed, and no field was hand-written.
 *
 * `points>=2` is what makes the recording useful: the slice contains stories from 2 to
 * 702 points, so a test can set a threshold in the middle and watch both sides of it.
 * A recording taken at the threshold under test would have no negative cases in it at all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertPlausibleYield,
  SourceDriftError,
  SourceUnavailableError,
  type ConnectorContext,
  type HttpResponse,
} from "@ai-digest/core";
import { hnConnector, type HnConfig, type HnCursor } from "./index.js";

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/hn");
const page0 = readFileSync(join(FIXTURES, "search-by-date.page-0.json"), "utf8");
const page1 = readFileSync(join(FIXTURES, "search-by-date.page-1.json"), "utf8");

/** Facts read off the recording once, so no assertion below re-derives its expectation. */
const NO_URL_STORY = "49424762"; // an Ask HN post: the `url` key is absent, not null
const ABOVE_TEN = ["49424758", "49424747", "49424606", "49424444", "49424387", "49424320"];
const THIRD_STORY_CREATED_AT_I = 1787599959;

/** Serves one recorded body per call, then repeats the last — what a fixture run sees. */
function pagedHttp(bodies: string[]) {
  const calls: string[] = [];
  return {
    calls,
    get: (url: string): Promise<HttpResponse> => {
      const body = bodies[Math.min(calls.length, bodies.length - 1)] as string;
      calls.push(url);
      return Promise.resolve({ status: 200, body, notModified: false });
    },
  };
}

function ctx(
  http: { get: (url: string) => Promise<HttpResponse> },
  config: Partial<HnConfig> = {},
  overrides: Partial<ConnectorContext<HnConfig, HnCursor>> = {},
): ConnectorContext<HnConfig, HnCursor> {
  return {
    sourceKey: "hn:frontpage",
    config: { minPoints: 0, sourceName: "Hacker News", tags: "story", ...config },
    cursor: null,
    since: new Date("2000-01-01T00:00:00Z"),
    now: new Date("2026-08-29T10:00:00Z"),
    http,
    log: { debug: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

async function collect(c: ConnectorContext<HnConfig, HnCursor>) {
  const pages = [];
  for await (const page of hnConnector.fetch(c)) pages.push(page);
  return pages;
}

const itemsOf = <T>(pages: { items: T[] }[]): T[] => pages.flatMap((p) => p.items);

/** Rewrite the recorded JSON — the only way to author a negative case for a live API. */
function mutate(body: string, fn: (doc: Record<string, unknown>) => void): string {
  const doc = JSON.parse(body) as Record<string, unknown>;
  fn(doc);
  return JSON.stringify(doc);
}

const rename = (body: string, from: string, to: string): string =>
  mutate(body, (doc) => {
    for (const hit of doc["hits"] as Record<string, unknown>[]) {
      hit[to] = hit[from];
      delete hit[from];
    }
  });

describe("hn connector", () => {
  it("should return the stories above minPoints and none of the ones below", async () => {
    const pages = await collect(ctx(pagedHttp([page0]), { minPoints: 10 }));
    const items = itemsOf(pages);
    expect(items.map((i) => i.externalId)).toEqual(ABOVE_TEN);
    for (const item of items) {
      expect(item.signals["points"]).toBeGreaterThanOrEqual(10);
    }
    // The negative half, stated separately: the 44 stories below the threshold are not
    // merely absent from a count, they are absent by id.
    expect(items.map((i) => i.externalId)).not.toContain(NO_URL_STORY); // 4 points
  });

  it("should carry points and comments as signals for scoring to read", async () => {
    const [page] = await collect(ctx(pagedHttp([page0]), { minPoints: 100 }));
    const top = page?.items.find((i) => i.externalId === "49424606");
    expect(top?.signals["points"]).toBe(702);
    expect(typeof top?.signals["comments"]).toBe("number");
    expect(top?.title).toBe("Oceans hit highest temperature on record");
    expect(top?.publishedAt).toMatch(/^2026-08-24T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect(top?.author).toBeTruthy();
  });

  // ── AC: a story with no external URL ────────────────────────────────────────────

  it("should give a text post the canonical discussion URL rather than dropping it", async () => {
    // The behaviour is chosen, not left to `undefined`: an Ask HN post's content lives on
    // Hacker News, so the discussion page is its canonical location. Dropping it would be
    // the connector doing selection, and would arrive downstream as a thinner week.
    const [page] = await collect(ctx(pagedHttp([page0]), { minPoints: 0 }));
    const ask = page?.items.find((i) => i.externalId === NO_URL_STORY);
    expect(ask).toBeDefined();
    expect(ask?.url).toBe(`https://news.ycombinator.com/item?id=${NO_URL_STORY}`);
    expect(ask?.body).toBeTruthy();
    expect(ask?.bodyFormat).toBe("html");
  });

  it("should fall back to the discussion URL when `url` is present but not absolute", async () => {
    const relative = mutate(page0, (doc) => {
      (doc["hits"] as Record<string, unknown>[])[0]!["url"] = "/item?id=49424767";
    });
    const [page] = await collect(ctx(pagedHttp([relative])));
    expect(page?.items[0]?.url).toBe("https://news.ycombinator.com/item?id=49424767");
  });

  it("should give every item an absolute http(s) URL", async () => {
    const [page] = await collect(ctx(pagedHttp([page0])));
    for (const item of page?.items ?? []) {
      expect(item.url).toMatch(/^https?:\/\//);
    }
  });

  // ── AC: the window and the cursor ───────────────────────────────────────────────

  it("should stop at the story seen on the previous run", async () => {
    const pages = await collect(
      ctx(pagedHttp([page0]), {}, { cursor: { newestCreatedAtI: THIRD_STORY_CREATED_AT_I } }),
    );
    // Results are newest-first: the two stories newer than the cursor, and nothing else.
    expect(itemsOf(pages)).toHaveLength(2);
    expect(pages[0]?.exhausted).toBe(true);
  });

  it("should checkpoint the newest timestamp it saw so the next run resumes there", async () => {
    const [page] = await collect(ctx(pagedHttp([page0])));
    expect(page?.cursor?.newestCreatedAtI).toBe(1787599981);
  });

  it("should return nothing when every story is older than the window", async () => {
    const pages = await collect(
      ctx(pagedHttp([page0]), {}, { since: new Date("2030-01-01T00:00:00Z") }),
    );
    expect(itemsOf(pages)).toHaveLength(0);
  });

  // ── AC: paging stops at the limit instead of draining the source ────────────────

  it("should stop at maxItemsPerRun instead of collecting every page into memory", async () => {
    // The recording says nbPages=20, i.e. ~1000 stories are reachable. The generator must
    // stop at the cap, not walk them: an unbounded connector fails as an out-of-memory
    // run hours in, which is indistinguishable from an infrastructure problem.
    const http = pagedHttp([page0, page1]);
    const pages = await collect(ctx(http, { minPoints: 0 }));
    expect(itemsOf(pages)).toHaveLength(hnConnector.policy.maxItemsPerRun);
    expect(http.calls).toHaveLength(2);
    expect(pages.at(-1)?.exhausted).toBe(true);
    // and it stopped mid-page rather than after finishing one
    expect(pages[0]?.items).toHaveLength(50);
    expect(pages[1]?.items).toHaveLength(30);
  });

  it("should stop at maxPagesPerRun when pages stay small", async () => {
    // Pages of five distinct stories, re-keyed from the recording: 10 pages of 5 is 50
    // items, under the item cap, so the page cap is the bound being exercised here.
    const small = Array.from({ length: 20 }, (_, page) =>
      mutate(page0, (doc) => {
        const hits = (doc["hits"] as Record<string, unknown>[]).slice(0, 5);
        for (const [i, hit] of hits.entries()) hit["objectID"] = `p${page}-${i}`;
        doc["hits"] = hits;
        delete doc["nbPages"];
      }),
    );
    const http = pagedHttp(small);
    const pages = await collect(ctx(http, { minPoints: 0 }));
    expect(http.calls).toHaveLength(hnConnector.policy.maxPagesPerRun);
    expect(itemsOf(pages)).toHaveLength(5 * hnConnector.policy.maxPagesPerRun);
  });

  it("should stop when a page repeats stories it has already walked", async () => {
    // An offline run is served the same recorded file for every request, because the
    // fixture client answers by file and not by URL. Without this the generator pages to
    // a policy cap and yields the same stories several times over.
    const http = pagedHttp([page0]);
    const pages = await collect(ctx(http, { minPoints: 0 }));
    expect(http.calls).toHaveLength(2);
    expect(itemsOf(pages)).toHaveLength(50);
  });

  it("should send the window and the threshold to the source, not just filter locally", async () => {
    const http = pagedHttp([page0]);
    await collect(ctx(http, { minPoints: 25 }, { since: new Date("2026-08-24T00:00:00Z") }));
    const url = new URL(http.calls[0] as string);
    expect(url.searchParams.get("numericFilters")).toBe("created_at_i>1787529600,points>=25");
    expect(url.searchParams.get("tags")).toBe("story");
  });

  // ── the gates this connector must prove, red on the defects they name (DoD #4) ──

  it("should raise SourceDriftError naming `points` when Algolia renames it", async () => {
    // The failure mode this replaces: `points` becomes undefined, every story fails the
    // threshold, the source returns zero, and the digest reads as a quiet week — for as
    // long as nobody looks.
    const drifted = rename(page0, "points", "score");
    await expect(collect(ctx(pagedHttp([drifted])))).rejects.toThrow(SourceDriftError);
    await expect(collect(ctx(pagedHttp([drifted])))).rejects.toThrow(/points/);
  });

  it("should raise SourceDriftError naming `objectID` when it is renamed", async () => {
    await expect(collect(ctx(pagedHttp([rename(page0, "objectID", "object_id")])))).rejects.toThrow(
      /objectID/,
    );
  });

  it("should raise SourceDriftError naming `created_at_i` when it is renamed", async () => {
    await expect(
      collect(ctx(pagedHttp([rename(page0, "created_at_i", "createdAtI")]))),
    ).rejects.toThrow(/created_at_i/);
  });

  it("should raise SourceDriftError when `points` changes type rather than name", async () => {
    const retyped = mutate(page0, (doc) => {
      for (const hit of doc["hits"] as Record<string, unknown>[])
        hit["points"] = String(hit["points"]);
    });
    await expect(collect(ctx(pagedHttp([retyped])))).rejects.toThrow(SourceDriftError);
    await expect(collect(ctx(pagedHttp([retyped])))).rejects.toThrow(/points/);
  });

  it("should raise SourceDriftError naming `hits` when the envelope loses it", async () => {
    // The class assertion is load-bearing, and was added after the two-way break check:
    // without the envelope schema the loop throws `envelope.hits is not iterable`, whose
    // message happens to contain "hits" — so a message-only assertion stayed green with
    // the gate removed. A TypeError also reads to the runner as a bug in us rather than
    // as the source having changed shape.
    const noHits = mutate(page0, (doc) => {
      doc["results"] = doc["hits"];
      delete doc["hits"];
    });
    await expect(collect(ctx(pagedHttp([noHits])))).rejects.toThrow(SourceDriftError);
    await expect(collect(ctx(pagedHttp([noHits])))).rejects.toThrow(/hits/);
  });

  it("should raise SourceDriftError, not SyntaxError, when the answer is not JSON", async () => {
    // A captive portal or an Algolia error page is an HTML document with status 200.
    // `JSON.parse` would surface it as a bare SyntaxError, which reads as a bug in us.
    const html = "<html><body>503 Service Unavailable</body></html>";
    await expect(collect(ctx(pagedHttp([html])))).rejects.toThrow(SourceDriftError);
    await expect(collect(ctx(pagedHttp([html])))).rejects.toThrow(/not JSON/);
  });

  it("should raise SourceUnavailableError when the window yields fewer than expectMinItems", async () => {
    // Driven by the recorded fixture rather than by a bare number: a threshold nothing
    // clears is exactly the shape of "the source answered 200 and gave us nothing".
    const pages = await collect(ctx(pagedHttp([page0, page1]), { minPoints: 1_000_000 }));
    expect(itemsOf(pages)).toHaveLength(0);
    expect(() => {
      assertPlausibleYield("hn:frontpage", itemsOf(pages).length, hnConnector.policy);
    }).toThrow(SourceUnavailableError);
    expect(() => {
      assertPlausibleYield("hn:frontpage", 1, hnConnector.policy);
    }).not.toThrow();
  });

  it("should declare a kind usable as a source-key prefix", () => {
    // A source key is `kind:name`, and profiles/schema.ts validates the prefix with
    // /^[a-z0-9]+$/ — a kind with a dash generates cleanly and is then unusable anywhere.
    expect(hnConnector.kind).toMatch(/^[a-z0-9]+$/);
  });

  it("should require minPoints rather than defaulting it", () => {
    // A default here would be this package deciding what counts as noticed on Hacker News.
    expect(hnConnector.configSchema.safeParse({ sourceName: "Hacker News" }).success).toBe(false);
    expect(hnConnector.configSchema.safeParse({ minPoints: 50, sourceName: "HN" }).success).toBe(
      true,
    );
  });
});
