#!/usr/bin/env node
/**
 * Generate packages/connectors/src/registry.ts from the directories under src/.
 *
 * WHY THIS IS GENERATED: "add a connector" is the ideal unit of parallel work — a new
 * folder, a fixture, a test — and it has to scale to several agents at once. A
 * hand-maintained registry would be a hotspot that every connector epic edits, which
 * means a serialize label, which means those epics run one at a time. An eliminated
 * hotspot parallelises work; a locked one serialises it.
 *
 * The file carries TWO exports for that reason. `connectors` is the runtime lookup the
 * ingest stage uses; `sourceVariants` is the per-kind config schema that profiles/schema.ts
 * folds into its discriminated union, so a new source no longer has to be written into a
 * shared profile file either.
 *
 * `kind` and the exported symbol are read from the AST rather than matched with a regex:
 * a regex finds `kind:` inside a comment or a nested object literal and would key the
 * registry off the wrong string. It is also why the connector directory is not the key —
 * `getConnector(source.kind)` looks up by the declared kind, and the two are free to differ.
 *
 * Types for the exports below live in gen-connectors.d.mts, because the test that imports
 * them is type-checked.
 *
 * Run: pnpm gen:connectors        (checked by `pnpm gen:connectors --check` in verify)
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "packages", "connectors", "src");
const OUT = join(SRC, "registry.ts");

const DEFINE = "defineConnector";

/** The only flag. Anything else is a typo, and a typo here is dangerous — see `main`. */
const KNOWN_FLAGS = new Set(["--check"]);

/** Path as a human reads it in an error, not as the filesystem spells it. */
const where = (dir) => `packages/connectors/src/${dir}/index.ts`;

/**
 * Byte order, not locale order.
 *
 * `localeCompare` collates by the machine's locale, and `--check` compares the generated
 * file byte for byte. Generating under one collation and verifying under another would
 * show a diff that no edit caused.
 */
const byBytes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A connector directory becomes an identifier in generated TypeScript, so it has to be a
 * legal one. `2rss` would emit `import { c as 2rssConnector }`, which does not parse — and
 * the failure would surface as a syntax error in a generated file rather than as a
 * sentence about the directory that caused it.
 */
const DIR_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * A `kind` becomes the prefix of every source key, and profiles/schema.ts validates keys
 * against /^[a-z0-9]+:[a-z0-9-]+$/ — no dashes in the prefix. A kind outside that charset
 * generates cleanly and is then unusable in any profile, which is a defect discovered a
 * long way from the connector that caused it.
 */
const KIND_PATTERN = /^[a-z0-9]+$/;

const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Static name of an object-literal member, or undefined for computed/spread members. */
function memberName(node) {
  if (!ts.isPropertyAssignment(node)) return undefined;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return undefined;
}

