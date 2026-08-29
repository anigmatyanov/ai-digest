/**
 * `Repo` backed by Postgres.
 *
 * Same interface as MemoryRepo, so no stage knows which one it is talking to — that is what
 * keeps the fixtures run offline while production persists.
 *
 * Every write is an upsert keyed on the same uniqueness the schema declares. That is the
 * whole point: a run killed between stages and restarted must not duplicate anything, and
 * the guarantee has to come from a constraint rather than from a check in code, because a
 * check races with itself the moment two ticks overlap.
 *
 * Dates cross this boundary as UTC ISO strings and live as `Date` inside the database, per
 * the project convention. The mapping is explicit in both directions rather than implicit,
 * so a missing conversion is a type error instead of a string that reaches Postgres.
 */

import type {
  Candidate,
  CandidateFilter,
  Card,
  CardFilter,
  Issue,
  RawItem,
  Repo,
  RunJournalEntry,
  StageJournalEntry,
} from "@ai-digest/core";
import { DatabaseUnavailableError, hostOf } from "./client.js";
import { Prisma } from "./generated/client.js";
import type { PrismaClient } from "./generated/client.js";

/** What the repository needs to know about the run's topic, snapshotted from the profile. */
export interface TopicIdentity {
  slug: string;
  title: string;
  lang: string;
  profileJson: unknown;
  profileHash: string;
}

/** A source as the profile declares it. Rows are reconciled at run start, not lazily. */
export interface SourceIdentity {
  key: string;
  kind: string;
  enabled: boolean;
  weight: number;
}

const iso = (d: Date): string => d.toISOString();
const at = (s: string | undefined): Date | null => (s === undefined ? null : new Date(s));
const isoOrUndefined = (d: Date | null): string | undefined => (d === null ? undefined : iso(d));

/**
 * Upsert arguments, built where they can be checked without a database.
 *
 * The idempotency of this product is not the queries below — it is their SHAPE: which unique
 * key each upsert matches on, what belongs to `create` alone, and what `update` must not
 * touch. None of that needs Postgres to verify, and while it lived inline inside the methods
 * the only proof it was right was a live-run transcript (E-007 `## Заметки`). Swapping
 * `where: { sourceId_externalId: … }` for `where: { id }` compiled, ran, and passed every
 * gate this repository had. As data, the same shape is asserted in prisma-repo.test.ts.
 *
 * These are pure: no client, no clock beyond what the caller already supplied as an ISO
 * string, no await.
 */

/**
 * Upsert arguments minus the projection knobs. This repository always reads whole rows, and
 * dropping `select`/`include`/`omit` from the declared type is what keeps the client's
 * result type the full model rather than a union that depends on a projection nobody passes.
 */
type UpsertShape<T> = Omit<T, "select" | "include" | "omit">;

/** Keyed on the slug, which is what a profile is identified by; the id is minted here. */
export function topicUpsertArgs(topic: TopicIdentity): UpsertShape<Prisma.TopicUpsertArgs> {
  const data = {
    title: topic.title,
    lang: topic.lang,
    profileJson: topic.profileJson as object,
    profileHash: topic.profileHash,
  };
  return {
    where: { slug: topic.slug },
    create: { ...data, slug: topic.slug },
    update: data,
  };
}

/** Keyed on (topicId, key): the same source key under two topics is two rows, not one. */
export function sourceUpsertArgs(
  topicId: string,
  source: SourceIdentity,
): UpsertShape<Prisma.SourceUpsertArgs> {
  const data = { kind: source.kind, enabled: source.enabled, weight: source.weight };
  return {
    where: { topicId_key: { topicId, key: source.key } },
    create: { ...data, topicId, key: source.key },
    // `cursor`, `health` and the failure counters are runtime state and are deliberately
    // NOT in `data`: reconciling configuration must not erase what the last run learned.
    // The silent-death detector reads exactly that history.
    update: data,
  };
}

/**
 * Keyed on (sourceId, externalId) — the constraint that makes ingest idempotent. On a
 * second run the row is found and updated in place, which is why a restart costs nothing
 * and creates nothing.
 *
 * No `id` in `create`, deliberately. An earlier version passed the pipeline's own
 * `raw-<sourceKey>-<externalId>`, which carries no topic while the unique key does: the
 * same item under two topics missed on `where`, fell through to `create`, and collided on
 * the primary key. References still resolve because `putRawItems` returns the persisted id.
 */
