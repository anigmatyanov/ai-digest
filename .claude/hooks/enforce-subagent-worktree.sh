#!/usr/bin/env bash
# PreToolUse backstop on Edit|Write|MultiEdit|NotebookEdit. Blocks a sub-agent from
# writing outside its own worktree.
#
# WHY: intercept-agent-worktree.sh hands each sub-agent a directory, but nothing forces it
# to stay there. One agent writing into the main tree — or into a sibling's worktree —
# corrupts work that is not its own and shows up later as an inexplicable diff.
#
# SCOPE: only sessions that carry `.agent_id` (i.e. sub-agents). The parent session writes
# to the main tree by design and is never blocked here.
#
# NAMED LIMITS — what this does NOT catch:
#   * The worktree boundary through Bash. Since E-005 the repository boundary IS enforced
#     for Bash by bash-write-path-guard.sh, which shares is_scratch and the deny paragraph
#     with this hook via _paths.sh. The two rails are deliberately not identical: this one
#     also refuses a write into the MAIN tree or into a SIBLING worktree, the Bash one stops
#     at the repository. See that hook's own NAMED LIMITS for the write forms it misses.
#   * A sub-agent that never `cd`s into its worktree and whose cwd is the main tree: it is
#     blocked from writing, which is correct, but the message cannot name its worktree.
#   * Symlinked paths that resolve outside the worktree — normalisation is lexical.
#   * Symlinks that resolve out of the repository: normalisation is lexical, so a link
#     inside the tree pointing at ~/Desktop is still judged "inside". Resolving it would
#     mean touching the filesystem for a path that often does not exist yet.
#
# KILL SWITCH: .claude/hooks/enforce-subagent-worktree.disabled

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=_paths.sh
source "$(dirname "${BASH_SOURCE[0]}")/_paths.sh"
payload="$(cat)"
warn() { printf '%s\n' "$*" >&2; }

[[ -f "$REPO_ROOT/.claude/hooks/enforce-subagent-worktree.disabled" ]] && {
  warn "[enforce-subagent-worktree] DISABLED by kill-switch file."; exit 0; }
command -v jq >/dev/null 2>&1 || exit 0

agent_id="$(printf '%s' "$payload" | jq -r '.agent_id // ""' 2>/dev/null)"
[[ -z "$agent_id" ]] && exit 0   # parent session — not our business

target="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null)"
[[ -z "$target" ]] && exit 0
[[ "$target" != /* ]] && target="$PWD/$target"

# norm_path / is_scratch / outside_repo_reason live in _paths.sh — shared with
# bash-write-path-guard.sh so the two rails cannot drift apart on what "scratch" means.
norm="$(norm_path "$target")"

# Outside the repository: scratch space only, everything else denied.
#
# WHY THIS CHANGED (2026-08-29): this hook used to wave through every path outside
# $REPO_ROOT as "not our business". Measured that day: a sub-agent could create files in
# ~/Desktop and inside the sibling project ~/Desktop/_LMS, because nothing else stops it
# — there is no sandbox, no additionalDirectories, and the settings deny-list covers
# `rm -rf ~` but not ~/Desktop/anything. With 4-6 agents running at once, a mistyped
# absolute path lands in someone else's project and surfaces a week later as an
# inexplicable diff. Scratch paths still pass: refusing /tmp would cost a retry on every
# legitimate temporary file, and a temp file damages nothing.

WT_PREFIX="$REPO_ROOT/.claude/worktrees/"
if [[ "$norm" != "$REPO_ROOT"/* && "$norm" != "$REPO_ROOT" ]]; then
  is_scratch "$norm" && exit 0
  reason="$(outside_repo_reason "$norm" "$REPO_ROOT")"
elif [[ "$norm" == "$WT_PREFIX"* ]]; then
  own="${norm#"$WT_PREFIX"}"; own="${own%%/*}"
  cwd_own=""
  [[ "$PWD" == "$WT_PREFIX"* ]] && { cwd_own="${PWD#"$WT_PREFIX"}"; cwd_own="${cwd_own%%/*}"; }
  # Writing inside a worktree is fine when it is the one we are working in. When cwd is
  # not a worktree at all we cannot tell whose it is, so we allow it: this is a backstop,
  # and a false block here costs a retry on legitimate work.
  [[ -z "$cwd_own" || "$cwd_own" == "$own" ]] && exit 0
  reason="Blocked: this sub-agent is working in worktree '$cwd_own' but tried to write into '$own'.
  target: $norm
Write only inside your own worktree. File another agent's work as a note in the epic instead."
else
  reason="Blocked: sub-agents must not write into the main working tree.
  target: $norm
Your worktree was provisioned for you — cd into it (see the [managed-worktree: ...] marker
at the top of your prompt) and write there. If this genuinely belongs in the main tree, it
belongs to the parent session, not to you: report it instead of writing it."
fi

jq -n --arg r "$reason" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
warn "$reason"
exit 2
