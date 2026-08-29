import { describe, expect, it, vi } from "vitest";
import { formatFunnel, runPipeline } from "./pipeline.js";
import { defineStage, EmptyStageInputError, withResume, type RunContext } from "./stage.js";
import { MemoryRepo } from "./memory-repo.js";
import type { Candidate, Card, Issue, RawItem } from "../types.js";

function ctx(): RunContext {
  return {
    runId: "run1",
    cycleId: "2026-W35",
    now: new Date("2026-08-25T10:00:00Z"),
    dryRun: true,
    // A real (empty) repository rather than `{}`: the orchestrator asks it whether this
    // cycle still has work in it before the first stage runs, and a stub that cannot
    // answer would be testing a pipeline nobody runs.
    repo: new MemoryRepo(),
    llm: {} as RunContext["llm"],
    log: { debug: vi.fn(), warn: vi.fn() },
    profile: {},
  };
}

describe("runPipeline", () => {
  it("should thread each stage's output into the next stage's input", async () => {
    const double = defineStage<number[], number[]>({
      name: "double",
      run: (input) => Promise.resolve(input.map((n) => n * 2)),
    });
    const inc = defineStage<number[], number[]>({
      name: "inc",
      run: (input) => Promise.resolve(input.map((n) => n + 1)),
    });

    const { output } = await runPipeline([double, inc] as never, [1, 2, 3], ctx());
    expect(output).toEqual([3, 5, 7]);
  });

  it("should fail when a stage receives an empty input", async () => {
    // The whole point: an empty issue must be an error, not a quiet week.
    const drain = defineStage<number[], number[]>({
      name: "drain",
      run: () => Promise.resolve([]),
    });
    const next = defineStage<number[], number[]>({ name: "next", run: (i) => Promise.resolve(i) });

    await expect(runPipeline([drain, next] as never, [1], ctx())).rejects.toThrow(
      EmptyStageInputError,
    );
  });

  it("should name the stage that produced nothing, not just the one that failed", async () => {
    const drain = defineStage<number[], number[]>({
      name: "drain",
      run: () => Promise.resolve([]),
    });
    const next = defineStage<number[], number[]>({ name: "next", run: (i) => Promise.resolve(i) });

    await expect(runPipeline([drain, next] as never, [1], ctx())).rejects.toThrow(/"drain"/);
  });

  it("should allow an empty input when the stage opts in", async () => {
    // `ingest` may legitimately find nothing on a quiet day; the opt-in is per stage so
    // the safe behaviour is what you get by forgetting to think about it.
    const quiet = defineStage<number[], number[]>({
      name: "quiet",
      run: () => Promise.resolve([]),
    });
    const tolerant = defineStage<number[], string>({
      name: "tolerant",
      allowEmptyInput: true,
      run: () => Promise.resolve("ok"),
    });

    const { output } = await runPipeline([quiet, tolerant] as never, [1], ctx());
    expect(output).toBe("ok");
  });

  it("should record the funnel with per-stage input and output counts", async () => {
    const half = defineStage<number[], number[]>({
      name: "half",
      run: (input) => Promise.resolve(input.slice(0, Math.ceil(input.length / 2))),
    });

    const { report } = await runPipeline([half] as never, [1, 2, 3, 4], ctx());
    expect(report.stages).toHaveLength(1);
    expect(report.stages[0]).toMatchObject({ stage: "half", input: 4, output: 2 });
    expect(formatFunnel(report)).toContain("4 ->     2");
  });

  it("should treat a non-array output as one item rather than as nothing", async () => {
    // An issue is a single object. Counting it as 0 would trip the empty-input guard on
    // the very stage that is supposed to receive it.
    const build = defineStage<number[], { id: string }>({
      name: "build",
      run: () => Promise.resolve({ id: "issue-1" }),
    });
    const render = defineStage<{ id: string }, string>({
      name: "render",
      run: (issue) => Promise.resolve(issue.id),
    });

    const { output, report } = await runPipeline([build, render] as never, [1], ctx());
    expect(output).toBe("issue-1");
    expect(report.stages[1]).toMatchObject({ stage: "render", input: 1 });
  });
});

// ─────────────── a cycle that is already finished (E-011) ───────────────

/**
 * A repository that refuses to be written to without saying so.
 *
 * The criterion is "not a single write", and the only way to assert that honestly is to
 * record every write method rather than to check one of them.
 */
function recordingRepo(candidates: Candidate[]): {
  repo: RunContext["repo"];
  writes: string[];
} {
  const writes: string[] = [];
  const repo = {
    putRawItems: (i: RawItem[]) => {
      writes.push("putRawItems");
      return Promise.resolve(i);
    },
    listRawItems: () => Promise.resolve([] as RawItem[]),
    putCandidates: (c: Candidate[]) => {
      writes.push("putCandidates");
      return Promise.resolve(c);
    },
    listCandidates: () => Promise.resolve(candidates),
    putCards: (c: Card[]) => {
      writes.push("putCards");
      return Promise.resolve(c);
    },
    listCards: () => Promise.resolve([] as Card[]),
    putIssue: (i: Issue) => {
      writes.push("putIssue");
      return Promise.resolve(i);
    },
    recordStage: () => {
      writes.push("recordStage");
      return Promise.resolve();
    },
    recordRun: () => {
      writes.push("recordRun");
      return Promise.resolve();
    },
  } as unknown as RunContext["repo"];
  return { repo, writes };
}

