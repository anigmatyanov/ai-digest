/**
 * The generator is a gate, not a convenience: it is the thing that lets two agents add a
 * connector each without editing a shared file. These tests cover the ways it could fail
 * quietly — picking one of two connectors that claim the same `kind`, reading `kind` out of
 * a comment, or accepting a mistyped flag and overwriting the file it was asked to verify.
 *
 * `collectConnectors` takes file CONTENTS rather than paths, so most of this touches no
 * disk at all; `main` is exercised against a temporary directory, because `--check` is what
 * AC #4 rests on and it was previously reachable only by running the real repository.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectConnectors, main, renderRegistry } from "./gen-connectors.mjs";

const connectorSource = (kind: string, exportName = "someConnector"): string => `
import { defineConnector } from "@ai-digest/core";
import { z } from "zod";

export const ${exportName} = defineConnector({
  kind: "${kind}",
  configSchema: z.object({ feedUrl: z.string() }),
  cursorSchema: z.object({}),
  policy: { expectMinItems: 1 },
  async *fetch() {},
});
`;

describe("collectConnectors", () => {
  it("reads kind and the exported symbol out of the source", () => {
    const found = collectConnectors([
      { dir: "rss", source: connectorSource("rss", "rssConnector") },
    ]);
    expect(found).toEqual([
      { dir: "rss", kind: "rss", exportName: "rssConnector", local: "rssConnector" },
    ]);
  });

  it("keys off the declared kind, not the directory name", () => {
    // The two coincide today by accident. `getConnector(source.kind)` looks up by kind, so
    // a directory named for readability must not silently become the registry key.
    const found = collectConnectors([
      { dir: "hacker-news", source: connectorSource("hn", "hackerNewsConnector") },
    ]);
    expect(found[0]?.kind).toBe("hn");

    const rendered = renderRegistry(found);
    expect(rendered).toContain('"hn": hackerNewsConnector as unknown as AnyConnector,');
    expect(rendered).toContain('{ kind: "hn", config: hackerNewsConnector.configSchema },');
    expect(rendered).toContain('from "./hacker-news/index.js"');
    expect(rendered).not.toContain('"hacker-news":');
  });

  it("names BOTH directories when two connectors declare the same kind", () => {
    // zod does detect this — lazily, at the first parse, as a bare
    // Error("Duplicate discriminator value \"rss\"") that names neither directory and
    // arrives nowhere near the person who added the second connector.
    expect(() =>
      collectConnectors([
        { dir: "rss", source: connectorSource("rss", "rssConnector") },
        { dir: "atom", source: connectorSource("rss", "atomConnector") },
      ]),
    ).toThrow(
      /two connectors declare kind "rss".*packages\/connectors\/src\/rss\/index\.ts.*packages\/connectors\/src\/atom\/index\.ts/s,
    );
  });

  it("names BOTH directories when two of them collapse to one local import name", () => {
    // Symmetric with the duplicate-kind case and just as silent: the generated file would
    // carry two `import { … as foo1Connector }` bindings and fail to parse.
    //
    // Reachable because digits have no upper case: `foo-1` and `foo1` both satisfy the
    // directory charset and both camel-case to `foo1`. Letters cannot collide this way,
    // which is why the pair below is a digit one.
    expect(() =>
      collectConnectors([
        { dir: "foo-bar", source: connectorSource("one", "oneConnector") },
        { dir: "foo-bar2", source: connectorSource("two", "twoConnector") },
      ]),
    ).not.toThrow();

    expect(() =>
      collectConnectors([
        { dir: "foo-1", source: connectorSource("one", "oneConnector") },
        { dir: "foo1", source: connectorSource("two", "twoConnector") },
      ]),
    ).toThrow(
      /packages\/connectors\/src\/foo-1\/index\.ts.*packages\/connectors\/src\/foo1\/index\.ts.*duplicate import binding/s,
    );
  });

  it("names the directory when the file declares no connector", () => {
    expect(() =>
      collectConnectors([{ dir: "empty", source: "export const nothing = 1;\n" }]),
    ).toThrow(
      /packages\/connectors\/src\/empty\/index\.ts.*exactly one `defineConnector\(\.\.\.\)` call, found 0/s,
    );
  });

  it("names the directory when the file declares two connectors", () => {
    expect(() =>
      collectConnectors([
        {
          dir: "double",
          source: connectorSource("a", "aConnector") + connectorSource("b", "bConnector"),
        },
      ]),
    ).toThrow(/packages\/connectors\/src\/double\/index\.ts.*found 2/s);
  });

  it("is not fooled by `kind:` in a comment or in a nested object", () => {
    // The reason this reads the AST instead of matching a regex.
    const source = `
import { defineConnector } from "@ai-digest/core";
// kind: "commented-out"
export const trickyConnector = defineConnector({
  policy: { kind: "nested" },
  kind: "real",
  async *fetch() {},
});
`;
    expect(collectConnectors([{ dir: "tricky", source }])[0]?.kind).toBe("real");
  });

  it("refuses a connector nested inside an exported value instead of being it", () => {
    // Climbing to the nearest enclosing VariableDeclaration accepted this and keyed the
    // registry off `bundle`, emitting `bundle.configSchema`. The mistake then surfaced as
    // a type error in a generated file, a long way from the directory that caused it —
    // the same "choose one silently" failure the duplicate-kind check exists to refuse.
    const source = `
import { defineConnector } from "@ai-digest/core";
export const bundle = { inner: defineConnector({ kind: "z", async *fetch() {} }) };
`;
    expect(() => collectConnectors([{ dir: "nested", source }])).toThrow(
      /packages\/connectors\/src\/nested\/index\.ts.*must be the initialiser of an exported const/s,
    );
  });

  it("refuses a kind that is not a string literal", () => {
    const source = `
import { defineConnector } from "@ai-digest/core";
const KIND = "computed";
export const c = defineConnector({ kind: KIND, async *fetch() {} });
`;
    expect(() => collectConnectors([{ dir: "computed", source }])).toThrow(
      /packages\/connectors\/src\/computed\/index\.ts.*must be a non-empty string literal/s,
    );
  });

  it("refuses a kind that could never appear in a valid source key", () => {
    // A source key is `kind:name` and the profile schema validates the prefix as
    // [a-z0-9]+. A dashed kind generates cleanly and is then unusable in any profile.
    expect(() =>
      collectConnectors([{ dir: "github-atom", source: connectorSource("github-atom") }]),
    ).toThrow(/packages\/connectors\/src\/github-atom\/index\.ts.*kind "github-atom" must match/s);
  });

  it("refuses a directory name that is not a legal identifier stem", () => {
    // `2rss` would emit `import { someConnector as 2rssConnector }`, which does not parse.
    expect(() => collectConnectors([{ dir: "2rss", source: connectorSource("rss") }])).toThrow(
      /packages\/connectors\/src\/2rss.*kebab-case/s,
    );
  });

  it("refuses a connector that is not assigned to an exported const", () => {
    const source = `
import { defineConnector } from "@ai-digest/core";
const hidden = defineConnector({ kind: "hidden", async *fetch() {} });
export default hidden;
`;
    expect(() => collectConnectors([{ dir: "hidden", source }])).toThrow(
      /packages\/connectors\/src\/hidden\/index\.ts.*must be the initialiser of an exported const/s,
    );
  });

  it("sorts by kind so the generated file does not churn on directory renames", () => {
    const found = collectConnectors([
      { dir: "z-dir", source: connectorSource("aaa", "zConnector") },
      { dir: "a-dir", source: connectorSource("zzz", "aConnector") },
    ]);
    expect(found.map((c) => c.kind)).toEqual(["aaa", "zzz"]);
  });
});

describe("renderRegistry", () => {
  it("aliases the import when the exported name is not the one the registry uses", () => {
    const rendered = renderRegistry(
      collectConnectors([{ dir: "hacker-news", source: connectorSource("hn", "connector") }]),
    );
    expect(rendered).toContain(
      'import { connector as hackerNewsConnector } from "./hacker-news/index.js";',
    );
  });

  it("emits the contributions WITHOUT an AnyConnector cast", () => {
    // Casting the contribution to AnyConnector (ConnectorDefinition<never, never>) is the
    // failure this project was warned about: the union still compiles, and every source
    // config silently becomes assignable.
    const rendered = renderRegistry(
      collectConnectors([{ dir: "rss", source: connectorSource("rss") }]),
    );
    const variants = rendered.slice(rendered.indexOf("export const sourceVariants"));
    expect(variants).toContain("config: rssConnector.configSchema },");
    expect(variants.slice(0, variants.indexOf("] as const;"))).not.toContain("AnyConnector");
    expect(variants).toContain("] as const;");
  });

  it("refuses to emit an empty tuple", () => {
    // z.discriminatedUnion needs a non-empty tuple. An empty one fails in profiles/schema.ts
    // as a type error about tuple arity, which says nothing about connectors.
    expect(() => renderRegistry([])).toThrow(/no connector directories found/);
  });
});

describe("main", () => {
  let root: string;
  let src: string;
  let out: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gen-connectors-"));
    src = join(root, "src");
    out = join(src, "registry.ts");
    mkdirSync(join(src, "rss"), { recursive: true });
    writeFileSync(join(src, "rss", "index.ts"), connectorSource("rss", "rssConnector"), "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the registry and reports what it generated", () => {
    expect(main(src, out, [])).toEqual({
      code: 0,
      message: "generated registry.ts with 1 connector(s): rss",
    });
    expect(readFileSync(out, "utf8")).toContain('"rss": rssConnector as unknown as AnyConnector,');
  });

  it("--check passes on a freshly generated file", () => {
    main(src, out, []);
    expect(main(src, out, ["--check"])).toEqual({
      code: 0,
      message: "connector registry up to date (1: rss)",
    });
  });

  it("--check fails on a file edited by hand, and does NOT repair it", () => {
    // The point of --check: it reports, it never writes. A --check that silently fixed
    // the file would turn `pnpm verify` into a mutation of the tree it is verifying.
    main(src, out, []);
    writeFileSync(out, "// someone edited this by hand\n", "utf8");

    const result = main(src, out, ["--check"]);
    expect(result.code).toBe(1);
    expect(result.message).toContain("Run: pnpm gen:connectors");
    expect(readFileSync(out, "utf8")).toBe("// someone edited this by hand\n");
  });

  it("--check fails when a connector directory appeared after the last generation", () => {
    main(src, out, []);
    mkdirSync(join(src, "probe"));
    writeFileSync(join(src, "probe", "index.ts"), connectorSource("probe", "probeConnector"));

    expect(main(src, out, ["--check"]).code).toBe(1);
  });

  it("REFUSES a mistyped flag instead of falling through to writing the file", () => {
    // The worst failure this script has. `--check-stale` used to miss the
    // `argv.includes("--check")` test, so the command wrote the file it was asked to
    // verify and exited 0 — `pnpm verify` would have erased a hand edit and called the
    // registry up to date.
    main(src, out, []);
    writeFileSync(out, "// someone edited this by hand\n", "utf8");

    const result = main(src, out, ["--check-stale"]);
    expect(result.code).toBe(1);
    expect(result.message).toContain("--check-stale");
    expect(readFileSync(out, "utf8")).toBe("// someone edited this by hand\n");
  });

  it("reports a collection failure as an exit code rather than throwing", () => {
    writeFileSync(join(src, "rss", "index.ts"), "export const nothing = 1;\n", "utf8");
    const result = main(src, out, []);
    expect(result.code).toBe(1);
    expect(result.message).toContain("packages/connectors/src/rss/index.ts");
  });
});
