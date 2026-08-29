/**
 * Sequential stage runner.
 *
 * Responsibilities beyond calling stages in order:
 *
 *  - It records each stage's input and output to `runs/<runId>/<stage>.{in,out}.json`.
 *    That is not a debug log: `pnpm golden` and `pnpm cost:report` read those files, so
 *    the record is part of the contract.
 *  - It refuses to let a stage silently receive nothing. A quietly empty issue looks
 *    exactly like a quiet week, which is why the check is fatal by default and a stage
 *    has to opt out.
 *  - It chooses work by the STATUS OF A ROW rather than by a step number. A run killed
 *    halfway is restarted, not redone: a stage whose rows are already past it is skipped —
 *    loudly, with the reason in the funnel — and one that is partly done receives only what
 *    is left. Without this the second run re-asks the model about every candidate, which
 *    costs real money and is invisible in a fixtures replay.
 *  - It writes the journal (`PipelineRun` / `StageRun`), so a stage that failed halfway
 *    leaves behind what to resume from instead of only a stack trace in a dead terminal.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EmptyStageInputError,
  isCandidateTerminal,
  sizeOf,
  type RunContext,
  type Stage,
  type StageResume,
} from "./stage.js";

export interface StageRecord {
  stage: string;
  input: number;
  output: number;
  durationMs: number;
  /** Present when the stage did not run, and says why. Never present without a reason. */
  skipped?: string;
  /** Present when the stage ran on a subset because the rest was already done. */
  resumed?: { alreadyDone: number; status: string };
}

/** Why a run stopped before its first stage. Absent on a run that had work to do. */
export interface SettledCycle {
  candidates: number;
  reason: string;
}

export interface RunReport {
  runId: string;
  cycleId: string;
  startedAt: string;
  finishedAt: string;
  stages: StageRecord[];
  /** Sources that failed or returned implausibly little. Reported, never fatal. */
  degradedSources: { sourceKey: string; reason: string }[];
  settled?: SettledCycle;
}

export interface PipelineOptions {
  /** Where to write the per-stage record. Omitted in unit tests that do not need it. */
  artefactDir?: string;
  /**
   * Live list of degraded sources, read AFTER the stages finish.
   *
   * It arrives by reference rather than by value because ingest fills it while the
   * pipeline is running. The previous shape wrote report.json with an empty list and let
   * the caller mutate the returned object afterwards — the console funnel showed the
   * truth and the persisted artefact never could, which is the one record that outlives
   * the terminal.
   */
  degradedSources?: { sourceKey: string; reason: string }[];
}

/** How many row ids a checkpoint carries before it starts summarising instead. */
const CHECKPOINT_ID_LIMIT = 200;

/**
 * Run `stages` in order, threading each output into the next input.
 *
 * Typed as `unknown` between stages on purpose: a chain of heterogeneous stages cannot be
 * expressed without either a variadic generic tangle or a lie. The zod schema at each
 * stage boundary is what actually enforces the shape, and it does so at runtime, where
 * malformed source data actually arrives.
 */
export async function runPipeline(
  stages: Stage<never, unknown>[],
  initialInput: unknown,
  ctx: RunContext,
  options: PipelineOptions = {},
): Promise<{ output: unknown; report: RunReport }> {
  const startedAt = new Date(ctx.now).toISOString();
  const records: StageRecord[] = [];
  let current: unknown = initialInput;

  const finish = async (settled?: SettledCycle): Promise<RunReport> => {
    const report: RunReport = {
      runId: ctx.runId,
      cycleId: ctx.cycleId,
      startedAt,
      finishedAt: new Date().toISOString(),
      stages: records,
      degradedSources: [...(options.degradedSources ?? [])],
      ...(settled ? { settled } : {}),
    };
    await writeArtefact(options.artefactDir, "report.json", report);
    return report;
  };

  // ── Is there anything left to do for this cycle at all? ──
  //
  // Asked BEFORE the first stage and answered with a read, because the criterion is "not a
  // single write": re-running a finished cycle must not even re-upsert the raw items it
  // already has. The read is deliberately narrow — this cycle's candidates — so a fresh
  // cycle, whose set is empty, is never mistaken for a finished one.
  const settled = await settledCycle(ctx);
  if (settled) {
    ctx.log.debug(`pipeline: ${settled.reason}`);
    return { output: undefined, report: await finish(settled) };
  }

  try {
    for (const stage of stages) {
      const resume = stage.resume as StageResume<unknown, unknown> | undefined;
      let work: unknown = current;
      let resumed: StageRecord["resumed"];

      if (resume?.select) {
        const decision = await resume.select(current, ctx);
        if (decision.kind === "skip") {
          const outputSize = sizeOf(decision.output);
          records.push({
            stage: stage.name,
            input: 0,
            output: outputSize,
            durationMs: 0,
            skipped: decision.reason,
          });
          ctx.log.debug(`stage ${stage.name}: skipped — ${decision.reason}`);
          await ctx.repo.recordStage({
            runId: ctx.runId,
            cycleId: ctx.cycleId,
            stage: stage.name,
            status: "skipped",
            inputCount: 0,
            outputCount: outputSize,
          });
          current = decision.output;
          continue;
        }
        work = decision.input;
        if (decision.alreadyDone !== undefined && decision.alreadyDone > 0) {
          resumed = { alreadyDone: decision.alreadyDone, status: decision.doneStatus ?? "done" };
        }
      }

      const inputSize = sizeOf(work);
      if (inputSize === 0 && !stage.allowEmptyInput) {
        throw new EmptyStageInputError(
          stage.name,
          records.length === 0
            ? "It was the first stage, so the run started with nothing to do."
            : `The previous stage "${records[records.length - 1]?.stage}" produced 0 items.`,
        );
      }

      await writeArtefact(options.artefactDir, `${stage.name}.in.json`, work);
      const t0 = Date.now();
      let output: unknown;
      try {
        output = await (stage.run as (i: unknown, c: RunContext) => Promise<unknown>)(work, ctx);
        if (resume?.commit) output = await resume.commit(work, output, ctx);
      } catch (error) {
        // The one place a checkpoint can honestly be written: the orchestrator knows what
        // it handed over and knows none of it was confirmed done. Written before the throw
        // propagates, because the process may not survive to write it later.
        await ctx.repo.recordStage({
          runId: ctx.runId,
          cycleId: ctx.cycleId,
          stage: stage.name,
          status: "failed",
          inputCount: inputSize,
          outputCount: 0,
          checkpoint: checkpointOf(work),
          error: describe(error),
        });
        throw error;
      }
      const durationMs = Date.now() - t0;
      await writeArtefact(options.artefactDir, `${stage.name}.out.json`, output);

      const outputSize = sizeOf(output);
      records.push({
        stage: stage.name,
        input: inputSize,
        output: outputSize,
        durationMs,
        ...(resumed ? { resumed } : {}),
      });
      ctx.log.debug(`stage ${stage.name}: ${inputSize} -> ${outputSize} (${durationMs}ms)`);
      await ctx.repo.recordStage({
        runId: ctx.runId,
        cycleId: ctx.cycleId,
        stage: stage.name,
        status: "completed",
        inputCount: inputSize,
        outputCount: outputSize,
      });
      current = output;
    }
  } catch (error) {
    const report = await finish();
    await ctx.repo.recordRun({
      runId: ctx.runId,
      cycleId: ctx.cycleId,
      status: "failed",
      metrics: report,
      error: describe(error),
    });
    throw error;
  }

  const report = await finish();
  await ctx.repo.recordRun({
    runId: ctx.runId,
    cycleId: ctx.cycleId,
    status: "completed",
    metrics: report,
  });
  return { output: current, report };
}

