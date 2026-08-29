/**
 * Types for scripts/gen-connectors.mjs.
 *
 * The script is plain JavaScript run by node, so it carries no types of its own, while
 * `tsconfig.eslint.json` type-checks the test that imports it. The obvious-looking fix —
 * casting the result of `await import(...)` to the shape you want — does nothing: it
 * re-types a value that is already `any`, and TS7016 stays where it was. It went unnoticed
 * until `pnpm typecheck` began compiling the test project on 2026-08-29.
 *
 * `allowJs` would silence the same error while telling the compiler nothing about these
 * functions. A declaration file is the only form that makes the test's expectations
 * checkable, and it is checked in turn: change an argument here without changing the
 * script and the test compiles against a lie, so keep the two in the same commit.
 */

/** One connector, as read out of its `index.ts`. */
export interface CollectedConnector {
  /** Directory under packages/connectors/src/. */
  dir: string;
  /** The `kind` the connector declares. The registry key and the profile discriminator. */
  kind: string;
  /** The symbol the connector's index.ts exports. */
  exportName: string;
  /** The name the generated registry imports it as, derived from `dir`. */
  local: string;
}

/** A connector's index.ts, by directory name and contents. */
export interface ConnectorEntry {
  dir: string;
  source: string;
}

/** Exit code plus the single line the script prints. */
export interface RunResult {
  code: 0 | 1;
  message: string;
}

export declare function collectConnectors(entries: ConnectorEntry[]): CollectedConnector[];
export declare function renderRegistry(found: CollectedConnector[]): string;
export declare function readEntries(srcDir: string): ConnectorEntry[];
export declare function main(srcDir: string, outPath: string, argv: readonly string[]): RunResult;
