/**
 * What this file gates: the SHAPE of every write `PrismaRepo` makes.
 *
 * The whole idempotency of the product is which unique key each upsert matches on, what
 * belongs to `create` alone, what `update` must not touch, and which id comes back out.
 * Until this file existed the only proof of any of it was a live-run transcript in the
 * notes of E-007 — a demonstration, not a gate. Swapping
 * `where: { sourceId_externalId: … }` for `where: { id }` compiled, ran, and passed
 * `pnpm verify` green.
 *
 * What this file deliberately does NOT test: Prisma, and Postgres. That a unique index is
 * honoured is the database's job and it does not need our test; that we asked for the right
 * index is ours, and nothing else was asking.
 *
 * Two mechanisms, chosen per property:
 *
 *   - Argument shape is plain data, so it is built by pure functions in prisma-repo.ts and
 *     asserted here directly. No client involved.
 *   - Two properties are not arguments at all — "the join rewrite happens in ONE
 *     transaction" and "the persisted id is what comes back" — and those need a stand-in
 *     that records calls. It covers exactly the fourteen entry points this repository
 *     touches, which is a recorder, not a description of Prisma Client.
 */

import { describe, expect, it } from "vitest";
import type { Candidate, Card, Issue, RawItem } from "@ai-digest/core";
import { Prisma } from "./generated/client.js";
import type { PrismaClient } from "./generated/client.js";
import {
  candidateRawItemRows,
  candidateUpsertArgs,
  cardUpsertArgs,
  issueCardRows,
  issueUpsertArgs,
  PrismaRepo,
  rawItemUpsertArgs,
  sourceUpsertArgs,
  topicUpsertArgs,
} from "./prisma-repo.js";
import type { SourceIdentity, TopicIdentity } from "./prisma-repo.js";

// ─────────────────────────────── fixtures ───────────────────────────────

const TOPIC: TopicIdentity = {
  slug: "ai",
  title: "AI Digest",
  lang: "ru",
  profileJson: { slug: "ai" },
  profileHash: "a".repeat(64),
};

const SOURCE: SourceIdentity = { key: "hn", kind: "rss", enabled: true, weight: 1.5 };

/** `id` is the one the pipeline built. It must not survive contact with the database. */
const RAW: RawItem = {
  id: "raw-hn-42",
  sourceKey: "hn",
  externalId: "42",
  url: "https://example.com/a",
  title: "A title",
  author: "someone",
  publishedAt: "2026-08-20T00:00:00.000Z",
  body: "body text",
  bodyFormat: "text",
  lang: "en",
  signals: { points: 10 },
  fetchedAt: "2026-08-25T00:00:00.000Z",
};

const HASH = "b".repeat(64);

const CAND: Candidate = {
  id: "cand-bbbbbbbbbbbb",
  status: "scored",
  canonicalUrl: "https://example.com/a",
  canonicalUrlHash: HASH,
  title: "A title",
  lang: "en",
  publishedAt: "2026-08-20T00:00:00.000Z",
  firstSeenAt: "2026-08-25T00:00:00.000Z",
  contentHash: "c".repeat(64),
  extractedText: "text",
  prefilterScore: 0.4,
  score: 0.8,
  scoreBreakdown: { freshness: 0.5 },
  rawItemIds: ["rawItem-db-1", "rawItem-db-2"],
  cycleId: "2026-W35",
};

const CARD: Card = {
  id: "card-1",
  candidateId: "candidate-db-1",
  type: "recipe",
  techniqueKey: "vendor/area/technique",
  slug: "a-card",
  title: "Card",
  summary: "Summary",
  body: "Body",
  steps: ["one"],
  tags: ["tag"],
  claims: [
    { text: "t1", quote: "q1", sourceUrl: "https://example.com/a", verified: true },
    { text: "t2", quote: "q2", sourceUrl: "https://example.com/a", verified: true },
  ],
  attribution: { sourceName: "Example", sourceUrl: "https://example.com/a" },
  evidenceOk: true,
  promptVersion: "v1",
};