/** String value of a literal initialiser, or undefined if it is not a literal. */
function literalString(node) {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/**
 * Read `kind` and the exported symbol out of every connector's index.ts.
 *
 * Pure on purpose: it takes file contents, not paths, so the failure modes below are
 * testable without a filesystem. `entries` is `[{ dir, source }]`.
 */
export function collectConnectors(entries) {
  const found = [];

  for (const { dir, source } of entries) {
    if (!DIR_PATTERN.test(dir)) {
      throw new Error(
        `packages/connectors/src/${dir}: a connector directory must be lower-case kebab-case ` +
          `starting with a letter (matching ${String(DIR_PATTERN)}), because the generated ` +
          `registry turns it into a TypeScript identifier.`,
      );
    }

    const file = ts.createSourceFile(
      where(dir),
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const calls = [];
    const walk = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === DEFINE
      ) {
        calls.push(node);
      }
      ts.forEachChild(node, walk);
    };
    walk(file);

    if (calls.length !== 1) {
      throw new Error(
        `${where(dir)}: expected exactly one \`${DEFINE}(...)\` call, found ${calls.length}. ` +
          `One directory declares one connector — that is what makes the registry generatable.`,
      );
    }

    const call = calls[0];
    const arg = call.arguments[0];
    if (arg === undefined || !ts.isObjectLiteralExpression(arg)) {
      throw new Error(
        `${where(dir)}: \`${DEFINE}(...)\` must be called with an object literal, so \`kind\` ` +
          `can be read without executing the file.`,
      );
    }

    const kind = literalString(arg.properties.find((p) => memberName(p) === "kind")?.initializer);
    if (kind === undefined || kind.length === 0) {
      throw new Error(
        `${where(dir)}: \`${DEFINE}({ kind })\` must be a non-empty string literal. ` +
          `A computed kind cannot be read statically, and the profile schema needs the literal ` +
          `to keep a source's config typed.`,
      );
    }
    if (!KIND_PATTERN.test(kind)) {
      throw new Error(
        `${where(dir)}: kind "${kind}" must match ${String(KIND_PATTERN)}. A source key is ` +
          `\`kind:name\` and profiles/schema.ts validates the prefix with the same charset, so a ` +
          `kind outside it can never appear in a valid profile.`,
      );
    }

    // The call must BE the initialiser, not merely sit somewhere inside one. Climbing to
    // the nearest enclosing VariableDeclaration accepted
    // `export const bundle = { inner: defineConnector({...}) }`, keyed the registry off
    // `bundle`, and emitted `bundle.configSchema` — a failure that lands on typecheck, far
    // from the connector that caused it. Picking one silently is the defect this generator
    // exists to refuse.
    const declaration = call.parent;
    const isInitialiser =
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer === call &&
      ts.isIdentifier(declaration.name);
    const statement = isInitialiser ? declaration.parent?.parent : undefined;
    const exported =
      statement !== undefined &&
      ts.isVariableStatement(statement) &&
      (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

    if (!isInitialiser || !exported) {
      throw new Error(
        `${where(dir)}: the \`${DEFINE}(...)\` call must be the initialiser of an exported const ` +
          `(\`export const <name>Connector = ${DEFINE}({...})\`), because the registry imports it by name.`,
      );
    }

    found.push({ dir, kind, exportName: declaration.name.text, local: `${camel(dir)}Connector` });
  }

  const byKind = new Map();
  for (const c of found) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c.dir]);
  for (const [kind, dirs] of byKind) {
    if (dirs.length > 1) {
      throw new Error(
        `two connectors declare kind "${kind}": ${dirs.map(where).join(" and ")}. ` +
          `\`kind\` is both the registry key and the profile's discriminator, so it has to be ` +
          `unique — zod would otherwise fail lazily at the first parse, naming neither directory.`,
      );
    }
  }

  const byLocal = new Map();
  for (const c of found) byLocal.set(c.local, [...(byLocal.get(c.local) ?? []), c.dir]);
  for (const [local, dirs] of byLocal) {
    if (dirs.length > 1) {
      throw new Error(
        `directories ${dirs.map(where).join(" and ")} both produce the local name "${local}" ` +
          `in the generated registry, which would emit a duplicate import binding. Rename one directory.`,
      );
    }
  }

  return found.sort((a, b) => byBytes(a.kind, b.kind));
}

