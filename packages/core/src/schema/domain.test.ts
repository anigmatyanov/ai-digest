import { describe, expect, it } from "vitest";
import { CandidateSchema, CardSchema, ClaimSchema, IssueSchema, RawItemDraftSchema } from "./domain.js";

const url = "https://example.com/post";
const iso = "2026-08-25T10:00:00Z";
const hash = "a".repeat(64);

const claim = { text: "Hooks run before the tool call", quote: "hooks run first", sourceUrl: url };

const card = {
  id: "c1",
  candidateId: "cand1",
  type: "recipe",
  techniqueKey: "claude-code/hooks/pre-tool-use",
  slug: "pre-tool-use-hooks",
  title: "Хуки до вызова инструмента",
  summary: "Коротко о приёме",
  body: "Текст карточки",
  claims: [claim, { ...claim, text: "second" }],
  attribution: { sourceName: "Simon Willison", sourceUrl: url },
  promptVersion: "test@1",
};

describe("domain schemas", () => {
  it("should default bodyFormat and signals so a connector need not repeat them", () => {
    const parsed = RawItemDraftSchema.parse({ externalId: "1", url });
    expect(parsed.bodyFormat).toBe("text");
    expect(parsed.signals).toEqual({});
  });

  it("should reject a raw item without a stable external id", () => {
    // externalId is half of the ingest idempotency key; an empty one silently turns
    // every rerun into duplicate rows.
    expect(RawItemDraftSchema.safeParse({ externalId: "", url }).success).toBe(false);
  });

  it("should require at least two claims on a card", () => {
    // One claim is an assertion; the schema's job is to make a card carry its evidence.
    expect(CardSchema.safeParse({ ...card, claims: [claim] }).success).toBe(false);
    expect(CardSchema.safeParse(card).success).toBe(true);
  });

  it("should cap a quote at 200 characters", () => {
    // The legal frame is a short quotation with attribution, not a reprint. 200 is the
    // number written in docs/epics and in the plan — kept as a literal on purpose, so a
    // change to the schema cannot quietly agree with itself.
    const long = { ...claim, quote: "x".repeat(201) };
    expect(ClaimSchema.safeParse(long).success).toBe(false);
    expect(ClaimSchema.safeParse({ ...claim, quote: "x".repeat(200) }).success).toBe(true);
  });

  it("should reject a techniqueKey that is not vendor/area/technique", () => {
    // Repeat protection keys on this slug; a free-form string makes every card unique
    // and the protection inert.
    expect(CardSchema.safeParse({ ...card, techniqueKey: "hooks" }).success).toBe(false);
    expect(CardSchema.safeParse({ ...card, techniqueKey: "Claude/Hooks" }).success).toBe(false);
    expect(CardSchema.safeParse({ ...card, techniqueKey: "a/b/c/d" }).success).toBe(true);
  });

  it("should default evidenceOk to false", () => {
    // A card is untrusted until the deterministic quote check has run.
    expect(CardSchema.parse(card).evidenceOk).toBe(false);
  });

  it("should reject a cycleId that is not an ISO week", () => {
    const base = {
      id: "i1",
      topicSlug: "ai",
      number: 1,
      title: "Выпуск 1",
      intro: "",
      cardIds: [],
      createdAt: iso,
    };
    expect(IssueSchema.safeParse({ ...base, cycleId: "2026-08" }).success).toBe(false);
    expect(IssueSchema.safeParse({ ...base, cycleId: "2026-W35" }).success).toBe(true);
  });

  it("should require a candidate to name the raw items it came from", () => {
    // A candidate with no provenance cannot be attributed, and attribution is mandatory
    // before anything reaches a reader.
    const base = {
      id: "x",
      status: "normalized",
      canonicalUrl: url,
      canonicalUrlHash: hash,
      title: "t",
      firstSeenAt: iso,
      contentHash: hash,
      extractedText: "text",
    };
    expect(CandidateSchema.safeParse({ ...base, rawItemIds: [] }).success).toBe(false);
    expect(CandidateSchema.safeParse({ ...base, rawItemIds: ["r1"] }).success).toBe(true);
  });

  it("should reject a status outside the state machine", () => {
    expect(
      CandidateSchema.safeParse({
        id: "x",
        status: "almost_done",
        canonicalUrl: url,
        canonicalUrlHash: hash,
        title: "t",
        firstSeenAt: iso,
        contentHash: hash,
        extractedText: "text",
        rawItemIds: ["r1"],
      }).success,
    ).toBe(false);
  });
});