const ISSUE: Issue = {
  id: "issue-2026-W35",
  topicSlug: "ai",
  cycleId: "2026-W35",
  number: 7,
  title: "Issue 7",
  intro: "Intro",
  cardIds: ["card-db-1", "card-db-2"],
  createdAt: "2026-08-26T00:00:00.000Z",
};

/** Prisma's create/update inputs are XOR unions; a test only ever reads them as data. */
const data = (o: unknown): Record<string, unknown> => o as Record<string, unknown>;

// ────────────────────── the unique key every upsert matches on ──────────────────────

interface UpsertCase {
  /** Named so the failure says which method lost its idempotency. */
  method: string;
  args: { where: object; create: object; update: object };
  key: string;
  value: unknown;
}

const UPSERTS: readonly UpsertCase[] = [
  {
    method: "PrismaRepo.open → topics",
    args: topicUpsertArgs(TOPIC),
    key: "slug",
    value: "ai",
  },
  {
    method: "PrismaRepo.open → sources",
    args: sourceUpsertArgs("topic-1", SOURCE),
    key: "topicId_key",
    value: { topicId: "topic-1", key: "hn" },
  },
  {
    method: "putRawItems → raw_items",
    args: rawItemUpsertArgs("source-1", RAW),
    key: "sourceId_externalId",
    value: { sourceId: "source-1", externalId: "42" },
  },
  {
    method: "putCandidates → candidates",
    args: candidateUpsertArgs("topic-1", CAND),
    key: "topicId_canonicalUrlHash",
    value: { topicId: "topic-1", canonicalUrlHash: HASH },
  },
  {
    method: "putCards → cards",
    args: cardUpsertArgs(CARD),
    key: "candidateId_techniqueKey",
    value: { candidateId: "candidate-db-1", techniqueKey: "vendor/area/technique" },
  },
  {
    method: "putIssue → issues",
    args: issueUpsertArgs("topic-1", ISSUE),
    key: "topicId_cycleId",
    value: { topicId: "topic-1", cycleId: "2026-W35" },
  },
];

for (const c of UPSERTS) {
  describe(c.method, () => {
    // The defect this exists for, stated as a test: `where: { id }` compiles, because the
    // primary key is also a unique input. It just stops deduplicating anything.
    it("matches on the schema's unique key, never on the primary key", () => {
      expect(Object.keys(c.args.where)).toEqual([c.key]);
    });

    it("carries every column of that key", () => {
      expect(data(c.args.where)[c.key]).toEqual(c.value);
    });

    // An `id` in `update` rewrites the primary key of a row other rows already reference.
    it("never rewrites the primary key on update", () => {
      expect(Object.keys(c.args.update)).not.toContain("id");
    });
  });
}

// ───────────────────────── create against update, per table ─────────────────────────

describe("topicUpsertArgs", () => {
  it("writes the slug on create and leaves it alone afterwards", () => {
    const args = topicUpsertArgs(TOPIC);
    expect(data(args.create).slug).toBe("ai");
    expect(Object.keys(args.update)).not.toContain("slug");
  });

  it("snapshots the profile and its hash on every reconcile", () => {
    expect(data(topicUpsertArgs(TOPIC).update)).toMatchObject({
      profileJson: { slug: "ai" },
      profileHash: "a".repeat(64),
    });
  });
});

describe("sourceUpsertArgs", () => {
  // The invariant the schema comment claims and nothing was checking: reconciling
  // configuration must not erase what the last run learned. `consecutiveFailures` and
  // `itemsMedian` are what the silent-death detector reads to tell "answered 200 with
  // nothing" from "was never asked"; resetting them would blind it once a week.
  it("updates configuration only, never the source's runtime state", () => {
    expect(Object.keys(sourceUpsertArgs("topic-1", SOURCE).update).sort()).toEqual([
      "enabled",
      "kind",
      "weight",
    ]);
  });

  it("binds the source to the topic on create", () => {
    expect(data(sourceUpsertArgs("topic-1", SOURCE).create)).toMatchObject({
      topicId: "topic-1",
      key: "hn",
    });
  });
});

