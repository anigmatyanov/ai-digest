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
 * Canonical form of a URL.
 *
 * Without this, the same article shared with two different `?utm_source=` values is two
 * candidates, and the digest prints it twice — the most visible kind of quality failure.
 */
export function canonicaliseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim();
  }
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
