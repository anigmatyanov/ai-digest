#!/usr/bin/env bash
# PreToolUse hook on Bash. Allows a branch deletion whose work is provably already in main,
# and blocks one that would lose commits.
#
# WHY THIS REPLACED A FLAT BAN: `git branch -d` refuses after a squash merge — squash
# leaves no ancestry, so git considers the branch unmerged forever — and `-D` was banned
# outright. Between them, every finished epic left a branch behind and the owner had to
# approve each removal by hand. The ban protected against exactly one thing (losing
# unmerged work), and that thing is checkable, so it is checked instead of delegated to a
# human who will approve it every time anyway.
#
# THE CHECK: the branch's tree must be reachable from main. Two ways that can be true:
#   * ancestry — `git merge-base --is-ancestor <branch> main` (a normal merge), or
#   * content — `git diff --quiet main <branch>` (a squash merge: no shared history, but
#     nothing in the branch that main does not already have).
# The second is what makes squash workflows work. Neither is a guess.
#
# NAMED LIMITS — what this does NOT do:
#   * It does not consider the remote. A branch pushed and not merged upstream is still
#     deletable locally if main here contains its content; that is correct for a local ref.
#   * It compares against `main` only. A branch based on some other integration branch is
#     judged against main and will be refused — deliberately, since guessing the intended
#     base is how a guard starts approving the wrong thing.
#   * It cannot judge a deletion by wildcard or one driven through xargs; those reach the
#     fail-closed branch below and are refused rather than guessed at.
#   * It allows a branch whose ONLY difference from main is under docs/epics/. That is not
#     a loophole: /finish-branch writes the status flip (in-progress -> done) ON main in the
#     same commit as the squash, so a correctly finished branch differs by exactly that one
#     file and by nothing else. Any difference outside docs/epics/ is refused.
#
# KILL SWITCH: .claude/hooks/git-branch-delete-guard.disabled

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
payload="$(cat)"
warn() { printf '%s\n' "$*" >&2; }

deny() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  warn "$1"
  exit 2
}

[[ -f "$REPO_ROOT/.claude/hooks/git-branch-delete-guard.disabled" ]] && {
  warn "[git-branch-delete-guard] DISABLED by kill-switch file."; exit 0; }
command -v jq >/dev/null 2>&1 || exit 0

cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null)"
[[ -z "$cmd" ]] && exit 0

# Only judge an actual local branch deletion. Anything else is none of our business.
printf '%s\n' "$cmd" | grep -qE '(^|[[:space:];&|])git[[:space:]]+branch[[:space:]]+.*-[dD]([[:space:]]|$)' || exit 0

# Deleting a REMOTE branch is a different, outward-facing act and stays out of scope here.
printf '%s\n' "$cmd" | grep -qE 'push[[:space:]]+\S+[[:space:]]+--delete|push[[:space:]]+--delete' && exit 0

# Extract the branch names: tokens after the -d/-D flag that are not themselves flags.
#
# Written without `mapfile`: macOS ships bash 3.2, where it does not exist, and the hook
# would die with a syntax error at load — silently passing everything, since a hook that
# cannot start blocks nothing.
branches=""
while IFS= read -r seg; do
  set -- $seg
  [ "${1:-}" = "git" ] && [ "${2:-}" = "branch" ] || continue
  shift 2 2>/dev/null || continue
  seen_flag=0
  for t in "$@"; do
    case "$t" in
      -d|-D|--delete) seen_flag=1 ;;
      -*) ;;
      *) [ "$seen_flag" = "1" ] && branches="$branches $t" ;;
    esac
  done
done <<EOF
$(printf '%s\n' "$cmd" | tr ';&|' '\n')
EOF

branches="$(printf '%s' "$branches" | tr -s ' ' | sed 's/^ //')"

if [ -z "$branches" ]; then
  deny "Blocked: could not tell which branch this would delete, so it cannot be checked.
  command: $cmd
Name the branch explicitly: git branch -D <branch>"
fi

for br in $branches; do
  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$br" || {
    warn "[git-branch-delete-guard] '$br' is not a local branch — leaving it to git."
    continue
  }

  if git -C "$REPO_ROOT" merge-base --is-ancestor "$br" main 2>/dev/null; then
    warn "[git-branch-delete-guard] '$br' is an ancestor of main — safe to delete."
    continue
  fi

  if git -C "$REPO_ROOT" diff --quiet main "$br" 2>/dev/null; then
    warn "[git-branch-delete-guard] '$br' has no content main lacks (squash-merged) — safe to delete."
    continue
  fi

  # A plain `git diff main <branch>` is symmetric and answers the wrong question: it also
  # lists everything main gained AFTER the merge, so a branch that is merely behind looks
  # identical to one holding unmerged work. Measured here — two files main had moved on
  # were reported as "work that would be lost".
  #
  # The question that matters is per file: did THIS BRANCH change it, and if so, did that
  # change reach main? Compare each file the branch touched since the merge base against
  # both sides.
  base="$(git -C "$REPO_ROOT" merge-base main "$br" 2>/dev/null)"
  outside=""
  for f in $(git -C "$REPO_ROOT" diff --name-only "$base" "$br" 2>/dev/null); do
    case "$f" in docs/epics/*) continue ;; esac
    on_branch="$(git -C "$REPO_ROOT" rev-parse "$br:$f" 2>/dev/null || echo missing)"
    on_main="$(git -C "$REPO_ROOT" rev-parse "main:$f" 2>/dev/null || echo missing)"
    # The branch's version is what main has right now: arrived, untouched since.
    [ "$on_branch" = "$on_main" ] && continue

    # Or main once held exactly this blob and has moved on since. Without this, a file the
    # branch delivered and main then edited is indistinguishable from one that never
    # arrived — measured on live-effects-guard.sh, delivered by the branch and amended on
    # main an hour later. Walking main's history for the file answers it exactly rather
    # than guessing from a symmetric diff.
    arrived=0
    for c in $(git -C "$REPO_ROOT" rev-list main -- "$f" 2>/dev/null); do
      if [ "$(git -C "$REPO_ROOT" rev-parse "$c:$f" 2>/dev/null)" = "$on_branch" ]; then
        arrived=1
        break
      fi
    done
    [ "$arrived" = "1" ] && continue

    outside="$outside $f"
  done
  outside="$(printf '%s' "$outside" | tr ' ' '\n' | grep -v '^$' || true)"

  if [ -z "$outside" ]; then
    warn "[git-branch-delete-guard] every file '$br' touched is present on main with the same content — safe to delete."
    continue
  fi

  ahead="$(git -C "$REPO_ROOT" rev-list --count "main..$br" 2>/dev/null || echo '?')"
  files="$(printf '%s\n' "$outside" | head -5 | sed 's/^/    /')"
  deny "Blocked: '$br' still holds work that main does not have.
  commits ahead of main: $ahead
  files that differ (outside docs/epics/):
$files

This is the one thing the deletion guard exists for. Merge it, or prove the content is in
main and re-run — a branch whose tree matches main is deleted without asking.
  git diff --stat main $br"
done

exit 0