describe("rawItemUpsertArgs", () => {
  // `raw-<sourceKey>-<externalId>` carries no topic while the unique key does. Passing it
  // as the primary key made the same item under two topics miss on `where`, fall through
  // to `create`, and collide on the id.
  it("lets the database mint the id", () => {
    expect(Object.keys(rawItemUpsertArgs("source-1", RAW).create)).not.toContain("id");
  });

  it("writes identity and fetchedAt on create only", () => {
    const args = rawItemUpsertArgs("source-1", RAW);
    expect(Object.keys(args.create)).toEqual(
      expect.arrayContaining(["sourceId", "externalId", "fetchedAt"]),
    );
    for (const createOnly of ["sourceId", "externalId", "fetchedAt"]) {
      expect(Object.keys(args.update)).not.toContain(createOnly);
    }
  });

  it("crosses the boundary as Date, having arrived as an ISO string", () => {
    const args = rawItemUpsertArgs("source-1", RAW);
    expect(data(args.create).fetchedAt).toEqual(new Date("2026-08-25T00:00:00.000Z"));
    expect(data(args.update).publishedAt).toEqual(new Date("2026-08-20T00:00:00.000Z"));
  });

  // An optional that went away upstream has to become a NULL column, not a missing key:
  // a missing key leaves yesterday's author on the row forever.
  it("turns an absent optional into a NULL column rather than into a missing key", () => {
    const { author: _a, publishedAt: _p, title: _t, ...stripped } = RAW;
    const args = rawItemUpsertArgs("source-1", stripped);
    expect(data(args.update)).toMatchObject({ author: null, publishedAt: null, title: null });
  });
});

describe("candidateUpsertArgs", () => {
  // `cand-<first 12 hex of the canonical hash>` is a truncation of the very key this
  // upsert matches on, minus the topic the key includes. 48 bits collide by birthday at
  // around 24k candidates.
  it("lets the database mint the id", () => {
    expect(Object.keys(candidateUpsertArgs("topic-1", CAND).create)).not.toContain("id");
  });

  it("keeps the key columns and firstSeenAt out of update", () => {
    const args = candidateUpsertArgs("topic-1", CAND);
    for (const createOnly of ["topicId", "canonicalUrlHash", "firstSeenAt"]) {
      expect(Object.keys(args.create)).toContain(createOnly);
      expect(Object.keys(args.update)).not.toContain(createOnly);
    }
  });

  // Prisma tells "JSON null" apart from "the column is NULL". We mean the column; the
  // other one writes the four characters `null` into the JSON and reads back as a value.
  it("means the column, not a JSON null, when there is no score breakdown", () => {
    const { scoreBreakdown: _s, ...noBreakdown } = CAND;
    const args = candidateUpsertArgs("topic-1", noBreakdown);
    expect(data(args.update).scoreBreakdown).toBe(Prisma.DbNull);
    expect(data(args.update).scoreBreakdown).not.toBeNull();
  });

  it("passes the breakdown through when there is one", () => {
    expect(data(candidateUpsertArgs("topic-1", CAND).update).scoreBreakdown).toEqual({
      freshness: 0.5,
    });
  });
});

describe("cardUpsertArgs", () => {
  it("keys on the domain fact — one card per candidate per technique", () => {
    expect(data(cardUpsertArgs(CARD).where).candidateId_techniqueKey).toEqual({
      candidateId: "candidate-db-1",
      techniqueKey: "vendor/area/technique",
    });
  });

  // Recorded as it is today, not endorsed: cards are the one table whose primary key still
  // comes from the pipeline, and `extract` builds `card-<candidateId>` without the technique
  // that the unique key includes. One card per candidate today, a primary-key collision the
  // day there are two. Filed as E-013a — outside this epic's file map as a behaviour change.
  it("carries the pipeline's id into create", () => {
    expect(data(cardUpsertArgs(CARD).create).id).toBe("card-1");
  });
});

describe("issueUpsertArgs", () => {
  it("keeps the cycle out of update: an issue does not change weeks", () => {
    const args = issueUpsertArgs("topic-1", ISSUE);
    expect(data(args.create).cycleId).toBe("2026-W35");
    expect(Object.keys(args.update)).not.toContain("cycleId");
  });
});

