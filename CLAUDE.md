# CLAUDE.md

Guidance for Claude Code working in this repository.

## Что это

**AI Digest** — автономный еженедельный дайджест лайфхаков по работе с ИИ. Пайплайн сам собирает источники, отбирает, кластеризует, пишет выпуск и публикует его на сайт и в Telegram. Тема **не зашита в код**: она задаётся файлом-профилем в `profiles/`, и второй профиль на другую тему обязан работать без правок в `packages/*`.

Это главный архитектурный инвариант: **любая тематическая специфика живёт в профиле, любой код — общий.** Продуктовое решение про «ИИ», «лайфхак» или «промпт», записанное в `packages/core`, — дефект. Приёмочный тест инварианта — профиль `appsec`, собирающий выпуск при нулевом диффе в `packages/`.

## Стек и раскладка

- TypeScript end-to-end, **Node 24**, pnpm workspaces, ESM, `type: module`.
- `apps/web` — Next.js (App Router) на Vercel. Преимущественно SSG. Здесь же вебхук Telegram и `/api/revalidate`.
- `apps/pipeline` — CLI-раннер, точка входа для GitHub Actions.
- `packages/core` — доменные типы, стадии, автомат состояний, оркестратор. Топик-агностично.
- `packages/db` — Prisma (Neon Postgres + pgvector), миграции, ретеншн, векторные запросы.
- `packages/connectors` — плагины источников, директория на источник. `index.ts` **генерируется**.
- `packages/llm` — каскад Claude, кэш, бюджет, верификатор доказательств, промпты.
- `packages/telegram` — Bot API: публикация, вебхук, рендер постов.
- `profiles/` — TS-профили тем. `fixtures/` — записанные ответы источников. `golden/` — замороженные входы и эталонные выпуски. `costs/` — baseline стоимости.
- `docs/epics/` — очередь работы для агентов. `scripts/` — CLI-обвязка.

### Окружение (грабля, измеренная 2026-08-25)

**В системном `PATH` этой машины лежит Node v20.15 (EOL с апреля 2026), а не Node 24.** Рабочий Node 24 стоит через Homebrew и не слинкован: `/opt/homebrew/opt/node@24/bin`. Формулы `node@20` и `node@22` в этом brew **сломаны** — их динамические библиотеки (`icu4c`, `simdjson`) снесены апгрейдом, `node --version` падает с `dyld: Library not loaded`.

`pnpm` ставится через corepack и по умолчанию доступен только как `corepack pnpm`. Этого **недостаточно**: скрипт `verify` внутри себя вызывает `pnpm typecheck`, и вложенный вызов упадёт с `sh: pnpm: command not found`. Нужен настоящий `pnpm` в `PATH`.

