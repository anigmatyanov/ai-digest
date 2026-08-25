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

/** Source entries are a discriminated union on `kind` — that is what buys the typo check. */
const RssSourceSchema = z.object({
  key: z.string().regex(/^[a-z0-9]+:[a-z0-9-]+$/, "expected kind:name, e.g. rss:openai"),
  kind: z.literal("rss"),
  /** Contribution to the authority component of the score. */
  weight: z.number().min(0).max(3).default(1),
  enabled: z.boolean().default(true),
  config: z.object({
    feedUrl: z.string().url(),
    sourceName: z.string().min(1),
  }),
  /** Offline runs read this file instead of the network. */
  fixture: z.string().optional(),
});

export const SourceSchema = z.discriminatedUnion("kind", [RssSourceSchema]);
export type Source = z.infer<typeof SourceSchema>;

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
