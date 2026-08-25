/**
 * Model prices, USD per 1M tokens. Anthropic first-party rates.
 *
 * Ids carry NO date suffix — a suffixed id (`claude-sonnet-5-20251114`) is an old form
 * and returns 404. This table and the ids in a profile must agree; `unknownModelCost`
 * makes a mismatch loud instead of silently costing nothing.
 */

export interface ModelPrice {
  /**
   * Whether the model accepts `thinking: {type:"adaptive"}` and `output_config.effort`.
   *
   * Not cosmetic: sending adaptive thinking to a pre-4.6 model returns
   * `400 adaptive thinking is not supported on this model`, and `effort` errors there
   * too. Found by a live run — fixtures cannot catch a request the API rejects.
   */
  adaptiveThinking: boolean;
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** Context window, for sanity-checking a prompt before sending it. */
  contextTokens: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 5, output: 25, contextTokens: 1_000_000, adaptiveThinking: true },
  "claude-sonnet-5": { input: 3, output: 15, contextTokens: 1_000_000, adaptiveThinking: true },
  // Haiku 4.5 predates the 4.6 line: no adaptive thinking, no effort.
  "claude-haiku-4-5": { input: 1, output: 5, contextTokens: 200_000, adaptiveThinking: false },
};

/**
 * Cache multipliers.
 *
 * Writing to the cache costs more than a plain input token; reading from it costs a
 * fraction. Ignoring these makes a cached run look cheaper than it is and an
 * uncached-by-accident run look normal — which is exactly the failure the cache
 * hit-rate metric exists to catch.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(
      `No price is known for model "${model}".\n` +
        `Known models: ${Object.keys(PRICES).join(", ")}.\n` +
        `If this is a new model, add it to packages/llm/src/pricing.ts — a run whose cost ` +
        `cannot be computed must not report itself as free.`,
    );
    this.name = "UnknownModelError";
  }
}

export function priceOf(model: string): ModelPrice {
  const price = PRICES[model];
  if (!price) throw new UnknownModelError(model);
  return price;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Cost of one call in USD, cache tiers included. */
export function costOf(model: string, usage: TokenUsage): number {
  const price = priceOf(model);
  const perToken = (rate: number) => rate / 1_000_000;
  return (
    usage.inputTokens * perToken(price.input) +
    usage.outputTokens * perToken(price.output) +
    (usage.cacheReadTokens ?? 0) * perToken(price.input) * CACHE_READ_MULTIPLIER +
    (usage.cacheWriteTokens ?? 0) * perToken(price.input) * CACHE_WRITE_MULTIPLIER
  );
}

/**
 * Share of input that came from cache.
 *
 * Reported as its own metric because a broken cache is invisible otherwise: nothing
 * errors, the run just costs several times more. Zero on a repeated run means a silent
 * invalidator sits in the prefix, and that is a defect rather than a fact of life.
 */
export function cacheHitRate(usage: TokenUsage): number {
  const total = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (total === 0) return 0;
  return (usage.cacheReadTokens ?? 0) / total;
}
