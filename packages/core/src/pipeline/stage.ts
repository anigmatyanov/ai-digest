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

/** Storage seen by a stage. The fixtures run supplies an in-memory implementation. */
export interface Repo {
  putRawItems(items: RawItem[]): Promise<RawItem[]>;
  listRawItems(): Promise<RawItem[]>;
  putCandidates(candidates: Candidate[]): Promise<Candidate[]>;
  listCandidates(filter?: { status?: Candidate["status"] }): Promise<Candidate[]>;
  putCards(cards: Card[]): Promise<Card[]>;
  listCards(): Promise<Card[]>;
  putIssue(issue: Issue): Promise<Issue>;
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
  run(input: TIn, ctx: RunContext): Promise<TOut>;
}

export interface Stage<TIn, TOut> extends StageDefinition<TIn, TOut> {
  readonly allowEmptyInput: boolean;
}

export function defineStage<TIn, TOut>(def: StageDefinition<TIn, TOut>): Stage<TIn, TOut> {
  return { ...def, allowEmptyInput: def.allowEmptyInput ?? false };
}

/** Count of items in a stage input, for the funnel and for the empty-input check. */
export function sizeOf(input: unknown): number {
  if (Array.isArray(input)) return input.length;
  if (input === null || input === undefined) return 0;
  return 1;
}