/**
 * Whether this cycle has candidates and every one of them is terminal.
 *
 * Two ways to get this wrong, both guarded above and both tested: an empty set satisfies
 * "every" vacuously and would stop a first run before it began, and keying on the first row
 * rather than on all of them would stop a resumed run that still had work in it.
 *
 * NAMED CONSEQUENCE: a cycle whose candidates all ended terminal is closed for the rest of
 * the week — items published later are not picked up until the next cycle. That is what the
 * criterion asks for, and re-opening it needs a signal this function does not have. Filed
 * as E-011a.
 */
async function settledCycle(ctx: RunContext): Promise<SettledCycle | undefined> {
  const rows = await ctx.repo.listCandidates({ cycleId: ctx.cycleId });
  if (rows.length === 0) return undefined;
  if (!rows.every((row) => isCandidateTerminal(row.status))) return undefined;

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const summary = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");
  return {
    candidates: rows.length,
    reason:
      `all ${rows.length} candidate(s) of cycle ${ctx.cycleId} are already in a terminal ` +
      `status (${summary}) — nothing to do, and nothing was written`,
  };
}

/** What a restart resumes from: the rows this stage was handed and did not finish. */
function checkpointOf(work: unknown): unknown {
  if (!Array.isArray(work)) return { resumeFrom: "stage-input", inputCount: sizeOf(work) };
  const ids = work
    .map((row: unknown) =>
      typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string"
        ? (row as { id: string }).id
        : undefined,
    )
    .filter((id): id is string => id !== undefined);
  return {
    resumeFrom: "rows",
    pending: work.length,
    ids: ids.slice(0, CHECKPOINT_ID_LIMIT),
    truncated: ids.length > CHECKPOINT_ID_LIMIT,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function writeArtefact(dir: string | undefined, name: string, value: unknown): Promise<void> {
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Human-readable funnel. This is what the owner reads on review instead of a diff. */
export function formatFunnel(report: RunReport): string {
  const header = `funnel (run ${report.runId}, cycle ${report.cycleId}):`;
  if (report.settled) return [header, `  nothing to do: ${report.settled.reason}`].join("\n");

  const width = Math.max(...report.stages.map((s) => s.stage.length), 5);
  const lines = report.stages.map((s) => {
    // A skipped stage prints its reason instead of an arrow. A stage that quietly did
    // nothing is indistinguishable from a broken one, so the reason is not optional.
    if (s.skipped !== undefined) {
      return `  ${s.stage.padEnd(width)}  skipped: ${s.skipped} (${s.output} already in hand)`;
    }
    const drop = s.input - s.output;
    const note = drop > 0 ? `  (-${drop})` : "";
    const resumed = s.resumed
      ? `  [resumed: ${s.resumed.alreadyDone} already ${s.resumed.status}]`
      : "";
    return `  ${s.stage.padEnd(width)}  ${String(s.input).padStart(5)} -> ${String(s.output).padStart(5)}${note}  ${s.durationMs}ms${resumed}`;
  });
  const degraded = report.degradedSources.map((d) => `  ! ${d.sourceKey}: ${d.reason}`);
  return [header, ...lines, ...degraded].join("\n");
}
