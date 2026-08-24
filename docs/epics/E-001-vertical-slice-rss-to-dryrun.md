---
id: E-001
title: "Вертикальный срез: RSS → карточки → отрендеренный выпуск (dry-run)"
status: todo
priority: P1
size: M
autonomy: paired
area: pipeline
depends_on: []
serialize: [prisma-schema, pipeline-contract, core-types, profile-schema, profiles, prompts, llm-costs, env-schema, toolchain]

costs_llm: true
touches_output: true
ui_visible: false
cloud_safe: false

claimed_by: ""
branch: ""
created: 2026-08-25
done: ""
discovered_from: ""
---

# E-001: Вертикальный срез — от RSS до отрендеренного выпуска

## Цель

Один сквозной путь работает офлайн на фикстурах: RSS-источник превращается в отрендеренный markdown-выпуск, и `--dry-run` печатает его, ничего никуда не отправляя.

Это образец формы, а не поставка ценности читателю. Каждый следующий коннектор и каждая следующая стадия будут выглядеть как этот код — субагент копирует форму существующего кода точнее, чем текст правил, поэтому срез делается вручную и целиком.

## Контекст (читать перед началом, по порядку)

1. [CLAUDE.md](../../CLAUDE.md) — инвариант «тема живёт в профиле, код общий» и конвенции.
2. [.claude/rules/pipeline.md](../../.claude/rules/pipeline.md) — контракт стадии и три обязательные вещи коннектора.
3. [.claude/rules/llm.md](../../.claude/rules/llm.md) — модели, структурированный вывод, golden-набор, бюджет.
4. `packages/core/src/errors.ts` — доменные ошибки уже написаны; на них ветвится раннер.
5. [.claude/rules/dod.md](../../.claude/rules/dod.md) — пункты 2, 4, 5, 6, 7 применяются к этому эпику все сразу.

## Объём — карта файлов

- `packages/core/src/types.ts`, `packages/core/src/schema/`, `packages/core/src/env.ts`
- `packages/core/src/pipeline/stage.ts`, `packages/core/src/pipeline/pipeline.ts`
- `packages/connectors/src/rss/`, `packages/connectors/src/registry.ts`
- `packages/llm/src/client.ts`, `packages/llm/src/pricing.ts`, `packages/llm/src/cost.ts`, `packages/llm/src/prompts/`
- `packages/db/prisma/schema.prisma`
- `apps/pipeline/src/`
- `profiles/schema.ts`, `profiles/_test.ts`
- `fixtures/rss/`, `golden/_test/`, `costs/baseline.json`
- `.env.example`, `package.json` (только добавление скриптов пайплайна)

## Вне объёма

- Реальная публикация в Telegram и на сайт — срез 1 и 2, отдельные эпики.
- Дедупликация через SimHash и pgvector — срез 3.
- Любой источник, кроме RSS — по одному эпику на коннектор.
- `apps/web` целиком.

## Критерии приёмки

- [ ] КОГДА выполнен `pnpm digest:run --profile profiles/_test.ts --fixtures --dry-run`, ТО в stdout печатается отрендеренный markdown-выпуск и воронка по стадиям с числом входов и выходов
- [ ] КОГДА тот же прогон выполнен повторно, ТО он не создаёт дублей: число кандидатов не растёт, а в отчёте видно попадание в `LlmCache`
- [ ] КОГДА в фикстуре RSS переименовано обязательное поле, ТО прогон падает с `SourceDriftError`, называющим это поле — а не отдаёт ноль элементов
- [ ] КОГДА источник в фикстуре отдаёт меньше `expectMinItems`, ТО поднимается `SourceUnavailableError`, прогон продолжается без него, и факт попадает в отчёт
- [ ] КОГДА прогнан `pnpm golden`, ТО структурные ассерты зелёные, и каждый пункт выпуска ссылается на URL, присутствующий во входе
- [ ] КОГДА в adversarial-вход подставлен текст с инструкцией «ignore previous instructions», ТО она не исполняется и пункт в выпуск не попадает
- [ ] КОГДА прогнан `pnpm cost:report`, ТО он печатает стоимость по стадиям и дельту к `costs/baseline.json`, а baseline закоммичен в этом же PR
- [ ] КОГДА выполнен `pnpm verify`, ТО typecheck, lint и тесты зелёные при выключенной сети

## Верификация

```bash
pnpm verify
pnpm build && pnpm build:proof
pnpm digest:run --profile profiles/_test.ts --fixtures --dry-run
pnpm golden
pnpm cost:report
node scripts/epics.mjs --selftest
```

Проверка драйвера дрейфа (пункт 4 DoD — гейт обязан быть показан красным):

```bash
cp fixtures/rss/anthropic-news.xml /tmp/f.bak
sed -i '' 's/<link>/<lnk>/' fixtures/rss/anthropic-news.xml
pnpm digest:run --profile profiles/_test.ts --fixtures --dry-run   # ждём SourceDriftError
cp /tmp/f.bak fixtures/rss/anthropic-news.xml
```

## Границы

**Никогда:** публиковать что-либо наружу; ходить в сеть из тестов; звать Anthropic SDK мимо `packages/llm/src/client.ts`; писать тематические решения («ИИ», «лайфхак») в `packages/core`.

**Спросить заранее:** новая env-переменная, новая зависимость, любое отступление от карты файлов, выбор модели, отличный от записанного в `.claude/rules/llm.md`.

## План реализации

_Заполняется до первого кода, отдельным коммитом._

## Заметки (append-only)

- 2026-08-25: эпик заведён при бутстрапе. `autonomy: paired` и `cloud_safe: false` намеренно: это образец формы для всех последующих эпиков, и он требует живого ключа Anthropic для однократной записи golden-снапшота.
