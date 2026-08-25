# Первичная настройка

Пошагово: что уже сделано, что нужно сделать руками, и как это проверить. Каждый шаг заканчивается командой, которая либо печатает ожидаемое, либо честно падает.

## Состояние на 2026-08-25

| Что                          | Состояние                                         |
| ---------------------------- | ------------------------------------------------- |
| Node 24 + pnpm               | ✅ глобально, префиксы к `PATH` не нужны          |
| Репозиторий                  | ✅ `github.com/anigmatyanov/ai-digest`, приватный |
| `ANTHROPIC_API_KEY` локально | ✅ экспортирован в `~/.zshrc`                     |
| `ANTHROPIC_API_KEY` в CI     | ⬜ нужен `gh secret set`                          |
| Проект в Neon                | ⬜                                                |
| Telegram-бот                 | ⬜ понадобится в срезе 1, не сейчас               |

## 1. `ANTHROPIC_API_KEY`

**Локально уже работает** — ключ экспортирован из `~/.zshrc`, ничего делать не нужно. `.env` для него не заводим: две копии одного секрета расходятся, и потом не понять, какая используется.

Проверка, что он видим процессу и не самоссылающийся (эта форма ломает `dotenv-expand` в Prisma рекурсией — в LMS каждый процесс Prisma умирал с `RangeError: Maximum call stack size exceeded`):

```bash
node -e 'const v=process.env.ANTHROPIC_API_KEY||"";
console.log(v.startsWith("sk-ant-") ? "ok, real key" : "PROBLEM: not a key");
console.log(/\$\{?ANTHROPIC_API_KEY\}?/.test(v) ? "PROBLEM: self-referential" : "ok, no self-reference")'
```

**Для CI** ключ нужен отдельно — GitHub Actions не видит твой `~/.zshrc`:

```bash
gh secret set ANTHROPIC_API_KEY --body "$ANTHROPIC_API_KEY"
gh secret list          # должен показать ANTHROPIC_API_KEY
```

Секреты репозитория не видны в логах и не отдаются форкам. Значение после записи прочитать нельзя — только перезаписать.

## 2. Проект в Neon

**Настроено 2026-08-25, проверено запросом к базе:**

| | |
|---|---|
| project id | `jolly-art-09773061` |
| регион | `aws-us-east-1` (рядом с раннерами Actions) |
| версия | PostgreSQL 18.6 |
| `vector` | 0.8.6 — доступен, ещё не установлен (это делает миграция E-001) |
| `pg_trgm` / `pgcrypto` | 1.6 / 1.4 — доступны |
| FTS `russian` | есть — поиск по сайту будет с русской морфологией, а не `simple` |
| таблиц в `public` | 0 |
| холодный старт | ~660 мс на первом запросе, дальше ~500 мс |

Обе строки подключения лежат в `.env` (он в `.gitignore`). Проверка живости:

```bash
cd packages/db && node --input-type=module -e '
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
const url = /^DATABASE_URL="(.+)"$/m.exec(readFileSync("../../.env","utf8"))[1];
console.log((await neon(url)`select version()`)[0].version);
'
```

Free-тир: 0.5 ГБ хранилища, 100 CU-часов в месяц, scale-to-zero, pgvector в комплекте. Для еженедельного дайджеста этого хватает — при условии ретеншна (см. `.claude/rules/pipeline.md`), иначе 0.5 ГБ кончатся примерно за 8 месяцев.

**2.1. Аккаунт и авторизация CLI.** ✅ сделано. `neonctl` 4.3.0, авторизован.

```bash
neonctl auth          # откроет браузер; регистрация через GitHub — самый короткий путь
neonctl me            # должен напечатать твой email
```

**2.2. Проект.** Регион выбирай ближе к раннерам GitHub Actions — они в основном `us-east`; для Vercel это тоже удобно.

```bash
neonctl projects create --name ai-digest --region-id aws-us-east-1
neonctl projects list
```

**2.3. Строки подключения.** Их две, и путать их нельзя:

```bash
neonctl connection-string --project-id <ID> --pooled     # DATABASE_URL          (хост с "-pooler")
neonctl connection-string --project-id <ID>              # DATABASE_URL_UNPOOLED (миграции и Prisma CLI)
```

Pooled — для приложения и пайплайна: Neon засыпает, а пул переживает пробуждение. Unpooled — для `prisma migrate`: миграции требуют прямого соединения и на пуле ведут себя непредсказуемо.

**2.4. Локальный `.env`.**

```bash
cp .env.example .env      # .env в .gitignore — он никогда не коммитится
```

Заполнить `DATABASE_URL` и `DATABASE_URL_UNPOOLED`. Остальное — по мере надобности.

**2.5. pgvector.** Расширение включается миграцией (`CREATE EXTENSION IF NOT EXISTS vector`), это часть E-001 — руками сейчас ничего делать не нужно.

**2.6. Секреты в CI:**

```bash
gh secret set DATABASE_URL --body "$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '\"')"
gh secret set DATABASE_URL_UNPOOLED --body "$(grep '^DATABASE_URL_UNPOOLED=' .env | cut -d= -f2- | tr -d '\"')"
```

**2.7. Ветки для агентских worktree.** Хук `intercept-agent-worktree.sh` пытается создать ветку Neon на каждый worktree — тогда параллельные агенты не дерутся за одну базу. Пока `neonctl` не авторизован, хук честно пишет `DATABASE_URL is NOT provisioned for this slot` и не подставляет общую базу: неверный `DATABASE_URL` хуже отсутствующего, потому что миграция уедет не туда молча. После `neonctl auth` это заработает само.

Проверка:

```bash
neonctl branches list --project-id <ID>
```

## 3. Telegram — позже

Понадобится в срезе 2 (окно отмены) и для публикации. Нужны будут `TELEGRAM_BOT_TOKEN` (от @BotFather), `TELEGRAM_CHANNEL_ID`, `TELEGRAM_OWNER_ID` и `TELEGRAM_WEBHOOK_SECRET`. До тех пор пайплайн гоняется с `--dry-run`, а `live-effects-guard.sh` не даёт случайно отправить что-то в реальный канал.

## Проверка целиком

```bash
pnpm verify                       # typecheck + lint + tests + hook battery + registry selftest
node scripts/epics.mjs --plan     # что можно брать в работу
gh secret list                    # что уже есть в CI
neonctl me                        # авторизован ли Neon CLI
```

## Ротация пароля роли

Пароль `neondb_owner` был однажды передан через переписку и считается засвеченным. Ротация:

```bash
neonctl roles reset-password --project-id jolly-art-09773061 --name neondb_owner
```

**Эта команда намеренно блокируется** хуком `live-effects-guard.sh` — она мутирует состояние базы. Запускать её нужно осознанно, с префиксом `ALLOW_LIVE_EFFECTS=1`, либо из консоли Neon. После ротации перезаписать обе строки в `.env` (см. 2.3) и, если секреты уже в CI, обновить их там.

Правило на будущее: строку подключения не передавать через чат — забирать сразу в `.env` командой `neonctl connection-string`.