export function rawItemUpsertArgs(
  sourceId: string,
  item: RawItem,
): UpsertShape<Prisma.RawItemUpsertArgs> {
  const data = {
    url: item.url,
    title: item.title ?? null,
    author: item.author ?? null,
    publishedAt: at(item.publishedAt),
    body: item.body ?? null,
    bodyFormat: item.bodyFormat,
    lang: item.lang ?? null,
    signals: item.signals,
  };
  return {
    where: { sourceId_externalId: { sourceId, externalId: item.externalId } },
    // `fetchedAt` is create-only: it records when this item first reached us, and a rerun
    // that finds the row again has not re-fetched anything new.
    create: { ...data, sourceId, externalId: item.externalId, fetchedAt: new Date(item.fetchedAt) },
    update: data,
  };
}

/**
 * Keyed on (topicId, canonicalUrlHash) — the fold that turns five sources into one
 * candidate.
 *
 * No `id` in `create`, and that is the fix from the E-007 review rather than an omission.
 * The pipeline builds `cand-<first 12 hex of the canonical hash>`, which is a TRUNCATION of
 * the very key this upsert matches on, and it omits the topic that the key includes. Two
 * measured consequences: one article under two topics misses on `where` and collides on the
 * primary key, and 48 bits collide by birthday at around 24k candidates.
 */
export function candidateUpsertArgs(
  topicId: string,
  c: Candidate,
): UpsertShape<Prisma.CandidateUpsertArgs> {
  const data = {
    status: c.status,
    statusReason: c.statusReason ?? null,
    canonicalUrl: c.canonicalUrl,
    title: c.title,
    lang: c.lang ?? null,
    publishedAt: at(c.publishedAt),
    contentHash: c.contentHash,
    extractedText: c.extractedText,
    prefilterScore: c.prefilterScore ?? null,
    score: c.score ?? null,
    // Prisma distinguishes "JSON null" from "column is NULL"; a bare `null` is rejected by
    // the type precisely so the choice has to be made. We mean the column.
    scoreBreakdown: c.scoreBreakdown ?? Prisma.DbNull,
    duplicateOfId: c.duplicateOfId ?? null,
    cycleId: c.cycleId ?? null,
  };
  return {
    where: { topicId_canonicalUrlHash: { topicId, canonicalUrlHash: c.canonicalUrlHash } },
    create: {
      ...data,
      topicId,
      canonicalUrlHash: c.canonicalUrlHash,
      firstSeenAt: new Date(c.firstSeenAt),
    },
    // `firstSeenAt` is not updated: it records when this news first appeared, and the second
    // source carrying it does not make it newer.
    update: data,
  };
}

/**
 * Keyed on (candidateId, techniqueKey) rather than on the id the pipeline built: one
 * candidate yields one card per technique, and that is a fact about the domain rather than
 * about how `extract` happens to name things today.
 */
export function cardUpsertArgs(card: Card): UpsertShape<Prisma.CardUpsertArgs> {
  const data = {
    candidateId: card.candidateId,
    type: card.type,
    techniqueKey: card.techniqueKey,
    slug: card.slug,
    title: card.title,
    summary: card.summary,
    body: card.body,
    steps: card.steps,
    tags: card.tags,
    claims: card.claims as unknown as object,
    attribution: card.attribution as unknown as object,
    evidenceOk: card.evidenceOk,
    promptVersion: card.promptVersion,
  };
  return {
    where: {
      candidateId_techniqueKey: {
        candidateId: card.candidateId,
        techniqueKey: card.techniqueKey,
      },
    },
    create: { ...data, id: card.id },
    update: data,
  };
}

/** One issue per cycle, enforced by the unique key rather than by looking first. */
export function issueUpsertArgs(
  topicId: string,
  issue: Issue,
): UpsertShape<Prisma.IssueUpsertArgs> {
  const data = {
    number: issue.number,
    title: issue.title,
    intro: issue.intro,
    publishedAt: at(issue.publishedAt),
  };
  return {
    where: { topicId_cycleId: { topicId, cycleId: issue.cycleId } },
    create: { ...data, topicId, cycleId: issue.cycleId },
    update: data,
  };
}

/** Rows of the candidate→raw-item join. Order is the caller's; the table has no position. */
export function candidateRawItemRows(
  candidateId: string,
  rawItemIds: readonly string[],
): Prisma.CandidateRawItemCreateManyInput[] {
  return rawItemIds.map((rawItemId) => ({ candidateId, rawItemId }));
}

/**
 * Rows of the issue→card join. `position` is the index, so the order of `cardIds` IS the
 * order of the published issue — nothing else records it.
 */
export function issueCardRows(
  issueId: string,
  cardIds: readonly string[],
): Prisma.IssueCardCreateManyInput[] {
  return cardIds.map((cardId, position) => ({ issueId, cardId, position }));
}

