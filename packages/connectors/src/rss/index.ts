/**
 * RSS / Atom connector.
 *
 * The reference shape for every connector that follows: a config schema, a cursor schema,
 * a policy, and a `fetch` that yields pages. Everything operational — retries, throttling,
 * cursor persistence — belongs to the runner, which is why this file is short.
 *
 * It handles both RSS 2.0 (`<item>`) and Atom (`<entry>`) because in practice a source
 * list mixes them and a connector per dialect would double the surface for no gain.
 */

import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import {
  defineConnector,
  parseOrDrift,
  SourceDriftError,
  type ConnectorContext,
  type Page,
} from "@ai-digest/core";
import type { RawItemDraft } from "@ai-digest/core";

export const RssConfigSchema = z.object({
  feedUrl: z.string().url(),
  /** Name shown in a card's attribution. Required: a card without a source is unpublishable. */
  sourceName: z.string().min(1),
});
export type RssConfig = z.infer<typeof RssConfigSchema>;

export const RssCursorSchema = z.object({
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  /** id of the newest entry seen last run — where this run stops walking back. */
  lastEntryId: z.string().optional(),
});
export type RssCursor = z.infer<typeof RssCursorSchema>;

/**
 * The shape a feed must have. Deliberately minimal: a schema that demands optional
 * niceties turns a cosmetic upstream change into a drift error and trains people to
 * ignore drift errors.
 */
const FeedEntrySchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  title: z.string().min(1),
  publishedAt: z.string().optional(),
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

/** Atom links are attribute-carrying objects; RSS links are plain text. */
const linkOf = (raw: unknown): string | undefined => {
  const direct = text(raw);
  if (direct) return direct;
  for (const l of asArray(raw as Record<string, unknown>[])) {
    const rel = l["@_rel"];
    if (rel === undefined || rel === "alternate") {
      const href = l["@_href"];
      if (typeof href === "string") return href;
    }
  }
  return undefined;
};

export const rssConnector = defineConnector<RssConfig, RssCursor>({
  kind: "rss",
  configSchema: RssConfigSchema,
  cursorSchema: RssCursorSchema,
  policy: {
    requestsPerMinute: 30,
    minIntervalMs: 1000,
    maxPagesPerRun: 1,
    maxItemsPerRun: 100,
    timeoutMs: 15_000,
    retries: 3,
    // One item is a plausible quiet week for a single blog. Zero is not — that is a dead
    // feed or a changed shape, and both must be reported rather than absorbed.
    expectMinItems: 1,
  },

  async *fetch(ctx: ConnectorContext<RssConfig, RssCursor>): AsyncIterable<Page<RssCursor>> {
    const res = await ctx.http.get(ctx.config.feedUrl, {
      ...(ctx.cursor?.etag !== undefined ? { etag: ctx.cursor.etag } : {}),
      ...(ctx.cursor?.lastModified !== undefined ? { lastModified: ctx.cursor.lastModified } : {}),
    });

    if (res.notModified) {
      // 304 means "nothing new", which is different from "nothing there". Yielding an
      // empty page with the cursor intact keeps the distinction.
      ctx.log.debug(`${ctx.sourceKey}: not modified`);
      yield { items: [], cursor: ctx.cursor ?? {}, exhausted: true };
      return;
    }

    const doc = parser.parse(res.body) as Record<string, unknown>;
    const channel = (doc["rss"] as { channel?: unknown })?.channel ?? doc["feed"];
    if (!channel || typeof channel !== "object") {
      // Not "no items" — the document is not a feed at all. Saying so by field name is
      // the difference between a diagnosable failure and a silently thin digest.
      throw new SourceDriftError(
        ctx.sourceKey,
        "rss.channel|feed",
        "neither <rss><channel> nor <feed> was present in the response",
      );
    }
    const raw = channel as Record<string, unknown>;
    const rawEntries = [...asArray(raw["item"]), ...asArray(raw["entry"])] as Record<
      string,
      unknown
    >[];

    const items: RawItemDraft[] = [];
    for (const e of rawEntries) {
      const url = linkOf(e["link"]);
      const entry = parseOrDrift(
        FeedEntrySchema,
        {
          id: text(e["guid"]) ?? text(e["id"]) ?? url,
          url,
          title: text(e["title"]),
          publishedAt: text(e["pubDate"]) ?? text(e["published"]) ?? text(e["updated"]),
          body:
            text(e["content:encoded"]) ??
            text(e["content"]) ??
            text(e["description"]) ??
            text(e["summary"]),
          author: text(e["author"]) ?? text((e["author"] as Record<string, unknown>)?.["name"]),
        },
        ctx.sourceKey,
      );

      if (entry.id === ctx.cursor?.lastEntryId) break; // caught up with the previous run
      const published = entry.publishedAt ? new Date(entry.publishedAt) : undefined;
      if (published && !Number.isNaN(published.getTime()) && published < ctx.since) continue;

      items.push({
        externalId: entry.id,
        url: entry.url,
        title: entry.title,
        bodyFormat: "html",
        signals: {},
        ...(entry.author !== undefined ? { author: entry.author } : {}),
        ...(published && !Number.isNaN(published.getTime())
          ? { publishedAt: published.toISOString() }
          : {}),
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