describe("join-table rows", () => {
  it("links every raw item the candidate was built from", () => {
    expect(candidateRawItemRows("candidate-db-1", ["r1", "r2"])).toEqual([
      { candidateId: "candidate-db-1", rawItemId: "r1" },
      { candidateId: "candidate-db-1", rawItemId: "r2" },
    ]);
  });

  // The order of `cardIds` IS the order of the published issue. Nothing else records it.
  it("numbers issue cards from the order they were given, starting at zero", () => {
    expect(issueCardRows("issue-db-1", ["c1", "c2", "c3"])).toEqual([
      { issueId: "issue-db-1", cardId: "c1", position: 0 },
      { issueId: "issue-db-1", cardId: "c2", position: 1 },
      { issueId: "issue-db-1", cardId: "c3", position: 2 },
    ]);
  });
});

// ───────────────────── a recorder for what arguments cannot show ─────────────────────

interface Op {
  model: string;
  method: string;
  args: Record<string, unknown>;
}

interface Recorded extends Op {
  /** true when the op reached the database inside `$transaction` rather than on its own. */
  batched: boolean;
}

/**
 * Awaitable, and also passable to `$transaction` unawaited — and that difference is the
 * whole gate. A real PrismaPromise behaves the same way: `$transaction` takes the promises
 * unawaited and runs them as one statement, so splitting the rewrite into two `await`s is
 * observable here exactly as it is observable in Postgres.
 */
interface PendingOp<T> extends PromiseLike<T> {
  readonly op: Op;
  readonly value: T;
}

interface FakeModel {
  upsert: (args: Record<string, unknown>) => PendingOp<Record<string, unknown>>;
  findMany: (args: Record<string, unknown>) => PendingOp<unknown[]>;
  deleteMany: (args: Record<string, unknown>) => PendingOp<{ count: number }>;
  createMany: (args: Record<string, unknown>) => PendingOp<{ count: number }>;
}

/** Fixed so a row's `createdAt` is an assertable value rather than the wall clock. */
const ROW_CREATED_AT = new Date("2026-08-26T00:00:00.000Z");

class FakePrisma {
  readonly calls: Recorded[] = [];
  /** Rows `findMany` should hand back, by model name. */
  readonly rows: Record<string, unknown[]> = {};
  private readonly seq = new Map<string, number>();

  readonly topic = this.model("topic");
  readonly source = this.model("source");
  readonly rawItem = this.model("rawItem");
  readonly candidate = this.model("candidate");
  readonly candidateRawItem = this.model("candidateRawItem");
  readonly card = this.model("card");
  readonly issue = this.model("issue");
  readonly issueCard = this.model("issueCard");

  readonly $transaction = (ops: readonly PendingOp<unknown>[]): Promise<unknown[]> => {
    this.calls.push({
      model: "$transaction",
      method: "$transaction",
      args: { ops: ops.map((o) => `${o.op.model}.${o.op.method}`) },
      batched: false,
    });
    for (const o of ops) this.calls.push({ ...o.op, batched: true });
    return Promise.resolve(ops.map((o) => o.value));
  };

  /** Typed as what PrismaRepo expects; the cast is confined to this file. */
  asClient(): PrismaClient {
    return this as unknown as PrismaClient;
  }

  /** Every recorded call against one model, in the order it was made. */
  of(model: string): Recorded[] {
    return this.calls.filter((c) => c.model === model);
  }

  /** Arguments of the one call to `model.method`; fails loudly if there was not exactly one. */
  argsOf(model: string, method: string): Record<string, unknown> {
    const found = this.calls.filter((c) => c.model === model && c.method === method);
    if (found.length !== 1) {
      throw new Error(`expected exactly one ${model}.${method}, saw ${found.length}`);
    }
    return found[0]!.args;
  }

  private model(name: string): FakeModel {
    return {
      upsert: (args) => this.pending(name, "upsert", args, this.nextRow(name)),
      findMany: (args) => this.pending(name, "findMany", args, this.rows[name] ?? []),
      deleteMany: (args) => this.pending(name, "deleteMany", args, { count: 0 }),
      createMany: (args) => this.pending(name, "createMany", args, { count: 0 }),
    };
  }

