/**
 * What this file gates: that the in-memory repository answers the SAME questions the
 * Postgres-backed one answers.
 *
 * The two implementations exist so a fixtures run needs no database, and that only holds
 * while their answers agree. The dangerous direction is the cheap one: a filter this
 * implementation ignores costs nothing here — one process, one cycle, an empty Map at
 * start — and returns the topic's entire history in production. Nothing offline would go
 * red, and the second issue would republish the first one's cards.
 */

import { describe, expect, it } from "vitest";
import { MemoryRepo } from "./memory-repo.js";
import type { Candidate, Card } from "../types.js";

function candidate(over: Partial<Candidate> & { id: string }): Candidate {
  return {
    status: "normalized",
    canonicalUrl: `https://example.com/${over.id}`,
    canonicalUrlHash: over.id.padEnd(64, "x").slice(0, 64),
    title: over.id,
    firstSeenAt: "2026-08-25T00:00:00.000Z",
    contentHash: "b".repeat(64),
    extractedText: "text",
    rawItemIds: ["raw-1"],
    cycleId: "2026-W35",
    ...over,
  };
}

function card(id: string, candidateId: string): Card {
  return {
    id,
    candidateId,
    type: "recipe",
    techniqueKey: `acme/area/${id}`,
    slug: id,
    title: id,
    summary: "s",
    body: "b",
    steps: [],
    tags: [],
    claims: [
      { text: "t", quote: "q", sourceUrl: "https://example.com/a", verified: true },
      { text: "t2", quote: "q2", sourceUrl: "https://example.com/a", verified: true },
    ],
    attribution: { sourceName: "example.com", sourceUrl: "https://example.com/a" },
    evidenceOk: true,
    promptVersion: "test@1",
  };
}

describe("listCandidates", () => {
  it("answers for one cycle, not for the topic's whole history", async () => {
    const repo = new MemoryRepo();
    await repo.putCandidates([
      candidate({ id: "this-week", cycleId: "2026-W35" }),
      candidate({ id: "last-week", cycleId: "2026-W34" }),
    ]);

    const rows = await repo.listCandidates({ cycleId: "2026-W35" });
    expect(rows.map((c) => c.id)).toEqual(["this-week"]);
  });

  it("narrows to one status when asked for one", async () => {
    const repo = new MemoryRepo();
    await repo.putCandidates([
      candidate({ id: "pending", status: "normalized" }),
      candidate({ id: "done", status: "extracted" }),
    ]);

    expect((await repo.listCandidates({ status: "normalized" })).map((c) => c.id)).toEqual([
      "pending",
    ]);
  });

  it("narrows to a SET of statuses, which is how a stage asks what it is already past", async () => {
    const repo = new MemoryRepo();
    await repo.putCandidates([
      candidate({ id: "pending", status: "normalized" }),
      candidate({ id: "extracted", status: "extracted" }),
      candidate({ id: "published", status: "in_issue" }),
      candidate({ id: "dropped", status: "prefiltered_out" }),
    ]);

    const rows = await repo.listCandidates({ status: ["extracted", "in_issue"] });
    expect(rows.map((c) => c.id).sort()).toEqual(["extracted", "published"]);
  });

  it("applies cycle and status together rather than one of the two", async () => {
    const repo = new MemoryRepo();
    await repo.putCandidates([
      candidate({ id: "right", status: "normalized", cycleId: "2026-W35" }),
      candidate({ id: "wrong-cycle", status: "normalized", cycleId: "2026-W34" }),
      candidate({ id: "wrong-status", status: "extracted", cycleId: "2026-W35" }),
    ]);

    const rows = await repo.listCandidates({ cycleId: "2026-W35", status: "normalized" });
    expect(rows.map((c) => c.id)).toEqual(["right"]);
  });

  it("returns everything when nothing was asked for", async () => {
    const repo = new MemoryRepo();
    await repo.putCandidates([candidate({ id: "a" }), candidate({ id: "b", cycleId: "2026-W34" })]);
    expect(await repo.listCandidates()).toHaveLength(2);
  });
});

describe("listCards", () => {
  it("scopes to a cycle through the candidate, because a card carries no cycle of its own", async () => {
    const repo = new MemoryRepo();
    await repo.putCandidates([
      candidate({ id: "cand-now", cycleId: "2026-W35" }),
      candidate({ id: "cand-then", cycleId: "2026-W34" }),
    ]);
    await repo.putCards([card("card-now", "cand-now"), card("card-then", "cand-then")]);

    const rows = await repo.listCards({ cycleId: "2026-W35" });
    expect(rows.map((c) => c.id)).toEqual(["card-now"]);
  });

  it("returns every card when no cycle was named", async () => {
    const repo = new MemoryRepo();
    await repo.putCandidates([candidate({ id: "cand-now" })]);
    await repo.putCards([card("card-now", "cand-now")]);
    expect(await repo.listCards()).toHaveLength(1);
  });
});

describe("the journal", () => {
  it("keys a stage entry on (runId, stage), so a retry overwrites its own attempt", async () => {
    const repo = new MemoryRepo();
    await repo.recordStage({
      runId: "run-1",
      cycleId: "2026-W35",
      stage: "extract",
      status: "failed",
      inputCount: 3,
      outputCount: 0,
      error: "timed out",
    });
    await repo.recordStage({
      runId: "run-1",
      cycleId: "2026-W35",
      stage: "extract",
      status: "completed",
      inputCount: 3,
      outputCount: 3,
    });

    expect(repo.stageEntries()).toHaveLength(1);
    expect(repo.stageEntries()[0]).toMatchObject({ status: "completed" });
  });

  it("keeps a second run's entry for the same stage apart from the first's", async () => {
    const repo = new MemoryRepo();
    for (const runId of ["run-1", "run-2"]) {
      await repo.recordStage({
        runId,
        cycleId: "2026-W35",
        stage: "extract",
        status: "completed",
        inputCount: 1,
        outputCount: 1,
      });
    }
    expect(repo.stageEntries()).toHaveLength(2);
  });
});
