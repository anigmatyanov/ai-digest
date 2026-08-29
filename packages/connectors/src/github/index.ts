/**
 * GitHub connector — releases and commits, over the `.atom` feeds.
 *
 * Measured 2026-08-24: `github.com/<owner>/<repo>/releases.atom` and
 * `.../commits/<branch>.atom` answer 200 with NO authentication and, unlike the REST API,
 * do not spend the 60-requests-per-hour anonymous budget. This pipeline asks from GitHub
 * Actions, i.e. from a datacentre IP where that budget is shared and effectively gone, so
 * the difference is between "polls three times a day" and "polls until it is throttled".
 *
 * Two feed kinds, one connector: they differ only in the URL and in which fields are
 * mandatory. They are NOT merged with the RSS connector, and the three parsing helpers
 * below are duplicated from rss/index.ts rather than shared — the epic's ## Границы says
 * no common Atom connector until there is a third case, and lifting the helpers into a
 * shared module is outside this epic's file map. See ## Заметки.
 */

import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import {
  defineConnector,
  parseOrDrift,
  SourceDriftError,
  SourceUnavailableError,
  type ConnectorContext,
  type HttpResponse,
  type Page,
} from "@ai-digest/core";
import type { RawItemDraft } from "@ai-digest/core";

/**
 * A pattern a profile supplies as a string and this file turns into a RegExp.
 *
 * Compilability is checked HERE, at the profile boundary, rather than at ingest time: an
 * unbalanced bracket in a profile would otherwise surface as a `SyntaxError` thrown from
 * inside a stage during a weekly cron run, naming neither the source nor the profile.
 */
const RegexPattern = z
  .string()
  .min(1)
  .refine(
    (pattern) => {
      try {
        new RegExp(pattern);
        return true;
      } catch {
        return false;
      }
    },
    { error: "is not a valid regular expression — it is compiled with `new RegExp(pattern)`" },
  );

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const isSafeSegment = (s: string): boolean => SEGMENT.test(s) && s !== "." && s !== "..";

/** `owner` and `repo` are interpolated into the feed URL, so their charset is constrained. */
const PathSegment = z
  .string()
  .min(1)
  .refine(isSafeSegment, {
    error:
      "may contain only letters, digits, dot, underscore and dash (and be neither `.` nor `..`) — " +
      "it is interpolated into the feed URL",
  });

export const GithubConfigSchema = z.object({
  owner: PathSegment,
  repo: PathSegment,
  /**
   * Which feed. Releases give a vendor's changelog, commits give the community's practice
   * — two different kinds of value out of one source, which is why both are here.
   */
  feed: z.enum(["releases", "commits"]),
  /**
   * Only meaningful for `feed: "commits"`. A slash is allowed (`release/4.2`) and every
   * segment is charset-checked, so a branch name cannot append a path or a query.
   */
  branch: z
    .string()
    .min(1)
    .refine((b) => b.split("/").every(isSafeSegment), {
      error: "each `/`-separated segment must be [A-Za-z0-9._-] and neither `.` nor `..`",
    })
    .default("main"),
  /** Name shown in a card's attribution. Required: a card without a source is unpublishable. */
  sourceName: z.string().min(1),
  /**
   * Entries whose title matches any of these are dropped.
   *
   * The rule lives in the profile, not here. A connector that knew what a "merge commit"
   * or a "bot" is would be a product decision compiled into `packages/`, and the next
   * repository — or the next digest topic — wants a different rule. Empty by default: a
   * source that configures nothing gets everything the feed carried.
   */
  excludeTitlePatterns: z.array(RegexPattern).default([]),
  /** The same, against the entry's author name. `\\[bot\\]$` is how a profile drops bots. */
  excludeAuthorPatterns: z.array(RegexPattern).default([]),
});
export type GithubConfig = z.infer<typeof GithubConfigSchema>;

export const GithubCursorSchema = z.object({
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  /** id of the newest entry kept last run — where this run stops walking back. */
  lastEntryId: z.string().optional(),
});
export type GithubCursor = z.infer<typeof GithubCursorSchema>;

/**
 * The shape both feeds must have.
 *
 * `updated` is required rather than optional because GitHub emits it on every entry of
 * both feeds and it is the ONLY timestamp there — releases.atom carries no `<published>`.
 * Optional would turn a renamed timestamp into dateless items, which prefilter then keeps
 * forever instead of ageing out.
 */
const GithubEntrySchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  title: z.string().min(1),
  updated: z.string().min(1),
  body: z.string().optional(),
  author: z.string().optional(),
});

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
});

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

const text = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && "#text" in v) return String(v["#text"]);
  return undefined;
};

/** Atom links are attribute-carrying objects; the href is resolved against the feed URL. */
const linkOf = (raw: unknown, base: string): string | undefined => {
  const resolve = (href: string): string | undefined => {
    try {
      return new URL(href, base).toString();
    } catch {
      return undefined;
    }
  };
  const direct = text(raw);
  if (direct) return resolve(direct);
  for (const l of asArray(raw as Record<string, unknown>[])) {
    const rel = l["@_rel"];
    if (rel === undefined || rel === "alternate") {
      const href = l["@_href"];
      if (typeof href === "string") return resolve(href);
    }
  }
  return undefined;
};

/**
 * The feed URL for a source — the entire "no token, no REST quota" claim in one function.
 * Exported so a test can assert it directly instead of inferring it from a mock's argument.
 */
export function githubFeedUrl(config: GithubConfig): string {
  const base = `https://github.com/${config.owner}/${config.repo}`;
  return config.feed === "releases"
    ? `${base}/releases.atom`
    : `${base}/commits/${config.branch}.atom`;
}

/** How this source names itself in an error: `owner/repo` plus what was being read. */
function describe(config: GithubConfig): string {
  return config.feed === "releases"
    ? `${config.owner}/${config.repo} releases`
    : `${config.owner}/${config.repo} commits on branch "${config.branch}"`;
}

/**
 * A 404, reported as the repository it happened to — not as a generic network failure.
 *
 * `[github:foo] HTTP 404` says nothing a person can act on; a run watching twenty
 * repositories needs to know WHICH one is gone. For a commits feed it is usually not the
 * repository at all but the branch, and that is the sentence this exists to print.
 */
function notFound(sourceKey: string, config: GithubConfig, url: string, cause?: unknown): never {
  const branchNote =
    config.feed === "commits"
      ? `, or the branch does not exist (a repository whose default branch is "master" ` +
        `answers exactly this 404 for "main")`
      : "";
  const message =
    `${describe(config)}: GitHub answered 404 for ${url}. The .atom feeds need no ` +
    `authentication, so this is not a token problem — the repository does not exist, was ` +
    `renamed, is private${branchNote}.`;
  throw cause === undefined
    ? new SourceUnavailableError(sourceKey, message)
    : new SourceUnavailableError(sourceKey, message, { cause });
}

/**
 * Did the HTTP layer report a 404?
 *
 * Matched on the message because `HttpResponse` carries a status but `LiveHttpClient`
 * THROWS on 4xx rather than returning one, so the status never reaches a connector as a
 * number. Widening that seam is outside this epic's file map and is filed as E-009a; until
 * then `res.status` is checked as well, so a client that returns a 404 rather than throwing
 * takes the same path.
 */
const looksLike404 = (error: unknown): boolean =>
  error instanceof SourceUnavailableError && /\b404\b/.test(error.message);

async function fetchFeed(
  ctx: ConnectorContext<GithubConfig, GithubCursor>,
  url: string,
): Promise<HttpResponse> {
  try {
    return await ctx.http.get(url, {
      ...(ctx.cursor?.etag !== undefined ? { etag: ctx.cursor.etag } : {}),
      ...(ctx.cursor?.lastModified !== undefined ? { lastModified: ctx.cursor.lastModified } : {}),
    });
  } catch (error) {
    // Only a 404 is relabelled. A timeout reported as "the repository does not exist" is a
    // worse error than the timeout, because it sends the reader to fix the wrong thing.
    if (looksLike404(error)) notFound(ctx.sourceKey, ctx.config, url, error);
    throw error;
  }
}

