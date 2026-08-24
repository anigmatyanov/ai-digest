import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  DigestError,
  LlmContractError,
  SourceDriftError,
  SourceUnavailableError,
} from "./errors.js";

describe("domain errors", () => {
  it("should report its own class name when a subclass is constructed", () => {
    // `new.target.name` rather than a hardcoded string: a renamed class that kept a
    // stale literal would log the wrong name for as long as nobody reads the logs.
    expect(new SourceUnavailableError("rss:openai", "timeout").name).toBe("SourceUnavailableError");
    expect(new SourceDriftError("hn:ai", "points", "expected number").name).toBe(
      "SourceDriftError",
    );
  });

  it("should stay catchable as DigestError when a subclass is thrown", () => {
    // The runner branches on this: our failures degrade the run, genuine bugs sink it.
    expect(() => {
      throw new BudgetExceededError(4.2, 4);
    }).toThrow(DigestError);
  });

  it("should name the source and the drifted field in the message", () => {
    const err = new SourceDriftError("tg:data_secrets", "data-post", "attribute missing");
    expect(err.message).toBe('[tg:data_secrets] schema drift at "data-post": attribute missing');
    expect(err.sourceKey).toBe("tg:data_secrets");
    expect(err.field).toBe("data-post");
  });

  it("should render both spend and limit in the budget message", () => {
    expect(new BudgetExceededError(4.2, 4).message).toBe(
      "LLM budget exceeded: spent $4.2000 of $4.00",
    );
  });

  it("should preserve the cause so the underlying failure is not swallowed", () => {
    const cause = new TypeError("socket hang up");
    expect(new LlmContractError("extract", "invalid json", { cause }).cause).toBe(cause);
  });
});
