/**
 * Stage contract.
 *
 * A stage is a pure function `(input, ctx) => output`. It does not know where its input
 * came from or where the output goes, and it reaches storage and models only through
 * `ctx` — that is what makes a golden run reproducible offline. An `if (source === "…")`
 * inside a stage is a defect (CLAUDE.md § pipeline).
 */

import { DigestError } from "../errors.js";
import type { Candidate, Card, Issue, RawItem } from "../types.js";

/**
 * What a read of the repository is allowed to narrow to.
 *
 * `cycleId` is not a convenience. A repository holds the whole history of its topic, while
 * a run owns one cycle, and resuming work by row status means asking "what is left in THIS
 * week" — an unscoped read answers with every week ever run and the second issue quietly
 * republishes the first one's cards. Found while E-013 was writing the repository's tests;
 * see the notes of E-011.
 */
export interface CandidateFilter {
  /**
   * One status, or the set of them a caller means. The set exists because "which rows is
   * this stage already past" is rarely one status: `extract` leaves a candidate as
   * `extracted`, and the stages after it move that same row on again.
   */
  status?: Candidate["status"] | readonly Candidate["status"][];
  cycleId?: string;
}

/** Cards carry no cycle of their own; a repository scopes them through their candidate. */
export interface CardFilter {
  cycleId?: string;
}

/**
 * One stage attempt, as the journal records it.
 *
 * `checkpoint` is the answer to "restart from where": for a stage that selects rows by
 * status it is the rows that were still pending when the stage stopped. `status: "failed"`
 * carries the reason in `error`, which is what tells a restart apart from a retry loop.
 */
export interface StageJournalEntry {
  runId: string;
  cycleId: string;
  stage: string;
  status: "completed" | "failed" | "skipped";
  inputCount: number;
  outputCount: number;
  checkpoint?: unknown;
  error?: string;
}

/** One run attempt. `metrics` is the funnel — the earliest place a bad prompt shows up. */
export interface RunJournalEntry {
  runId: string;
  cycleId: string;
  status: "completed" | "failed";
  metrics: unknown;
  error?: string;
}

/** Storage seen by a stage. The fixtures run supplies an in-memory implementation. */
export interface Repo {
  putRawItems(items: RawItem[]): Promise<RawItem[]>;
  /**
   * NAMED LIMIT: raw items carry no cycle, so this returns the topic's whole history. No
   * stage selects work from it — ingest is driven by the source cursor, not by row status —
   * and adding a fake cycle column to make the signature symmetric would be a lie about
   * what the table knows.
   */
  listRawItems(): Promise<RawItem[]>;
  putCandidates(candidates: Candidate[]): Promise<Candidate[]>;
  listCandidates(filter?: CandidateFilter): Promise<Candidate[]>;
  putCards(cards: Card[]): Promise<Card[]>;
  listCards(filter?: CardFilter): Promise<Card[]>;
  putIssue(issue: Issue): Promise<Issue>;
  /** Written by the orchestrator, never by a stage. A stage does not know it is a stage. */
  recordStage(entry: StageJournalEntry): Promise<void>;
  recordRun(entry: RunJournalEntry): Promise<void>;
}

/** Model access. Every implementation routes through packages/llm/src/client.ts. */
export interface LlmGateway {
  complete<T>(request: {
    purpose: string;
    model: string;
    system: string;
    user: string;
    schema: { parse: (v: unknown) => T };
    maxTokens?: number;
  }): Promise<{ value: T; usage: LlmUsage }>;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  cacheHit: boolean;
}

