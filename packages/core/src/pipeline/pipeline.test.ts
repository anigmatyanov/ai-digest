import { describe, expect, it, vi } from "vitest";
import { formatFunnel, runPipeline } from "./pipeline.js";
import { defineStage, EmptyStageInputError, type RunContext } from "./stage.js";

function ctx(): RunContext {
  return {
    runId: "run1",
    cycleId: "2026-W35",
    now: new Date("2026-08-25T10:00:00Z"),
    dryRun: true,
    repo: {} as RunContext["repo"],
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

    const { output } = await runPipeline(
      [double, inc] as never,
      [1, 2, 3],
      ctx(),
    );
    expect(output).toEqual([3, 5, 7]);
  });

  it("should fail when a stage receives an empty input", async () => {
    // The whole point: an empty issue must be an error, not a quiet week.
    const drain = defineStage<number[], number[]>({ name: "drain", run: () => Promise.resolve([]) });
    const next = defineStage<number[], number[]>({ name: "next", run: (i) => Promise.resolve(i) });

    await expect(runPipeline([drain, next] as never, [1], ctx())).rejects.toThrow(
      EmptyStageInputError,
    );
  });

  it("should name the stage that produced nothing, not just the one that failed", async () => {
    const drain = defineStage<number[], number[]>({ name: "drain", run: () => Promise.resolve([]) });
    const next = defineStage<number[], number[]>({ name: "next", run: (i) => Promise.resolve(i) });

    await expect(runPipeline([drain, next] as never, [1], ctx())).rejects.toThrow(/"drain"/);
  });

  it("should allow an empty input when the stage opts in", async () => {
    // `ingest` may legitimately find nothing on a quiet day; the opt-in is per stage so
    // the safe behaviour is what you get by forgetting to think about it.
    const quiet = defineStage<number[], number[]>({ name: "quiet", run: () => Promise.resolve([]) });
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
