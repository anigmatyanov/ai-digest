/**
 * A gate on the barrel, not on the connectors.
 *
 * `registry.ts` is generated so that "add a connector" stays a new-directory-only diff.
 * `index.ts` is written by hand, and until E-006a it carried three RSS symbols — a template
 * the next connector would have copied. Nothing failed when it did: the extra line compiles,
 * lints and ships. The cost only shows up later, as a shared file every connector epic
 * touches and therefore a serialize label that stops them running in parallel.
 *
 * So the property is asserted here: every top-level export or import in the barrel resolves
 * to `./registry.js`. Imports count too — a barrel could otherwise import a connector and
 * re-export it as its own declaration.
 *
 * Read from the AST rather than matched with a regex, for a reason visible in this very
 * repository: the header comment of `index.ts` quotes the forbidden line verbatim as an
 * example, and a regex over the file text would fail on the documentation warning against
 * the defect. `typescript` is imported from the root toolchain; the package's build config
 * excludes `*.test.ts`, so it never reaches `dist`.
 *
 * Scope of the claim: top-level statements of that one file. It says nothing about what
 * connectors export, or about a consumer that deep-imports `@ai-digest/connectors/dist/...`
 * past the barrel — the package's `exports` map is what forbids that.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const BARREL = fileURLToPath(new URL("./index.ts", import.meta.url));

/** The one module the barrel is allowed to re-export. */
const GENERATED = "./registry.js";

/**
 * Module specifiers the barrel pulls from that are not the generated registry.
 *
 * Returns the offenders rather than a boolean so a failure names the path that caused it:
 * "expected [\"./rss/index.js\"] to equal []" points at the file to fix, "expected false to
 * be true" does not.
 */
function nonRegistrySpecifiers(source: string): string[] {
  const file = ts.createSourceFile(
    "index.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const specifiers: string[] = [];
  for (const statement of file.statements) {
    const moduleSpecifier = ts.isExportDeclaration(statement)
      ? statement.moduleSpecifier
      : ts.isImportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  }

  return specifiers.filter((s) => s !== GENERATED);
}

describe("the connectors barrel", () => {
  it("re-exports the generated registry and nothing per-connector", () => {
    expect(nonRegistrySpecifiers(readFileSync(BARREL, "utf8"))).toEqual([]);
  });

  it("still re-exports the registry at all", () => {
    // Without this, deleting every line of index.ts would pass the assertion above.
    expect(readFileSync(BARREL, "utf8")).toContain(GENERATED);
  });

  it("names each offending path — shown against the barrel as it stood before E-006a", () => {
    // The exact pre-fix content, kept as the negative case the gate is checked against:
    // green on the fixed file proves nothing on its own, because a check that never fires
    // is also green (DoD #7).
    const before = [
      'export { connectors, getConnector, sourceVariants } from "./registry.js";',
      'export type { ConnectorKind } from "./registry.js";',
      'export { rssConnector, RssConfigSchema, RssCursorSchema } from "./rss/index.js";',
      'export type { RssConfig, RssCursor } from "./rss/index.js";',
    ].join("\n");

    expect(nonRegistrySpecifiers(before)).toEqual(["./rss/index.js", "./rss/index.js"]);
  });

  it("catches the other two shapes the same mistake takes", () => {
    // `export *` and an import re-exported under a local name both add a per-connector line
    // to the barrel without the word `export ... from` a naive check would look for.
    expect(nonRegistrySpecifiers('export * from "./hn/index.js";')).toEqual(["./hn/index.js"]);
    expect(
      nonRegistrySpecifiers(
        'import { hnConnector } from "./hn/index.js";\nexport const hn = hnConnector;',
      ),
    ).toEqual(["./hn/index.js"]);
  });

  it("does not fire on a comment that quotes the forbidden line", () => {
    // index.ts documents the defect by example. A regex would call that a violation.
    expect(
      nonRegistrySpecifiers(
        '// never: export { rssConnector } from "./rss/index.js";\n' +
          'export { connectors } from "./registry.js";',
      ),
    ).toEqual([]);
  });
});