/**
 * Prisma distinguishes "JSON null" from "the column is NULL" and rejects a bare null so the
 * choice has to be made. Every journal column here means the column.
 */
function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null ? Prisma.DbNull : value;
}

/**
 * A run attempt. `attempt` is supplied by the caller because it is derived from a COUNT of
 * existing rows, and a function that both counts and builds arguments could not be checked
 * without a database.
 *
 * NAMED LIMIT: two ticks that overlap can compute the same attempt and collide on
 * `@@unique([topicId, cycleId, attempt])`. That is the advisory lock's job, which is
 * explicitly out of this epic's scope; the collision is loud (a constraint violation naming
 * its constraint), not silent.
 */
export function pipelineRunCreateArgs(
  topicId: string,
  cycleId: string,
  attempt: number,
): Omit<Prisma.PipelineRunCreateArgs, "select" | "include" | "omit"> {
  return { data: { topicId, cycleId, attempt, status: "running" } };
}

/**
 * One stage of one run, keyed on `@@unique([runId, stage])`.
 *
 * `startedAt` is create-only: a stage that is retried inside the same run started when it
 * first started. `checkpoint` uses `Prisma.DbNull` rather than a bare null because Prisma
 * distinguishes "JSON null" from "the column is NULL", and we mean the column: a completed
 * stage has nothing to resume from.
 */
export function stageRunUpsertArgs(
  runRowId: string,
  entry: StageJournalEntry,
  finishedAt: Date,
): Omit<Prisma.StageRunUpsertArgs, "select" | "include" | "omit"> {
  const data = {
    status: entry.status,
    inputCount: entry.inputCount,
    outputCount: entry.outputCount,
    checkpoint: json(entry.checkpoint),
    error: entry.error ?? null,
    finishedAt,
  };
  return {
    where: { runId_stage: { runId: runRowId, stage: entry.stage } },
    create: { ...data, runId: runRowId, stage: entry.stage },
    update: data,
  };
}

/** Closing the run row. `metrics` is the funnel, which is why it is written at the end. */
export function pipelineRunFinishArgs(
  runRowId: string,
  entry: RunJournalEntry,
  finishedAt: Date,
): Omit<Prisma.PipelineRunUpdateArgs, "select" | "include" | "omit"> {
  return {
    where: { id: runRowId },
    data: {
      status: entry.status,
      finishedAt,
      // `metrics` is NOT nullable in the schema (it defaults to `{}`), so an absent one is
      // an empty object rather than a NULL column — DbNull is rejected here by the type.
      metrics: (entry.metrics ?? {}) as Prisma.InputJsonValue,
    },
  };
}

export class PrismaRepo implements Repo {
  /** sourceKey -> id. Populated by `open`, so no write path has to query for it. */
  private readonly sourceIds: ReadonlyMap<string, string>;

  /**
   * The runner's own run id -> the `pipeline_runs` row it belongs to.
   *
   * The runner names a run `run-<timestamp>` while the table keys on
   * (topicId, cycleId, attempt); nothing in the schema stores the runner's name, so the
   * association is held here for the life of the process. One entry in practice — a repo
   * instance serves one run — and a Map rather than a field so a second run id cannot
   * silently reuse the first run's row.
   */
  private readonly pipelineRunIds = new Map<string, string>();

  private constructor(
    private readonly prisma: PrismaClient,
    private readonly topicId: string,
    sourceIds: ReadonlyMap<string, string>,
  ) {
    this.sourceIds = sourceIds;
  }

  /**
   * Reconcile topic and source rows, then hand back a repository bound to them.
   *
   * Done once at run start rather than lazily on first write: a source row created halfway
   * through ingest would have no `itemsMedian` history, and the silent-death detector reads
   * exactly that history to tell "answered 200 with nothing" from "was never asked".
   */
  static async open(
    prisma: PrismaClient,
    topic: TopicIdentity,
    sources: readonly SourceIdentity[],
    connectionString?: string,
  ): Promise<PrismaRepo> {
    try {
      return await PrismaRepo.reconcile(prisma, topic, sources);
    } catch (error) {
      // Measured 2026-08-29 against an unreachable host: the adapter throws an `ErrorEvent`
      // whose `message` is the EMPTY STRING. Not a bad message — no message. A run would
      // die with a blank line and nothing to act on, so the first thing that touches the
      // database is wrapped here, where the host and the variable that supplied it are
      // still known.
      //
      // NAMED LIMIT: only this call is wrapped. A connection lost mid-run still surfaces as
      // the adapter's own error, because wrapping every query would bury the ones that
      // genuinely say something (constraint violations name their constraint).
      if (error instanceof DatabaseUnavailableError) throw error;
      // A Prisma error that carries a code is the database ANSWERING, not failing to
      // answer: an unapplied migration (P2021), a constraint violation, a bad column.
      // Wrapping those as "unreachable, you probably swapped the connection strings"
      // sends the reader to check the wrong thing entirely.
      if (typeof (error as { code?: unknown })?.code === "string") throw error;
      const detail = String((error as { message?: string })?.message ?? "").trim();
      throw new DatabaseUnavailableError(
        connectionString === undefined ? "<host not supplied to open()>" : hostOf(connectionString),
        "pooled (application)",
        detail === ""
          ? "The driver reported no message at all — the usual shape of an unreachable host."
          : detail,
      );
    }
  }

