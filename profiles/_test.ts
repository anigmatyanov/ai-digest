/**
 * The offline test profile.
 *
 * It points at recorded fixtures and carries no delivery channels, so a run against it
 * cannot publish even if every guard were removed. This is the only profile an agent runs
 * the pipeline against.
 */

import { defineProfile } from "./schema.js";

export const profile = defineProfile({
  slug: "test",
  title: "Test digest",
  lang: "ru",

  sources: [
    {
      key: "rss:simonwillison",
      kind: "rss",
      weight: 1.5,
      enabled: true,
      config: {
        feedUrl: "https://simonwillison.net/atom/entries/",
        sourceName: "Simon Willison",
      },
      fixture: "fixtures/rss/simonwillison.atom.xml",
    },
  ],

  cardTypes: {
    recipe: { title: "Приём", maxPerIssue: 4 },
    feature_impact: { title: "Что нового", maxPerIssue: 3 },
    case_study: { title: "Как это сделали", maxPerIssue: 2 },
    antipattern: { title: "Грабли", maxPerIssue: 2 },
  },

  prefilter: {
    // Wide on purpose: the fixture is frozen in time, and a narrow window would make the
    // golden run depend on the date it is executed.
    maxAgeDays: 3650,
    minBodyChars: 200,
    mustMatchAny: [],
    denyAny: ["\\b(airdrop|nft|we're hiring)\\b"],
  },

  selection: {
    cardsPerIssue: { min: 1, max: 4 },
    minScore: 0,
    requireEvidenceOk: true,
    maxPerSource: 4,
  },

  llm: {
    extract: { model: "claude-haiku-4-5", effort: "low" },
    compose: { model: "claude-sonnet-5", effort: "medium" },
    maxRunCostUsd: 1,
    maxCandidatesToExtract: 8,
  },

  prompts: {
    promptVersion: "test@1",
    domainBrief:
      "Аудитория — инженеры, ежедневно работающие с LLM-инструментами. Они знают, что такое промпт и токен.",
    whatCounts: {
      recipe: "Конкретный воспроизводимый приём: промпт, конфиг, хук, флаг CLI. Нужны шаги.",
      feature_impact: "Новая возможность инструмента ПЛЮС разбор, что она меняет в работе.",
      case_study: "«Как я построил X» с архитектурой и граблями, с конкретными решениями.",
      antipattern: "Что ломается, почему и как не наступить. Ценен механизм отказа.",
    },
    exclusions:
      "Не берём: раунды инвестиций, бенчмарки без выводов, маркетинговые анонсы без деталей, споры об AGI.",
    style:
      "Пиши по-русски, для коллег, на «ты». Плотно, без вводных абзацев. Английские термины оставляй как есть.",
  },

  // No channels: this profile renders, it never delivers.
  delivery: {},
});
