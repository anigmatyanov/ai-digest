#!/usr/bin/env node
/**
 * Cost of the most recent run, against the recorded baseline.
 *
 * Cost is a product property of a weekly autonomous pipeline: with nobody watching, a
 * threefold rise shows up on the invoice rather than in a report.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(readFileSync(join(ROOT, "costs/baseline.json"), "utf8"));

const runsDir = join(ROOT, "runs");
if (!existsSync(runsDir) || readdirSync(runsDir).length === 0) {
  console.error("no runs found — run `pnpm digest:run … --dry-run` first.");
  process.exit(1);
}
// Newest run that actually completed. A run that threw — EmptyStageInputError, a drift,
// an interrupt — leaves a directory with partial stage artefacts and no report.json, and
// reading it unguarded turned a dev helper into a stack trace.
const candidates = readdirSync(runsDir).sort().reverse();
const dirName = candidates.find((d) => existsSync(join(runsDir, d, "report.json")));
if (!dirName) {
  console.error(
    `no completed run found in ${runsDir} (${candidates.length} director(y|ies), none with report.json).\n` +
      "Run the pipeline once: pnpm digest:run --profile profiles/_test.ts --fixtures --dry-run",
  );
  process.exit(1);
}
const dir = join(runsDir, dirName);
const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
const costPath = join(dir, "cost.json");
const cost = existsSync(costPath) ? JSON.parse(readFileSync(costPath, "utf8")) : null;

// `--update-baseline` records the CURRENT run as the reference. Only meaningful after a
// live run: a replay costs nothing, and a baseline of 0.00 would make every future run
// look like an infinite regression.
if (process.argv.includes("--update-baseline")) {
  if (!cost || cost.totalUsd === 0) {
    console.error(
      "refusing to record a baseline from a run that cost $0.00 — replays are free.\n" +
        "Record one from a live run: env -u ANTHROPIC_API_KEY pnpm digest:run … --record",
    );
    process.exit(1);
  }
  const next = {
    status: "measured",
    totalUsd: cost.totalUsd,
    byStage: Object.fromEntries(Object.entries(cost.byStage).map(([k, v]) => [k, v.usd])),
    recordedAt: new Date().toISOString(),
    promptVersion: cost.promptVersion,
    calls: cost.calls,
  };
  writeFileSync(join(ROOT, "costs/baseline.json"), JSON.stringify(next, null, 2) + "\n");
  console.log(`baseline recorded: $${next.totalUsd.toFixed(4)} across ${next.calls} call(s) (${next.promptVersion})`);
  process.exit(0);
}

console.log(`run ${report.runId} (cycle ${report.cycleId})`);
for (const s of report.stages) {
  console.log(`  ${s.stage.padEnd(12)} ${String(s.input).padStart(4)} -> ${String(s.output).padStart(4)}  ${s.durationMs}ms`);
}

if (baseline.status === "not-measured") {
  console.log("");
  console.log("cost: not comparable — no baseline has been recorded yet.");
  console.log(`  ${baseline.why}`);
  // Exit 0: an unrecorded baseline is a known state of the project, not a regression.
  // Failing here would make `verify` red for a reason no code change can fix.
  process.exit(0);
}

console.log("");
if (!cost) {
  console.log("this run has no cost.json — it predates cost recording.");
  process.exit(0);
}
const delta = baseline.totalUsd === 0 ? 0 : ((cost.totalUsd - baseline.totalUsd) / baseline.totalUsd) * 100;
console.log(`cost: $${cost.totalUsd.toFixed(4)} across ${cost.calls} call(s)`);
for (const [stage, b] of Object.entries(cost.byStage)) {
  console.log(`  ${stage.padEnd(12)} $${b.usd.toFixed(4)}  ${b.calls} call(s)  in ${b.inputTokens} / out ${b.outputTokens}`);
}
console.log(`  cache hit rate: ${(cost.cacheHitRate * 100).toFixed(1)}%`);
console.log("");
console.log(`baseline $${baseline.totalUsd.toFixed(4)} (${baseline.recordedAt}, ${baseline.promptVersion})`);
if (cost.totalUsd === 0) {
  console.log("  this run was a replay and cost nothing — not comparable.");
} else {
  const sign = delta >= 0 ? "+" : "";
  console.log(`  delta: ${sign}${delta.toFixed(1)}%${delta > 20 ? "  ! above 20% — name the reason or it is a review finding" : ""}`);
}
