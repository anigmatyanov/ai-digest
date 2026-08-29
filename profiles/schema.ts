/**
 * Topic profile schema — the only place a topic exists.
 *
 * A second profile on a different subject must produce an issue with zero changes under
 * packages/. That is the acceptance test of the whole architecture, not a nice-to-have.
 *
 * TypeScript rather than YAML: a discriminated union on `kind` gives autocomplete for a
 * source's config and a compile error on a typo, where YAML would surface `chanel:`
 * instead of `channel:` at runtime in production. Prompt fragments are multi-line
 * templates that compose, which YAML makes miserable.
 *
 * What keeps a profile *data* rather than code: it may import nothing from packages/
 * except this file. If a profile wants an `if`, that belongs in a stage.
 */

import { z } from "zod";
import { sourceVariants } from "@ai-digest/connectors";

/**
 * What a connector contributes to this schema: its `kind` and the schema of its config.
 *
 * The contributions arrive from `packages/connectors/src/registry.ts`, which is generated.
 * That is the point of the indirection: adding a source is a new directory under
 * `packages/connectors/src/` plus `pnpm gen:connectors`, and this file does not change.
 * A hand-written union here would make every connector epic edit a file under the
 * `profile-schema` serialize label, and connector epics would run one at a time.
 */
export interface SourceContribution<K extends string = string, C = unknown> {
  readonly kind: K;
  readonly config: z.ZodType<C>;
}

/**
 * The half of a source entry that is the same whatever the source is.
 *
 * Everything kind-specific is `config`, and it comes from the connector.
 */
export function sourceVariantSchema<K extends string, C>(kind: K, config: z.ZodType<C>) {
  return z.object({
    key: z.string().regex(/^[a-z0-9]+:[a-z0-9-]+$/, "expected kind:name, e.g. rss:openai"),
    kind: z.literal(kind),
    /** Contribution to the authority component of the score. */
    weight: z.number().min(0).max(3).default(1),
    enabled: z.boolean().default(true),
    config,
    /** Offline runs read this file instead of the network. */
    fixture: z.string().optional(),
  });
}

type SourceVariant<T extends SourceContribution> = ReturnType<
  typeof sourceVariantSchema<T["kind"], z.output<T["config"]>>
>;

/**
 * Mapped over the tuple, not `.map()`ed over an array: `z.discriminatedUnion` wants a
 * non-empty tuple of discriminable schemas, and the result of `Array.prototype.map` is a
 * plain array whose element type is the union of every variant. Going through the array
 * type is what collapses `config` to `unknown` — silently, with no compile error.
 */
type SourceVariantTuple<T extends readonly SourceContribution[]> = {
  -readonly [I in keyof T]: SourceVariant<T[I]>;
};

/**
 * Fold the connectors' contributions into the source union.
 *
 * Exported so a test can exercise the mechanism on synthetic contributions rather than on
 * whichever connectors happen to exist today.
 */
export function buildSourceSchema<
  const T extends readonly [SourceContribution, ...SourceContribution[]],
>(contributions: T) {
  const known = contributions.map((c) => c.kind);
  // The one cast in this file, and it is localised here on purpose: TypeScript cannot
  // prove that a mapped type over a generic non-empty tuple is itself non-empty, so the
  // runtime `.map()` has to be re-attached to the tuple type the union requires.
  const variants = contributions.map((c) =>
    sourceVariantSchema(c.kind, c.config),
  ) as SourceVariantTuple<T>;

  return z.discriminatedUnion("kind", variants, {
    error: (issue) => {
      // Only the union's own "nothing matched the discriminator" issue is reworded. zod
      // says `Invalid discriminator value. Expected 'rss'` — it lists what was expected
      // and never says what it got, which is the half a reader needs. Other codes (a
      // source entry that is not an object at all) keep zod's wording.
      if (issue.code !== "invalid_union") return undefined;
      const input: unknown = issue.input;
      const got =
        typeof input === "object" && input !== null && "kind" in input
          ? JSON.stringify(input.kind)
          : "(missing)";
      return (
        `unknown source kind ${got}. Known kinds: ${known.join(", ")}. ` +
        "A source's kind comes from a connector: add a directory under " +
        "packages/connectors/src/ and run `pnpm gen:connectors`."
      );
    },
  });
}

export const SourceSchema = buildSourceSchema(sourceVariants);
/**
 * `z.infer` (the OUTPUT type), never `z.input`. A connector declares
 * `configSchema: z.ZodType<TConfig>`, whose zod-4 input type is `unknown`; switching to
 * `z.input` would turn every `config` into `unknown` and take the typo check with it.
 */
