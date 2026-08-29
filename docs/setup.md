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

### Приоритет источников ключа — грабля, измеренная 2026-08-25

`process.loadEnvFile()` (и любой dotenv-загрузчик) **не перезаписывает уже установленную переменную**. Если ключ экспортирован из `~/.zshrc`, значение из `.env` не применится — молча, без единой ошибки. Проверено здесь: после `loadEnvFile(".env")` в процессе оставался старый ключ из профиля оболочки.

Отсюда правило: **ключ живёт в одном месте, а не в двух.** Рекомендуемое место — `.env` (он в `.gitignore`, не утекает в каждый процесс машины и виден тому, кто читает репозиторий). Тогда:

```bash
# один раз: убрать экспорт из ~/.zshrc, либо запускать так
env -u ANTHROPIC_API_KEY pnpm digest:run --profile profiles/dist/_test.js --fixtures --dry-run --record
```

Проверить, какой ключ реально видит процесс:

```bash
node -e 'process.loadEnvFile(".env"); const k=process.env.ANTHROPIC_API_KEY||""; console.log(k.slice(0,14)+"…", k.length)'
```

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

**2.1. Аккаунт и авторизация CLI.** `neonctl` 4.3.0. Авторизация протухает — см. § 2.7; на 2026-08-29 требуется повторный `neonctl auth`.

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

**2.7. Ветки для агентских worktree.** Хук `intercept-agent-worktree.sh` создаёт ветку Neon на каждый worktree и **записывает её строки подключения в собственный `.env` слота** — обычный файл с правами 600, не симлинк. Общий `DATABASE_URL` в него не попадает: две переменные базы вырезаются, остальные секреты (`ANTHROPIC_API_KEY`, токены Telegram) копируются как есть — они про доступ, а не про изоляцию.

Пока `neonctl` не авторизован, хук пишет `DATABASE_URL is NOT provisioned for this slot ... and is ABSENT from its .env` и **не подставляет общую базу**: неверный `DATABASE_URL` хуже отсутствующего, потому что миграция уедет не туда молча. Прогоны `--fixtures` от этого не зависят вовсе. После `neonctl auth` это заработает само, но **только для worktree, созданных после** — уже выданный слот свой `.env` не перечитывает.

Симлинк, который здесь стоял до 2026-08-29, выглядел удобно ровно потому, что «всё работает сразу»: все агенты при этом делили одну базу, а созданные для них ветки Neon не использовал никто (E-015).

**Токен `neonctl` протухает молча.** Измерено 2026-08-29: `neonctl` при истёкшем refresh-токене печатает `Authentication failed, deleting credentials...`, удаляет `~/.config/neon/credentials.json` и уходит ждать браузер 60 секунд. Из агентской сессии это не чинится — нужен `neonctl auth` от владельца. Признак: у свежих worktree в `.env` нет `DATABASE_URL`.

Проверка (что видит слот — без строки подключения в выводе):

```bash
neonctl branches list                      # ветка на каждый живой worktree
neonctl me                                 # авторизован ли CLI вообще
cd .claude/worktrees/<slug> && pnpm db:status   # хост слота, не хост главного дерева
grep -c '^DATABASE_URL' .claude/worktrees/<slug>/.env   # 1 = провижининг прошёл, 0 = нет
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

Пароль `neondb_owner` однажды прошёл через переписку и считается засвеченным.

**`neonctl roles` умеет только `list`, `create`, `delete` — команды `reset-password` в CLI нет.** Путей два.

**Через консоль (короткий, рекомендуемый).** Neon Console → проект `ai-digest` → ветка `main` → Roles → `neondb_owner` → Reset password. Дальше перезаписать обе строки в `.env`:

```bash
neonctl connection-string --project-id jolly-art-09773061 --pooled   # -> DATABASE_URL
neonctl connection-string --project-id jolly-art-09773061            # -> DATABASE_URL_UNPOOLED
```

и обновить секреты в CI:

```bash
gh secret set DATABASE_URL --body "$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '\"')"
gh secret set DATABASE_URL_UNPOOLED --body "$(grep '^DATABASE_URL_UNPOOLED=' .env | cut -d= -f2- | tr -d '\"')"
```

**Через API.** Требует NEON_API_KEY (создаётся в Account settings → API keys), эндпоинт по документации Neon API v2 — вживую здесь не проверялся, потому что ключа нет:

```bash
ALLOW_LIVE_EFFECTS=1 curl -X POST \
  "https://console.neon.tech/api/v2/projects/jolly-art-09773061/branches/br-odd-wildflower-auvwcb49/roles/neondb_owner/reset_password" \
  -H "Authorization: Bearer $NEON_API_KEY"
```

Префикс `ALLOW_LIVE_EFFECTS=1` обязателен: команда мутирует состояние и намеренно блокируется хуком.

**Насколько это срочно.** База создана сегодня и пуста, доступ требует TLS, роль ограничена одной базой, а сам пароль не публиковался — риск низкий. Но ротация стоит трёх кликов, а «потом разберусь» с засвеченным паролем не проходит.

Правило на будущее: строку подключения не передавать через чат — забирать сразу в `.env` командой `neonctl connection-string`.
