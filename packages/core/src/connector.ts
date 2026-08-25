/**
 * Connector contract — the extension point of this project.
 *
 * A new source should be ~50 lines, because rate limiting, retries, conditional GET,
 * cursor persistence, error isolation and quota accounting all live in the runner. A
 * connector knows one thing: how to talk to its source and turn the answer into
 * `RawItemDraft[]`.
 *
 * A connector does NOT filter by topic. It returns everything the source gave for the
 * window; selection is the `prefilter`/`score` stages, configured by the profile. A
 * connector that knows about "AI" is a defect (CLAUDE.md § invariant).
 */

import type { z } from "zod";
import { SourceDriftError, SourceUnavailableError } from "./errors.js";
import type { RawItemDraft } from "./types.js";

export interface ConnectorPolicy {
  requestsPerMinute: number;
  minIntervalMs: number;
  maxPagesPerRun: number;
  maxItemsPerRun: number;
  timeoutMs: number;
  retries: number;
  /**
   * Fewest items a healthy source yields in a window.
   *
   * A source answering 200 with zero items is indistinguishable from a dead one, and that
   * is how a digest silently thins out over months. Below this, the runner raises
   * SourceUnavailableError rather than accepting the silence.
   */
  expectMinItems: number;
}

export interface HttpResponse {
  status: number;
  body: string;
  etag?: string;
  lastModified?: string;
  /** 304: the source has nothing new. Not an error, and not an empty result either. */
  notModified: boolean;
}

export interface HttpClient {
  get(url: string, init?: { etag?: string; lastModified?: string }): Promise<HttpResponse>;
}

export interface ConnectorContext<TConfig, TCursor> {
  sourceKey: string;
  config: TConfig;
  /** State from the previous run. Null on the first one. */
  cursor: TCursor | null;
  /** Lower bound of the window. Injected, never derived from the clock inside a stage. */
  since: Date;
  now: Date;
  http: HttpClient;
  log: { debug(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
}

export interface Page<TCursor> {
  items: RawItemDraft[];
  /** Checkpoint AFTER this page — the runner persists it before fetching the next. */
  cursor?: TCursor;
  exhausted?: boolean;
}

export interface ConnectorDefinition<TConfig, TCursor> {
  kind: string;
  configSchema: z.ZodType<TConfig>;
  cursorSchema: z.ZodType<TCursor>;
  policy: ConnectorPolicy;
  /**
   * Yield pages, not one array.
   *
   * The generator is the reason a quota exhausted on page 40, or a stage deadline, does
   * not throw away what was already collected: the runner checkpoints after every yield.
   */
  fetch(ctx: ConnectorContext<TConfig, TCursor>): AsyncIterable<Page<TCursor>>;
}

export type AnyConnector = ConnectorDefinition<never, never>;

export function defineConnector<TConfig, TCursor>(
  def: ConnectorDefinition<TConfig, TCursor>,
): ConnectorDefinition<TConfig, TCursor> {
  return def;
}

/**
 * Parse a source payload, turning a schema failure into a drift error that names the field.
 *
 * This is the difference between "the source changed shape" and "the source had nothing".
 * Without it a renamed field degrades into zero items, which reads as a quiet week and
 * goes unnoticed for months — which is exactly what DoD #4 requires a connector to prove
 * it does not do.
 */
export function parseOrDrift<T>(schema: z.ZodType<T>, value: unknown, sourceKey: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.length ? issue.path.join(".") : "<root>";
  throw new SourceDriftError(sourceKey, field, issue?.message ?? "did not match the schema");
}

/** Enforce `expectMinItems`. Called by the runner once a source's pages are drained. */
export function assertPlausibleYield(
  sourceKey: string,
  count: number,
  policy: ConnectorPolicy,
): void {
  if (count < policy.expectMinItems) {
    throw new SourceUnavailableError(
      sourceKey,
      `returned ${count} items, fewer than the ${policy.expectMinItems} a healthy window yields. ` +
        `Answering 200 with nothing is indistinguishable from being down, so this is reported ` +
        `rather than accepted.`,
    );
  }
}
