import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  defineStage,
  formatFunnel,
  MemoryRepo,
  runPipeline,
  type Candidate,
  type Issue,
  type LlmGateway,
  type LlmUsage,
  type RawItem,
  type RunContext,
} from "@ai-digest/core";
import { buildStages, isoWeek, parseArgs, resolveProfilePath } from "./run.js";

const REPO = resolve(import.meta.dirname, "../../..");

describe("resolveProfilePath", () => {
  it("should load the compiled profile when given the TypeScript source path", () => {
    // The epic's acceptance criterion and its verification block both name the .ts file —
    // the one a reader can actually see. Before this, every such invocation died with
    // ERR_MODULE_NOT_FOUND because a profile resolves ./schema.js at runtime.
    const compiled = join(REPO, "profiles/dist/_test.js");
    if (!existsSync(compiled)) return; // nothing built yet; the other cases still hold
    expect(resolveProfilePath(join(REPO, "profiles/_test.ts"))).toBe(compiled);
  });

  it("should leave an already-compiled path untouched", () => {
    const compiled = join(REPO, "profiles/dist/_test.js");
    expect(resolveProfilePath(compiled)).toBe(compiled);
  });

  it("should fall back to the given path when no compiled output exists", () => {
    // Better a clear module-not-found on the path the user typed than a silent redirect
    // to a file that is not there either.
    const missing = join(REPO, "profiles/does-not-exist.ts");
    expect(resolveProfilePath(missing)).toBe(missing);
  });
});

describe("parseArgs", () => {
  it("should default to a dry run being absent, so publishing needs an explicit flag", () => {
    expect(parseArgs([]).dryRun).toBe(false);
  });

  it("should read the profile path and the fixtures flag", () => {
    const o = parseArgs(["--profile", "profiles/_test.ts", "--fixtures", "--dry-run"]);
    expect(o.profilePath).toBe("profiles/_test.ts");
    expect(o.useFixtures).toBe(true);
    expect(o.dryRun).toBe(true);
  });
});

