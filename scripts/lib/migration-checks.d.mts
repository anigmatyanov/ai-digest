/**
 * Types for the plain-JS helper next door.
 *
 * The implementation stays .mjs because db-status.mjs imports it at runtime and Node cannot
 * load TypeScript. A declaration file is the honest way to type it — the alternative was a
 * `@ts-expect-error` on the test's import, which silences the checker instead of informing
 * it and would hide a real signature change.
 */

/** @returns a description of the problem, or null when the migration is fine. */
export function vectorOrderingProblem(
  sql: string,
  extensionAlreadyCreated?: boolean,
): string | null;
