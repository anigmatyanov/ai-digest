#!/usr/bin/env bash
# PostToolUse hook on Bash. After a push or a merge, sweeps branches that are already
# merged and worktree directories whose branch is gone.
#
# WHY: with several agents running, stale `agent/*` branches and orphaned worktree
# directories accumulate in days, not months, and `git worktree list` stops being readable.
#
# SAFETY — the two rules that matter:
#   1. Judge by `tool_input.command`, NEVER by the whole payload. PostToolUse payloads
#      include `tool_response`, so substring-matching the payload means that reading a file
#      which merely *mentions* `git push` triggers a sweep. This hook ends in branch
#      deletion; a sweep fired by `cat` is a data-loss bug.
#   2. `git branch -d` only, never `-D`. -d refuses to delete anything not fully merged, so
#      an agent's unmerged work cannot be swept away by mistake.
#
# FAIL CLOSED: on any doubt this hook does nothing. A missed sweep costs a stale directory;
# a wrong sweep costs work.
#
# NAMED LIMIT: it never removes a worktree whose branch still exists, even if the worktree
# is idle. /finish-branch owns that.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
payload="$(cat)"

[[ -f "$REPO_ROOT/.claude/hooks/post-git-cleanup.disabled" ]] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Rule 1: the command only. Not the payload, not the response.
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null)"
[[ -z "$cmd" ]] && exit 0
printf '%s\n' "$cmd" | grep -qE '(^|[[:space:];&|])git[[:space:]]+(push|merge)([[:space:]]|$)' || exit 0

git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1

current="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
swept=()
while IFS= read -r br; do
  [[ -z "$br" || "$br" == "$current" || "$br" == "main" ]] && continue
  # A branch checked out in a live worktree is still in use.
  git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | grep -qx "branch refs/heads/$br" && continue
  # Rule 2: -d, never -D.
  if git -C "$REPO_ROOT" branch -d "$br" >/dev/null 2>&1; then swept+=("$br"); fi
done < <(git -C "$REPO_ROOT" branch --merged main --format='%(refname:short)' 2>/dev/null)

if [[ ${#swept[@]} -gt 0 ]]; then
  printf '[post-git-cleanup] swept merged branches: %s\n' "${swept[*]}" >&2
fi
exit 0
