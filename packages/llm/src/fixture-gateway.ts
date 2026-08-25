/**
 * Gateway backed by recorded model responses.
 *
 * This is what makes the golden run deterministic and offline. A golden set that calls a
 * live model tests the weather: the same input yields different words each time, so the
 * only assertions that survive are the structural ones — and those are exactly what can
 * be checked against a recording instead, for free and without a key.
 *
 * Recordings are produced once, deliberately, by a live run (`pnpm golden:record`), and
 * committed. Editing one by hand is allowed but must be marked, or the next reader will
 * take it for something the model actually said.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LlmContractError, type LlmGateway, type LlmUsage } from "@ai-digest/core";
import { contentHash } from "./client.js";

export class MissingRecordingError extends LlmContractError {
  constructor(key: string, dir: string) {
    super(
      "fixture",
      `no recorded model response for "${key}" in ${dir}.\n` +
        `Record it once with a live run (pnpm golden:record), then commit the file. ` +
        `A fixtures run must never fall back to calling the model — that is how an ` +
        `"offline" gate quietly starts needing a key and a network.`,
    );
  }
}

export interface FixtureGatewayOptions {
  dir: string;
  /** When true, a miss is recorded from `live` instead of failing. Recording mode only. */
  recordWith?: LlmGateway;
  onWarn?: (message: string) => void;
}

/** Marker key a hand-authored stand-in must carry. */
export const HAND_AUTHORED_KEY = "_handAuthored";

function isHandAuthored(value: unknown): boolean {
  return typeof value === "object" && value !== null && HAND_AUTHORED_KEY in value;
}

/** Remove the marker before validation so it never has to appear in the schema. */
function strip(value: unknown): unknown {
  if (!isHandAuthored(value)) return value;
  const { [HAND_AUTHORED_KEY]: _marker, ...rest } = value as Record<string, unknown>;
  return rest;
}

export class FixtureGateway implements LlmGateway {
  constructor(private readonly options: FixtureGatewayOptions) {}

  private warn(message: string): void {
    (this.options.onWarn ?? ((m: string) => console.error(`  ! ${m}`)))(message);
  }

  async complete<T>(request: {
    purpose: string;
    model: string;
    system: string;
    user: string;
    schema: { parse: (v: unknown) => T };
    maxTokens?: number;
  }): Promise<{ value: T; usage: LlmUsage }> {
    const key = `${request.purpose}-${contentHash(request.system + request.user)}`;
    const path = join(this.options.dir, `${key}.json`);

    try {
      const raw = await readFile(path, "utf8");
      const parsed: unknown = JSON.parse(raw);

      // A hand-authored fixture announces itself on every single run.
      //
      // The rule "mark an edited fixture" is a comment nobody re-reads. Making the marker
      // behavioural means a stand-in cannot quietly become the thing everyone treats as
      // what the model said — which matters most for the golden set, whose whole value is
      // that it reflects real output.
      if (isHandAuthored(parsed)) {
        this.warn(
          `fixture ${key}.json is HAND-AUTHORED, not recorded from the model. ` +
            `Structural assertions against it are meaningful; conclusions about model ` +
            `behaviour are not. Re-record it with a live run when a key is available.`,
        );
      }

      // Validate the recording too: a fixture that no longer satisfies the schema is a
      // stale contract, and silently accepting it defeats the point of the schema.
      return { value: request.schema.parse(strip(parsed)), usage: recordedUsage(request.model) };
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!this.options.recordWith) throw new MissingRecordingError(key, this.options.dir);

      const live = await this.options.recordWith.complete(request);
      await mkdir(this.options.dir, { recursive: true });
      await writeFile(path, JSON.stringify(live.value, null, 2) + "\n", "utf8");
      return live;
    }
  }
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string })?.code === "ENOENT";
}

/**
 * A replayed call costs nothing and must say so.
 *
 * Reporting a plausible-looking cost here would make `cost:report` describe a run that
 * never happened, and the baseline would drift away from what the pipeline actually spends.
 */
function recordedUsage(model: string): LlmUsage {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    cacheHit: true,
  };
}
