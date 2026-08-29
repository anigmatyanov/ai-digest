/**
 * The AI life-hacks digest — the first real topic.
 *
 * Everything subject-specific about this digest lives in this file. `packages/` knows
 * nothing about AI, prompts or life-hacks, and the acceptance test of that claim is the
 * second profile on an unrelated subject building an issue with a zero diff under
 * `packages/`.
 *
 * Sources are limited to the three connectors that exist: `rss`, `hn`, `github`. Anthropic's
 * engineering blog, Bluesky, `t.me/s/` and YouTube belong here too and are deliberately
 * absent — writing a source for a connector that does not exist produces a profile that
 * fails validation, which is a worse kind of reminder than a line in an epic.
 */

import { defineProfile } from "./schema.js";

export const profile = defineProfile({
  slug: "ai-lifehacks",
  title: "AI-лайфхаки",
  lang: "ru",

  sources: [
    // ── practitioners writing about what they actually did ──────────────────────
    {
      key: "rss:simonwillison",
      kind: "rss",
      // The highest density of reproducible technique per post of anything in this list.
      weight: 2,
      enabled: true,
      config: {
        feedUrl: "https://simonwillison.net/atom/everything/",
        sourceName: "Simon Willison",
      },
    },
    {
      key: "rss:latent-space",
      kind: "rss",
      weight: 1.5,
      enabled: true,
      config: { feedUrl: "https://www.latent.space/feed", sourceName: "Latent Space" },
    },
    {
      key: "rss:raschka",
      kind: "rss",
      weight: 1.5,
      enabled: true,
      config: {
        feedUrl: "https://magazine.sebastianraschka.com/feed",
        sourceName: "Sebastian Raschka",
      },
    },

    // ── vendor changelogs: what changed, from the people who changed it ─────────
    {
      key: "github:claudecode",
      kind: "github",
      weight: 1.5,
      enabled: true,
      config: {
        owner: "anthropics",
        repo: "claude-code",
        feed: "releases",
        sourceName: "Claude Code releases",
        // All three are declared with defaults in the connector and are nonetheless
        // required here — and `branch` means nothing at all for a releases feed. `Profile`
        // is inferred from the schema's OUTPUT, so every default is mandatory at authoring
        // time. That makes defaults decorative and forces a profile to state values it does
        // not mean. Filed as E-017; spelled out rather than worked around.
        branch: "main",
        excludeTitlePatterns: [],
        excludeAuthorPatterns: [],
      },
    },
    {
      key: "rss:openai",
      kind: "rss",
      weight: 1,
      enabled: true,
      config: { feedUrl: "https://openai.com/news/rss.xml", sourceName: "OpenAI" },
    },
    {
      key: "rss:huggingface",
      kind: "rss",
      weight: 1,
      enabled: true,
      config: { feedUrl: "https://huggingface.co/blog/feed.xml", sourceName: "Hugging Face" },
    },

    // ── the community noticing things ───────────────────────────────────────────
    {
      key: "hn:frontpage",
      kind: "hn",
      weight: 1,
      enabled: true,
      config: {
        // 100 is where a story has been read by enough people that the comments are worth
        // something. Lower floods the funnel with links nobody checked; higher starts
        // dropping the narrow, technical posts this digest is actually for.
        minPoints: 100,
        sourceName: "Hacker News",
        // Spelled out although the connector declares a default. `Profile` is inferred from
        // the schema's OUTPUT, where defaults are already applied and therefore required, so
        // a default in a connector's config buys a profile author nothing. Named here rather
        // than worked around silently — see the note in this epic.
        tags: "story",
      },
    },
    {
      key: "rss:lobsters",
      kind: "rss",
      weight: 1,
      enabled: true,
      config: { feedUrl: "https://lobste.rs/t/ai,ml.rss", sourceName: "Lobsters" },
    },
    {
      // Every commit to a curated list is somebody having found a technique that worked.
      // Noisier than a blog and closer to practice.
      key: "github:awesomeclaudecode",
      kind: "github",
      weight: 0.8,
      enabled: true,
      config: {
        owner: "hesreallyhim",
        repo: "awesome-claude-code",
        feed: "commits",
        branch: "main",
        sourceName: "awesome-claude-code",
        excludeTitlePatterns: ["^Merge (pull request|branch)"],
        excludeAuthorPatterns: ["\\[bot\\]$"],
      },
    },
    {
      key: "github:awesomemcp",
      kind: "github",
      weight: 0.8,
      enabled: true,
      config: {
        owner: "punkpeye",
        repo: "awesome-mcp-servers",
        feed: "commits",
        branch: "main",
        sourceName: "awesome-mcp-servers",
        excludeTitlePatterns: ["^Merge (pull request|branch)"],
        excludeAuthorPatterns: ["\\[bot\\]$"],
      },
    },
  ],

  cardTypes: {
    recipe: { title: "Приём", maxPerIssue: 4 },
    feature_impact: { title: "Что нового", maxPerIssue: 3 },
    case_study: { title: "Как это сделали", maxPerIssue: 2 },
    antipattern: { title: "Грабли", maxPerIssue: 2 },
  },

  prefilter: {
    // A week plus slack for a cron that ran late. Unlike the test profile's 3650, this one
    // must NOT be wide: the window is what keeps a weekly digest weekly.
    maxAgeDays: 10,
    // Below this there is nothing to extract a technique from — it is a link, not a post.
    minBodyChars: 600,
    mustMatchAny: [],
    denyAny: [
      // Funding, hiring and marketing carry no technique. Written as whole words so
      // "seed data" and "series of" survive.
      "\\b(raises|funding round|series [a-z]|we're hiring|now hiring)\\b",
      "\\b(airdrop|nft|token sale)\\b",
      // Position pieces. The digest is about what to do on Monday, not about AGI.
      "\\b(agi|superintelligence|existential risk)\\b",
    ],
  },

  selection: {
    cardsPerIssue: { min: 5, max: 10 },
    minScore: 0.35,
    requireEvidenceOk: true,
    // Two per source keeps one prolific blog from becoming the issue.
    maxPerSource: 2,
  },

  llm: {
    extract: { model: "claude-haiku-4-5", effort: "low" },
    compose: { model: "claude-opus-5", effort: "high" },
    // Budgeted from the measured baseline of E-001 ($0.046 for 6 extract calls) scaled to
    // this funnel, with headroom. A run that exceeds it finishes the stage it is on and
    // reports, rather than dying — see BudgetGuard.
    maxRunCostUsd: 4,
    maxCandidatesToExtract: 45,
  },

  prompts: {
    promptVersion: "ai-lifehacks@1",
    domainBrief:
      "Аудитория — инженеры, которые каждый день работают с LLM-инструментами: Claude Code, " +
      "Cursor, MCP, агенты, RAG. Они знают, что такое промпт, токен и контекстное окно, и им " +
      "не нужно это объяснять. Им нужно то, что можно применить на этой неделе.",
    whatCounts: {
      recipe:
        "Конкретный воспроизводимый приём: промпт, конфиг, хук, флаг CLI, структура файла. " +
        "Обязательны шаги, по которым читатель повторит это у себя. Без шагов это не приём.",
      feature_impact:
        "Новая возможность инструмента ПЛЮС разбор, что она меняет в ежедневной работе. " +
        "Анонс без «что теперь можно делать иначе» не годится.",
      case_study:
        "«Как я построил X»: архитектура, конкретные решения и — обязательно — грабли. " +
        "История успеха без единой трудности почти всегда реклама.",
      antipattern:
        "Что ломается, почему и как не наступить. Ценен механизм отказа, а не сам факт.",
    },
    exclusions:
      "Не берём: раунды инвестиций и найм, бенчмарки без выводов, маркетинговые анонсы без " +
      "технических деталей, споры об AGI и рисках, пересказы чужих постов без своего опыта, " +
      "и туториалы уровня «что такое промпт».",
    style:
      "Пиши по-русски, для коллег, на «ты». Плотно, без вводных абзацев и без «в современном " +
      "мире». Английские термины оставляй как есть: prompt caching, tool use, context window. " +
      "Если приём требует команды или конфига — приводи их дословно.",
  },

  // Empty until E-010 lands the Telegram publisher. A profile that names a channel before
  // the code to deliver to it exists is a profile that lies about what a run will do.
  delivery: {},
});