export const githubConnector = defineConnector<GithubConfig, GithubCursor>({
  kind: "github",
  configSchema: GithubConfigSchema,
  cursorSchema: GithubCursorSchema,
  policy: {
    requestsPerMinute: 30,
    minIntervalMs: 1000,
    // Both feeds serve a short window of recent entries in ONE document — there is no
    // pagination to walk, which is the other half of why this costs no REST quota.
    maxPagesPerRun: 1,
    maxItemsPerRun: 100,
    timeoutMs: 15_000,
    retries: 3,
    // One entry inside the window is the least a watched repository plausibly produces.
    // Zero is reported rather than absorbed. The known over-report — a repository that
    // genuinely published no release that week — is written up in the epic's ## Заметки.
    expectMinItems: 1,
  },

  async *fetch(
    ctx: ConnectorContext<GithubConfig, GithubCursor>,
  ): AsyncIterable<Page<GithubCursor>> {
    const url = githubFeedUrl(ctx.config);
    const res = await fetchFeed(ctx, url);
    if (res.status === 404) notFound(ctx.sourceKey, ctx.config, url);

    if (res.notModified) {
      // 304 means "nothing new", which is different from "nothing there". An empty page
      // with the cursor intact keeps the two distinguishable for the runner.
      ctx.log.debug(`${ctx.sourceKey}: not modified`);
      yield { items: [], cursor: ctx.cursor ?? {}, exhausted: true };
      return;
    }

    const doc = parser.parse(res.body) as Record<string, unknown>;
    const feed = doc["feed"];
    if (!feed || typeof feed !== "object") {
      // Not "no entries" — the document is not an Atom feed at all. GitHub serves HTML for
      // several failure modes, and reporting that as a quiet week is the failure mode this
      // product cannot afford.
      throw new SourceDriftError(
        ctx.sourceKey,
        "feed",
        `no <feed> element in the response from ${url}; the document is not an Atom feed`,
      );
    }

    // Compiled once per run rather than once per entry: the profile carries strings so it
    // stays data, and this is the single place where they become behaviour.
    const excludeTitle = ctx.config.excludeTitlePatterns.map((p) => new RegExp(p));
    const excludeAuthor = ctx.config.excludeAuthorPatterns.map((p) => new RegExp(p));

    const rawEntries = asArray((feed as Record<string, unknown>)["entry"]) as Record<
      string,
      unknown
    >[];

    const items: RawItemDraft[] = [];
    for (const e of rawEntries) {
      const entry = parseOrDrift(
        GithubEntrySchema,
        {
          id: text(e["id"]),
          url: linkOf(e["link"], url),
          title: text(e["title"]),
          updated: text(e["updated"]),
          body: text(e["content"]),
          author: text((e["author"] as Record<string, unknown> | undefined)?.["name"]),
        },
        ctx.sourceKey,
      );
      const author = entry.author;

      // A commit entry without an author is drift, not a quirk. `excludeAuthorPatterns` is
      // what drops bot commits, so an author field that quietly disappeared would quietly
      // disable the filter: bot noise floods the digest while the feed keeps answering 200
      // and every test stays green. Drift that disables a filter must be as loud as drift
      // that empties a feed.
      if (ctx.config.feed === "commits" && author === undefined) {
        throw new SourceDriftError(
          ctx.sourceKey,
          "author",
          `commit entry ${entry.id} carries no <author><name>; the author-based exclusion ` +
            `rules of this source cannot be applied to it`,
        );
      }

      if (entry.id === ctx.cursor?.lastEntryId) break; // caught up with the previous run

      const published = new Date(entry.updated);
      if (!Number.isNaN(published.getTime()) && published < ctx.since) continue;

      if (excludeTitle.some((re) => re.test(entry.title))) {
        ctx.log.debug(`${ctx.sourceKey}: excluded by title — ${entry.title}`);
        continue;
      }
      if (author !== undefined && excludeAuthor.some((re) => re.test(author))) {
        ctx.log.debug(`${ctx.sourceKey}: excluded by author — ${author}`);
        continue;
      }

      items.push({
        externalId: entry.id,
        url: entry.url,
        title: entry.title,
        bodyFormat: "html",
        signals: {},
        ...(author !== undefined ? { author } : {}),
        // Both feeds carry <updated> and nothing else: for a release that is when it was
        // published, unless the notes were edited afterwards; for a commit it is the commit
        // date. It is named `publishedAt` because that is the field it feeds.
        ...(Number.isNaN(published.getTime()) ? {} : { publishedAt: published.toISOString() }),
        ...(entry.body !== undefined ? { body: entry.body } : {}),
      });
    }

    yield {
      items,
      exhausted: true,
      cursor: {
        ...(res.etag !== undefined ? { etag: res.etag } : {}),
        ...(res.lastModified !== undefined ? { lastModified: res.lastModified } : {}),
        ...(items[0]?.externalId !== undefined ? { lastEntryId: items[0]?.externalId } : {}),
      },
    };
  },
});