export interface StageLogger {
  debug(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface RunContext {
  runId: string;
  cycleId: string;
  /** Injected rather than read from the clock: a golden run must not move with the date. */
  now: Date;
  dryRun: boolean;
  repo: Repo;
  llm: LlmGateway;
  log: StageLogger;
  /** Whatever the profile carries. Stages read policy from here, never from constants. */
  profile: unknown;
}

/** Raised when a stage received nothing where the pipeline has historically had input. */
export class EmptyStageInputError extends DigestError {
  constructor(
    readonly stage: string,
    hint: string,
  ) {
    super(
      `Stage "${stage}" received an empty input where a non-empty one was expected.\n` +
        `${hint}\n` +
        `This is deliberately fatal: a quietly empty issue is the worst failure mode of ` +
        `this product, because it is indistinguishable from a week with nothing in it.`,
    );
  }
}

export interface StageDefinition<TIn, TOut> {
  name: string;
  /**
   * Whether an empty input is a legitimate outcome for this stage.
   *
   * `ingest` may legitimately return nothing on a quiet day; `compose` receiving nothing
   * means something upstream broke. Default is that empty input is fatal — a stage has to
   * opt into tolerating it, so the safe behaviour is the one you get by forgetting.
   */
  allowEmptyInput?: boolean;
  /**
   * How this stage's work is chosen when a previous run already did part of it.
   *
   * Absent — and that is the default — the stage receives the previous stage's output,
   * which is correct for anything deterministic and free. Present, the orchestrator asks
   * the repository which ROWS still need this stage instead of assuming that step N-1 ran
   * in this process. See `withResume`.
   */
  resume?: StageResume<TIn, TOut>;
  run(input: TIn, ctx: RunContext): Promise<TOut>;
}

export interface Stage<TIn, TOut> extends StageDefinition<TIn, TOut> {
  readonly allowEmptyInput: boolean;
}

export function defineStage<TIn, TOut>(def: StageDefinition<TIn, TOut>): Stage<TIn, TOut> {
  return { ...def, allowEmptyInput: def.allowEmptyInput ?? false };
}

/**
 * What `select` decided this stage has to do.
 *
 * `skip` is deliberately not "an empty input by another name". A stage whose rows are all
 * already past it and a stage whose rows all vanished are indistinguishable from a count,
 * and the second one is the worst failure mode this product has. So `skip` carries the
 * repository's own answer as `output`, and the reason it is allowed to skip — and an
 * implementation that cannot name a positive `alreadyDone` must return `work` and let the
 * empty-input guard fire.
 */
export type StageWork<TIn, TOut> =
  | { kind: "work"; input: TIn; alreadyDone?: number; doneStatus?: string }
  | { kind: "skip"; output: TOut; reason: string };

/**
 * The declaration that a stage's input comes from the repository by row status.
 *
 * Both halves are needed and they are not symmetric. `select` answers "what is left"; it
 * runs BEFORE the stage and may cancel it. `commit` answers "what did this stage just
 * finish"; it runs after, moves those rows on, and returns what the next stage receives —
 * which is how a skipped `extract` still hands `select` the cards the repository holds.
 *
 * Neither lives inside a stage. A stage stays a pure `(input, ctx) => output` that does not
 * know where its input came from, and the resume plan is declared where the pipeline is
 * assembled, next to the profile that supplies the caps it applies.
 */
export interface StageResume<TIn, TOut> {
  select?(previous: TIn, ctx: RunContext): Promise<StageWork<TIn, TOut>>;
  commit?(work: TIn, output: TOut, ctx: RunContext): Promise<TOut>;
}

/** Attach a resume plan at assembly time, leaving the stage itself untouched. */
export function withResume<TIn, TOut>(
  stage: Stage<TIn, TOut>,
  resume: StageResume<TIn, TOut>,
): Stage<TIn, TOut> {
  return { ...stage, resume };
}

/**
 * Statuses a candidate never leaves.
 *
 * Copied by intent, not by import, from the comments on `CandidateStatus` in
 * schema/domain.ts: `duplicate`, `prefiltered_out` and `rejected` are marked terminal
 * there, and `published` is the end of the line. `extracted`, `scored` and `in_issue` are
 * NOT here — a row in one of them still has a stage ahead of it.
 */
export const CANDIDATE_TERMINAL_STATUSES: readonly Candidate["status"][] = [
  "duplicate",
  "prefiltered_out",
  "rejected",
  "published",
];

export function isCandidateTerminal(status: Candidate["status"]): boolean {
  return CANDIDATE_TERMINAL_STATUSES.includes(status);
}

/**
 * The statuses `normalize` is able to produce, and therefore the only ones a re-derivation
 * is allowed to write over an existing row.
 */
const REDERIVED_STATUSES: readonly Candidate["status"][] = ["new", "normalized"];

/**
 * Reconcile a freshly derived candidate with the row already stored for it.
 *
 * This is the hinge the whole epic turns on. A restarted run re-fetches the same items and
 * re-derives the same candidates — deterministically, with the same hashes — and every one
 * of them comes out of `normalize` as `normalized`. Persisting that verbatim drags a row
 * that is already `extracted` back to the start of the automaton, and the next stage
 * dutifully pays the model for it a second time. The status regression is silent: the row
 * count is identical, the funnel looks healthy, and only the invoice knows.
 *
 * Content still wins: the text, hashes and origins come from the fresh derivation, because
 * those are what the source says now. Only the automaton's position, and the fields written
 * by the stages that moved it, are held.
 */
export function mergeCandidate(incoming: Candidate, stored: Candidate | undefined): Candidate {
  // The caller is a stage advancing the row, not a re-derivation. It knows more than the
  // database does.
  if (!REDERIVED_STATUSES.includes(incoming.status)) return incoming;
  if (!stored || REDERIVED_STATUSES.includes(stored.status)) return incoming;
  return {
    ...incoming,
    status: stored.status,
    ...(stored.statusReason !== undefined ? { statusReason: stored.statusReason } : {}),
    ...(stored.prefilterScore !== undefined ? { prefilterScore: stored.prefilterScore } : {}),
    ...(stored.score !== undefined ? { score: stored.score } : {}),
    ...(stored.scoreBreakdown !== undefined ? { scoreBreakdown: stored.scoreBreakdown } : {}),
    ...(stored.duplicateOfId !== undefined ? { duplicateOfId: stored.duplicateOfId } : {}),
  };
}

/** Count of items in a stage input, for the funnel and for the empty-input check. */
export function sizeOf(input: unknown): number {
  if (Array.isArray(input)) return input.length;
  if (input === null || input === undefined) return 0;
  return 1;
}
