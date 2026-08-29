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
  defineStage,
  extractStage,
  formatFunnel,
  loadEnv,
  MemoryRepo,
  mergeCandidate,
  normalizeStage,
  prefilterStage,
  renderIssue,
  requireEnv,
  runPipeline,
  selectStage,
  withResume,
  type CardFilter,
  type Repo,
  type RunContext,
  type Stage,
} from "@ai-digest/core";
import type { Candidate, Issue, RawItem } from "@ai-digest/core";
import {
  AnthropicGateway,
  BudgetGuard,
  contentHash,
  FixtureGateway,
  formatCostReport,
  MemoryLlmCache,
} from "@ai-digest/llm";
import { createPrismaClient, PrismaRepo } from "@ai-digest/db";
import { makeIngestStage, type SourceConfig } from "./ingest.js";

export interface CliOptions {
  profilePath: string;
  useFixtures: boolean;
  dryRun: boolean;
  record: boolean;
  /**
   * Persist to Postgres even under --fixtures.
   *
   * Exists because the two choices were conflated: --fixtures selected the recorded model
   * responses AND the in-memory repository, so there was no way to exercise the database
   * without paying for live model calls. Separating them is what makes the persistence
   * guarantees testable at all — and the default stays fully offline.
   */
  useDb: boolean;
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
    useDb: argv.includes("--db"),
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

/** "2 in_issue, 1 rejected" — a skip has to say what it is standing on. */
function statusTally(rows: readonly Candidate[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");
}

/**
 * The pipeline, assembled — and the one place that says which stages pick their work by
 * row status rather than by step number.
 *
 * The resume plans live here rather than inside the stages on purpose. A stage stays a
 * pure `(input, ctx) => output` that does not know where its input came from; "which rows
 * are still mine" is a question about the repository and the profile's caps, and both of
 * those are known here and nowhere else. It is also what keeps `packages/core/src/pipeline/
 * stages/*.ts` free of repository calls.
 *
 * Extracted from `main` so a test can run the REAL chain twice over one repository. That
 * property — a second run over the same cycle does not pay for `extract` again — is not a
 * property of any single stage, and a test that assembled its own lookalike chain would
 * keep passing while this one drifted.
 */
export function buildStages(
  repo: Repo,
  profile: Record<string, unknown>,
  ingest: Stage<never, unknown>,
): Stage<never, unknown>[] {
  const cycleOf = (ctx: RunContext): CardFilter => ({ cycleId: ctx.cycleId });

  /**
   * Statuses only `extract` or something after it can produce.
   *
   * This is a fact about THIS assembly's order, which is why it lives here and not in
   * `packages/core`. `prefiltered_out` and `duplicate` are absent on purpose: a row in
   * either never reached the model, so counting it as "extract already did this one"
   * would let a run skip the money stage on the strength of work nobody did.
   */
  const PAST_EXTRACT: readonly Candidate["status"][] = [
    "extracted",
    "scored",
    "in_issue",
    "published",
    "rejected",
  ];
  const extractCap = (profile["llm"] as { maxCandidatesToExtract: number }).maxCandidatesToExtract;

  const captureRawItems = defineStage<RawItem[], RawItem[]>({
    name: "persist-raw",
    allowEmptyInput: true,
    run: (items) => repo.putRawItems(items),
  });

  // Candidates are persisted before anything references them, and before `prefilter` runs
  // rather than after it.
  //
  // Found by the first live run against Postgres: nothing in the pipeline wrote candidates
  // at all, and cards referencing them failed with a foreign key violation. MemoryRepo
  // could not surface this — an in-memory Map has no referential integrity, so the gap was
  // invisible for as long as the only repository was in memory.
  //
  // Rejected candidates are persisted too, on purpose: `prefiltered_out` is a terminal
  // STATUS, not an absence. It used to be written after `prefilter`, which meant the
  // rejects never reached storage at all and the comment saying otherwise was aspirational.
  //
  // `mergeCandidate` is what stops the persist from being a status regression: a restarted
  // run re-derives every candidate as `normalized`, and writing that over a row that is
  // already `extracted` sends it back through the model.
  const captureCandidates = defineStage<Candidate[], Candidate[]>({
    name: "persist-candidates",
    allowEmptyInput: false,
    run: async (candidates, ctx) => {
      const stored = new Map(
        (await repo.listCandidates(cycleOf(ctx))).map((c) => [c.canonicalUrlHash, c]),
      );
      return repo.putCandidates(
        candidates.map((c) => mergeCandidate(c, stored.get(c.canonicalUrlHash))),
      );
    },
  });

  // `prefilter` is deterministic and free, so it always runs; what it needs is a commit,
  // because a rejection that is not written down is a rejection the next run pays to
  // rediscover — and, worse, one that never appears in the funnel.
  const prefilter = withResume(prefilterStage, {
    async commit(work, kept, ctx) {
      const keptIds = new Set(kept.map((c) => c.id));
      const dropped = work
        .filter((c) => !keptIds.has(c.id))
        // Only rows the automaton has not already moved past. Prefilter is deterministic,
        // so this set is normally identical between runs — but "normally" is not a
        // guarantee when the source edits an article, and a rule that can walk an
        // `in_issue` candidate back to `prefiltered_out` would silently unpublish it.
        .filter((c) => c.status === "new" || c.status === "normalized")
        .map((c) => ({
          ...c,
          status: "prefiltered_out" as const,
          statusReason: c.statusReason ?? "rejected by the profile's prefilter rules",
        }));
      if (dropped.length > 0) {
        await repo.putCandidates(dropped);
        ctx.log.debug(`prefilter: ${dropped.length} candidate(s) recorded as prefiltered_out`);
      }
      return kept;
    },
  });

  // The money boundary, and the only stage whose skip is worth anything.
  //
  // `select` reads the rows that are still `normalized` IN THIS CYCLE — that is the whole
  // "work is chosen by row status" claim, made good. The profile's cap is applied here
  // rather than left to the stage so that `commit` knows exactly which candidates were
  // offered to the model and can move all of them, instead of guessing.
  const extract = withResume(extractStage, {
    async select(_previous, ctx) {
      const pending = await repo.listCandidates({ cycleId: ctx.cycleId, status: "normalized" });
      const done = await repo.listCandidates({ cycleId: ctx.cycleId, status: PAST_EXTRACT });
      if (pending.length === 0 && done.length > 0) {
        return {
          kind: "skip",
          output: await repo.listCards(cycleOf(ctx)),
          reason: `${done.length} candidate(s) of this cycle were already extracted (${statusTally(done)})`,
        };
      }
      return {
        kind: "work",
        input: pending.slice(0, extractCap),
        alreadyDone: done.length,
        doneStatus: "extracted",
      };
    },
    async commit(work, cards, ctx) {
      const withCard = new Set(cards.map((card) => card.candidateId));
      await repo.putCards(cards);
      await repo.putCandidates(
        work.map((c) =>
          withCard.has(c.id)
            ? { ...c, status: "extracted" as const }
            : {
                ...c,
                status: "rejected" as const,
                statusReason: c.statusReason ?? "the model found no usable technique in it",
              },
        ),
      );
      // Everything this cycle has written, not only what this run produced: after a partial
      // resume the new cards are a minority of the issue, and returning only them would
      // publish a fraction of the week.
      return repo.listCards(cycleOf(ctx));
    },
  });

  // `select` deliberately has NO `select` of its own. Its input is whatever `extract`
  // handed on, and `extract` hands on the cycle's cards in BOTH of its paths — the commit
  // after a real run, and the skip. A second read of the repository here would be a second
  // route to the same answer, and the moment there are two, the skip's output stops being
  // load-bearing: it could return nothing and no test could tell. Measured: with the
  // duplicate read in place, replacing the skip's output with `[]` left all 263 tests green.
  const select = withResume(selectStage, {
    async commit(work, issue, ctx) {
      const chosen = new Set(issue.cardIds);
      const candidateIds = new Set(
        work.filter((card) => chosen.has(card.id)).map((card) => card.candidateId),
      );
      const inIssue = (await repo.listCandidates(cycleOf(ctx)))
        .filter((c) => candidateIds.has(c.id))
        .map((c) => ({ ...c, status: "in_issue" as const }));
      if (inIssue.length > 0) await repo.putCandidates(inIssue);
      return issue;
    },
  });

  return [
    ingest,
    captureRawItems,
    normalizeStage,
    captureCandidates,
    prefilter,
    extract,
    select,
  ] as never;
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

  const profileModule = (await import(
    pathToFileURL(resolveProfilePath(options.profilePath)).href
  )) as {
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

  if (options.useDb && !options.useFixtures) {
    // --db reads as "exercise the database", and on its own it also selects the live
    // model gateway, which costs money. Saying so beats discovering it on the invoice.
    console.error(
      "! --db without --fixtures also uses the LIVE model gateway, and those calls are billed.\n" +
        "  For a database run at no model cost: --fixtures --db --dry-run",
    );
  }

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

  // A fixtures run is offline by definition and never opens a connection, even when
  // DATABASE_URL happens to be set in the shell. Without that rule the golden gate starts
  // failing on a cold Neon branch, on a neighbour's unapplied migration and on a flaky
  // network — none of which say anything about the pipeline, and all of which end with
  // someone deleting the gate.
  const repo =
    options.useFixtures && !options.useDb
      ? new MemoryRepo()
      : await PrismaRepo.open(
          createPrismaClient(requireEnv("DATABASE_URL", env)),
          {
            slug: String(profile["slug"]),
            title: String(profile["title"]),
            lang: String(profile["lang"]),
            profileJson: profile,
            // Insertion order of a TS module object is stable across runs of the same file,
            // so a plain stringify is reproducible here. The hash exists to tell two profile
            // VERSIONS apart, not to canonicalise key order.
            profileHash: contentHash(JSON.stringify(profile)),
          },
          (profile["sources"] as SourceConfig[]).map((s) => ({
            key: s.key,
            kind: s.kind,
            enabled: s.enabled ?? true,
            weight: s.weight ?? 1,
          })),
          requireEnv("DATABASE_URL", env),
        );
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

  const { output, report } = await runPipeline(
    buildStages(repo, profile, ingest as never),
    [],
    ctx,
    { artefactDir, degradedSources: degraded },
  );

  // A cycle whose candidates are all terminal produced no issue and wrote nothing. Saying
  // so and stopping is the point of the check; rendering an empty document instead would
  // publish "nothing happened this week" as if it were an issue.
  if (report.settled) {
    console.error("");
    console.error(formatFunnel(report));
    console.error("");
    console.error(`artefacts: ${artefactDir}`);
    return 0;
  }

  const issue = output as Issue;
  const markdown = renderIssue(
    issue,
    await repo.listCards({ cycleId }),
    profile["cardTypes"] as Record<string, { title: string }>,
  );

  await mkdir(artefactDir, { recursive: true });
  await writeFile(join(artefactDir, "issue.md"), markdown, "utf8");
  // Cost belongs in the artefacts, not only on the terminal: the baseline is taken from
  // here, and a number that exists only in scrollback cannot be compared against later.
  await writeFile(
    join(artefactDir, "cost.json"),
    JSON.stringify(
      {
        ...budget.report(),
        promptVersion: (profile["prompts"] as { promptVersion: string }).promptVersion,
      },
      null,
      2,
    ) + "\n",
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