Перед любой командой в этом репозитории:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
corepack enable --install-directory ~/.local/bin   # один раз; затем ~/.local/bin в PATH
node --version   # обязан напечатать v24.x, а не v20.x
```

## Команды

```bash
pnpm install
pnpm verify           # typecheck + lint + test — ЭТО главный гейт, он же в CI на каждом PR
pnpm typecheck        # tsc -b
pnpm lint             # eslint, с типизированными правилами
pnpm test             # vitest
pnpm build            # tsc -b
pnpm rebuild          # clean + build — когда нужна честная сборка с нуля
pnpm build:proof      # проверка АРТЕФАКТА, а не exit-кода (см. ниже)
pnpm format           # prettier --write
```

**Сборку доказывай артефактом, а не exit-кодом.** Измерено на этом репозитории 2026-08-25: если `*.tsbuildinfo` уцелел, а `dist/` удалён, `tsc -b` считает, что делать нечего — **exit 0 и пустой `dist/`**. Воспроизведение: `rm -rf packages/core/dist && pnpm typecheck; ls packages/core/dist`. Поэтому после сборки — `pnpm build:proof`, а не `echo $?`.

**Никогда не запускай пайплайн с реальными эффектами из агентской сессии.** Публикация в Telegram, `vercel deploy`, `gh workflow run` и прогон против прод-ветки Neon блокируются хуком `.claude/hooks/live-effects-guard.sh`. Прогоны — только `--dry-run` и `--fixtures`.

## Архитектура пайплайна

`ingest → normalize → dedupe → prefilter → triage → extract → verify → score → select → compose → review → publish → index`

- Стадия — чистая функция `(input, ctx) => output`. Она не знает, откуда пришли данные и куда пойдут. `if (source === "…")` внутри `score` или `compose` — дефект.
- В сеть и БД — только через `ctx.repo` и `ctx.llm`. Это то, что делает golden-прогон офлайн-воспроизводимым.
- **Работа выбирается по статусу строки, а не по номеру шага.** Прогон можно убить в любой момент и перезапустить без дублей и повторной оплаты LLM.
- LLM участвует ровно в двух местах: `triage`/`extract` (отбор) и `compose` (написание). Больше нигде.
- **Стадия, получившая пустой вход там, где исторически было непусто, падает.** Тихо пустой выпуск — худший режим отказа: он выглядит как «на этой неделе ничего не было».

Детали: [.claude/rules/pipeline.md](.claude/rules/pipeline.md), [.claude/rules/llm.md](.claude/rules/llm.md).

## Конвенции кода

- **Только именованные экспорты.** Исключения — конфиги инструментов и `page.tsx`/`layout.tsx`/`route.ts` в Next.js. Проверяется линтером.
- Файлы `kebab-case`, типы `PascalCase` без префикса `I`. Тесты рядом с исходником: `foo.ts` → `foo.test.ts`.
- **Все внешние данные проходят через zod-схему на границе** — ответ источника, профиль, env, ответ LLM. Внутри пайплайна `any`/`unknown` не путешествуют.
- **`process.env` читается только в `packages/core/src/env.ts`** (zod). Проверяется линтером.
- Ошибки — доменные классы из `packages/core/src/errors.ts`, никогда голый `Error`. Коннектор, упавший на сети, кидает `SourceUnavailableError`, и это не крашит прогон.
- **Никаких сетевых вызовов в тестах.** Проверяется: `test/setup/no-network.ts` подменяет `fetch` и падает с `NetworkAccessInTestError`, называя URL.
- Даты — UTC ISO-строки на границах, `Date` внутри. Абсолютные даты в тексте, никогда относительные.

## Правила параллельной работы агентов

Здесь одновременно работают несколько субагентов. Правила не про вежливость — про то, чтобы ветки мержились.

1. **Один эпик = один worktree = одна ветка `agent/<slug>` = один squash-PR.** Вызов `Agent` перехватывается хуком `.claude/hooks/intercept-agent-worktree.sh`: он создаёт worktree, ветку и слот, затем делает **одноразовый deny** с инструкцией по retry. Это нормальный путь, а не ошибка. Опт-аут для мелочи — префикс `quick:` в `description`.
2. **Субагент пишет только внутрь своего worktree.** Backstop — `enforce-subagent-worktree.sh`.
3. **Исполнитель НИКОГДА не трогает frontmatter эпика и текст критериев приёмки.** Только чекбоксы (по факту проверки), `## План реализации` и `## Заметки` (append-only, в самый конец). Это одновременно правило и механика: ветка, не трогающая frontmatter, squash-мержится поверх флипов статуса без конфликта.
4. **Перед веером агентов — `node scripts/epics.mjs --plan`, а не `--ready`.** `--plan` возвращает батч, безопасный к параллельному запуску, и карту файлов, которые уже правят живые ветки.
5. **Hotspot-файлы заперты serialize-метками.** Реестр — в [.claude/rules/backlog.md](.claude/rules/backlog.md). Файл из реестра в карте файлов → метка обязана быть во frontmatter.
6. **Работа вне карты файлов филится стабом-эпиком, а не делается инлайн.** Даже однострочная: инлайн-правка вне карты — коллизия, которую `--plan` не предсказывал.
7. **`git add` только с явным путём.** `git add -A`/`.`/`*` отклоняется хуком в любой сессии.
8. **`git stash` — репозиторный, а не твой.** Он общий на все worktree: твой `pop` может вытащить чужой WIP. Для сравнения с базой — отдельный worktree на нужном SHA, для парковки — коммит в свою ветку.
9. **После мержа `main` в живую ветку** — `pnpm install`, затем `pnpm db:status`, и только потом верификация. Красный прогон на непринятой миграции соседнего эпика выглядит как твой дефект и им не является.
10. **Ветку закрывает `/finish-branch agent/<slug>`.** Руками `git branch -D` — нельзя.

## Эпик-бэклог

Работа декомпозирована в одно-файловые эпики в [docs/epics/](docs/epics/). Один эпик = одна свежая агент-сессия. **Эпики никогда не переезжают между директориями** — терминальный статус живёт во frontmatter, очередь показывает скрипт.

```bash
node scripts/epics.mjs              # все эпики по статусам
node scripts/epics.mjs --ready      # что можно брать сейчас (+ причины блокировок)
node scripts/epics.mjs --plan       # безопасный параллельный батч + карта пересечений
node scripts/epics.mjs --validate docs/epics/E-0NN-*.md
node scripts/epics.mjs --stale      # мёртвые claim'ы
node scripts/epics.mjs --next-id
```

Команды цикла: `/epic-new`, `/epic-next`, `/epic-review`, `/finish-branch`. Мелочь идёт через `quick:` без эпика.

Правила процесса, права на правку и Definition of Done — [.claude/rules/backlog.md](.claude/rules/backlog.md) и [.claude/rules/dod.md](.claude/rules/dod.md).

## Границы — не строим

Постоянные продуктовые решения, а не отложенные фазы.

- **Не зашиваем тему в код.** Тематическое — в профиль.
- **Не строим CMS, редактор выпусков и админку контента.** Правка выпуска — правка markdown в репозитории.
- **Не строим свой планировщик.** Расписание — cron в GitHub Actions, точка.
- **Не строим аккаунты, подписки, платежи.** Читатель анонимен.
- **Не зовём Anthropic API мимо `packages/llm/src/client.ts`.**
- **Не ходим в сеть из тестов.** Никогда, ни под каким флагом.
- **Не публикуем ничего из агентской сессии.** Публикует только CI по расписанию.
- **Не добавляем второй LLM-провайдер**, пока для этого не появится продуктовая причина, записанная в эпике.

## Указатели на правила

- [.claude/rules/backlog.md](.claude/rules/backlog.md) — процесс эпиков, права, serialize-реестр, автономия.
- [.claude/rules/dod.md](.claude/rules/dod.md) — Definition of Done.
- [.claude/rules/pipeline.md](.claude/rules/pipeline.md) — коннекторы, стадии, профили, фикстуры.
- [.claude/rules/llm.md](.claude/rules/llm.md) — модели, промпты, кэш, стоимость, golden-набор.
- [.claude/rules/web.md](.claude/rules/web.md) — Next.js, SSG, границы импорта.
- [.claude/rules/testing.md](.claude/rules/testing.md) — тесты, фикстуры, что чем ловится.