function candidate(status: Candidate["status"], n: number): Candidate {
  return {
    id: `cand-${n}`,
    status,
    canonicalUrl: `https://example.com/${n}`,
    canonicalUrlHash: String(n).repeat(64).slice(0, 64),
    title: `Candidate ${n}`,
    firstSeenAt: "2026-08-25T00:00:00.000Z",
    contentHash: "b".repeat(64),
    extractedText: "text",
    rawItemIds: [`raw-${n}`],
    cycleId: "2026-W35",
  };
}

describe("a cycle whose candidates have all reached a terminal status", () => {
  it("runs no stage and makes no write at all", async () => {
    const { repo, writes } = recordingRepo([
      candidate("prefiltered_out", 1),
      candidate("rejected", 2),
    ]);
    const ran = vi.fn();
    const stage = defineStage<number[], number[]>({
      name: "would-write",
      allowEmptyInput: true,
      run: (input) => {
        ran();
        return Promise.resolve(input);
      },
    });

    const c = ctx();
    const { report } = await runPipeline([stage] as never, [1], { ...c, repo });

    expect(ran).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(report.stages).toEqual([]);
    expect(formatFunnel(report)).toMatch(/terminal/i);
  });

  it("still runs when one candidate of the cycle has work left in it", async () => {
    // The short circuit must key on EVERY row, not on the first one it happens to read.
    // "Some are done" is the normal state of a resumed run, and stopping there would look
    // exactly like a quiet week.
    const { repo } = recordingRepo([candidate("prefiltered_out", 1), candidate("normalized", 2)]);
    const ran = vi.fn();
    const stage = defineStage<number[], number[]>({
      name: "must-run",
      allowEmptyInput: true,
      run: (input) => {
        ran();
        return Promise.resolve(input);
      },
    });

    await runPipeline([stage] as never, [1], { ...ctx(), repo });
    expect(ran).toHaveBeenCalled();
  });

  it("still runs on a cycle that has no candidates yet", async () => {
    // Vacuous truth is the trap: "every candidate is terminal" is true of an empty set,
    // and a first run would stop before doing anything at all.
    const { repo } = recordingRepo([]);
    const ran = vi.fn();
    const stage = defineStage<number[], number[]>({
      name: "first-run",
      allowEmptyInput: true,
      run: (input) => {
        ran();
        return Promise.resolve(input);
      },
    });

    await runPipeline([stage] as never, [1], { ...ctx(), repo });
    expect(ran).toHaveBeenCalled();
  });
});

// ─────────────── skipping a stage whose rows are already done (E-011) ───────────────

describe("a stage whose work a previous run already finished", () => {
  it("is skipped, and the funnel says which stage and on what grounds", async () => {
    // A stage that quietly did nothing is indistinguishable from a broken one. The reason
    // is not decoration: it is the difference between "resumed correctly" and "the
    // repository handed back an empty list and nobody noticed".
    const ran = vi.fn();
    const stage = withResume(
      defineStage<number[], string[]>({
        name: "expensive",
        run: () => {
          ran();
          return Promise.resolve([]);
        },
      }),
      {
        select: () =>
          Promise.resolve({
            kind: "skip" as const,
            output: ["already", "written"],
            reason: "7 candidate(s) of this cycle were already extracted",
          }),
      },
    );
    const after = defineStage<string[], number>({
      name: "after",
      run: (input) => Promise.resolve(input.length),
    });

    const { output, report } = await runPipeline([stage, after] as never, [1], ctx());

    expect(ran).not.toHaveBeenCalled();
    expect(output).toBe(2);
    expect(report.stages[0]).toMatchObject({
      stage: "expensive",
      skipped: "7 candidate(s) of this cycle were already extracted",
    });
    const funnel = formatFunnel(report);
    expect(funnel).toContain("expensive");
    expect(funnel).toContain("skipped: 7 candidate(s) of this cycle were already extracted");
  });

  it("still fails loudly when the repository has nothing done AND nothing pending", async () => {
    // The escape hatch a resume plan must not have. "No rows left" and "no rows at all"
    // are the same number and opposite facts, and treating the second as a skip is how a
    // silently empty issue gets published.
    const stage = withResume(
      defineStage<number[], number[]>({
        name: "expensive",
        run: (input) => Promise.resolve(input),
      }),
      { select: () => Promise.resolve({ kind: "work" as const, input: [], alreadyDone: 0 }) },
    );

    await expect(runPipeline([stage] as never, [1], ctx())).rejects.toThrow(EmptyStageInputError);
  });

  it("reports a partial resume rather than passing it off as a full run", async () => {
    const stage = withResume(
      defineStage<number[], number[]>({
        name: "expensive",
        run: (input) => Promise.resolve(input),
      }),
      {
        select: () =>
          Promise.resolve({
            kind: "work" as const,
            input: [1, 2],
            alreadyDone: 5,
            doneStatus: "extracted",
          }),
      },
    );

    const { report } = await runPipeline([stage] as never, [1, 2, 3], ctx());
    expect(report.stages[0]).toMatchObject({ resumed: { alreadyDone: 5, status: "extracted" } });
    expect(formatFunnel(report)).toContain("[resumed: 5 already extracted]");
  });

  it("runs the stage on what `select` chose, not on what the previous stage produced", async () => {
    const seen: unknown[] = [];
    const stage = withResume(
      defineStage<number[], number[]>({
        name: "picky",
        run: (input) => {
          seen.push(input);
          return Promise.resolve(input);
        },
      }),
      { select: () => Promise.resolve({ kind: "work" as const, input: [42] }) },
    );

    await runPipeline([stage] as never, [1, 2, 3], ctx());
    expect(seen).toEqual([[42]]);
  });

  it("passes what `commit` returned to the next stage, not what `run` returned", async () => {
    // This is how a partly-resumed `extract` still hands the whole cycle's cards on: the
    // stage produced only the new ones, and the repository knows about the rest.
    const stage = withResume(
      defineStage<number[], string[]>({
        name: "partial",
        run: () => Promise.resolve(["new"]),
      }),
      { commit: (_work, output) => Promise.resolve([...output, "already-stored"]) },
    );
    const after = defineStage<string[], string[]>({
      name: "after",
      run: (input) => Promise.resolve(input),
    });

    const { output } = await runPipeline([stage, after] as never, [1], ctx());
    expect(output).toEqual(["new", "already-stored"]);
  });
});

