---
description: Merge a finished agent branch, close its epic, and clean up the worktree
argument-hint: "agent/<slug>"
---

# /finish-branch

## Жёсткие правила — никогда не нарушать

- НИКОГДА `git push --force`.
- НИКОГДА `git reset --hard`.
- НИКОГДА `git branch -D`. Только `-d` (безопасное удаление).
- НИКОГДА не удаляй удалённую ветку.
- Если что-то выглядит неправильно — грязное дерево, push не прошёл, ветка не смержена — **STOP и доложи**. Не импровизируй в обход гейта.

## Шаги

**1. Pre-check.** Дерево чистое, ты на `main`, `git pull --ff-only`.

**2. Rebase-clean гейт.** Это то, что ловит конфликты, которые `--plan` предсказать не мог:

```bash
git merge-tree --write-tree main "$BR" >/dev/null 2>&1 || {
  echo "Ветка не мержится чисто на текущий main."
  echo "STOP. Верни её на ребейз — не ребейзи автоматически."
  exit 1
}
```

**3. Squash-merge и закрытие эпика одним коммитом.** Порядок нагружен смыслом: правка эпика попадает **в тот же** коммит, что и код, иначе история покажет фичу без закрытого контракта.

```bash
git merge --squash "$BR"
# в файле эпика: status: done, done: <YYYY-MM-DD>
git add docs/epics/E-NNN-<slug>.md
git commit -m "feat(E-NNN): <summary>"
git push origin main
```

**4. Уборка.**

> **`-d` не сработает после squash-merge, и это не ошибка.** Squash не оставляет ancestry,
> поэтому git считает ветку несмерженной навсегда, а `-D` запрещён правилом и стоит в
> `permissions.deny`. Правило существует, чтобы не потерять работу, — но оно же оставляет
> ветки копиться, и разрешить это противоречие может только владелец.
>
> Порядок: докажи, что содержимое уже в main, и покажи доказательство владельцу.
>
> ```bash
> git diff --stat main "$BR"    # пусто (кроме флипа статуса эпика) = всё в main
> ```
>
> Непустой дифф означает, что что-то не доехало: СТОП. Пустой — ветка безвредна и ждёт
> решения владельца; агент её не удаляет.

```bash
git branch -d "$BR"                                   # ожидаемо откажет после squash — см. выше
git worktree remove ".claude/worktrees/<slug>"
rm -rf ".claude/worktrees/.slots/<N>"                 # освободить слот
command -v neonctl >/dev/null && neonctl branches delete "$BR"
git worktree prune
```

**5. Отчёт.** Что смержено, какой эпик закрыт, какой слот освобождён, что осталось в очереди (`node scripts/epics.mjs --plan`).

**Деплой:** пуш в `main` не публикует выпуск. Пайплайн запускается по расписанию в GitHub Actions.
