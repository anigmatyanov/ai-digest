---
id: E-006a
title: "Бочка packages/connectors/src/index.ts не должна расти на каждый коннектор"
status: draft
priority: P3
size: S
autonomy: auto
area: connectors
depends_on: [E-006]
serialize: []

costs_llm: false
touches_output: false
ui_visible: false
cloud_safe: true

claimed_by: ""
branch: ""
created: 2026-08-29
done: ""
discovered_from: E-006
---

# E-006a: пер-коннекторные ре-экспорты в бочке коннекторов

## Цель

Добавление коннектора не требует правки `packages/connectors/src/index.ts` — последнего
общего файла, который пер-коннекторный дифф ещё трогает.

## Контекст (читать перед началом, по порядку)

1. `packages/connectors/src/index.ts` — сейчас там четыре строки, две из которых
   специфичны для RSS:

   ```ts
   export { rssConnector, RssConfigSchema, RssCursorSchema } from "./rss/index.js";
   export type { RssConfig, RssCursor } from "./rss/index.js";
   ```

   Это шаблон: следующий коннектор скопирует его и допишет свои две строки. Ровно тот
   хотспот, который E-006 убрал из `profiles/schema.ts`, только на пакет ниже.

2. Измерено 2026-08-29 в ветке E-006: **у этих экспортов нет ни одного потребителя за
   пределами `packages/connectors`.** `packages/connectors/src/rss/index.test.ts`
   импортирует их относительным путём (`./index.js`), `registry.ts` — тоже. Проверка:

   ```bash
   grep -rn "rssConnector\|RssConfig\|RssCursor" --exclude-dir=node_modules --exclude-dir=dist . \
     | grep -v "^./packages/connectors/src/rss/" | grep -v "^./packages/connectors/src/registry.ts"
   ```

3. [.claude/rules/backlog.md](../../.claude/rules/backlog.md) § serialize-реестр —
   «его можно сгенерировать? Если да — генерируй, а не запирай». Здесь, судя по пункту 2,
   ответ ещё проще: генерировать нечего, потому что экспортировать наружу нечего.

## Объём — карта файлов

- `packages/connectors/src/index.ts` — снять пер-коннекторные ре-экспорты.
- `packages/connectors/src/*/index.test.ts` — если какой-то тест ходил через бочку.

## Вне объёма

- `registry.ts` и генератор: они уже решают эту задачу и не меняются.
- Новые коннекторы.

## Критерии приёмки

- [ ] КОГДА в `packages/connectors/src/` добавлена директория с коннектором и запущен
      `pnpm gen:connectors`, ТО `git diff --name-only` относительно коммита, добавившего
      коннектор, не содержит `packages/connectors/src/index.ts`.
- [ ] КОГДА `packages/connectors/src/index.ts` не экспортирует символы конкретного
      коннектора, ТО `pnpm verify` зелёный — то есть у этих экспортов действительно не
      было потребителей.

## Верификация

```bash
pnpm verify
pnpm build && pnpm build:proof
```

## Границы

**Никогда:** трогать генерируемый `registry.ts` руками; добавлять коннекторы.

**Спросить заранее:** если у ре-экспортов найдётся живой потребитель за пределами пакета —
это меняет постановку, и решение о форме (генерировать бочку vs. импортировать по пути)
принимает владелец.

## План реализации

_Заполняет исполнитель._

## Заметки (append-only)

- 2026-08-29, найдено при исполнении E-006. Инлайн не сделано намеренно: карта файлов E-006
  сузила `packages/connectors/src/index.ts` до «одной строки ре-экспорта вкладов», а снятие
  чужих экспортов — правка вне этой границы (backlog.md § «Гранулярность идёт за картой»).