  private nextRow(name: string): Record<string, unknown> {
    const n = (this.seq.get(name) ?? 0) + 1;
    this.seq.set(name, n);
    return { id: `${name}-db-${n}`, createdAt: ROW_CREATED_AT };
  }

  private pending<T>(
    model: string,
    method: string,
    args: Record<string, unknown>,
    value: T,
  ): PendingOp<T> {
    const op: Op = { model, method, args };
    const calls = this.calls;
    return {
      op,
      value,
      then<R1 = T, R2 = never>(
        onfulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
        onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
      ): PromiseLike<R1 | R2> {
        calls.push({ ...op, batched: false });
        return Promise.resolve(value).then(onfulfilled, onrejected);
      },
    };
  }
}

const openRepo = async (fake: FakePrisma): Promise<PrismaRepo> =>
  PrismaRepo.open(fake.asClient(), TOPIC, [SOURCE]);

// ───────────────────────────── what comes back out ─────────────────────────────

describe("the persisted id is what the run keeps referencing", () => {
  // Every reference inside a run — candidate → raw items, issue → cards — is resolved from
  // what these methods return. Returning the caller's own id looks fine until the second
  // run, when the row already exists under a different id and every foreign key breaks.
  it("putRawItems returns the row's id, not the one the pipeline built", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    const out = await repo.putRawItems([RAW, { ...RAW, externalId: "43" }]);
    expect(out.map((i) => i.id)).toEqual(["rawItem-db-1", "rawItem-db-2"]);
    expect(out[0]!.id).not.toBe(RAW.id);
  });

  it("putCandidates returns the row's id", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    const [out] = await repo.putCandidates([CAND]);
    expect(out!.id).toBe("candidate-db-1");
    expect(out!.id).not.toBe(CAND.id);
  });

  it("putCards returns the row's id", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    const [out] = await repo.putCards([CARD]);
    expect(out!.id).toBe("card-db-1");
  });

  it("putIssue returns the row's id and the row's createdAt as an ISO string", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    const out = await repo.putIssue(ISSUE);
    expect(out.id).toBe("issue-db-1");
    expect(out.createdAt).toBe("2026-08-26T00:00:00.000Z");
  });

  it("keys raw items on the source id reconciled at open, not on the source key", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    await repo.putRawItems([RAW]);
    expect(data(fake.argsOf("rawItem", "upsert").where).sourceId_externalId).toEqual({
      sourceId: "source-db-1",
      externalId: "42",
    });
  });

  it("refuses an item from a source the profile does not declare, naming what it knows", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    await expect(repo.putRawItems([{ ...RAW, sourceKey: "nope" }])).rejects.toThrow(/known: hn/);
  });
});

// ───────────────────────────── the join rewrite ─────────────────────────────

describe("rewriting a join table leaves no window", () => {
  // Between the delete and the insert the candidate has no raw items. A failure there
  // leaves a row that violates `rawItemIds: z.array(...).min(1)` — data that type-checks
  // and dies at a stage boundary. Two separate queries compile and pass every other test;
  // only the shape of the call says whether the window exists.
  it("putCandidates deletes and recreates candidate_raw_items in ONE transaction", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    await repo.putCandidates([CAND]);

    const transactions = fake.calls.filter((c) => c.method === "$transaction");
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.args.ops).toEqual([
      "candidateRawItem.deleteMany",
      "candidateRawItem.createMany",
    ]);
    expect(fake.of("candidateRawItem").map((c) => c.batched)).toEqual([true, true]);
  });

  it("putCandidates scopes the delete to the candidate and links every raw item", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    await repo.putCandidates([CAND]);

    const [del, create] = fake.of("candidateRawItem");
    expect(del!.args.where).toEqual({ candidateId: "candidate-db-1" });
    expect(create!.args.data).toEqual([
      { candidateId: "candidate-db-1", rawItemId: "rawItem-db-1" },
      { candidateId: "candidate-db-1", rawItemId: "rawItem-db-2" },
    ]);
    expect(create!.args.skipDuplicates).toBe(true);
  });

  it("putIssue deletes and recreates issue_cards in ONE transaction, in order", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    await repo.putIssue(ISSUE);

    const transactions = fake.calls.filter((c) => c.method === "$transaction");
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.args.ops).toEqual(["issueCard.deleteMany", "issueCard.createMany"]);
    expect(fake.of("issueCard").map((c) => c.batched)).toEqual([true, true]);

    const [del, create] = fake.of("issueCard");
    expect(del!.args.where).toEqual({ issueId: "issue-db-1" });
    expect(create!.args.data).toEqual([
      { issueId: "issue-db-1", cardId: "card-db-1", position: 0 },
      { issueId: "issue-db-1", cardId: "card-db-2", position: 1 },
    ]);
    // issue_cards is unique on (issueId, position); a repeated card id in the input would
    // otherwise abort the whole rewrite.
    expect(create!.args.skipDuplicates).toBe(true);
  });
});

