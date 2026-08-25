import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetGuard, compareToBaseline, formatCostReport } from "./cost.js";

const REPO = resolve(import.meta.dirname, "../../..");

/** Every .ts under packages/ and apps/, excluding build output and node_modules. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

describe("llm entrypoint guard", () => {
  it("should be the only module importing the Anthropic SDK", () => {
    // The rule "never call Anthropic outside packages/llm/src/client.ts" is unenforceable
    // by convention: it holds for exactly as long as everyone remembers it. This is the
    // check that makes it real, and it is why the rule can be stated as a guarantee.
    const roots = [join(REPO, "packages"), join(REPO, "apps")].filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });

    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const rel = relative(REPO, file);
        if (rel === join("packages", "llm", "src", "client.ts")) continue;
        if (rel.endsWith(".test.ts")) continue;
        const text = readFileSync(file, "utf8");
        if (/from\s+["']@anthropic-ai\/sdk/.test(text)) offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("BudgetGuard", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0 };

  it("should accumulate spend across calls", () => {
    const guard = new BudgetGuard(10);
    guard.record({ stage: "extract", purpose: "p", model: "claude-sonnet-5", usage, latencyMs: 1 });
    guard.record({ stage: "extract", purpose: "p", model: "claude-sonnet-5", usage, latencyMs: 1 });
    expect(guard.spentUsd).toBeCloseTo(6, 6);
    expect(guard.remainingUsd).toBeCloseTo(4, 6);
  });

  it("should refuse to start a call once the ceiling is reached", () => {
    // The stage stops on a boundary and the issue is built from what is ready. An issue
    // of five cards beats no issue, so this throws before spending, not after.
    const guard = new BudgetGuard(1);
    guard.record({ stage: "extract", purpose: "p", model: "claude-sonnet-5", usage, latencyMs: 1 });
    expect(() => {
      guard.assertCanSpend();
    }).toThrow(/budget exceeded/i);
  });

  it("should group cost by stage", () => {
    const guard = new BudgetGuard(100);
    guard.record({ stage: "extract", purpose: "p", model: "claude-haiku-4-5", usage, latencyMs: 1 });
    guard.record({ stage: "compose", purpose: "p", model: "claude-opus-5", usage, latencyMs: 1 });
    const report = guard.report();
    expect(report.byStage["extract"]?.usd).toBeCloseTo(1, 6);
    expect(report.byStage["compose"]?.usd).toBeCloseTo(5, 6);
    expect(report.calls).toBe(2);
  });

  it("should flag a run more than 20% above baseline", () => {
    const guard = new BudgetGuard(100);
    guard.record({ stage: "extract", purpose: "p", model: "claude-sonnet-5", usage, latencyMs: 1 });
    const comparison = compareToBaseline(guard.report(), {
      totalUsd: 2,
      byStage: { extract: 2 },
      recordedAt: "2026-08-25T00:00:00Z",
      promptVersion: "test@1",
    });
    expect(comparison.deltaPct).toBeCloseTo(50, 6);
    expect(comparison.overThreshold).toBe(true);
  });

  it("should warn when several calls produced no cache reads at all", () => {
    // A broken prompt cache raises no error; it just multiplies cost. The warning is the
    // only place that shows up before the invoice does.
    const guard = new BudgetGuard(100);
    guard.record({ stage: "extract", purpose: "p", model: "claude-haiku-4-5", usage, latencyMs: 1 });
    guard.record({ stage: "extract", purpose: "p", model: "claude-haiku-4-5", usage, latencyMs: 1 });
    expect(formatCostReport(guard.report())).toMatch(/zero cache reads/);
  });
});