export type Source = z.infer<typeof SourceSchema>;

/*
 * Compile-time guards on the two properties that make this schema worth writing in
 * TypeScript. They live in a BUILT file rather than in a test on purpose: build configs
 * exclude *.test.ts, so a type assertion in a test is not checked by anything that runs.
 *
 * `_sourceKindStaysLiteral` fails if the union widened to `kind: string`, which is what
 * the generated tuple losing its `as const` produces.
 *
 * `_sourceConfigStaysTyped` covers the three ways `config` degrades, because they degrade
 * to three DIFFERENT types and a guard against one of them silently misses the others:
 *   - `unknown` — `z.input` in place of `z.infer` (a connector's `z.ZodType<TConfig>` has
 *     `unknown` as its input type);
 *   - `never`   — a contribution typed through `AnyConnector`, i.e.
 *     `ConnectorDefinition<never, never>`;
 *   - `Record<string, unknown>` — the config schema weakened to `z.record`, the exact
 *     shortcut ## Границы of this epic forbids.
 * Every one of them still compiles and still validates; it just stops rejecting a
 * misspelled config field, which is the entire reason profiles are not YAML.
 */
type KindStaysLiteral<T extends string> = string extends T ? false : true;
type ConfigStaysTyped<T> = unknown extends T
  ? false
  : [T] extends [never]
    ? false
    : string extends keyof T
      ? false
      : true;
const _sourceKindStaysLiteral: KindStaysLiteral<Source["kind"]> = true;
const _sourceConfigStaysTyped: ConfigStaysTyped<Source["config"]> = true;

/*
 * Named limit (DoD #8): the runtime half of the typo check only fires when the correctly
 * spelled field is REQUIRED. zod strips unknown keys, so `sourceNam:` is reported as
 * `sources.0.config.sourceName: expected string, received undefined`. Misspell an
 * OPTIONAL field and validation passes — that case is caught by TypeScript at the point
 * the profile is written, and by nothing at all if a profile is ever loaded as JSON.
 */

export const CardTypePolicySchema = z.object({
  title: z.string().min(1),
  maxPerIssue: z.number().int().positive(),
});

export const ProfileSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  /** Language of the ISSUE, not of the sources. */
  lang: z.string().length(2),

  sources: z.array(SourceSchema).min(1),

  /** The shapes this topic's know-how takes, and how many of each an issue may carry. */
  cardTypes: z.record(
    z.enum(["recipe", "feature_impact", "case_study", "antipattern"]),
    CardTypePolicySchema,
  ),

  /** Deterministic, free, and run before any model is called. */
  prefilter: z.object({
    maxAgeDays: z.number().int().positive(),
    minBodyChars: z.number().int().nonnegative(),
    /** Serialised as strings so a profile stays data; compiled once at load. */
    mustMatchAny: z.array(z.string()).default([]),
    denyAny: z.array(z.string()).default([]),
  }),

  selection: z.object({
    cardsPerIssue: z.object({
      min: z.number().int().positive(),
      max: z.number().int().positive(),
    }),
    minScore: z.number().min(0).max(1),
    /** A card whose quotes were not found verbatim never reaches a reader. */
    requireEvidenceOk: z.boolean().default(true),
    maxPerSource: z.number().int().positive().default(2),
  }),

  llm: z.object({
    /** Model ids carry no date suffix — a suffixed id is an old form and returns 404. */
    extract: z.object({ model: z.string().min(1), effort: z.enum(["low", "medium", "high"]) }),
    compose: z.object({ model: z.string().min(1), effort: z.enum(["low", "medium", "high"]) }),
    /** A run that exceeds this stops on a stage boundary and reports what it has. */
    maxRunCostUsd: z.number().positive(),
    maxCandidatesToExtract: z.number().int().positive(),
  }),

  /** Topic-specific prompt fragments. The schema and the rules belong to packages/llm. */
  prompts: z.object({
    promptVersion: z.string().min(1),
    domainBrief: z.string().min(1),
    whatCounts: z.record(z.string(), z.string()),
    exclusions: z.string().min(1),
    style: z.string().min(1),
  }),

  /** Empty means "render only". A profile with no channels cannot publish by construction. */
  delivery: z
    .object({
      telegramChannelEnv: z.string().optional(),
      webBasePath: z.string().optional(),
    })
    .default({}),
});

export type Profile = z.infer<typeof ProfileSchema>;

/** Identity with a type check — the profile is validated again at load. */
export function defineProfile(profile: Profile): Profile {
  return profile;
}

export function parseProfile(value: unknown): Profile {
  return ProfileSchema.parse(value);
}
