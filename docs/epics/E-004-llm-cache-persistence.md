---
id: E-004
title: "Персистентный LlmCache и учёт попаданий в отчёте прогона"
status: draft
priority: P2
size: M
autonomy: plan-gated
area: llm
depends_on: [E-001]
serialize: [prisma-schema, llm-costs, core-types, pipeline-contract]

costs_llm: true
touches_output: false
ui_visible: false
cloud_safe: false

claimed_by: ""
branch: ""
created: 2026-08-25
done: ""
discovered_from: "E-001"
---

# E-004: Персистентный LlmCache и учёт попаданий

## Цель

Повторный прогон на том же окне не оплачивает LLM повторно, и попадание в кэш видно в отчёте прогона числом, а не на слово.

## Контекст (читать перед начала, по порядку)

1. `packages/llm/src/client.ts` — на попадании в кэш происходит ранний возврат **без** `budget.record`, поэтому вызов не попадает ни в один отчёт.
2. `packages/llm/src/fixture-gateway.ts` — реплей не получает `BudgetGuard` вовсе и возвращает нулевой `usage`.
3. `packages/llm/src/cost.ts` — `cacheHitRate` считается по токенам **prompt caching** Anthropic, что не то же самое, что попадание в наш `LlmCache`. Две разные вещи под одним словом.
4. `packages/core/src/pipeline/memory-repo.ts` — `MemoryRepo` и `MemoryLlmCache` живут в пределах процесса; между прогонами не переживает ничего.
5. `packages/db/prisma/schema.prisma` — не существует. Шаг 12 плана E-001 не был сделан, и именно сюда он относится.

Критерий 2 эпика E-001 снят с галочки по итогам ревью: его вторая половина («в отчёте видно попадание в `LlmCache`») невыполнима по конструкции, а не просто не продемонстрирована.

## Объём — карта файлов

- `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/`, `packages/db/src/`
- `packages/llm/src/client.ts`, `packages/llm/src/cost.ts`, `packages/llm/src/fixture-gateway.ts`
- `packages/core/src/pipeline/stage.ts` (интерфейс `Repo`, если понадобится)
- `scripts/cost-report.mjs`

## Вне объёма

- Полная доменная схема БД — только то, что нужно кэшу и учёту прогонов.
- Дедупликация через pgvector и эмбеддинги.

## Критерии приёмки

- [ ] КОГДА прогон повторён на том же окне, ТО число оплаченных вызовов равно нулю, и это видно в `cost.json`
- [ ] КОГДА в отчёте печатается доля попаданий, ТО попадания в `LlmCache` и токены prompt caching различены и названы отдельно
- [ ] КОГДА попадание в кэш обслужило вызов, ТО оно записано в `BudgetGuard` с нулевой стоимостью, а не пропущено мимо учёта
- [ ] КОГДА прогнан `pnpm cost:report`, ТО дельта к baseline названа, и baseline обновлён в этом же PR

## Верификация

```bash
pnpm verify
pnpm digest:run --profile profiles/_test.ts --fixtures --dry-run
pnpm cost:report
pnpm db:status
```

## Границы

**Никогда:** называть prompt caching и `LlmCache` одним словом в отчёте; писать миграцию против общей БД из агентской сессии.

**Спросить заранее:** любая миграция; изменение формата `costs/baseline.json`.

## План реализации

_Заполняет read-only Plan-агент; владелец одобряет до кода._

## Заметки (append-only)

- 2026-08-25: заведён по итогам ревью E-001. Сюда же переносится пропущенный шаг 12 плана E-001 (Prisma-схема) — он не нужен ни одному критерию E-001, но нужен этому.
