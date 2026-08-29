/**
 * RawItem[] -> Candidate[].
 *
 * Canonicalises the URL, strips markup to text, and computes the two hashes everything
 * downstream keys on: `canonicalUrlHash` folds the same story from several sources into
 * one candidate, and `contentHash` is the LLM cache key that makes a rerun free.
 */

import { createHash } from "node:crypto";
import { defineStage, type RunContext } from "../stage.js";
import type { Candidate, RawItem } from "../../types.js";

/** Tracking parameters that change nothing about the page they point at. */
const NOISE_PARAMS = [
  /^utm_/,
  /^ref$/,
  /^ref_/,
  /^fbclid$/,
  /^gclid$/,
  /^mc_cid$/,
  /^mc_eid$/,
  /^source$/,
  /^s$/,
];

/**
 * Canonical form of a URL, or null when it is not an absolute URL at all.
 *
 * Without canonicalisation the same article shared with two different `?utm_source=`
 * values is two candidates and the digest prints it twice.
 *
 * Returning NULL rather than the input is the other half, and it is the half that was
 * wrong: the previous version swallowed the parse failure and handed the raw string on,
 * so a relative href travelled through normalize and prefilter and detonated in extract
 * with a bare TypeError — after the model call for that candidate had been billed, and
 * two stages past ingest's per-source isolation. A boundary that cannot say "no" is not
 * a boundary.
 */
export function canonicaliseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.protocol = url.protocol === "http:" ? "https:" : url.protocol;
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (NOISE_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  // A trailing slash is not a different page.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  url.search = url.searchParams.toString();
  return url.toString();
}

/** Markup to readable text. Deliberately dependency-free — this is not a browser. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const sha256 = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

export const normalizeStage = defineStage<RawItem[], Candidate[]>({
  name: "normalize",
  run(items: RawItem[], ctx: RunContext): Promise<Candidate[]> {
    const byHash = new Map<string, Candidate>();

    for (const item of items) {
      const canonicalUrl = canonicaliseUrl(item.url);
      if (canonicalUrl === null) {
        // The source's problem, not a reason to lose the run. Named so it is diagnosable:
        // a silently shorter funnel is how a broken source hides.
        ctx.log.warn(
          `normalize: ${item.sourceKey} yielded an item whose URL is not absolute — dropped`,
          { externalId: item.externalId, url: item.url },
        );
        continue;
      }
      const canonicalUrlHash = sha256(canonicalUrl);
      const text = item.body ? htmlToText(item.body) : "";

      const existing = byHash.get(canonicalUrlHash);
      if (existing) {
        // Same story, another source: keep one candidate and remember both origins, so
        // attribution and source diversity stay computable.
        existing.rawItemIds.push(item.id);
        continue;
      }

      byHash.set(canonicalUrlHash, {
        id: `cand-${canonicalUrlHash.slice(0, 12)}`,
        status: "normalized",
        canonicalUrl,
        canonicalUrlHash,
        title: item.title ?? canonicalUrl,
        firstSeenAt: ctx.now.toISOString(),
        contentHash: sha256(`${item.title ?? ""}\n${text}`),
        extractedText: text,
        rawItemIds: [item.id],
        ...(item.lang !== undefined ? { lang: item.lang } : {}),
        ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt } : {}),
        ...(ctx.cycleId !== undefined ? { cycleId: ctx.cycleId } : {}),
      });
    }

    return Promise.resolve([...byHash.values()]);
  },
});