// ───────────────────────────── reads stay inside the topic ─────────────────────────────

describe("every read is scoped to the run's topic", () => {
  // A missing scope is invisible with one topic in the database and silently merges two
  // digests the moment a second profile exists — which is the point of the second profile.
  it("listRawItems joins through the source's topic", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    await repo.listRawItems();
    expect(fake.argsOf("rawItem", "findMany").where).toEqual({
      source: { topicId: "topic-db-1" },
    });
  });

  it("listCards joins through the candidate's topic", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    await repo.listCards();
    expect(fake.argsOf("card", "findMany").where).toEqual({
      candidate: { topicId: "topic-db-1" },
    });
  });

  it("listCandidates adds the status filter only when one was asked for", async () => {
    const fake = new FakePrisma();
    const repo = await openRepo(fake);
    await repo.listCandidates();
    expect(fake.of("candidate").at(-1)!.args.where).toEqual({ topicId: "topic-db-1" });
    await repo.listCandidates({ status: "scored" });
    expect(fake.of("candidate").at(-1)!.args.where).toEqual({
      topicId: "topic-db-1",
      status: "scored",
    });
  });

  it("maps a row back across the boundary: Date to ISO string, NULL to absent", async () => {
    const fake = new FakePrisma();
    fake.rows.rawItem = [
      {
        id: "rawItem-db-1",
        externalId: "42",
        url: "https://example.com/a",
        title: null,
        author: null,
        publishedAt: null,
        body: null,
        bodyFormat: "text",
        lang: null,
        signals: { points: 10 },
        fetchedAt: new Date("2026-08-25T00:00:00.000Z"),
        source: { key: "hn" },
      },
    ];
    const repo = await openRepo(fake);
    const [item] = await repo.listRawItems();
    expect(item!.fetchedAt).toBe("2026-08-25T00:00:00.000Z");
    expect(item!.sourceKey).toBe("hn");
    expect(item!.title).toBeUndefined();
    expect(item!.publishedAt).toBeUndefined();
  });
});

// ───────────────────────────── the test run opens nothing ─────────────────────────────

describe("no connection is opened by this suite", () => {
  // The reason this assertion lives in a test file at all: the fetch stub in
  // test/setup/no-network.ts never covered the database. PrismaNeon reaches Postgres over
  // a WebSocket — `@neondatabase/serverless` 1.1.0 opens it as `new WebSocket(url)` — so
  // a test that accidentally touched a real client connected for real and nothing said so.
  // Removing the WebSocket stub from the setup file turns this red.
  //
  // The URL is loopback on purpose. The day this guard regresses, this is the one test that
  // constructs a socket, and it must not be the leak it exists to prevent: 127.0.0.1 is
  // refused locally and nothing leaves the machine.
  it("the network guard refuses a WebSocket, naming the URL", () => {
    expect(() => new WebSocket("ws://127.0.0.1:9/neon")).toThrowError(
      /Network access from a test is forbidden: ws:\/\/127\.0\.0\.1:9\/neon/,
    );
  });

  // Nothing above ever constructs a PrismaClient: every repository test runs against the
  // recorder. The suite therefore needs neither DATABASE_URL nor a socket of any kind.
  it("the repository under test never saw a real client", () => {
    const fake = new FakePrisma();
    expect(fake.asClient()).toBeInstanceOf(FakePrisma);
  });
});
