---
id: E-003
title: "URL валидируется на границе, а не взрывается через две стадии"
status: todo
priority: P1
size: S
autonomy: plan-gated
area: pipeline
depends_on: [E-001]
serialize: [core-types, pipeline-contract]

costs_llm: false
touches_output: false
ui_visible: false
cloud_safe: true

claimed_by: ""
branch: ""
created: 2026-08-25
done: ""
discovered_from: "E-001"
---

# E-003: URL валидируется на границе

## Цель

Относительная или битая ссылка из фида отбраковывается на входе с понятной ошибкой, а не роняет прогон две стадии спустя, уже после оплаты вызова модели.

## Контекст (читать перед началом, по порядку)

1. `packages/core/src/pipeline/stages/normalize.ts:36` — `canonicaliseUrl` глотает провал `new URL()` и возвращает вход как есть.
2. `packages/core/src/pipeline/stages/extract.ts` — `new URL(candidate.canonicalUrl).hostname` в сборке `attribution`; здесь и происходит `TypeError`.
3. `apps/pipeline/src/ingest.ts` — `RawItem` собирается спредом, поэтому `RawItemSchema` (zod) не применяется ни разу.
4. [CLAUDE.md](../../CLAUDE.md) § Конвенции: «Все внешние данные проходят через zod-схему на границе». Сейчас правило записано, но не исполняется.

Найдено ревью E-001. Относительный `href` легален в Atom при `xml:base` и встречается у нескольких генераторов статических сайтов; `linkOf` возвращает его дословно. В фикстуре E-001 все ссылки абсолютные, поэтому дефект не проявляется — но этот срез является образцом формы, и следующий коннектор унаследует дыру.

## Объём — карта файлов

- `packages/core/src/pipeline/stages/normalize.ts`
- `packages/core/src/pipeline/stages/extract.ts`
- `packages/core/src/types.ts`, `packages/core/src/schema/`
- `apps/pipeline/src/ingest.ts`
- `packages/connectors/src/rss/`
- `fixtures/rss/`

## Вне объёма

- Разрешение относительных ссылок через `xml:base` для всех возможных диалектов — достаточно резолва относительно `feedUrl`.
- Изменение контракта стадии.

## Критерии приёмки

- [ ] КОГДА запись фида содержит относительный `href`, ТО он резолвится относительно `feedUrl` коннектора и становится абсолютным
- [ ] КОГДА ссылку невозможно привести к абсолютной, ТО элемент отбраковывается на стадии ingest с указанием источника и значения — прогон продолжается без него
- [ ] КОГДА фикстура содержит относительную ссылку, ТО прогон доходит до выпуска, а не падает с `TypeError` — и это показано красным на коде до починки
- [ ] КОГДА выполнен `pnpm verify`, ТО всё зелёное при выключенной сети

## Верификация

```bash
pnpm verify
pnpm test -- normalize
pnpm digest:run --profile profiles/_test.ts --fixtures --dry-run
```

## Границы

**Никогда:** глотать невалидный URL молча; чинить симптом в `extract` вместо границы.

**Спросить заранее:** любое расширение карты файлов; изменение формы `RawItem`.

## План реализации

_Заполняет read-only Plan-агент; владелец одобряет до кода._

## Заметки (append-only)

- 2026-08-25: заведён по итогам ревью E-001, подтверждено состязательной проверкой. Приоритет P1 не из-за частоты, а из-за наследования: E-001 объявлен образцом формы для всех коннекторов.
