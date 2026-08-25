/**
 * Candidate[] -> Candidate[], deterministic and free.
 *
 * This runs before the money boundary. Everything it rejects costs nothing, and every
 * rule it applies comes from the profile — a regex about "AI" hardcoded here would be
 * the exact defect the topic-agnostic invariant forbids.
 */

import { defineStage, type RunContext } from "../stage.js";
import type { Candidate } from "../../types.js";

export interface PrefilterPolicy {
  maxAgeDays: number;
  minBodyChars: number;
  mustMatchAny: string[];
  denyAny: string[];
}

export interface PrefilterOutcome {
  kept: Candidate[];
  /** Why each rejection happened — the funnel is only useful if drops are attributable. */
  dropped: { id: string; reason: string }[];
}

export function applyPrefilter(
  candidates: Candidate[],
  policy: PrefilterPolicy,
  now: Date,
): PrefilterOutcome {
  // Compiled once per run, not per candidate: the profile carries strings so it stays
  // data, and this is where they become behaviour.
  const must = policy.mustMatchAny.map((p) => new RegExp(p, "i"));
  const deny = policy.denyAny.map((p) => new RegExp(p, "i"));
  const cutoff = new Date(now.getTime() - policy.maxAgeDays * 86_400_000);

  const kept: Candidate[] = [];
  const dropped: { id: string; reason: string }[] = [];

  for (const c of candidates) {
    const haystack = `${c.title}\n${c.extractedText}`;

    if (c.publishedAt) {
      const published = new Date(c.publishedAt);
      if (!Number.isNaN(published.getTime()) && published < cutoff) {
        dropped.push({ id: c.id, reason: `older than ${policy.maxAgeDays}d` });
        continue;
      }
    }
    if (c.extractedText.length < policy.minBodyChars) {
      dropped.push({
        id: c.id,
        reason: `body ${c.extractedText.length} chars < ${policy.minBodyChars}`,
      });
      continue;
    }
    const blocked = deny.find((re) => re.test(haystack));
    if (blocked) {
      dropped.push({ id: c.id, reason: `matched deny rule ${String(blocked)}` });
      continue;
    }
    if (must.length > 0 && !must.some((re) => re.test(haystack))) {
      dropped.push({ id: c.id, reason: "matched no required pattern" });
      continue;
    }
    kept.push(c);
  }

  return { kept, dropped };
}

export const prefilterStage = defineStage<Candidate[], Candidate[]>({
  name: "prefilter",
  run(candidates: Candidate[], ctx: RunContext): Promise<Candidate[]> {
    const profile = ctx.profile as { prefilter: PrefilterPolicy };
    const { kept, dropped } = applyPrefilter(candidates, profile.prefilter, ctx.now);
    for (const d of dropped) ctx.log.debug(`prefilter dropped ${d.id}: ${d.reason}`);
    return Promise.resolve(kept);
  },
});
