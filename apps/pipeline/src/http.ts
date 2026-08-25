/**
 * HTTP clients for connectors.
 *
 * Two implementations behind one interface: the real one, and one that serves a recorded
 * file. The fixtures client is not a test double bolted on afterwards — it is how an
 * offline run is possible at all, and it is the only client an agent session ever uses.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SourceUnavailableError, type HttpClient, type HttpResponse } from "@ai-digest/core";

/** Serves a recorded response from disk. Never touches the network. */
export class FixtureHttpClient implements HttpClient {
  constructor(
    private readonly fixturePath: string,
    private readonly sourceKey: string,
  ) {}

  async get(): Promise<HttpResponse> {
    try {
      const body = await readFile(resolve(this.fixturePath), "utf8");
      return { status: 200, body, notModified: false };
    } catch (error) {
      throw new SourceUnavailableError(
        this.sourceKey,
        `fixture ${this.fixturePath} could not be read. Record it with \`pnpm fixtures:record\`.`,
        { cause: error },
      );
    }
  }
}

export interface LiveHttpOptions {
  timeoutMs: number;
  retries: number;
  userAgent: string;
}

/**
 * Real HTTP with conditional GET, bounded retries and a timeout.
 *
 * Retries only what is worth retrying: a 404 is an answer, and retrying it three times
 * just makes the failure slower.
 */
export class LiveHttpClient implements HttpClient {
  constructor(
    private readonly sourceKey: string,
    private readonly options: LiveHttpOptions,
  ) {}

  async get(url: string, init?: { etag?: string; lastModified?: string }): Promise<HttpResponse> {
    const headers: Record<string, string> = { "user-agent": this.options.userAgent };
    if (init?.etag) headers["if-none-match"] = init.etag;
    if (init?.lastModified) headers["if-modified-since"] = init.lastModified;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, this.options.timeoutMs);
        try {
          const res = await fetch(url, { headers, signal: controller.signal });
          if (res.status === 304) return { status: 304, body: "", notModified: true };
          if (res.status >= 400) {
            // 4xx is an answer, not a hiccup — retrying it only makes failure slower.
            if (res.status < 500) {
              throw new SourceUnavailableError(this.sourceKey, `HTTP ${res.status} for ${url}`);
            }
            throw new Error(`HTTP ${res.status}`);
          }
          return {
            status: res.status,
            body: await res.text(),
            notModified: false,
            ...(res.headers.get("etag") ? { etag: res.headers.get("etag") as string } : {}),
            ...(res.headers.get("last-modified")
              ? { lastModified: res.headers.get("last-modified") as string }
              : {}),
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        if (error instanceof SourceUnavailableError) throw error;
        lastError = error;
        if (attempt < this.options.retries) {
          const backoff = 2 ** attempt * 500 + Math.floor(Math.random() * 250);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    throw new SourceUnavailableError(this.sourceKey, `giving up after ${this.options.retries + 1} attempts`, {
      cause: lastError,
    });
  }
}
