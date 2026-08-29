/**
 * Hacker News connector, through the Algolia search API.
 *
 * `search_by_date`, never `search`: relevance ranking is not stable between runs, so a
 * cursor built on it walks over items it has already seen and misses ones it has not.
 * Date ordering is total and descending, which is what makes both the window bound and
 * the cursor a simple "stop when you reach it".
 *
 * Measured 2026-08-29: `hn.algolia.com/api/v1/search_by_date` answers 200 with no key and
 * no registration, which is why this is the source that needed neither.
 *
 * WHAT THIS CONNECTOR DOES NOT DO: it does not know the topic. `minPoints` is not topic
 * selection — it is the source's own notion of "was this noticed here", the same way an
 * RSS feed's notion is "the author published it". Selection by meaning is `prefilter` and
 * `score`, configured by the profile.
 */

import { z } from "zod";
import {
  defineConnector,
  parseOrDrift,
  SourceDriftError,
  type ConnectorContext,
  type ConnectorPolicy,
  type Page,
  type RawItemDraft,
} from "@ai-digest/core";

const SEARCH_BY_DATE = "https://hn.algolia.com/api/v1/search_by_date";

/** Algolia caps `hitsPerPage` at 1000; 50 keeps a single page small enough to checkpoint. */
const HITS_PER_PAGE = 50;

/** Where a text post's content actually lives. See `urlOf`. */
const discussionUrl = (objectID: string): string =>
  `https://news.ycombinator.com/item?id=${objectID}`;

export const HnConfigSchema = z.object({
  /**
   * Fewest points a story must have to be returned.
   *
   * Required, with no default, deliberately: a default would be this file deciding what
   * counts as noticed on Hacker News, and that decision belongs to whoever adds the
   * source. It is applied twice — as a `numericFilters` bound so a run does not page
   * through thousands of one-point stories to find the handful that matter, and again
   * locally, because a connector that trusts the server to have filtered has no way to
   * tell "the filter was dropped" from "nothing qualified".
   */
  minPoints: z.number().int().min(0),
  /** Name shown in a card's attribution. Required: a card without a source is unpublishable. */
  sourceName: z.string().min(1),
  /**
   * Algolia tag filter.
   *
   * NAMED LIMIT: the response schema below is the shape of a STORY. `story` covers Ask HN
   * and Show HN, which carry the `ask_hn`/`show_hn` tags in addition. Pointing this at
   * `comment` would make every hit fail the schema and raise drift, which is the loud
   * failure rather than the silent one, but it is still not a supported configuration.
   */
  tags: z
    .string()
    .regex(/^[a-z0-9_,()]+$/, "expected Algolia tags, e.g. story or (story,poll)")
    .default("story"),
});
export type HnConfig = z.infer<typeof HnConfigSchema>;

export const HnCursorSchema = z.object({
  /**
   * `created_at_i` of the newest story seen last run — where this run stops walking back.
   *
   * Seconds, because that is the unit Algolia filters and sorts on; converting to
   * milliseconds here would mean converting back at every comparison.
   */
  newestCreatedAtI: z.number().int().optional(),
});
export type HnCursor = z.infer<typeof HnCursorSchema>;

/**
 * The envelope. Only what is actually read: `hits` to walk and `nbPages` to know when to
 * stop asking. Demanding the rest (`nbHits`, `processingTimeMS`, `exhaustiveNbHits`)
 * would turn a cosmetic change in Algolia's response into a drift error, and a drift
 * error people learn to ignore is worse than none.
 */
const ResponseSchema = z.object({
  hits: z.array(z.unknown()),
  nbPages: z.number().optional(),
});

/**
 * The shape of one story.
 *
 * `points` and `created_at_i` are required on purpose: they are the two fields this
 * connector makes decisions with, and a rename of either would otherwise degrade into
 * "returned nothing this week". `url` is optional because a text post genuinely has none.
 */
const HitSchema = z.object({
  objectID: z.string().min(1),
  title: z.string().min(1),
  points: z.number(),
  created_at_i: z.number(),
  url: z.string().optional(),
  author: z.string().optional(),
  num_comments: z.number().optional(),
  story_text: z.string().optional(),
});
type Hit = z.infer<typeof HitSchema>;

const POLICY: ConnectorPolicy = {
  requestsPerMinute: 60,
  minIntervalMs: 500,
  maxPagesPerRun: 10,
  // 500 stories above a threshold is more than any window of this digest can use, and the
  // cap is here to bound memory and request count — not to select. Selection that depends
  // on where a cap fell would be undetectable from the outside.
  maxItemsPerRun: 80,
  timeoutMs: 15_000,
  retries: 3,
  // One story above the threshold is a plausible quiet week. Zero is not: Algolia answers
  // 200 with an empty `hits` array for a malformed filter exactly as it does for a genuine
  // absence, and the two must not look the same to the runner.
  expectMinItems: 1,
};

/**
 * Where a story points.
 *
 * A text post (Ask HN, a plain discussion) has no `url` at all — the key is absent, not
 * null. The choice made here is the canonical discussion page rather than dropping the
 * item, for two reasons: the discussion page IS the item's canonical location, so nothing
 * is being invented; and a connector that drops items is a connector doing selection,
 * which is the profile's job. Dropping it would also be invisible downstream — it would
 * arrive as a thinner week.
 *
 * A `url` that is present but not absolute http(s) is treated the same way. Passing it on
 * would push the failure to the ingest boundary, where it is rejected item by item with a
 * warning nobody reads.
 */
