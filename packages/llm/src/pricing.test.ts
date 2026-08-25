import { describe, expect, it } from "vitest";
import {
  cacheHitRate,
  costOf,
  CACHE_READ_MULTIPLIER,
  PRICES,
  priceOf,
  UnknownModelError,
} from "./pricing.js";

describe("pricing", () => {
  it("should price a plain call from the published rates", () => {
    // Literals, not values read back from PRICES: a test that asks the table what it
    // contains cannot fail when the table is wrong.
    const usd = costOf("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(usd).toBeCloseTo(3 + 15, 6);
  });

  it("should charge cache reads at a tenth of the input rate", () => {
    const usd = costOf("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(5 * CACHE_READ_MULTIPLIER, 6);
  });

  it("should charge cache writes above the input rate", () => {
    const write = costOf("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    const plain = costOf("claude-opus-5", { inputTokens: 1_000_000, outputTokens: 0 });
    expect(write).toBeGreaterThan(plain);
  });

  it("should refuse an unknown model rather than report it as free", () => {
    // A run whose cost cannot be computed must not look like it cost nothing.
    expect(() => costOf("claude-sonnet-5-20251114", { inputTokens: 1, outputTokens: 1 })).toThrow(
      UnknownModelError,
    );
  });

  it("should carry no date suffix on any model id", () => {
    // A suffixed id is an old form and returns 404 from the API.
    for (const id of Object.keys(PRICES)) {
      expect(id).not.toMatch(/-\d{8}$/);
    }
  });

  it("should expose a context window for every priced model", () => {
    for (const id of Object.keys(PRICES)) {
      expect(priceOf(id).contextTokens).toBeGreaterThan(0);
    }
  });

  it("should report a zero hit rate when nothing was read from cache", () => {
    expect(cacheHitRate({ inputTokens: 100, outputTokens: 10 })).toBe(0);
    expect(cacheHitRate({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 50 })).toBeCloseTo(
      0.5,
      6,
    );
  });
});
