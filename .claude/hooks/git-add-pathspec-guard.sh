#!/usr/bin/env bash
# PreToolUse hook on Bash. Rejects `git add` without an explicit pathspec.
#
# WHY: `git add -A` sweeps whatever else is in the tree — a sibling agent's in-flight edit,
# a stray build artefact, a local .env. In the main working tree that is how one session's
# commit silently swallows another's work.
#
# SCOPE NOTE: inside a worktree `git add -A` only sweeps that worktree, so the risk is
# smaller there — but the habit is what matters, and a commit is easier to prevent than to
# unpick. This applies to every session, parent included.
#
# NAMED LIMITS — forms deliberately not caught (the list is short on purpose; extend it
# when an agent actually tries one, not in anticipation):
#   * `bash -c "git add -A"`, `eval`, aliases, `xargs git add`
#   * `git -C <dir> add -A`
#   * brace expansion resolving to a bare directory
#
# KILL SWITCHES: SKIP_GIT_ADD_GUARD=1 (env prefix) or .claude/hooks/git-add-pathspec-guard.disabled

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
payload="$(cat)"
warn() { printf '%s\n' "$*" >&2; }

[[ -f "$REPO_ROOT/.claude/hooks/git-add-pathspec-guard.disabled" ]] && {
  warn "[git-add-pathspec-guard] DISABLED by kill-switch file."; exit 0; }
# Fail OPEN without jq: this is a hygiene rail, and a broken parser must not stop all work.
command -v jq >/dev/null 2>&1 || exit 0

cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null)"
[[ -z "$cmd" ]] && exit 0
[[ "$cmd" =~ (^|[[:space:];&|])SKIP_GIT_ADD_GUARD=1([[:space:]]) ]] && {
  warn "[git-add-pathspec-guard] bypassed via SKIP_GIT_ADD_GUARD=1."; exit 0; }

# Split on shell separators so `foo && git add -A` is judged, not just a leading `git add`.
verdict=0
offending=""
while IFS= read -r seg; do
  # Parse tokens rather than substring-matching the payload: a command whose *output*
  # mentions "git add" (a `cat` of this very file) must not be judged as one.
  read -ra tok <<<"$seg"
  [[ ${#tok[@]} -lt 2 ]] && continue
  [[ "${tok[0]}" != "git" ]] && continue
  [[ "${tok[1]}" != "add" && "${tok[1]}" != "stage" ]] && continue

  paths=0
  for ((i = 2; i < ${#tok[@]}; i++)); do
    t="${tok[$i]}"
    case "$t" in
      -A|--all|-u|--update|--no-ignore-removal) verdict=1; offending="$seg"; break ;;
      .|./|\*|:/|:/\*)                          verdict=1; offending="$seg"; break ;;
      -*)                                       continue ;;
      *)                                        paths=$((paths + 1)) ;;
    esac
  done
  [[ $verdict -eq 1 ]] && break
  [[ $paths -eq 0 ]] && { verdict=1; offending="$seg"; break; }
# printf '%s\n', not '%s': without a trailing newline `while read` never yields the last
# (and for a single command, only) segment, and the guard silently passes everything.
# That is exactly how this hook first shipped green while checking nothing.
done < <(printf '%s\n' "$cmd" | tr ';&|' '\n' | sed 's/^[[:space:]]*//')

[[ $verdict -eq 0 ]] && exit 0

reason="Blocked: \`git add\` without an explicit pathspec.
  command: $offending
Stage the files you actually changed, by name:
  git add packages/core/src/foo.ts packages/core/src/foo.test.ts
\`-A\`, \`.\`, \`*\` and a bare \`git add\` sweep whatever else is in the tree — including a
sibling agent's in-flight work. Use \`git status --short\` to see what you touched.
Emergency bypass, knowingly: SKIP_GIT_ADD_GUARD=1 git add ..."

jq -n --arg r "$reason" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
warn "$reason"
exit 2
