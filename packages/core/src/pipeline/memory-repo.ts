/**
 * In-memory Repo.
 *
 * This is what lets `--fixtures --dry-run` need no database at all. A golden run that
 * talks to Postgres is not offline: it fails on a cold start, on a migration a neighbour
 * merged, and on a network that happens to be down — none of which say anything about the
 * pipeline. The interface is the same one the Prisma-backed repository implements.
 *
 * It lives for exactly one process, which is why the cycle filters below look like
 * ceremony here and are not: the same calls run against Postgres, where the topic's whole
 * history is on the other end. A filter that this implementation can afford to ignore is a
 * filter the pipeline stops passing, and then the production read is unscoped.
 */

import type {
  CandidateFilter,
  CardFilter,
  Repo,
  RunJournalEntry,
  StageJournalEntry,
} from "./stage.js";
import type { Candidate, Card, Issue, RawItem } from "../types.js";

export class MemoryRepo implements Repo {
  private readonly rawItems = new Map<string, RawItem>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly cards = new Map<string, Card>();
  private issue: Issue | undefined;
  private readonly stageJournal: StageJournalEntry[] = [];
  private readonly runJournal: RunJournalEntry[] = [];

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
  listCandidates(filter?: CandidateFilter): Promise<Candidate[]> {
    let rows = [...this.candidates.values()];
    if (filter?.status !== undefined) {
      const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
      rows = rows.filter((c) => wanted.includes(c.status));
    }
    if (filter?.cycleId !== undefined) rows = rows.filter((c) => c.cycleId === filter.cycleId);
    return Promise.resolve(rows);
  }
  putCards(cards: Card[]): Promise<Card[]> {
    for (const card of cards) this.cards.set(card.id, card);
    return Promise.resolve(cards);
  }
  listCards(filter?: CardFilter): Promise<Card[]> {
    const rows = [...this.cards.values()];
    if (filter?.cycleId === undefined) return Promise.resolve(rows);
    // A card has no cycle of its own; it belongs to the cycle of the candidate it was
    // written from. The database answers this with a join, and so does this.
    const inCycle = new Set(
      [...this.candidates.values()].filter((c) => c.cycleId === filter.cycleId).map((c) => c.id),
    );
    return Promise.resolve(rows.filter((card) => inCycle.has(card.candidateId)));
  }
  putIssue(issue: Issue): Promise<Issue> {
    this.issue = issue;
    return Promise.resolve(issue);
  }
  getIssue(): Issue | undefined {
    return this.issue;
  }

  /** Keyed the way `@@unique([runId, stage])` keys it, so a retry overwrites its attempt. */
  recordStage(entry: StageJournalEntry): Promise<void> {
    const at = this.stageJournal.findIndex(
      (e) => e.runId === entry.runId && e.stage === entry.stage,
    );
    if (at >= 0) this.stageJournal[at] = entry;
    else this.stageJournal.push(entry);
    return Promise.resolve();
  }
  recordRun(entry: RunJournalEntry): Promise<void> {
    this.runJournal.push(entry);
    return Promise.resolve();
  }
  /** Read back by tests and by nothing else; the run report is the production reader. */
  stageEntries(): readonly StageJournalEntry[] {
    return this.stageJournal;
  }
  runEntries(): readonly RunJournalEntry[] {
    return this.runJournal;
  }
}
