---
id: E-008a
title: "Деградация источника в ingest не покрыта ни одним тестом"
status: draft
priority: P2
size: S
autonomy: auto
area: pipeline
depends_on: []
serialize: []

costs_llm: false
touches_output: false
ui_visible: false
cloud_safe: true

claimed_by: ""
branch: ""
created: 2026-08-29
done: ""
discovered_from: E-008
---

# E-008a: изоляция упавшего источника доказана транскриптом, а не тестом

## Цель

Прогон, в котором один источник упал, а остальные отработали, ломает сборку, если
изоляцию сломать — сегодня он остаётся зелёным.

## Контекст (читать перед началом, по порядку)

1. `apps/pipeline/src/ingest.ts` — `try/catch` вокруг каждого источника,
   `assertPlausibleYield` после исчерпания страниц, `options.degraded.push(...)`. Это и
   есть механизм, о котором говорит DoD #4 («прогон продолжается без источника, факт
   попадает в отчёт как degraded»).
2. Измерено 2026-08-29 в ветке E-008: **тестов у этого файла нет.**
   `apps/pipeline/src/` содержит только `run.test.ts`, и `grep -n degraded` по нему не
   находит ничего. `packages/connectors/src/*/index.test.ts` покрывают половину
   контракта — `assertPlausibleYield` бросает `SourceUnavailableError` — но не то, что
   раннер этот бросок ловит, не роняет прогон и доносит его до отчёта.
3. Живой транскрипт, которым это было показано в E-008 (профиль-скрэтч в `/tmp`,
   `--fixtures --dry-run`, источник `hn` с недостижимым `minPoints`):

   ```
   ! hn:frontpage degraded: [hn:frontpage] returned 0 items, fewer than the 1 a healthy
     window yields. …
     · stage ingest: 0 -> 6 (23ms)
   funnel (run …):
     ! hn:frontpage: [hn:frontpage] returned 0 items, …
   ```

   Транскрипт — доказательство, но не гейт (.claude/rules/testing.md § Что тестом не
   ловится): он не оставляет в репозитории ничего, что покраснеет завтра. Убери `catch` —
   и `pnpm verify` останется зелёным.

## Объём — карта файлов

- `apps/pipeline/src/ingest.test.ts` — новый файл.
- `apps/pipeline/src/ingest.ts` — только если тест покажет дефект; иначе не трогать.

## Вне объёма

- Новые коннекторы и правка существующих. Тест пишется на синтетическом коннекторе или
  на том, что есть в реестре, — он про раннер, а не про источник.
- Профили.

## Критерии приёмки

- [ ] КОГДА один из двух источников бросает `SourceUnavailableError`,
      ТО стадия `ingest` возвращает элементы второго, а не падает.
- [ ] КОГДА источник отдал меньше `expectMinItems`,
      ТО его ключ и причина попадают в `degraded`, и `formatFunnel` печатает их строкой `!`.
- [ ] КОГДА источник бросает не-доменную ошибку (`TypeError`),
      ТО она тоже изолируется и попадает в `degraded` с именем класса, а не роняет прогон.
- [ ] КОГДА `try/catch` вокруг источника удалён,
      ТО набор краснеет. Показать транскрипт.

## Верификация

```bash
pnpm verify
pnpm test -- ingest
```

## Границы

**Никогда:** сеть в тестах; правка коннекторов ради удобства теста.

## План реализации

_Заполняет исполнитель._

## Заметки (append-only)

_Только в конец._
