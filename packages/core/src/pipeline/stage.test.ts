/**
 * What this file gates: the rule that stops a restarted run from paying twice.
 *
 * `mergeCandidate` is one `if` away from being a no-op, and the no-op version is silent.
 * A restart re-derives every candidate as `normalized` — same ids, same hashes, same row
 * count — so a persist that overwrote the stored status would look identical in the funnel,
 * in the artefacts and in the row counts. The only place it would show up is the invoice.
 * Nothing else in this repository was watching that.
 */

import { describe, expect, it } from "vitest";
import {
  CANDIDATE_TERMINAL_STATUSES,
  defineStage,
  isCandidateTerminal,
  mergeCandidate,
  withResume,
} from "./stage.js";
import type { Candidate } from "../types.js";

function candidate(status: Candidate["status"], over: Partial<Candidate> = {}): Candidate {
  return {
    id: "cand-1",
    status,
    canonicalUrl: "https://example.com/a",
    canonicalUrlHash: "a".repeat(64),
    title: "A title",
    firstSeenAt: "2026-08-25T00:00:00.000Z",
    contentHash: "b".repeat(64),
    extractedText: "text",
    rawItemIds: ["raw-1"],
    cycleId: "2026-W35",
    ...over,
  };
}

describe("mergeCandidate", () => {
  it("keeps the stored status when a rerun re-derives the row as `normalized`", () => {
    // The whole epic in one assertion: without this, the next stage sees `normalized`,
    // decides the row is unprocessed, and asks the model about it a second time.
    const merged = mergeCandidate(candidate("normalized"), candidate("extracted"));
    expect(merged.status).toBe("extracted");
  });

  it("keeps the stored status for every status the automaton has already moved past", () => {
    for (const stored of [
      "extracted",
      "scored",
      "in_issue",
      "published",
      "rejected",
      "prefiltered_out",
      "duplicate",
    ] as const) {
      expect(mergeCandidate(candidate("normalized"), candidate(stored)).status).toBe(stored);
    }
  });

  it("takes the fresh row when the stored one has not moved yet", () => {
    const merged = mergeCandidate(
      candidate("normalized", { title: "New title" }),
      candidate("normalized", { title: "Old title" }),
    );
    expect(merged.title).toBe("New title");
  });

  it("lets a stage advance the row: an incoming status past `normalized` wins", () => {
    // `extract` writes `extracted` over a row the database still calls `normalized`. If
    // the stored value won here, the automaton could never move at all.
    const merged = mergeCandidate(candidate("extracted"), candidate("normalized"));
    expect(merged.status).toBe("extracted");
  });

  it("holds the status but not the content: the source is what the source says now", () => {
    const merged = mergeCandidate(
      candidate("normalized", { title: "Edited headline", extractedText: "new body" }),
      candidate("in_issue", { title: "Stale headline", extractedText: "old body" }),
    );
    expect(merged.status).toBe("in_issue");
    expect(merged.title).toBe("Edited headline");
    expect(merged.extractedText).toBe("new body");
  });

  it("carries the fields the stages that moved the row wrote, not just the status", () => {
    const stored = candidate("prefiltered_out", {
      statusReason: "matched deny rule /nft/i",
      prefilterScore: 0.1,
      score: 0.4,
      scoreBreakdown: { freshness: 0.4 },
    });
    const merged = mergeCandidate(candidate("normalized"), stored);
    expect(merged.statusReason).toBe("matched deny rule /nft/i");
    expect(merged.prefilterScore).toBe(0.1);
    expect(merged.score).toBe(0.4);
    expect(merged.scoreBreakdown).toEqual({ freshness: 0.4 });
  });

  it("passes a first-seen candidate straight through", () => {
    const fresh = candidate("normalized");
    expect(mergeCandidate(fresh, undefined)).toEqual(fresh);
  });
});

describe("terminal statuses", () => {
  it("names exactly the statuses a candidate never leaves", () => {
    // Deliberately spelled out rather than derived: this list is what decides whether a
    // whole run is skipped, and a set computed from the enum would silently grow when
    // someone adds a status.
    expect([...CANDIDATE_TERMINAL_STATUSES].sort()).toEqual([
      "duplicate",
      "prefiltered_out",
      "published",
      "rejected",
    ]);
  });

  it("does not treat a row with a stage still ahead of it as finished", () => {
    for (const status of ["new", "normalized", "extracted", "scored", "in_issue"] as const) {
      expect(isCandidateTerminal(status)).toBe(false);
    }
  });
});

describe("withResume", () => {
  it("attaches the plan without touching what the stage does", async () => {
    const stage = defineStage<number[], number[]>({
      name: "double",
      run: (input) => Promise.resolve(input.map((n) => n * 2)),
    });
    const wrapped = withResume(stage, {});
    expect(wrapped.name).toBe("double");
    expect(wrapped.allowEmptyInput).toBe(false);
    expect(await wrapped.run([1, 2], {} as never)).toEqual([2, 4]);
  });
});