  private static async reconcile(
    prisma: PrismaClient,
    topic: TopicIdentity,
    sources: readonly SourceIdentity[],
  ): Promise<PrismaRepo> {
    const row = await prisma.topic.upsert(topicUpsertArgs(topic));

    const ids = new Map<string, string>();
    for (const source of sources) {
      const persisted = await prisma.source.upsert(sourceUpsertArgs(row.id, source));
      ids.set(source.key, persisted.id);
    }

    return new PrismaRepo(prisma, row.id, ids);
  }

  private sourceIdFor(sourceKey: string): string {
    const id = this.sourceIds.get(sourceKey);
    if (id === undefined) {
      throw new Error(
        `No source row for "${sourceKey}". Sources are reconciled from the profile at run ` +
          `start, so this means the item came from a source the profile does not declare — ` +
          `known: ${[...this.sourceIds.keys()].join(", ") || "(none)"}.`,
      );
    }
    return id;
  }

  async putRawItems(items: RawItem[]): Promise<RawItem[]> {
    const out: RawItem[] = [];
    for (const item of items) {
      const sourceId = this.sourceIdFor(item.sourceKey);
      const row = await this.prisma.rawItem.upsert(rawItemUpsertArgs(sourceId, item));
      // The persisted id is returned, not the one the caller generated: a candidate created
      // on the second run must reference the row that already exists.
      out.push({ ...item, id: row.id });
    }
    return out;
  }

  async listRawItems(): Promise<RawItem[]> {
    const rows = await this.prisma.rawItem.findMany({
      where: { source: { topicId: this.topicId } },
      include: { source: { select: { key: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      sourceKey: r.source.key,
      externalId: r.externalId,
      url: r.url,
      title: r.title ?? undefined,
      author: r.author ?? undefined,
      publishedAt: isoOrUndefined(r.publishedAt),
      body: r.body ?? undefined,
      bodyFormat: r.bodyFormat as RawItem["bodyFormat"],
      lang: r.lang ?? undefined,
      signals: r.signals as Record<string, number>,
      fetchedAt: iso(r.fetchedAt),
    }));
  }

  async putCandidates(candidates: Candidate[]): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const c of candidates) {
      const row = await this.prisma.candidate.upsert(candidateUpsertArgs(this.topicId, c));

      // The join is rewritten rather than merged: rawItemIds is the current, complete answer
      // to "what produced this candidate", and a merge would accumulate rows from a previous
      // run whose raw items may since have been folded elsewhere.
      //
      // In ONE transaction. Between the delete and the insert the candidate has no raw
      // items, and a failure there would leave a row that violates the domain schema's
      // `rawItemIds: z.array(...).min(1)` — data that type-checks and dies at a stage
      // boundary, which is precisely what this schema exists to prevent.
      await this.prisma.$transaction([
        this.prisma.candidateRawItem.deleteMany({ where: { candidateId: row.id } }),
        this.prisma.candidateRawItem.createMany({
          data: candidateRawItemRows(row.id, c.rawItemIds),
          skipDuplicates: true,
        }),
      ]);

      out.push({ ...c, id: row.id });
    }
    return out;
  }