/** Render registry.ts. Pure: takes what `collectConnectors` returned, returns file text. */
export function renderRegistry(found) {
  if (found.length === 0) {
    throw new Error(
      "no connector directories found under packages/connectors/src/. The generated variant " +
        "tuple would be empty, and a discriminated union cannot be built from nothing — " +
        "profiles/schema.ts would stop compiling with a type error instead of a readable one.",
    );
  }

  const importLine = (c) =>
    c.exportName === c.local
      ? `import { ${c.local} } from "./${c.dir}/index.js";`
      : `import { ${c.exportName} as ${c.local} } from "./${c.dir}/index.js";`;

  return `// GENERATED by scripts/gen-connectors.mjs — do not edit.
//
// Editing this file by hand defeats the reason it is generated: two agents adding a
// connector each must not touch a shared file. Add a directory under src/ and re-run
// \`pnpm gen:connectors\`.
//
// Keyed by the \`kind\` each connector declares, not by its directory name: \`getConnector\`
// is called with \`source.kind\`, and the two are allowed to differ.

import type { AnyConnector } from "@ai-digest/core";
${found.map(importLine).join("\n")}

export const connectors = {
${found.map((c) => `  "${c.kind}": ${c.local} as unknown as AnyConnector,`).join("\n")}
} as const;

export type ConnectorKind = keyof typeof connectors;

/**
 * The per-kind config schemas profiles/schema.ts builds its source union from.
 *
 * \`as const\` and the ABSENCE of an \`AnyConnector\` cast are load-bearing. \`AnyConnector\`
 * is \`ConnectorDefinition<never, never>\`, which erases the config type and widens \`kind\`
 * to \`string\`; a source entry would then accept any config object at all, and the reason
 * profiles are TypeScript rather than YAML would be gone with no compile error to say so.
 */
export const sourceVariants = [
${found.map((c) => `  { kind: "${c.kind}", config: ${c.local}.configSchema },`).join("\n")}
] as const;

/** Look up a connector by kind, failing with the list of known kinds rather than undefined. */
export function getConnector(kind: string): AnyConnector {
  const found = (connectors as Record<string, AnyConnector | undefined>)[kind];
  if (!found) {
    throw new Error(
      \`Unknown connector kind "\${kind}". Known kinds: \${Object.keys(connectors).join(", ") || "(none)"}.\` +
        \` Add a directory under packages/connectors/src/ and run \\\`pnpm gen:connectors\\\`.\`,
    );
  }
  return found;
}
`;
}

/** Directory listing -> `[{ dir, source }]`. The only part that touches disk. */
export function readEntries(srcDir) {
  return readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(srcDir, e.name, "index.ts")))
    .map((e) => ({ dir: e.name, source: readFileSync(join(srcDir, e.name, "index.ts"), "utf8") }))
    .sort((a, b) => byBytes(a.dir, b.dir));
}

/**
 * The whole script as a function: paths and argv in, exit code and one line out.
 *
 * Parameterised rather than reading module-level constants so the `--check` behaviour is
 * testable against a temporary directory. `--check` is what AC #4 rests on, and it was
 * previously reachable only by running the real generator against the real repository.
 */
export function main(srcDir, outPath, argv) {
  // An unrecognised flag is refused rather than ignored. Silently ignoring one is the
  // worst failure this script has: `--check-stale` instead of `--check` would make the
  // command WRITE the file it was asked to verify, and report success doing it.
  const unrecognised = argv.filter((a) => !KNOWN_FLAGS.has(a));
  if (unrecognised.length > 0) {
    return {
      code: 1,
      message:
        `gen-connectors: unrecognised argument(s): ${unrecognised.join(", ")}. ` +
        `The only flag is --check. This is refused rather than ignored because ignoring it ` +
        `turns a verification into an overwrite.`,
    };
  }

  let found;
  let body;
  try {
    found = collectConnectors(readEntries(srcDir));
    body = renderRegistry(found);
  } catch (error) {
    return {
      code: 1,
      message: `gen-connectors: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const kinds = found.map((c) => c.kind);
  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";

  if (argv.includes("--check")) {
    if (existing !== body) {
      return {
        code: 1,
        message:
          "registry.ts is stale — a connector directory was added or removed, a connector's\n" +
          "`kind` changed, or the file was edited by hand.\n" +
          "Run: pnpm gen:connectors",
      };
    }
    return {
      code: 0,
      message: `connector registry up to date (${kinds.length}: ${kinds.join(", ")})`,
    };
  }

  writeFileSync(outPath, body, "utf8");
  return {
    code: 0,
    message: `generated registry.ts with ${kinds.length} connector(s): ${kinds.join(", ")}`,
  };
}

// Importable for tests, executable as a script: the functions above must be reachable
// without running the generator against the real filesystem.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = main(SRC, OUT, process.argv.slice(2));
  (result.code === 0 ? console.log : console.error)(result.message);
  process.exit(result.code);
}