describe("isoWeek", () => {
  it("should format an ISO week the way the issue cycle key expects", () => {
    expect(isoWeek(new Date("2026-08-25T10:00:00Z"))).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("should put 4 January in week 1, which is the ISO rule that trips naive code", () => {
    expect(isoWeek(new Date("2026-01-04T00:00:00Z"))).toBe("2026-W01");
  });
});

// ───────────────── resuming a cycle instead of redoing it (E-011) ─────────────────

/**
 * These cases run the REAL assembly — `buildStages` — twice over ONE repository. The
 * property is not a property of any single stage: `extract` in isolation cannot know that
 * a previous run already asked about the same candidate. A test that assembled its own
 * lookalike chain would keep passing while the chain in `main` drifted, which is why the
 * assembly is exported rather than duplicated here.
 *
 * The model gateway is a counter rather than a fixture gateway on purpose: a fixture
 * replay is free, so a run that re-asks the model would still report $0.00 and the second
 * payment would be invisible. Counting calls is what makes it visible.
 */

const BODY =
  "Runner notes: the --resume flag is the one that matters here, and a killed run " +
  "continues where it stopped rather than starting the whole week over again from zero.";

interface CountingLlm extends LlmGateway {
  calls: number;
}

function countingLlm(): CountingLlm {
  const gateway: CountingLlm = {
    calls: 0,
    complete<T>(request: { schema: { parse: (v: unknown) => T } }): Promise<{
      value: T;
      usage: LlmUsage;
    }> {
      gateway.calls++;
      return Promise.resolve({
        value: request.schema.parse({
          isRelevant: true,
          rejectReason: null,
          type: "recipe",
          techniqueKey: `acme/cli/flag-${gateway.calls}`,
          title: "Флаг, который экономит час",
          summary: "Короткая выжимка",
          body: "Тело карточки",
          steps: ["раз", "два"],
          tags: ["cli"],
          claims: [
            { text: "Флаг существует", quote: "the --resume flag" },
            { text: "Он продолжает прогон", quote: "continues where it stopped" },
          ],
        }),
        usage: {
          model: "test",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.001,
          cacheHit: false,
        },
      });
    },
  };
  return gateway;
}

/** Everything `buildStages` reads out of a profile, and nothing else. */
const PROFILE: Record<string, unknown> = {
  slug: "test",
  title: "Test digest",
  lang: "ru",
  cardTypes: { recipe: { title: "Приём", maxPerIssue: 4 } },
  prefilter: { maxAgeDays: 3650, minBodyChars: 20, mustMatchAny: [], denyAny: [] },
  selection: {
    cardsPerIssue: { min: 1, max: 4 },
    minScore: 0,
    requireEvidenceOk: true,
    maxPerSource: 4,
  },
  llm: { extract: { model: "test-model" }, maxCandidatesToExtract: 8 },
  prompts: {
    promptVersion: "test@1",
    domainBrief: "brief",
    whatCounts: { recipe: "recipe" },
    exclusions: "none",
    style: "style",
  },
};

function rawItem(n: number): RawItem {
  return {
    id: `raw-src-${n}`,
    sourceKey: "src",
    externalId: String(n),
    url: `https://example.com/post-${n}`,
    title: `Post ${n}`,
    body: BODY,
    bodyFormat: "text",
    signals: {},
    fetchedAt: "2026-08-25T00:00:00.000Z",
  };
}

/** Stands in for the connector-backed ingest stage: offline, deterministic, no network. */
function stubIngest(items: RawItem[]) {
  return defineStage<unknown, RawItem[]>({
    name: "ingest",
    allowEmptyInput: true,
    run: () => Promise.resolve(items),
  });
}

function runCtx(repo: RunContext["repo"], llm: LlmGateway, runId: string): RunContext {
  return {
    runId,
    cycleId: "2026-W35",
    now: new Date("2026-08-25T10:00:00Z"),
    dryRun: true,
    repo,
    llm,
    log: { debug: vi.fn(), warn: vi.fn() },
    profile: PROFILE,
  };
}

async function runOnce(
  repo: MemoryRepo,
  llm: LlmGateway,
  runId: string,
  items: RawItem[],
): Promise<Awaited<ReturnType<typeof runPipeline>>> {
  const ctx = runCtx(repo, llm, runId);
  return runPipeline(buildStages(repo, PROFILE, stubIngest(items) as never), [], ctx);
}

describe("a cycle a previous run already worked on", () => {
  it("does not ask the model again about a candidate that was already extracted", async () => {
    const repo = new MemoryRepo();
    const llm = countingLlm();
    const items = [rawItem(1), rawItem(2), rawItem(3)];

    await runOnce(repo, llm, "run-1", items);
    const afterFirst = llm.calls;
    expect(afterFirst).toBe(3);

    await runOnce(repo, llm, "run-2", items);
    expect(llm.calls - afterFirst).toBe(0);
  });

  it("says in the funnel which stage it skipped and why, rather than repeating it quietly", async () => {
    const repo = new MemoryRepo();
    const llm = countingLlm();
    const items = [rawItem(1), rawItem(2)];

    await runOnce(repo, llm, "run-1", items);
    const { report } = await runOnce(repo, llm, "run-2", items);

    const funnel = formatFunnel(report);
    expect(funnel).toMatch(/extract.*skipped/i);
    expect(funnel).toMatch(/extracted/);
  });

  it("moves every candidate off `normalized` so the next run can tell work from done", async () => {
    const repo = new MemoryRepo();
    const items = [rawItem(1), rawItem(2)];
    await runOnce(repo, countingLlm(), "run-1", items);

    const statuses = (await repo.listCandidates({ cycleId: "2026-W35" })).map(
      (c: Candidate) => c.status,
    );
    expect(statuses).not.toContain("normalized");
    expect(statuses).toContain("in_issue");
  });

  it("still publishes the whole week when extract is skipped, not an empty issue", async () => {
    // The failure this guards is the tempting one: a skipped stage that reports success
    // and hands nothing on. `select` downstream would then build an issue out of zero
    // cards — the silently empty issue, arriving through the resume path instead of
    // through a broken source.
    const repo = new MemoryRepo();
    const llm = countingLlm();
    const items = [rawItem(1), rawItem(2)];

    const first = await runOnce(repo, llm, "run-1", items);
    const firstCards = (first.output as Issue).cardIds;
    expect(firstCards.length).toBeGreaterThan(0);

    const second = await runOnce(repo, llm, "run-2", items);
    expect((second.output as Issue).cardIds).toEqual(firstCards);
  });
});

describe("a cycle in which nothing survived the prefilter", () => {
  it("fails at extract rather than skipping it: nothing done is not the same as nothing left", async () => {
    // The one distinction the resume path exists to make. "No rows pending" is the same
    // number whether the work is finished or whether everything upstream was thrown away,
    // and a skip on the second reading turns a broken week into a quiet one. The run must
    // stop AT `extract`, naming it — not drift on to `select` and die there instead.
    const repo = new MemoryRepo();
    const llm = countingLlm();
    const denyEverything: Record<string, unknown> = {
      ...PROFILE,
      prefilter: { maxAgeDays: 3650, minBodyChars: 20, mustMatchAny: [], denyAny: ["Runner"] },
    };

    const ctx = runCtx(repo, llm, "run-1");
    await expect(
      runPipeline(
        buildStages(repo, denyEverything, stubIngest([rawItem(1), rawItem(2)]) as never),
        [],
        { ...ctx, profile: denyEverything },
      ),
    ).rejects.toThrow(/Stage "extract" received an empty input/);

    expect(llm.calls).toBe(0);
    // And it is recorded as a failure with the rows to look at, not as a completed run.
    expect(repo.stageEntries().find((e) => e.stage === "extract")).toBeUndefined();
    expect(repo.runEntries().at(-1)).toMatchObject({ status: "failed" });
  });
});
