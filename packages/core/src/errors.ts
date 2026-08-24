/**
 * Domain errors. Stages and connectors throw these, never a bare Error — the runner
 * branches on the class to decide whether one source failing should sink the whole run.
 */

/** Base class so the runner can tell our failures from genuine bugs. */
export class DigestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The source could not be reached, or returned implausibly little.
 *
 * Non-fatal by design: the run continues without it and the shortfall is reported.
 * A source that answers 200 with zero items is indistinguishable from a dead one,
 * which is why `expectMinItems` raises this too — see .claude/rules/pipeline.md.
 */
export class SourceUnavailableError extends DigestError {
  constructor(
    readonly sourceKey: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${sourceKey}] ${message}`, options);
  }
}

/**
 * The source answered, but its payload no longer matches the connector's schema.
 *
 * This is the error that must fire when an upstream API or page changes shape. Without
 * it a broken selector degrades into "zero items", which reads as "a quiet week" and
 * goes unnoticed for months.
 */
export class SourceDriftError extends DigestError {
  constructor(
    readonly sourceKey: string,
    readonly field: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${sourceKey}] schema drift at "${field}": ${message}`, options);
  }
}

/** The run hit its `maxRunCostUsd` ceiling. The stage stops on a boundary and reports. */
export class BudgetExceededError extends DigestError {
  constructor(
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(`LLM budget exceeded: spent $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(2)}`);
  }
}

/** The model's reply failed schema validation twice. Never "repair" it with a regex. */
export class LlmContractError extends DigestError {
  constructor(
    readonly stage: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${stage}] model output failed its contract: ${message}`, options);
  }
}
