/**
 * Card[] -> Issue -> markdown.
 *
 * Selection enforces the profile's quotas and the evidence rule; rendering turns the
 * result into the document a reader sees. Both are deterministic — nothing here calls a
 * model, which is what lets the golden set assert on structure.
 */

import { defineStage, type RunContext } from "../stage.js";
import type { Card, Issue } from "../../types.js";

export interface SelectionPolicy {
  cardsPerIssue: { min: number; max: number };
  minScore: number;
  requireEvidenceOk: boolean;
  maxPerSource: number;
}

export interface SelectProfile {
  slug: string;
  title: string;
  selection: SelectionPolicy;
  cardTypes: Record<string, { title: string; maxPerIssue: number }>;
}

export interface SelectionOutcome {
  selected: Card[];
  dropped: { id: string; reason: string }[];
}

export function selectCards(cards: Card[], profile: SelectProfile): SelectionOutcome {
  const { selection, cardTypes } = profile;
  const selected: Card[] = [];
  const dropped: { id: string; reason: string }[] = [];
  const perType = new Map<string, number>();
  const perSource = new Map<string, number>();

  for (const card of cards) {
    if (selection.requireEvidenceOk && !card.evidenceOk) {
      // A card whose quotes were not found verbatim never reaches a reader. This is the
      // last place that rule is applied, and it is applied by construction.
      dropped.push({ id: card.id, reason: "evidence check failed" });
      continue;
    }
    const typeCap = cardTypes[card.type]?.maxPerIssue ?? 0;
    const typeCount = perType.get(card.type) ?? 0;
    if (typeCount >= typeCap) {
      dropped.push({ id: card.id, reason: `type "${card.type}" already at its cap of ${typeCap}` });
      continue;
    }
    const host = card.attribution.sourceName;
    const sourceCount = perSource.get(host) ?? 0;
    if (sourceCount >= selection.maxPerSource) {
      dropped.push({ id: card.id, reason: `source "${host}" already at ${selection.maxPerSource}` });
      continue;
    }
    if (selected.length >= selection.cardsPerIssue.max) {
      dropped.push({ id: card.id, reason: "issue is full" });
      continue;
    }

    selected.push(card);
    perType.set(card.type, typeCount + 1);
    perSource.set(host, sourceCount + 1);
  }

  return { selected, dropped };
}

export const selectStage = defineStage<Card[], Issue>({
  name: "select",
  run(cards: Card[], ctx: RunContext): Promise<Issue> {
    const profile = ctx.profile as SelectProfile;
    const { selected, dropped } = selectCards(cards, profile);
    for (const d of dropped) ctx.log.debug(`select dropped ${d.id}: ${d.reason}`);

    if (selected.length < profile.selection.cardsPerIssue.min) {
      // Reported, not thrown: a thin issue is a signal for the owner, while an exception
      // here would discard cards that are perfectly publishable.
      ctx.log.warn(
        `select: ${selected.length} card(s), below the profile minimum of ` +
          `${profile.selection.cardsPerIssue.min}. The issue is thin.`,
      );
    }

    return Promise.resolve({
      id: `issue-${ctx.cycleId}`,
      topicSlug: profile.slug,
      cycleId: ctx.cycleId,
      number: 1,
      title: `${profile.title} — ${ctx.cycleId}`,
      intro: "",
      cardIds: selected.map((c) => c.id),
      createdAt: ctx.now.toISOString(),
    });
  },
});

/** Render an issue to markdown. Attribution is structural — a card cannot omit it. */
export function renderIssue(
  issue: Issue,
  cards: Card[],
  cardTypes: Record<string, { title: string }>,
): string {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const lines: string[] = [`# ${issue.title}`, ""];

  if (issue.intro) lines.push(issue.intro, "");

  if (issue.cardIds.length === 0) {
    lines.push("_Выпуск пуст._", "");
  }

  for (const [index, id] of issue.cardIds.entries()) {
    const card = byId.get(id);
    if (!card) continue;
    const kind = cardTypes[card.type]?.title ?? card.type;

    lines.push(`## ${index + 1}. ${card.title}`, "", `**${kind}** · ${card.summary}`, "");
    if (card.steps.length > 0) {
      lines.push(...card.steps.map((s, i) => `${i + 1}. ${s}`), "");
    }
    lines.push(card.body, "");
    if (card.tags.length > 0) lines.push(card.tags.map((t) => `\`${t}\``).join(" · "), "");
    lines.push(
      `Источник: [${card.attribution.sourceName}](${card.attribution.sourceUrl})`,
      "",
      "---",
      "",
    );
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export const renderStage = defineStage<Issue, string>({
  name: "render",
  async run(issue: Issue, ctx: RunContext): Promise<string> {
    const profile = ctx.profile as SelectProfile;
    const cards = await ctx.repo.listCards();
    return renderIssue(issue, cards, profile.cardTypes);
  },
});
