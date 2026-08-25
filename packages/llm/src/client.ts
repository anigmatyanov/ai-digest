/**
 * The ONLY module that imports the Anthropic SDK.
 *
 * A stage, a connector or the web app calling the SDK directly is a defect — enforced by
 * a guard test, because the rule is otherwise unenforceable and would rot. Everything
 * else talks to `LlmGateway` from packages/core, which is also what makes a fixtures run
 * possible: the gateway is swappable, the SDK is not.
 *
 * API shapes that are current and easy to get wrong from memory:
 *  - model ids carry no date suffix;
 *  - `thinking: { type: "adaptive" }` — `budget_tokens` returns 400 on the 5 series;
 *  - depth is `output_config.effort`, not a token budget;
 *  - structured output is `output_config.format`, and the deprecated `output_format` is not it;
 *  - assistant prefill returns 400, so response shape comes from the schema.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LlmContractError, type LlmGateway, type LlmUsage } from "@ai-digest/core";
import type { z } from "zod";
import type { BudgetGuard } from "./cost.js";
import { priceOf } from "./pricing.js";

export interface AnthropicGatewayOptions {
  apiKey: string;
  budget: BudgetGuard;
  stage: string;
  effort?: "low" | "medium" | "high";
  /** Prompt cache key material. Same key + same prompt version = a free rerun. */
  cache?: LlmCache;
}

/** Cache of validated model output, keyed by content rather than by position. */
export interface LlmCache {
  /** Resolves to the stored value, or undefined on a miss (both are `unknown`). */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** In-memory cache. A run that is retried within one process pays once. */
export class MemoryLlmCache implements LlmCache {
  private readonly store = new Map<string, unknown>();
  get(key: string): Promise<unknown> {
    return Promise.resolve(this.store.get(key));
  }
  set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

export class AnthropicGateway implements LlmGateway {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicGatewayOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
  }

  async complete<T>(request: {
    purpose: string;
    model: string;
    system: string;
    user: string;
    schema: { parse: (v: unknown) => T };
    maxTokens?: number;
  }): Promise<{ value: T; usage: LlmUsage }> {
    this.options.budget.assertCanSpend();
    priceOf(request.model); // fail before spending if the model has no known price

    const cacheKey = `${request.model}|${request.purpose}|${hash(request.system + request.user)}`;
    const cached = await this.options.cache?.get(cacheKey);
    if (cached !== undefined) {
      const value = request.schema.parse(cached);
      return { value, usage: zeroUsage(request.model, true) };
    }

    const started = Date.now();
    // Adaptive thinking and `effort` exist only from the 4.6 line onwards. Sending either
    // to an older model is a 400, not a graceful ignore, so the request is shaped per model.
    const supportsAdaptive = priceOf(request.model).adaptiveThinking;
    const response = await this.client.messages.parse({
      model: request.model,
      max_tokens: request.maxTokens ?? 8000,
      ...(supportsAdaptive ? { thinking: { type: "adaptive" as const } } : {}),
      output_config: {
        ...(supportsAdaptive ? { effort: this.options.effort ?? "medium" } : {}),
        // The schema is the contract. Prefill is gone on this model generation, so this
        // is how response shape is constrained.
        format: zodOutputFormat(request.schema as unknown as z.ZodType<T>),
      },
      system: [
        // Stable prefix first, volatile content after: the cache is prefix-matched, so a
        // timestamp or a run id anywhere in here silently invalidates everything below.
        { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: request.user }],
    });

    const parsed = response.parsed_output;
    if (parsed === null || parsed === undefined) {
      throw new LlmContractError(
        this.options.stage,
        `the model returned output that did not satisfy the schema for "${request.purpose}". ` +
          `Retry once, then fail — never repair model output with a regex.`,
      );
    }

    const u = response.usage;
    const record = this.options.budget.record({
      stage: this.options.stage,
      purpose: request.purpose,
      model: request.model,
      usage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
    });

    const value = request.schema.parse(parsed);
    await this.options.cache?.set(cacheKey, value);

    return {
      value,
      usage: {
        model: request.model,
        inputTokens: record.usage.inputTokens,
        outputTokens: record.usage.outputTokens,
        cacheReadTokens: record.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: record.usage.cacheWriteTokens ?? 0,
        costUsd: record.costUsd,
        cacheHit: record.cacheHit,
      },
    };
  }
}

function zeroUsage(model: string, cacheHit: boolean): LlmUsage {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    cacheHit,
  };
}

/** Stable, dependency-free content hash for cache keys. */
function hash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export { hash as contentHash };
