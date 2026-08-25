/**
 * Domain schemas. Types are inferred from these, never declared alongside them — a type
 * and a validator that are written separately drift, and the drift shows up as data that
 * type-checks but fails at a stage boundary.
 *
 * Nothing here knows the topic. `Card.type` is a set of shapes a piece of know-how can
 * take, not a set of AI subjects; a profile supplies what counts as each shape. A product
 * decision about "AI" or "lifehacks" in this file would be a defect (CLAUDE.md § invariant).
 */

import { z } from "zod";

/** UTC ISO-8601. Dates cross boundaries as strings and live as `Date` inside a stage. */
export const IsoDateTime = z.iso.datetime({ offset: true });

export const Url = z.string().url();

/** What a connector yields. It has no id yet — the repository assigns one. */
export const RawItemDraftSchema = z.object({
  /** Stable id *within the source*. Together with sourceKey it makes ingest idempotent. */
  externalId: z.string().min(1),
  url: Url,
  title: z.string().optional(),
  author: z.string().optional(),
  publishedAt: IsoDateTime.optional(),
  body: z.string().optional(),
  bodyFormat: z.enum(["text", "html", "markdown"]).default("text"),
  lang: z.string().length(2).optional(),
  /** points, comments, stars, views — whatever the source exposes. Scoring reads it. */
  signals: z.record(z.string(), z.number()).default({}),
});
export type RawItemDraft = z.infer<typeof RawItemDraftSchema>;

export const RawItemSchema = RawItemDraftSchema.extend({
  id: z.string().min(1),
  sourceKey: z.string().min(1),
  fetchedAt: IsoDateTime,
});
export type RawItem = z.infer<typeof RawItemSchema>;

/**
 * One candidate = one piece of news, however many sources carried it.
 *
 * The state machine lives here and only here. A second status on Card would desynchronise
 * from this one on the first retry, so Card is a payload, not a parallel automaton.
 */
export const CandidateStatus = z.enum([
  "new",
  "normalized",
  "duplicate", // terminal: folded into duplicateOfId
  "prefiltered_out", // terminal: cheap deterministic rules rejected it
  "extracted",
  "scored",
  "in_issue",
  "published",
  "rejected", // terminal: verifier or owner removed it
]);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

export const CandidateSchema = z.object({
  id: z.string().min(1),
  status: CandidateStatus,
  statusReason: z.string().optional(),

  canonicalUrl: Url,
  /** sha256(canonicalUrl). The uniqueness key that folds five sources into one candidate. */
  canonicalUrlHash: z.string().length(64),
  title: z.string(),
  lang: z.string().length(2).optional(),
  publishedAt: IsoDateTime.optional(),
  firstSeenAt: IsoDateTime,
  /** sha256 of the normalised text — the LLM cache key, so a rerun costs nothing. */
  contentHash: z.string().length(64),
  extractedText: z.string(),

  prefilterScore: z.number().min(0).max(1).optional(),
  score: z.number().min(0).max(1).optional(),
  scoreBreakdown: z.record(z.string(), z.number()).optional(),

  duplicateOfId: z.string().optional(),
  rawItemIds: z.array(z.string()).min(1),
  cycleId: z.string().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/**
 * A claim carries its own evidence.
 *
 * `quote` must appear verbatim in the source text; a deterministic check enforces that for
 * free, before any model is asked whether the quote actually supports the claim. This is
 * the cheapest defence against the most damaging failure mode, and it is why the schema
 * demands claims at all rather than accepting prose.
 */
export const ClaimSchema = z.object({
  text: z.string().min(1),
  quote: z.string().min(1).max(200),
  sourceUrl: Url,
  verified: z.boolean().default(false),
});
export type Claim = z.infer<typeof ClaimSchema>;

/** Shapes a piece of know-how can take. What fills each shape comes from the profile. */
export const CardType = z.enum(["recipe", "feature_impact", "case_study", "antipattern"]);
export type CardType = z.infer<typeof CardType>;

export const CardSchema = z.object({
  id: z.string().min(1),
  candidateId: z.string().min(1),
  type: CardType,
  /** Stable slug of the technique: vendor/area/technique. Repeat protection keys on it. */
  techniqueKey: z
    .string()
    .regex(/^[a-z0-9-]+(\/[a-z0-9-]+){1,3}$/, "expected vendor/area/technique"),
  slug: z.string().regex(/^[a-z0-9-]+$/),

  title: z.string().min(1),
  summary: z.string().min(1),
  body: z.string().min(1),
  steps: z.array(z.string()).max(7).default([]),
  tags: z.array(z.string()).max(6).default([]),

  claims: z.array(ClaimSchema).min(2),
  attribution: z.object({
    author: z.string().optional(),
    sourceName: z.string().min(1),
    sourceUrl: Url,
    publishedAt: IsoDateTime.optional(),
  }),

  /** False until every quote was found verbatim in the source. Gates entry to an issue. */
  evidenceOk: z.boolean().default(false),
  promptVersion: z.string().min(1),
});
export type Card = z.infer<typeof CardSchema>;

export const IssueSchema = z.object({
  id: z.string().min(1),
  topicSlug: z.string().min(1),
  /** ISO week, e.g. 2026-W35. One issue per cycle, enforced by the repository. */
  cycleId: z.string().regex(/^\d{4}-W\d{2}$/),
  number: z.number().int().positive(),
  title: z.string().min(1),
  intro: z.string(),
  cardIds: z.array(z.string()),
  createdAt: IsoDateTime,
  publishedAt: IsoDateTime.optional(),
});
export type Issue = z.infer<typeof IssueSchema>;