// ─────────────── the journal a killed run leaves behind (E-011) ───────────────

describe("the stage journal", () => {
  it("records what to resume from and why, when a stage fails halfway", async () => {
    const repo = new MemoryRepo();
    const rows = [{ id: "cand-a" }, { id: "cand-b" }, { id: "cand-c" }];
    const stage = defineStage<{ id: string }[], unknown>({
      name: "extract",
      run: () => Promise.reject(new Error("the model timed out")),
    });

    await expect(runPipeline([stage] as never, rows, { ...ctx(), repo })).rejects.toThrow(
      "the model timed out",
    );

    const entry = repo.stageEntries().find((e) => e.stage === "extract");
    expect(entry).toMatchObject({ stage: "extract", status: "failed", inputCount: 3 });
    expect(entry?.error).toContain("the model timed out");
    expect(entry?.checkpoint).toEqual({
      resumeFrom: "rows",
      pending: 3,
      ids: ["cand-a", "cand-b", "cand-c"],
      truncated: false,
    });
  });

  it("leaves no checkpoint behind on a stage that finished", async () => {
    // A stale checkpoint on a completed stage is worse than none: it tells the next reader
    // to resume from rows that are already done.
    const repo = new MemoryRepo();
    const stage = defineStage<number[], number[]>({
      name: "fine",
      run: (input) => Promise.resolve(input),
    });

    await runPipeline([stage] as never, [1, 2], { ...ctx(), repo });
    const entry = repo.stageEntries().find((e) => e.stage === "fine");
    expect(entry).toMatchObject({ status: "completed", inputCount: 2, outputCount: 2 });
    expect(entry?.checkpoint).toBeUndefined();
    expect(entry?.error).toBeUndefined();
  });

  it("records a skipped stage as skipped rather than as completed", async () => {
    const repo = new MemoryRepo();
    const stage = withResume(
      defineStage<number[], number[]>({ name: "expensive", run: () => Promise.resolve([]) }),
      {
        select: () =>
          Promise.resolve({ kind: "skip" as const, output: [1, 2, 3], reason: "already done" }),
      },
    );

    await runPipeline([stage] as never, [1], { ...ctx(), repo });
    expect(repo.stageEntries()[0]).toMatchObject({
      stage: "expensive",
      status: "skipped",
      inputCount: 0,
      outputCount: 3,
    });
  });

  it("closes the run with the funnel, so the metrics outlive the terminal", async () => {
    const repo = new MemoryRepo();
    const stage = defineStage<number[], number[]>({
      name: "fine",
      run: (input) => Promise.resolve(input),
    });

    await runPipeline([stage] as never, [1, 2], { ...ctx(), repo });
    const entry = repo.runEntries()[0];
    expect(entry).toMatchObject({ runId: "run1", cycleId: "2026-W35", status: "completed" });
    expect((entry?.metrics as RunReportShape).stages[0]?.stage).toBe("fine");
  });

  it("closes a run that died as failed, naming the error", async () => {
    const repo = new MemoryRepo();
    const stage = defineStage<number[], number[]>({
      name: "boom",
      run: () => Promise.reject(new Error("nope")),
    });

    await expect(runPipeline([stage] as never, [1], { ...ctx(), repo })).rejects.toThrow("nope");
    expect(repo.runEntries()[0]).toMatchObject({ status: "failed" });
    expect(repo.runEntries()[0]?.error).toContain("nope");
  });
});

/** Only what the assertions above read out of the journalled report. */
interface RunReportShape {
  stages: { stage: string }[];
}
