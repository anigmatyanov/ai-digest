/**
 * Sequential stage runner.
 *
 * Two responsibilities beyond calling stages in order:
 *
 *  - It records each stage's input and output to `runs/<runId>/<stage>.{in,out}.json`.
 *    That is not a debug log: `pnpm golden` and `pnpm cost:report` read those files, so
 *    the record is part of the contract.
 *  - It refuses to let a stage silently receive nothing. A quietly empty issue looks
 *    exactly like a quiet week, which is why the check is fatal by default and a stage
 *    has to opt out.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EmptyStageInputError, sizeOf, type RunContext, type Stage } from "./stage.js";

export interface StageRecord {
  stage: string;
  input: number;
  output: number;
  durationMs: number;
}

export interface RunReport {
  runId: string;
  cycleId: string;
  startedAt: string;
  finishedAt: string;
  stages: StageRecord[];
  /** Sources that failed or returned implausibly little. Reported, never fatal. */
  degradedSources: { sourceKey: string; reason: string }[];
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

  for (const stage of stages) {
    const inputSize = sizeOf(current);
    if (inputSize === 0 && !stage.allowEmptyInput) {
      throw new EmptyStageInputError(
        stage.name,
        records.length === 0
          ? "It was the first stage, so the run started with nothing to do."
          : `The previous stage "${records[records.length - 1]?.stage}" produced 0 items.`,
      );
    }

    await writeArtefact(options.artefactDir, `${stage.name}.in.json`, current);
    const t0 = Date.now();
    const output = await (stage.run as (i: unknown, c: RunContext) => Promise<unknown>)(
      current,
      ctx,
    );
    const durationMs = Date.now() - t0;
    await writeArtefact(options.artefactDir, `${stage.name}.out.json`, output);

    records.push({ stage: stage.name, input: inputSize, output: sizeOf(output), durationMs });
    ctx.log.debug(`stage ${stage.name}: ${inputSize} -> ${sizeOf(output)} (${durationMs}ms)`);
    current = output;
  }

  const report: RunReport = {
    runId: ctx.runId,
    cycleId: ctx.cycleId,
    startedAt,
    finishedAt: new Date().toISOString(),
    stages: records,
    degradedSources: [...(options.degradedSources ?? [])],
  };
  await writeArtefact(options.artefactDir, "report.json", report);
  return { output: current, report };
}

async function writeArtefact(dir: string | undefined, name: string, value: unknown): Promise<void> {
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Human-readable funnel. This is what the owner reads on review instead of a diff. */
export function formatFunnel(report: RunReport): string {
  const width = Math.max(...report.stages.map((s) => s.stage.length), 5);
  const lines = report.stages.map((s) => {
    const drop = s.input - s.output;
    const note = drop > 0 ? `  (-${drop})` : "";
    return `  ${s.stage.padEnd(width)}  ${String(s.input).padStart(5)} -> ${String(s.output).padStart(5)}${note}  ${s.durationMs}ms`;
  });
  const degraded = report.degradedSources.map((d) => `  ! ${d.sourceKey}: ${d.reason}`);
  return [`funnel (run ${report.runId}, cycle ${report.cycleId}):`, ...lines, ...degraded].join(
    "\n",
  );
}