function urlOf(hit: Hit, log: ConnectorContext<HnConfig, HnCursor>["log"]): string {
  if (hit.url !== undefined) {
    try {
      const parsed = new URL(hit.url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
    } catch {
      // fall through to the discussion URL
    }
    log.warn(`hn story ${hit.objectID}: url ${JSON.stringify(hit.url)} is not absolute http(s)`);
  }
  return discussionUrl(hit.objectID);
}

function toDraft(hit: Hit, log: ConnectorContext<HnConfig, HnCursor>["log"]): RawItemDraft {
  return {
    externalId: hit.objectID,
    url: urlOf(hit, log),
    title: hit.title,
    // `story_text` is HN-rendered HTML — it carries <p> and <a>, not markdown.
    bodyFormat: "html",
    publishedAt: new Date(hit.created_at_i * 1000).toISOString(),
    signals: {
      points: hit.points,
      ...(hit.num_comments !== undefined ? { comments: hit.num_comments } : {}),
    },
    ...(hit.author !== undefined ? { author: hit.author } : {}),
    ...(hit.story_text !== undefined ? { body: hit.story_text } : {}),
  };
}

function buildUrl(config: HnConfig, floorSec: number, page: number): string {
  const params = new URLSearchParams({
    tags: config.tags,
    hitsPerPage: String(HITS_PER_PAGE),
    page: String(page),
    numericFilters: `created_at_i>${floorSec},points>=${config.minPoints}`,
  });
  return `${SEARCH_BY_DATE}?${params.toString()}`;
}

/**
 * JSON, or a drift error naming the body.
 *
 * An HTML error page parses as neither a story nor a failure worth retrying, and
 * `JSON.parse` would surface it as a bare SyntaxError — which the runner treats as a bug
 * in us rather than as the source having changed.
 */
function parseJson(body: string, sourceKey: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new SourceDriftError(
      sourceKey,
      "<body>",
      `the response was not JSON (${body.slice(0, 60).replace(/\s+/g, " ")}…)`,
      { cause: error },
    );
  }
}

export const hnConnector = defineConnector<HnConfig, HnCursor>({
  kind: "hn",
  configSchema: HnConfigSchema,
  cursorSchema: HnCursorSchema,
  policy: POLICY,

  async *fetch(ctx: ConnectorContext<HnConfig, HnCursor>): AsyncIterable<Page<HnCursor>> {
    // Two lower bounds collapse into one: the window the run was given, and where the
    // previous run stopped. Whichever is later wins.
    const floorSec = Math.max(
      Math.floor(ctx.since.getTime() / 1000),
      ctx.cursor?.newestCreatedAtI ?? 0,
    );

    let yielded = 0;
    let newest = ctx.cursor?.newestCreatedAtI;
    /**
     * Every objectID this run has already walked.
     *
     * Not a nicety: an offline run is served the SAME recorded page for every request,
     * because the fixture client answers by file and not by URL. Without this the
     * generator would page until it hit a policy cap and yield the same fifty stories
     * several times over. It also covers the live case where a story is pushed onto the
     * next page by one arriving while the run is paging.
     */
    const seen = new Set<string>();

    for (let page = 0; page < POLICY.maxPagesPerRun; page++) {
      const res = await ctx.http.get(buildUrl(ctx.config, floorSec, page));
      const envelope = parseOrDrift(
        ResponseSchema,
        parseJson(res.body, ctx.sourceKey),
        ctx.sourceKey,
      );

      const items: RawItemDraft[] = [];
      let fresh = 0;
      let reachedFloor = false;
      let capped = false;

      for (const raw of envelope.hits) {
        const hit = parseOrDrift(HitSchema, raw, ctx.sourceKey);
        if (seen.has(hit.objectID)) continue;
        seen.add(hit.objectID);
        fresh++;

        // Results are strictly newest-first, so the first story at or below the floor
        // means every remaining one is too.
        if (hit.created_at_i <= floorSec) {
          reachedFloor = true;
          break;
        }
        newest = Math.max(newest ?? 0, hit.created_at_i);

        // The local half of the threshold. The query already asked for it; this is what
        // makes "the filter stopped being applied" show up as a filtered run rather than
        // as an issue full of one-point stories.
        if (hit.points < ctx.config.minPoints) continue;

        items.push(toDraft(hit, ctx.log));
        if (yielded + items.length >= POLICY.maxItemsPerRun) {
          capped = true;
          break;
        }
      }

      yielded += items.length;
      const lastPage = envelope.nbPages !== undefined && page + 1 >= envelope.nbPages;
      const exhausted = capped || reachedFloor || fresh === 0 || lastPage;

      yield {
        items,
        exhausted,
        cursor: { ...(newest !== undefined ? { newestCreatedAtI: newest } : {}) },
      };
      if (exhausted) return;
    }

    ctx.log.debug(
      `${ctx.sourceKey}: stopped at maxPagesPerRun=${POLICY.maxPagesPerRun} with ${yielded} item(s)`,
    );
  },
});
