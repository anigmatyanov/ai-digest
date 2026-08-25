/**
 * Run cost accounting and the budget guard.
 *
 * Cost is a product property of a weekly autonomous pipeline, not an afterthought: with
 * nobody watching, a threefold increase shows up on the invoice rather than in a report.
 */

import { BudgetExceededError } from "@ai-digest/core";
import { cacheHitRate, costOf, type TokenUsage } from "./pricing.js";

export interface CallRecord {
  stage: string;
  purpose: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
  cacheHit: boolean;
  latencyMs: number;
}

export interface CostReport {
  totalUsd: number;
  byStage: Record<string, { calls: number; usd: number; inputTokens: number; outputTokens: number }>;
  cacheHitRate: number;
  calls: number;
}

/**
 * Accumulates spend for one run and refuses to keep going past the profile's ceiling.
 *
 * On exceeding the budget the stage stops on a boundary and the issue is assembled from
 * whatever is ready. An issue of five cards beats no issue — killing the run outright
 * would trade a partial result for nothing.
 */
export class BudgetGuard {
  private readonly records: CallRecord[] = [];

  constructor(private readonly limitUsd: number) {}

  get spentUsd(): number {
    return this.records.reduce((sum, r) => sum + r.costUsd, 0);
  }

  get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.spentUsd);
  }

  /** Throw before making a call that the budget cannot cover. */
  assertCanSpend(): void {
    if (this.spentUsd >= this.limitUsd) {
      throw new BudgetExceededError(this.spentUsd, this.limitUsd);
    }
  }

  record(entry: Omit<CallRecord, "costUsd" | "cacheHit">): CallRecord {
    const record: CallRecord = {
      ...entry,
      costUsd: costOf(entry.model, entry.usage),
      cacheHit: (entry.usage.cacheReadTokens ?? 0) > 0,
    };
    this.records.push(record);
    return record;
  }

  report(): CostReport {
    const byStage: CostReport["byStage"] = {};
    for (const r of this.records) {
      const bucket = (byStage[r.stage] ??= { calls: 0, usd: 0, inputTokens: 0, outputTokens: 0 });
      bucket.calls += 1;
      bucket.usd += r.costUsd;
      bucket.inputTokens += r.usage.inputTokens + (r.usage.cacheReadTokens ?? 0);
      bucket.outputTokens += r.usage.outputTokens;
    }
    const totals = this.records.reduce<TokenUsage>(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.usage.inputTokens,
        outputTokens: acc.outputTokens + r.usage.outputTokens,
        cacheReadTokens: (acc.cacheReadTokens ?? 0) + (r.usage.cacheReadTokens ?? 0),
        cacheWriteTokens: (acc.cacheWriteTokens ?? 0) + (r.usage.cacheWriteTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
    return {
      totalUsd: this.spentUsd,
      byStage,
      cacheHitRate: cacheHitRate(totals),
      calls: this.records.length,
    };
  }
}

export interface Baseline {
  totalUsd: number;
  byStage: Record<string, number>;
  recordedAt: string;
  promptVersion: string;
}

export interface BaselineComparison {
  totalUsd: number;
  baselineUsd: number;
  deltaPct: number;
  /** True when the run grew more than 20% without an explanation (DoD #6). */
  overThreshold: boolean;
  perStage: { stage: string; usd: number; baselineUsd: number; deltaPct: number }[];
}

export const COST_REGRESSION_THRESHOLD_PCT = 20;

export function compareToBaseline(report: CostReport, baseline: Baseline): BaselineComparison {
  const pct = (now: number, before: number) =>
    before === 0 ? (now === 0 ? 0 : Infinity) : ((now - before) / before) * 100;

  const stages = new Set([...Object.keys(report.byStage), ...Object.keys(baseline.byStage)]);
  const perStage = [...stages].sort().map((stage) => {
    const usd = report.byStage[stage]?.usd ?? 0;
    const baselineUsd = baseline.byStage[stage] ?? 0;
    return { stage, usd, baselineUsd, deltaPct: pct(usd, baselineUsd) };
  });

  const deltaPct = pct(report.totalUsd, baseline.totalUsd);
  return {
    totalUsd: report.totalUsd,
    baselineUsd: baseline.totalUsd,
    deltaPct,
    overThreshold: deltaPct > COST_REGRESSION_THRESHOLD_PCT,
    perStage,
  };
}

export function formatCostReport(report: CostReport, comparison?: BaselineComparison): string {
  const lines = [`cost: $${report.totalUsd.toFixed(4)} across ${report.calls} call(s)`];
  for (const [stage, b] of Object.entries(report.byStage)) {
    lines.push(
      `  ${stage.padEnd(12)} $${b.usd.toFixed(4)}  ${b.calls} call(s)  ` +
        `in ${b.inputTokens} / out ${b.outputTokens}`,
    );
  }
  lines.push(`  cache hit rate: ${(report.cacheHitRate * 100).toFixed(1)}%`);
  if (report.cacheHitRate === 0 && report.calls > 1) {
    lines.push(
      "  ! zero cache reads across several calls. Two causes, both silent:\n" +
        "      1. the cacheable prefix is under the ~1024-token minimum, so caching never\n" +
        "         engages — measured here at ~545 tokens for the test profile's system prompt;\n" +
        "      2. something volatile sits in the prefix (a timestamp, a run id, unsorted JSON)\n" +
        "         and invalidates it every call.\n" +
        "     Neither raises an error; both multiply cost.",
    );
  }
  if (comparison) {
    const sign = comparison.deltaPct >= 0 ? "+" : "";
    lines.push(
      `  vs baseline $${comparison.baselineUsd.toFixed(4)}: ${sign}${comparison.deltaPct.toFixed(1)}%` +
        (comparison.overThreshold
          ? `  ! above ${COST_REGRESSION_THRESHOLD_PCT}% — name the reason in ## Заметки or it is a review finding`
          : ""),
    );
  }
  return lines.join("\n");
}