  async listCandidates(filter?: CandidateFilter): Promise<Candidate[]> {
    const rows = await this.prisma.candidate.findMany({
      // Scoped to the cycle whenever the caller names one. Without it a resumed run reads
      // every candidate the topic has ever had, and "what is left to do this week" is
      // answered with the whole history. `@@index([topicId, status])` and `@@index([cycleId])`
      // already cover this; a composite index would need a migration and has not been earned.
      where: {
        topicId: this.topicId,
        ...(filter?.status !== undefined
          ? {
              status:
                typeof filter.status === "string"
                  ? filter.status
                  : { in: filter.status.map((v) => v) },
            }
          : {}),
        ...(filter?.cycleId ? { cycleId: filter.cycleId } : {}),
      },
      include: { rawItems: { select: { rawItemId: true } } },
      // Deterministic, and not for tidiness. Since E-011 the work `extract` does is the
      // FIRST `maxCandidatesToExtract` rows of this read, so an unordered `findMany` means
      // the cap picks arbitrary candidates and two runs over identical data can produce
      // different issues. Postgres guarantees no order without an ORDER BY, and it happily
      // returns insertion order right up until the day a row is updated.
      orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status as Candidate["status"],
      statusReason: r.statusReason ?? undefined,
      canonicalUrl: r.canonicalUrl,
      canonicalUrlHash: r.canonicalUrlHash,
      title: r.title,
      lang: r.lang ?? undefined,
      publishedAt: isoOrUndefined(r.publishedAt),
      firstSeenAt: iso(r.firstSeenAt),
      contentHash: r.contentHash,
      extractedText: r.extractedText,
      prefilterScore: r.prefilterScore ?? undefined,
      score: r.score ?? undefined,
      scoreBreakdown: (r.scoreBreakdown ?? undefined) as Record<string, number> | undefined,
      duplicateOfId: r.duplicateOfId ?? undefined,
      rawItemIds: r.rawItems.map((j) => j.rawItemId),
      cycleId: r.cycleId ?? undefined,
    }));
  }

  async putCards(cards: Card[]): Promise<Card[]> {
    const out: Card[] = [];
    for (const card of cards) {
      const row = await this.prisma.card.upsert(cardUpsertArgs(card));
      out.push({ ...card, id: row.id });
    }
    return out;
  }

  async listCards(filter?: CardFilter): Promise<Card[]> {
    const rows = await this.prisma.card.findMany({
      // A card has no cycle column; it belongs to the cycle of its candidate, so the scope
      // is expressed as a join rather than duplicated onto the card.
      where: {
        candidate: {
          topicId: this.topicId,
          ...(filter?.cycleId ? { cycleId: filter.cycleId } : {}),
        },
      },
      // The order of this read IS the order of the issue: `select` walks the cards in the
      // order it receives them and `issueCardRows` numbers them by index. Before E-011 that
      // order came from the array `extract` had just built; now it comes from here.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      candidateId: r.candidateId,
      type: r.type as Card["type"],
      techniqueKey: r.techniqueKey,
      slug: r.slug,
      title: r.title,
      summary: r.summary,
      body: r.body,
      steps: r.steps,
      tags: r.tags,
      claims: r.claims as unknown as Card["claims"],
      attribution: r.attribution as unknown as Card["attribution"],
      evidenceOk: r.evidenceOk,
      promptVersion: r.promptVersion,
    }));
  }

  async putIssue(issue: Issue): Promise<Issue> {
    const row = await this.prisma.issue.upsert(issueUpsertArgs(this.topicId, issue));

    // Same transaction, same reason. `skipDuplicates` because issue_cards carries a
    // unique key on (issueId, position) and a repeated card id in the input would
    // otherwise abort the whole rewrite.
    await this.prisma.$transaction([
      this.prisma.issueCard.deleteMany({ where: { issueId: row.id } }),
      this.prisma.issueCard.createMany({
        data: issueCardRows(row.id, issue.cardIds),
        skipDuplicates: true,
      }),
    ]);

    return { ...issue, id: row.id, createdAt: iso(row.createdAt) };
  }

  /**
   * Find or create the `pipeline_runs` row this journal entry belongs to.
   *
   * The attempt number is a COUNT of what is already there, which is why this is not an
   * upsert: there is no key to upsert on until the number is known.
   */
  private async pipelineRunId(runId: string, cycleId: string): Promise<string> {
    const known = this.pipelineRunIds.get(runId);
    if (known !== undefined) return known;
    const attempt =
      (await this.prisma.pipelineRun.count({ where: { topicId: this.topicId, cycleId } })) + 1;
    const row = await this.prisma.pipelineRun.create(
      pipelineRunCreateArgs(this.topicId, cycleId, attempt),
    );
    this.pipelineRunIds.set(runId, row.id);
    return row.id;
  }

  async recordStage(entry: StageJournalEntry): Promise<void> {
    const runRowId = await this.pipelineRunId(entry.runId, entry.cycleId);
    await this.prisma.stageRun.upsert(stageRunUpsertArgs(runRowId, entry, new Date()));
  }

  async recordRun(entry: RunJournalEntry): Promise<void> {
    const runRowId = await this.pipelineRunId(entry.runId, entry.cycleId);
    await this.prisma.pipelineRun.update(pipelineRunFinishArgs(runRowId, entry, new Date()));
  }
}
