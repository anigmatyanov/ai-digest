/**
 * registry.ts is generated, which is exactly why it needs a test: nothing else asserts
 * that what the generator emits behaves. The whole `getConnector` failure message could be
 * deleted and every other test in the repository would stay green.
 *
 * Written against whatever connectors exist rather than against "rss", so adding one does
 * not make this file another per-connector edit.
 */

import { describe, expect, it } from "vitest";
import { connectors, getConnector, sourceVariants } from "./registry.js";

describe("getConnector", () => {
  it("returns the connector registered under a known kind", () => {
    const kind = Object.keys(connectors)[0];
    expect(kind).toBeDefined();
    expect(getConnector(kind as string)).toBe(
      (connectors as Record<string, unknown>)[kind as string],
    );
  });

  it("fails naming the kind it got, the kinds it knows, and the command to run", () => {
    // `undefined` returned from a lookup surfaces three stages later as "cannot read
    // property fetch of undefined", which says nothing about the profile that caused it.
    expect(() => getConnector("definitely-not-a-connector")).toThrow(
      /Unknown connector kind "definitely-not-a-connector"/,
    );
    expect(() => getConnector("definitely-not-a-connector")).toThrow(
      new RegExp(`Known kinds: .*${Object.keys(connectors)[0]}`),
    );
    expect(() => getConnector("definitely-not-a-connector")).toThrow(/pnpm gen:connectors/);
  });
});

describe("the two generated exports", () => {
  it("cover exactly the same kinds", () => {
    // They are emitted from one list, so drift means the template was edited by hand.
    // If they ever disagree, a profile could name a kind the pipeline cannot resolve —
    // validation green, run red.
    expect(sourceVariants.map((v) => v.kind).sort()).toEqual(Object.keys(connectors).sort());
  });

  it("carries a config schema for every kind", () => {
    for (const variant of sourceVariants) {
      expect(typeof variant.config.safeParse).toBe("function");
    }
  });
});
