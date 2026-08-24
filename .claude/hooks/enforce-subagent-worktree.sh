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
#   * Writes performed through Bash (`echo > file`, `sed -i`). Bash is guarded by
#     live-effects-guard.sh for effects, not for paths; a determined `bash -c` can still
#     write anywhere. This hook covers the file tools, which is where it happens in practice.
#   * A sub-agent that never `cd`s into its worktree and whose cwd is the main tree: it is
#     blocked from writing, which is correct, but the message cannot name its worktree.
#   * Symlinked paths that resolve outside the worktree — normalisation is lexical.
#   * Paths OUTSIDE the repository entirely (/tmp, /dev/null, the scratchpad). Deliberate:
#     they are not this hook's business, and refusing them costs a retry every time.
#
# KILL SWITCH: .claude/hooks/enforce-subagent-worktree.disabled

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

# Lexical normalisation: collapse `.` and `..` without touching the filesystem, so a
# non-existent target is still judged correctly.
norm="$(printf '%s' "$target" | awk -F/ '{n=0; for(i=1;i<=NF;i++){ if($i=="."||$i==""){continue} else if($i==".."){ if(n>0) n-- } else { p[++n]=$i } } s=""; for(j=1;j<=n;j++) s=s"/"p[j]; if(s=="") s="/"; print s}')"

# Outside the repository: explicitly not our business (see NAMED LIMITS).
[[ "$norm" != "$REPO_ROOT"/* && "$norm" != "$REPO_ROOT" ]] && exit 0

WT_PREFIX="$REPO_ROOT/.claude/worktrees/"
if [[ "$norm" == "$WT_PREFIX"* ]]; then
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
