/**
 * CLI runner. The entry point GitHub Actions calls, and the one an agent runs offline.
 *
 * Publishing is not reachable from here yet, and until it is, `--dry-run` is the only
 * mode. The flag exists now so the guard, the docs and the epic all speak about the same
 * thing from the start — a flag added after the fact is a flag someone forgets to pass.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractStage,
  formatFunnel,
  loadEnv,
  MemoryRepo,
  normalizeStage,
  prefilterStage,
  renderIssue,
  requireEnv,
  runPipeline,
  selectStage,
  type RunContext,
} from "@ai-digest/core";
import type { Card, Issue } from "@ai-digest/core";
import {
  AnthropicGateway,
  BudgetGuard,
  FixtureGateway,
  formatCostReport,
  MemoryLlmCache,
} from "@ai-digest/llm";
import { makeIngestStage, type SourceConfig } from "./ingest.js";

export interface CliOptions {
  profilePath: string;
  useFixtures: boolean;
  dryRun: boolean;
  record: boolean;
  outDir: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    profilePath: get("--profile") ?? "profiles/dist/_test.js",
    useFixtures: argv.includes("--fixtures"),
    dryRun: argv.includes("--dry-run"),
    record: argv.includes("--record"),
    outDir: get("--out") ?? "runs",
  };
}

/**
 * Accept the SOURCE path of a profile and load the compiled one.
 *
 * A profile is TypeScript, so `--profile profiles/_test.ts` cannot be imported at runtime:
 * it resolves `./schema.js`, which exists only under profiles/dist. Everyone — the epic's
 * acceptance criteria, its verification block, the docs — naturally writes the path of the
 * file they can see, and every one of them got ERR_MODULE_NOT_FOUND. Rewriting the docs to
 * say `profiles/dist/_test.js` would have been the smaller change and the worse one: it
 * asks every reader to know about a build directory in order to name a file that is right
 * there. The compiled path still works, so nothing that already worked breaks.
 */
export function resolveProfilePath(input: string): string {
  const abs = resolve(input);
  if (!abs.endsWith(".ts")) return abs;
  const compiled = abs.replace(/([\\/])([^\\/]+)\.ts$/, "$1dist$1$2.js");
  return existsSync(compiled) ? compiled : abs;
}

/** ISO week, e.g. 2026-W35. The one issue per cycle is keyed on this. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);

  if (!options.dryRun) {
    // Refused in code, not only by the hook: a guard that lives outside the program is a
    // guard the program does not have when it runs anywhere else.
    console.error(
      "Refusing to run without --dry-run. Publishing belongs to CI on a schedule, never to\n" +
        "an interactive session. Use: pnpm digest:run --profile profiles/dist/_test.js --fixtures --dry-run",
    );
    return 2;
  }

  const profileModule = (await import(pathToFileURL(resolveProfilePath(options.profilePath)).href)) as {
    profile?: Record<string, unknown>;
  };
  const profile = profileModule.profile;
  if (!profile) {
    console.error(`${options.profilePath} has no \`profile\` export.`);
    return 2;
  }

  const now = new Date();
  const runId = `run-${now.toISOString().replace(/[:.]/g, "-")}`;
  const cycleId = isoWeek(now);
  const artefactDir = join(options.outDir, runId);

  const env = loadEnv();
  const budget = new BudgetGuard((profile["llm"] as { maxRunCostUsd: number }).maxRunCostUsd);
  const llm = options.useFixtures
    ? new FixtureGateway({
        dir: join("fixtures", "llm", String(profile["slug"])),
        ...(options.record
          ? {
              recordWith: new AnthropicGateway({
                apiKey: requireEnv("ANTHROPIC_API_KEY", env),
                budget,
                stage: "extract",
                cache: new MemoryLlmCache(),
              }),
            }
          : {}),
      })
    : new AnthropicGateway({
        apiKey: requireEnv("ANTHROPIC_API_KEY", env),
        budget,
        stage: "extract",
        cache: new MemoryLlmCache(),
      });

  const repo = new MemoryRepo();
  const degraded: { sourceKey: string; reason: string }[] = [];

  const ctx: RunContext = {
    runId,
    cycleId,
    now,
    dryRun: options.dryRun,
    repo,
    llm,
    log: {
      debug: (m) => {
        console.error(`  · ${m}`);
      },
      warn: (m) => {
        console.error(`  ! ${m}`);
      },
    },
    profile,
  };

  const ingest = makeIngestStage(profile["sources"] as SourceConfig[], {
    useFixtures: options.useFixtures,
    windowDays: (profile["prefilter"] as { maxAgeDays: number }).maxAgeDays,
    degraded,
  });

  // Cards are stashed on the way past so `render` can read them back through the repo —
  // the same path the database-backed run uses.
  const captureCards = {
    name: "persist",
    allowEmptyInput: false,
    run: async (cards: Card[]) => {
      await repo.putCards(cards);
      return cards;
    },
  };

  const { output, report } = await runPipeline(
    [ingest, normalizeStage, prefilterStage, extractStage, captureCards, selectStage] as never,
    [],
    ctx,
    { artefactDir, degradedSources: degraded },
  );

  const issue = output as Issue;
  const markdown = renderIssue(
    issue,
    await repo.listCards(),
    profile["cardTypes"] as Record<string, { title: string }>,
  );

  await mkdir(artefactDir, { recursive: true });
  await writeFile(join(artefactDir, "issue.md"), markdown, "utf8");
  // Cost belongs in the artefacts, not only on the terminal: the baseline is taken from
  // here, and a number that exists only in scrollback cannot be compared against later.
  await writeFile(
    join(artefactDir, "cost.json"),
    JSON.stringify({ ...budget.report(), promptVersion: (profile["prompts"] as { promptVersion: string }).promptVersion }, null, 2) + "\n",
    "utf8",
  );

  console.error("");
  console.error(formatFunnel(report));
  console.error("");
  console.error(formatCostReport(budget.report()));
  console.error("");
  console.error(`artefacts: ${artefactDir}`);
  console.error("");
  console.log(markdown);
  return 0;
}
