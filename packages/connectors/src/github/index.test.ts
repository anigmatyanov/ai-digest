/**
 * Everything here runs off the two recorded feeds under fixtures/github/. No test may
 * reach the network — test/setup/no-network.ts fails naming the URL if one tries.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertPlausibleYield,
  canonicaliseUrl,
  RawItemDraftSchema,
  SourceDriftError,
  SourceUnavailableError,
} from "@ai-digest/core";
import type { ConnectorContext, HttpResponse } from "@ai-digest/core";
import {
  githubConnector,
  githubFeedUrl,
  GithubConfigSchema,
  type GithubConfig,
  type GithubCursor,
} from "./index.js";

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/github");
const releasesFeed = readFileSync(join(FIXTURES, "widget-cli-releases.atom.xml"), "utf8");
const commitsFeed = readFileSync(join(FIXTURES, "widget-cli-commits.atom.xml"), "utf8");

/** Config through the real schema, so a test never exercises a shape a profile cannot produce. */
function config(overrides: Partial<GithubConfig> = {}): GithubConfig {
  return GithubConfigSchema.parse({
    owner: "acme-labs",
    repo: "widget-cli",
    feed: "releases",
    sourceName: "widget-cli",
    ...overrides,
  });
}

function ctx(
  body: string,
  overrides: Partial<ConnectorContext<GithubConfig, GithubCursor>> = {},
): ConnectorContext<GithubConfig, GithubCursor> {
  const response: HttpResponse = { status: 200, body, notModified: false, etag: '"abc"' };
  return {
    sourceKey: "github:widget-cli",
    config: config(),
    cursor: null,
    since: new Date("2000-01-01T00:00:00Z"),
    now: new Date("2026-08-29T10:00:00Z"),
    http: { get: () => Promise.resolve(response) },
    log: { debug: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

async function collect(c: ConnectorContext<GithubConfig, GithubCursor>) {
  const pages = [];
  for await (const page of githubConnector.fetch(c)) pages.push(page);
  return pages;
}

/** The exclusion rules a profile would write to drop merges and bots. Not defaults. */
const EXCLUDE_MERGES_AND_BOTS = {
  excludeTitlePatterns: ["^Merge (pull request|branch|remote-tracking branch) "],
  excludeAuthorPatterns: ["\\[bot\\]$"],
};

describe("feed URL", () => {
  it("addresses the .atom feeds, which need no token and spend no REST quota", () => {
    expect(githubFeedUrl(config({ feed: "releases" }))).toBe(
      "https://github.com/acme-labs/widget-cli/releases.atom",
    );
    expect(githubFeedUrl(config({ feed: "commits" }))).toBe(
      "https://github.com/acme-labs/widget-cli/commits/main.atom",
    );
    expect(githubFeedUrl(config({ feed: "commits", branch: "release/4.2" }))).toBe(
      "https://github.com/acme-labs/widget-cli/commits/release/4.2.atom",
    );
    // No api.github.com anywhere: the moment one appears, the epic's whole premise is gone.
    for (const feed of ["releases", "commits"] as const) {
      expect(githubFeedUrl(config({ feed }))).not.toContain("api.github.com");
    }
  });

  it("refuses an owner, repo or branch that could rewrite the URL", () => {
    // A config is external data. Without this, `repo: "x/../../settings"` or
    // `branch: "main?token=…"` would be interpolated into the URL verbatim.
    expect(() => config({ repo: "widget-cli/../../settings" })).toThrow();
    expect(() => config({ owner: "acme labs" })).toThrow();
    expect(() => config({ feed: "commits", branch: "main?x=1" })).toThrow();
    expect(() => config({ feed: "commits", branch: "release/../etc" })).toThrow();
    expect(() => config({ feed: "commits", branch: "release/4.2" })).not.toThrow();
  });

  it("rejects an exclusion pattern that is not a compilable regex", () => {
    // At the profile boundary, where the offending pattern can be named — not inside a
    // stage during a cron run, as a bare SyntaxError.
    expect(() => config({ excludeTitlePatterns: ["^Merge ("] })).toThrow();
    expect(() => config({ excludeAuthorPatterns: ["[bot"] })).toThrow();
  });
});

describe("releases feed", () => {
  it("turns every release into a raw item with a title, a link and a publication date", async () => {
    const [page] = await collect(ctx(releasesFeed));
    expect(page?.items.length).toBe(5);
    for (const item of page?.items ?? []) {
      expect(item.title).toBeTruthy();
      expect(item.url).toMatch(/^https:\/\/github\.com\/acme-labs\/widget-cli\/releases\/tag\//);
      expect(item.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(item.externalId).toBeTruthy();
      expect(item.bodyFormat).toBe("html");
    }
    const newest = page?.items[0];
    expect(newest?.title).toBe("v4.2.0");
    expect(newest?.publishedAt).toBe("2026-08-24T09:41:12.000Z");
    expect(newest?.author).toBe("marta-ok");
    expect(newest?.body).toContain("Conditional GET");
  });

  it("takes the entry's alternate link, not the feed's own", async () => {
    const [page] = await collect(ctx(releasesFeed));
    for (const item of page?.items ?? []) {
      expect(item.url).not.toBe("https://github.com/acme-labs/widget-cli/releases.atom");
      expect(item.url).not.toBe("https://github.com/acme-labs/widget-cli/releases");
    }
  });

  it("skips releases older than the window", async () => {
    const [page] = await collect(ctx(releasesFeed, { since: new Date("2026-08-13T00:00:00Z") }));
    expect(page?.items.map((i) => i.title)).toEqual(["v4.2.0", "v4.1.3"]);
  });

  it("stops at the entry kept on the previous run", async () => {
    const [first] = await collect(ctx(releasesFeed));
    const thirdId = first?.items[2]?.externalId;
    const [page] = await collect(ctx(releasesFeed, { cursor: { lastEntryId: thirdId } }));
    expect(page?.items.length).toBe(2);
    expect(page?.cursor?.lastEntryId).toBe(first?.items[0]?.externalId);
  });

  it("returns an empty page but keeps the cursor on 304", async () => {
    // "Nothing new" and "nothing there" must not look the same to the runner. The .atom
    // feeds serve an ETag, so this is the ordinary case three times a day, not an edge one.
    const cursor = { etag: '"abc"', lastEntryId: "x" };
    const notModified: HttpResponse = { status: 304, body: "", notModified: true };
    const [page] = await collect(
      ctx("", { cursor, http: { get: () => Promise.resolve(notModified) } }),
    );
    expect(page?.items).toEqual([]);
    expect(page?.cursor).toEqual(cursor);
  });

  it("sends the stored validators back as a conditional GET", async () => {
    const get = vi.fn(() =>
      Promise.resolve({ status: 200, body: releasesFeed, notModified: false }),
    );
    await collect(
      ctx(releasesFeed, {
        cursor: { etag: '"v1"', lastModified: "Mon, 24 Aug 2026 09:41:12 GMT" },
        http: { get },
      }),
    );
    expect(get).toHaveBeenCalledWith("https://github.com/acme-labs/widget-cli/releases.atom", {
      etag: '"v1"',
      lastModified: "Mon, 24 Aug 2026 09:41:12 GMT",
    });
  });
});

describe("commits feed", () => {
  const commitsCtx = (overrides: Partial<GithubConfig> = {}) =>
    ctx(commitsFeed, { config: config({ feed: "commits", ...overrides }) });

  it("returns every commit when the source configures no exclusion rule", async () => {
    // The other half of the assertion below: with no rule, nothing is dropped. If a
    // constant in the connector did the filtering, this count would not be 7.
    const [page] = await collect(commitsCtx());
    expect(page?.items.length).toBe(7);
  });

  it("drops merge commits and bot commits by the source's rules", async () => {
    const [page] = await collect(commitsCtx(EXCLUDE_MERGES_AND_BOTS));
    expect(page?.items.map((i) => i.title)).toEqual([
      "Cache the compiled exclude patterns per run, not per item",
      "Treat an empty config file as an empty object",
      "Stream stage output instead of buffering until exit",
    ]);
    for (const item of page?.items ?? []) {
      expect(item.author).not.toMatch(/\[bot\]$/);
      expect(item.title).not.toMatch(/^Merge /);
    }
  });

  it("applies whatever rule the source gives it, not a rule about merges and bots", async () => {
    // The same fixture, a rule with nothing to do with merges or bots: if the connector
    // carried its own idea of what to drop, this would not track the config.
    const [page] = await collect(commitsCtx({ excludeAuthorPatterns: ["^marta-ok$"] }));
    expect(page?.items.map((i) => i.author)).toEqual([
      "rk-dev",
      "dependabot[bot]",
      "rk-dev",
      "github-actions[bot]",
    ]);
  });

  it("carries the commit link, message and date", async () => {
    const [page] = await collect(commitsCtx(EXCLUDE_MERGES_AND_BOTS));
    const newest = page?.items[0];
    expect(newest?.url).toBe(
      "https://github.com/acme-labs/widget-cli/commit/9f1c0ab4e7d25c3f6a0b8e11d4c77aa903b21e5d",
    );
    expect(newest?.publishedAt).toBe("2026-08-26T16:04:19.000Z");
    expect(newest?.body).toContain("8% of the ingest stage");
  });
});

describe("what the ingest boundary receives", () => {
  it("yields drafts that survive both boundaries, from both feeds", async () => {
    // Two places drop an item silently: ingest re-parses every draft with
    // RawItemDraftSchema, and normalize refuses a URL it cannot canonicalise — a `tag:`
    // URI passes `z.string().url()` and dies at the second one. Both warn into a cron log
    // nobody reads, so an item plausible here and rejected there is a thinner digest with
    // no error anywhere.
    const pages = [
      ...(await collect(ctx(releasesFeed))),
      ...(await collect(ctx(commitsFeed, { config: config({ feed: "commits" }) }))),
    ];
    const items = pages.flatMap((p) => p.items);
    expect(items.length).toBe(12);
    for (const item of items) {
      const parsed = RawItemDraftSchema.safeParse(item);
      expect(parsed.success ? null : parsed.error.issues[0]).toBeNull();
      expect(canonicaliseUrl(item.url)).not.toBeNull();
    }
  });
});

// ── the three things a connector is proved by, red on the defect each names (DoD #4) ──

describe("drift detection", () => {
  it("raises SourceDriftError naming `title` when the feed renames it", async () => {
    // The failure this replaces: a renamed field yields zero items, which reads as a quiet
    // week and goes unnoticed for months.
    const drifted = releasesFeed.replace(/<title>/g, "<name>").replace(/<\/title>/g, "</name>");
    await expect(collect(ctx(drifted))).rejects.toThrow(SourceDriftError);
    await expect(collect(ctx(drifted))).rejects.toThrow(/schema drift at "title"/);
  });

  it("raises SourceDriftError naming `updated` when the timestamp is renamed", async () => {
    // GitHub emits no <published>, so <updated> is the only date there is. Silently losing
    // it would produce dateless items that prefilter's maxAgeDays can never age out.
    const drifted = commitsFeed
      .replace(/<updated>/g, "<timestamp>")
      .replace(/<\/updated>/g, "</timestamp>");
    await expect(collect(ctx(drifted, { config: config({ feed: "commits" }) }))).rejects.toThrow(
      SourceDriftError,
    );
    await expect(collect(ctx(drifted, { config: config({ feed: "commits" }) }))).rejects.toThrow(
      /schema drift at "updated"/,
    );
  });

  it("raises SourceDriftError naming `url` when an entry loses its link", async () => {
    const drifted = releasesFeed.replace(/<link rel="alternate"/g, '<lnk rel="alternate"');
    await expect(collect(ctx(drifted))).rejects.toThrow(/schema drift at "url"/);
  });

  it("raises SourceDriftError naming `author` when a commit entry loses its author", async () => {
    // Specific to the commits feed: this field is what the bot-exclusion rule reads, so
    // losing it silently would disable the rule rather than empty the feed.
    const drifted = commitsFeed
      .replace(/<author>/g, "<committer>")
      .replace(/<\/author>/g, "</committer>");
    await expect(collect(ctx(drifted, { config: config({ feed: "commits" }) }))).rejects.toThrow(
      /schema drift at "author"/,
    );
  });

  it("raises SourceDriftError when the response is not an Atom feed at all", async () => {
    await expect(collect(ctx("<html><body>Not Found</body></html>"))).rejects.toThrow(
      SourceDriftError,
    );
    await expect(collect(ctx("<html><body>Not Found</body></html>"))).rejects.toThrow(/feed/);
  });
});

describe("a source that answers but gives nothing", () => {
  it("raises SourceUnavailableError below expectMinItems", () => {
    // A repository answering 200 with zero entries is indistinguishable from a dead one.
    expect(() => {
      assertPlausibleYield("github:widget-cli", 0, githubConnector.policy);
    }).toThrow(SourceUnavailableError);
    expect(() => {
      assertPlausibleYield("github:widget-cli", 1, githubConnector.policy);
    }).not.toThrow();
  });

  it("yields nothing at all from a well-formed but empty feed, which the runner then reports", async () => {
    const empty = releasesFeed.replace(/<entry>[\s\S]*<\/entry>/, "");
    const [page] = await collect(ctx(empty));
    expect(page?.items).toEqual([]);
    expect(() => {
      assertPlausibleYield("github:widget-cli", page?.items.length ?? 0, githubConnector.policy);
    }).toThrow(SourceUnavailableError);
  });
});

describe("a repository or branch that does not exist", () => {
  const notFound = new SourceUnavailableError(
    "github:missing",
    "HTTP 404 for https://github.com/…",
  );

  it("names the repository when the HTTP layer throws a 404", async () => {
    await expect(
      collect(ctx(releasesFeed, { http: { get: () => Promise.reject(notFound) } })),
    ).rejects.toThrow(SourceUnavailableError);
    await expect(
      collect(ctx(releasesFeed, { http: { get: () => Promise.reject(notFound) } })),
    ).rejects.toThrow(/acme-labs\/widget-cli releases/);
  });

  it("names the repository and the branch for a commits feed", async () => {
    // The common cause is not a missing repository but a default branch called "master",
    // which answers the identical 404 for "main".
    await expect(
      collect(
        ctx(commitsFeed, {
          config: config({ feed: "commits" }),
          http: { get: () => Promise.reject(notFound) },
        }),
      ),
    ).rejects.toThrow(/acme-labs\/widget-cli commits on branch "main"/);
  });

  it("names the repository when a client returns a 404 rather than throwing", async () => {
    const response: HttpResponse = { status: 404, body: "Not Found", notModified: false };
    await expect(
      collect(ctx(releasesFeed, { http: { get: () => Promise.resolve(response) } })),
    ).rejects.toThrow(/acme-labs\/widget-cli releases/);
  });

  it("leaves a failure that is not a 404 alone", async () => {
    // A timeout relabelled "the repository does not exist" sends the reader to fix the
    // wrong thing.
    const timeout = new SourceUnavailableError("github:widget-cli", "giving up after 4 attempts");
    await expect(
      collect(ctx(releasesFeed, { http: { get: () => Promise.reject(timeout) } })),
    ).rejects.toThrow(/giving up after 4 attempts/);
  });
});
