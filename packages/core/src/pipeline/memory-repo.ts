/**
 * In-memory Repo.
 *
 * This is what lets `--fixtures --dry-run` need no database at all. A golden run that
 * talks to Postgres is not offline: it fails on a cold start, on a migration a neighbour
 * merged, and on a network that happens to be down — none of which say anything about the
 * pipeline. The interface is the same one the Prisma-backed repository implements.
 */

import type { Repo } from "./stage.js";
import type { Candidate, Card, Issue, RawItem } from "../types.js";

export class MemoryRepo implements Repo {
  private readonly rawItems = new Map<string, RawItem>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly cards = new Map<string, Card>();
  private issue: Issue | undefined;

  putRawItems(items: RawItem[]): Promise<RawItem[]> {
    // Keyed by (sourceKey, externalId), the same uniqueness the database enforces —
    // so a rerun is idempotent here for the same reason it is idempotent in production.
    for (const item of items) this.rawItems.set(`${item.sourceKey}|${item.externalId}`, item);
    return Promise.resolve(items);
  }
  listRawItems(): Promise<RawItem[]> {
    return Promise.resolve([...this.rawItems.values()]);
  }
  putCandidates(candidates: Candidate[]): Promise<Candidate[]> {
    for (const c of candidates) this.candidates.set(c.canonicalUrlHash, c);
    return Promise.resolve(candidates);
  }
  listCandidates(filter?: { status?: Candidate["status"] }): Promise<Candidate[]> {
    const all = [...this.candidates.values()];
    return Promise.resolve(filter?.status ? all.filter((c) => c.status === filter.status) : all);
  }
  putCards(cards: Card[]): Promise<Card[]> {
    for (const card of cards) this.cards.set(card.id, card);
    return Promise.resolve(cards);
  }
  listCards(): Promise<Card[]> {
    return Promise.resolve([...this.cards.values()]);
  }
  putIssue(issue: Issue): Promise<Issue> {
    this.issue = issue;
    return Promise.resolve(issue);
  }
  getIssue(): Issue | undefined {
    return this.issue;
  }
}
