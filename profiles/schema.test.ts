/**
 * The source union is assembled from connector contributions, so these tests exercise the
 * ASSEMBLY on synthetic contributions rather than on whichever connectors happen to exist.
 * A test written against "rss" would keep passing after the mechanism stopped working and
 * only the one real connector kept it upright.
 *
 * The exception is the last block, which uses the real `SourceSchema`: an unknown kind has
 * to be rejected by the schema the pipeline actually loads, and that can be asserted
 * without naming any connector.
 */

import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import { buildSourceSchema, parseProfile, SourceSchema } from "./schema.js";
import { profile } from "./_test.js";

/** Two synthetic connectors. `chat` is the AC #3 example: `chanel` vs `channel`. */
const feedContribution = {
  kind: "feed",
  config: z.object({ feedUrl: z.string().url(), sourceName: z.string().min(1) }),
} as const;

const chatContribution = {
  kind: "chat",
  config: z.object({ channel: z.string().min(1), sinceId: z.number().optional() }),
} as const;

const Union = buildSourceSchema([feedContribution, chatContribution]);
/** Profile-shaped, so issue paths read the way a profile author sees them. */
const Sources = z.object({ sources: z.array(Union) });

describe("buildSourceSchema", () => {
  it("accepts every contributed kind with its own config, and applies the shared defaults", () => {
    // This is AC #1 in miniature: a second contribution validates with no edit to the
    // union itself — the tuple is the only thing that grew.
    expect(
      Union.parse({
        key: "feed:example",
        kind: "feed",
        config: { feedUrl: "https://e.com/f.xml", sourceName: "E" },
      }),
    ).toEqual({
      key: "feed:example",
      kind: "feed",
      weight: 1,
      enabled: true,
      config: { feedUrl: "https://e.com/f.xml", sourceName: "E" },
    });

    expect(
      Union.parse({ key: "chat:team", kind: "chat", config: { channel: "#team" } }),
    ).toMatchObject({
      kind: "chat",
      config: { channel: "#team" },
    });
  });

  it("reports a misspelled config field BY PATH, not as a vague union failure", () => {
    const result = Sources.safeParse({
      sources: [{ key: "chat:team", kind: "chat", config: { chanel: "#team" } }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("sources.0.config.channel");
  });

  it("does NOT catch a typo in an OPTIONAL field — the named limit, as behaviour", () => {
    // DoD #8: the limit is committed here rather than described in a comment, because a
    // comment cannot go red. zod strips unknown keys, so the runtime half of the typo
    // check only fires when the correctly spelled field is REQUIRED. `sinceId` is
    // optional, so `sinceld` parses clean and the entry loses the value silently.
    //
    // What still catches it is TypeScript, at the point the profile is written
    // (`TS2353: 'sinceld' does not exist in type ...`) — and nothing at all if a profile
    // is ever loaded from JSON. Widen this test the day that becomes possible.
    const result = Sources.safeParse({
      sources: [{ key: "chat:team", kind: "chat", config: { channel: "#team", sinceld: 5 } }],
    });

    expect(result.success).toBe(true);
    expect(result.data?.sources[0]?.config).toEqual({ channel: "#team" });
  });

  it("names the kind it GOT, and lists the ones it knows", () => {
    const result = Sources.safeParse({
      sources: [{ key: "nope:thing", kind: "nope", config: {} }],
    });

    const message = result.error?.issues[0]?.message ?? "";
    // zod's own wording here is `Invalid discriminator value. Expected 'feed'|'chat'` —
    // it says what it wanted and never what it received, which is the half that tells a
    // profile author whether they typo'd or forgot to run `pnpm gen:connectors`.
    expect(message).toContain('"nope"');
    expect(message).toContain("feed");
    expect(message).toContain("chat");
    expect(result.error?.issues[0]?.path.join(".")).toBe("sources.0.kind");
  });

  it("leaves zod's own wording alone for failures that are not an unknown kind", () => {
    // The custom message must not swallow every union issue: a source entry that is not
    // an object at all is a different mistake and deserves zod's description of it.
    const result = Sources.safeParse({ sources: [42] });
    expect(result.error?.issues[0]?.message).toMatch(/expected object/i);
    expect(result.error?.issues[0]?.message).not.toMatch(/unknown source kind/);
  });

  it("keeps a kind's config confined to that kind", () => {
    // Autocomplete's runtime shadow: a `chat` entry carrying a `feed` config is rejected,
    // which is what would stop being true if `config` collapsed to `unknown`.
    const result = Union.safeParse({
      key: "chat:team",
      kind: "chat",
      config: { feedUrl: "https://e.com/f.xml", sourceName: "E" },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("config.channel");
  });
});

describe("SourceSchema (built from the real connector contributions)", () => {
  it("rejects a kind no connector declares, and says which kinds exist", () => {
    const result = SourceSchema.safeParse({
      key: "nope:thing",
      kind: "definitely-not-a-connector",
      config: {},
    });

    expect(result.success).toBe(false);
    const message = result.error?.issues[0]?.message ?? "";
    expect(message).toContain('"definitely-not-a-connector"');
    expect(message).toContain("pnpm gen:connectors");
  });
});

describe("the half of a source entry that is the same for every kind", () => {
  // It moved out of the per-kind object into `sourceVariantSchema`, so it is now written
  // once and asserted once. Before this block, all three constraints could be deleted
  // together and the suite stayed green.

  it("requires a key shaped `kind:name`", () => {
    const result = Sources.safeParse({
      sources: [
        {
          key: "Feed Example",
          kind: "feed",
          config: { feedUrl: "https://e.com/f.xml", sourceName: "E" },
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path.join(".")).toBe("sources.0.key");
    expect(result.error?.issues[0]?.message).toContain("kind:name");
  });

  it("bounds weight to 0..3", () => {
    const entry = (weight: number) => ({
      sources: [
        {
          key: "feed:example",
          kind: "feed",
          weight,
          config: { feedUrl: "https://e.com/f.xml", sourceName: "E" },
        },
      ],
    });

    expect(Sources.safeParse(entry(3)).success).toBe(true);
    for (const bad of [-1, 3.5]) {
      const result = Sources.safeParse(entry(bad));
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path.join(".")).toBe("sources.0.weight");
    }
  });

  it("defaults weight and enabled rather than leaving them undefined", () => {
    // A source that forgot `enabled` must be on, and one that forgot `weight` must score
    // as an ordinary source — not as `undefined`, which the scorer would read as 0.
    const parsed = Union.parse({
      key: "feed:example",
      kind: "feed",
      config: { feedUrl: "https://e.com/f.xml", sourceName: "E" },
    });
    expect(parsed.weight).toBe(1);
    expect(parsed.enabled).toBe(true);
  });
});

describe("ProfileSchema", () => {
  it("accepts the offline test profile unchanged", () => {
    expect(() => parseProfile(profile)).not.toThrow();
  });

  it("refuses a profile with no sources at all", () => {
    // A digest with zero sources produces a silently empty issue, which reads to a reader
    // as a week in which nothing happened — the worst failure mode this project has.
    const result = ProfileSchemaProbe({ ...profile, sources: [] });
    expect(result.ok).toBe(false);
    expect(result.paths).toContain("sources");
  });

  it("refuses a source whose kind no connector declares", () => {
    const result = ProfileSchemaProbe({
      ...profile,
      sources: [{ ...profile.sources[0], kind: "definitely-not-a-connector" }],
    });
    expect(result.ok).toBe(false);
    expect(result.messages.join(" ")).toContain("definitely-not-a-connector");
  });
});

/** parseProfile throws; these tests want the issues, so unwrap once instead of everywhere. */
function ProfileSchemaProbe(value: unknown): {
  ok: boolean;
  paths: string[];
  messages: string[];
} {
  try {
    parseProfile(value);
    return { ok: true, paths: [], messages: [] };
  } catch (error) {
    const issues = error instanceof ZodError ? error.issues : [];
    return {
      ok: false,
      paths: issues.map((i) => i.path.join(".")),
      messages: issues.map((i) => i.message),
    };
  }
}
