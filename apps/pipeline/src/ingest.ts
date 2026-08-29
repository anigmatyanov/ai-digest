/**
 * Source[] -> RawItem[].
 *
 * Each source is fetched inside its own try/catch. One source being down must not sink a
 * run — it is reported as degraded and the issue is built from the rest. The alternative,
 * a run that fails whenever any of twenty feeds hiccups, is a pipeline that never
 * publishes.
 */

import {
  assertPlausibleYield,
  defineStage,
  RawItemDraftSchema,
  SourceUnavailableError,
  type HttpClient,
  type RawItem,
  type RunContext,
} from "@ai-digest/core";
import { getConnector } from "@ai-digest/connectors";
import { FixtureHttpClient, LiveHttpClient } from "./http.js";

export interface SourceConfig {
  key: string;
  kind: string;
  enabled?: boolean;
  weight?: number;
  config: Record<string, unknown>;
  fixture?: string;
}

export interface IngestOptions {
  useFixtures: boolean;
  windowDays: number;
  /** Populated as sources fail. The caller folds it into the run report. */
  degraded: { sourceKey: string; reason: string }[];
}

export function makeIngestStage(sources: SourceConfig[], options: IngestOptions) {
  return defineStage<unknown, RawItem[]>({
    name: "ingest",
    // The first stage receives no upstream input, so an empty one is expected here and
    // nowhere else.
    allowEmptyInput: true,
    async run(_input: unknown, ctx: RunContext): Promise<RawItem[]> {
      const since = new Date(ctx.now.getTime() - options.windowDays * 86_400_000);
      const items: RawItem[] = [];

      for (const source of sources) {
        if (source.enabled === false) {
          ctx.log.debug(`${source.key}: disabled in the profile, skipped`);
          continue;
        }

        try {
          const connector = getConnector(source.kind);
          const http: HttpClient = options.useFixtures
            ? new FixtureHttpClient(requireFixture(source), source.key)
            : new LiveHttpClient(source.key, {
                timeoutMs: connector.policy.timeoutMs,
                retries: connector.policy.retries,
                userAgent: "ai-digest/0.1 (+https://github.com/anigmatyanov/ai-digest)",
              });

          let fetched = 0;
          const iterable = connector.fetch({
            sourceKey: source.key,
            config: source.config,
            cursor: null,
            since,
            now: ctx.now,
            http,
            log: ctx.log,
          } as never);

          for await (const page of iterable as AsyncIterable<{ items: unknown[] }>) {
            for (const draft of page.items) {
              // The boundary where a source's data becomes ours, and therefore the place
              // CLAUDE.md's "zod at the boundary" rule has to be executed rather than
              // merely stated. It used to be a spread, so RawItemDraftSchema — including
              // its `url()` — never ran, and a malformed item reached later stages.
              const parsed = RawItemDraftSchema.safeParse(draft);
              if (!parsed.success) {
                const issue = parsed.error.issues[0];
                ctx.log.warn(
                  `${source.key}: item rejected at the boundary — ` +
                    `${issue?.path.join(".") || "<root>"}: ${issue?.message ?? "invalid"}`,
                  { item: draft },
                );
                continue;
              }
              items.push({
                ...parsed.data,
                id: `raw-${source.key}-${parsed.data.externalId}`,
                sourceKey: source.key,
                fetchedAt: ctx.now.toISOString(),
              });
              fetched++;
            }
          }

          assertPlausibleYield(source.key, fetched, connector.policy);
          ctx.log.debug(`${source.key}: ${fetched} item(s)`);
        } catch (error) {
          // Isolated per source, deliberately. A degraded source is reported and shows up
          // in the issue as a missing section, not as a failed run.
          const reason =
            error instanceof SourceUnavailableError
              ? error.message
              : `${(error as Error).name}: ${(error as Error).message}`;
          options.degraded.push({ sourceKey: source.key, reason });
          ctx.log.warn(`${source.key} degraded: ${reason}`);
        }
      }

      return items;
    },
  });
}

function requireFixture(source: SourceConfig): string {
  if (!source.fixture) {
    throw new SourceUnavailableError(
      source.key,
      "the profile has no `fixture` for this source, and this run is offline. " +
        "Add one, or run without --fixtures.",
    );
  }
  return source.fixture;
}
