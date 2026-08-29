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

import type { Candidate, Card, Issue, RawItem, Repo } from "@ai-digest/core";
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

export class PrismaRepo implements Repo {
  /** sourceKey -> id. Populated by `open`, so no write path has to query for it. */
  private readonly sourceIds: ReadonlyMap<string, string>;

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
    const row = await prisma.topic.upsert({
      where: { slug: topic.slug },
      create: {
        slug: topic.slug,
        title: topic.title,
        lang: topic.lang,
        profileJson: topic.profileJson as object,
        profileHash: topic.profileHash,
      },
      update: {
        title: topic.title,
        lang: topic.lang,
        profileJson: topic.profileJson as object,
        profileHash: topic.profileHash,
      },
    });

    const ids = new Map<string, string>();
    for (const source of sources) {
      const persisted = await prisma.source.upsert({
        where: { topicId_key: { topicId: row.id, key: source.key } },
        create: {
          topicId: row.id,
          key: source.key,
          kind: source.kind,
          enabled: source.enabled,
          weight: source.weight,
        },
        // `cursor`, `health` and the failure counters are runtime state and are deliberately
        // NOT reset here: reconciling configuration must not erase what the last run learned.
        update: { kind: source.kind, enabled: source.enabled, weight: source.weight },
      });
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
      // The unique key does the deduplication. On a second run the row is found and
      // updated in place, which is why a restart costs nothing and creates nothing.
      const row = await this.prisma.rawItem.upsert({
        where: { sourceId_externalId: { sourceId, externalId: item.externalId } },
        // The database mints the id. An earlier version passed the pipeline's own
        // `raw-<sourceKey>-<externalId>`, which carries no topic while the unique key
        // does: the same item under two topics missed on `where`, fell through to
        // `create`, and collided on the primary key. References still resolve because
        // the persisted id is what this method returns.
        create: {
          ...data,
          sourceId,
          externalId: item.externalId,
          fetchedAt: new Date(item.fetchedAt),
        },
        update: data,
      });
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
        // Prisma distinguishes "JSON null" from "column is NULL"; a bare `null` is
        // rejected by the type precisely so the choice has to be made. We mean the column.
        scoreBreakdown: c.scoreBreakdown ?? Prisma.DbNull,
        duplicateOfId: c.duplicateOfId ?? null,
        cycleId: c.cycleId ?? null,
      };
      const row = await this.prisma.candidate.upsert({
        where: {
          topicId_canonicalUrlHash: {
            topicId: this.topicId,
            canonicalUrlHash: c.canonicalUrlHash,
          },
        },
        create: {
          ...data,
          // No `id` here, deliberately. The pipeline builds `cand-<first 12 hex of the
          // canonical hash>`, which is a TRUNCATION of the very key this upsert matches
          // on — and it omits the topic that the key includes. Two consequences, both
          // measured in review: one article under two topics misses on `where` and
          // collides on the primary key, and 48 bits collide by birthday at around 24k
          // candidates. The database mints the id; downstream references resolve because
          // this method returns the persisted row's id.
          topicId: this.topicId,
          canonicalUrlHash: c.canonicalUrlHash,
          firstSeenAt: new Date(c.firstSeenAt),
        },
        // firstSeenAt is not updated: it records when this news first appeared, and the
        // second source carrying it does not make it newer.
        update: data,
      });

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
          data: c.rawItemIds.map((rawItemId) => ({ candidateId: row.id, rawItemId })),
          skipDuplicates: true,
        }),
      ]);

      out.push({ ...c, id: row.id });
    }
    return out;
  }

  async listCandidates(filter?: { status?: Candidate["status"] }): Promise<Candidate[]> {
    const rows = await this.prisma.candidate.findMany({
      where: { topicId: this.topicId, ...(filter?.status ? { status: filter.status } : {}) },
      include: { rawItems: { select: { rawItemId: true } } },
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
      const row = await this.prisma.card.upsert({
        // Keyed on (candidateId, techniqueKey) rather than on the id the pipeline built:
        // one candidate yields one card per technique, and that is a fact about the domain
        // rather than about how `extract` happens to name things today.
        where: {
          candidateId_techniqueKey: {
            candidateId: card.candidateId,
            techniqueKey: card.techniqueKey,
          },
        },
        create: { ...data, id: card.id },
        update: data,
      });
      out.push({ ...card, id: row.id });
    }
    return out;
  }

  async listCards(): Promise<Card[]> {
    const rows = await this.prisma.card.findMany({
      where: { candidate: { topicId: this.topicId } },
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
    const data = {
      number: issue.number,
      title: issue.title,
      intro: issue.intro,
      publishedAt: at(issue.publishedAt),
    };
    // One issue per cycle, enforced by the unique key rather than by looking first.
    const row = await this.prisma.issue.upsert({
      where: { topicId_cycleId: { topicId: this.topicId, cycleId: issue.cycleId } },
      create: { ...data, topicId: this.topicId, cycleId: issue.cycleId },
      update: data,
    });

    // Same transaction, same reason. `skipDuplicates` because issue_cards carries a
    // unique key on (issueId, position) and a repeated card id in the input would
    // otherwise abort the whole rewrite.
    await this.prisma.$transaction([
      this.prisma.issueCard.deleteMany({ where: { issueId: row.id } }),
      this.prisma.issueCard.createMany({
        data: issue.cardIds.map((cardId, position) => ({ issueId: row.id, cardId, position })),
        skipDuplicates: true,
      }),
    ]);

    return { ...issue, id: row.id, createdAt: iso(row.createdAt) };
  }
}
