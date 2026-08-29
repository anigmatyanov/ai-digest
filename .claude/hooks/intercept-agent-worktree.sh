#!/usr/bin/env bash
# PreToolUse hook on `Agent`. Gives every write-capable sub-agent its own git worktree.
#
# WHY: N sub-agents sharing one working tree corrupt each other's files and index. The
# preview slot is a side effect; isolation of the checkout is the point.
#
# FLOW: provision a worktree, then DENY this call once with a reason that tells the parent
# how to retry. The retry carries a marker and passes through. The sub-agent never learns
# a hook was involved — it just receives a working directory.
#
# PASS-THROUGH (no worktree):
#   * read-only subagent_type (they cannot write, so they cannot collide)
#   * description starting with `quick:` — the opt-out for one-line work
#   * prompt already carrying `[managed-worktree: ` — this is the retry
#
# NAMED LIMITS — cases this hook does NOT handle, deliberately:
#   * It does not clean up worktrees. `/finish-branch` does. An abandoned agent leaves a
#     worktree behind on purpose: losing an agent's work to an automatic sweep is worse
#     than a stale directory.
#   * It does not provision a Neon branch when `neonctl` is absent or unauthenticated; it
#     warns and leaves DATABASE_URL unset for the slot. A wrong DATABASE_URL is worse than
#     a missing one — the epic's verification will say so loudly.
#   * It isolates the DATABASE per slot, not the whole environment. ANTHROPIC_API_KEY and
#     the Telegram tokens are copied from the main tree's .env unchanged, on purpose: those
#     are about access, not isolation. See .claude/hooks/_slot-env.sh.
#   * It does not detect an `Agent` call whose description is empty AND whose prompt is
#     empty; that gets a hash-based slug and works, but the branch name is meaningless.
#   * It cannot tell a genuinely new task from a resumed one beyond branch-name identity.
#     Same description -> same slug -> the existing worktree is reused.
#
# KILL SWITCHES (each prints a warning — a forgotten switch must not silently disable
# the rail forever):
#   SKIP_AGENT_WORKTREE=1                      env, one command
#   .claude/hooks/intercept-agent-worktree.disabled   file, until removed

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=_toolchain.sh
source "$(dirname "${BASH_SOURCE[0]}")/_toolchain.sh"
# shellcheck source=_slot-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/_slot-env.sh"

WT_DIR="$REPO_ROOT/.claude/worktrees"
SLOT_DIR="$WT_DIR/.slots"
READ_ONLY_AGENTS="Explore Plan code-reviewer claude-code-guide statusline-setup"

payload="$(cat)"

warn() { printf '%s\n' "$*" >&2; }

# Fail OPEN on infrastructure problems: this is an isolation rail, not a security
# boundary, and a hook that cannot parse its input must not block all delegation.
if [[ -f "$REPO_ROOT/.claude/hooks/intercept-agent-worktree.disabled" ]]; then
  warn "[intercept-agent-worktree] DISABLED by kill-switch file — sub-agents share the main tree."
  exit 0
fi
if [[ "${SKIP_AGENT_WORKTREE:-0}" == "1" ]]; then
  warn "[intercept-agent-worktree] bypassed via SKIP_AGENT_WORKTREE=1."
  exit 0
fi
command -v jq >/dev/null 2>&1 || { warn "[intercept-agent-worktree] jq not found — passing through."; exit 0; }

jqr() { printf '%s' "$payload" | jq -r "$1" 2>/dev/null; }

subagent_type="$(jqr '.tool_input.subagent_type // ""')"
description="$(jqr '.tool_input.description // ""')"
prompt="$(jqr '.tool_input.prompt // ""')"

for ro in $READ_ONLY_AGENTS; do
  [[ "$subagent_type" == "$ro" ]] && exit 0
done
[[ "$description" == quick:* ]] && exit 0
[[ "$prompt" == *"[managed-worktree: "* ]] && exit 0

# ── slug ────────────────────────────────────────────────────────────────────────
# Truncate before transliterating: the description is model-authored text and this is
# the one place it reaches a shell. 200 chars is far more than five tokens need.
raw="${description:0:200}"
[[ -z "${raw// }" ]] && raw="${prompt:0:80}"

slug="$(printf '%s' "$raw" \
  | iconv -f UTF-8 -t ASCII//TRANSLIT 2>/dev/null \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
  | tr '-' '\n' \
  | grep -vxE 'a|an|the|to|of|for|in|on|at|fix|add|new|feature|agent|implement|create|update|make' \
  | grep -vx '' \
  | head -5 \
  | paste -sd- -)"

if [[ -z "$slug" ]]; then
  slug="agent-$(printf '%s' "$raw" | shasum | cut -c1-6)"
fi
slug="${slug:0:40}"; slug="${slug%-}"

branch="agent/$slug"
path="$WT_DIR/$slug"

# ── collisions, safety-first order ──────────────────────────────────────────────
if git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | grep -qx "worktree $path"; then
  existing="$(git -C "$REPO_ROOT" -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  if [[ "$existing" == "$branch" ]]; then
    :  # live worktree on our branch — reuse it (this is a re-dispatch after rework)
  else
    warn "[intercept-agent-worktree] $path exists on branch '$existing', not '$branch'. Refusing to touch it."
    exit 1
  fi
elif [[ -e "$path" ]]; then
  warn "[intercept-agent-worktree] $path exists but is not a registered worktree."
  warn "  Inspect it, then: rm -rf '$path' && git -C '$REPO_ROOT' worktree prune"
  exit 1
else
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    for n in 2 3 4 5 6 7 8 9; do
      if ! git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/${branch}-${n}"; then
        branch="${branch}-${n}"; slug="${slug}-${n}"; path="$WT_DIR/$slug"; break
      fi
    done
  fi
  mkdir -p "$WT_DIR"
  if ! git -C "$REPO_ROOT" worktree add "$path" -b "$branch" >/dev/null 2>&1; then
    warn "[intercept-agent-worktree] git worktree add failed for $branch — passing through unisolated."
    exit 0
  fi
fi

# ── slot: atomic claim via mkdir(2) ─────────────────────────────────────────────
# mkdir is the claim. A read-then-write registry hands the same slot to two branches.
mkdir -p "$SLOT_DIR"
slot=""
for n in $(seq 1 9); do
  if mkdir "$SLOT_DIR/$n" 2>/dev/null; then
    printf '%s\n' "$branch" > "$SLOT_DIR/$n/branch"; slot="$n"; break
  fi
  [[ "$(cat "$SLOT_DIR/$n/branch" 2>/dev/null)" == "$branch" ]] && { slot="$n"; break; }
done
[[ -z "$slot" ]] && slot=0
web_port=$((3100 + slot))

# ── provisioning (best effort; never fatal) ─────────────────────────────────────
( cd "$path" && pnpm install --silent >/dev/null 2>&1 ) || \
  warn "[intercept-agent-worktree] pnpm install did not complete in $path — the agent must run it."

# The slot's .env is a generated COPY, never a symlink. `ln -s` here meant every agent's
# DATABASE_URL resolved to the main tree's database while the Neon branch created for the
# slot went unused — measured 2026-08-29, see docs/epics/E-015. All of the decision-making
# lives in _slot-env.sh so the battery can exercise it; the note that comes back names the
# branch and the host and never the connection string.
db_note="$(slot_env_provision "$REPO_ROOT" "$path" "$branch")"

# ── one-shot deny with retry instructions ───────────────────────────────────────
reason="A worktree has been auto-provisioned for this sub-agent task:
  branch: $branch
  path:   $path
  slot:   $slot (web preview port $web_port)
  db:     $db_note

Retry the Agent call with these exact modifications and nothing else:
  - Prepend to .prompt, verbatim, including the brackets:
    \"[managed-worktree: $branch] Your working directory is $path. Run \\\`cd $path\\\` before any Edit, Write or Bash. Never write outside it.\"
  - Leave subagent_type, description and run_in_background unchanged.

This deny is one-shot: the retry passes through automatically. It is not an error.
For a one-line change that needs no isolation, prefix the description with 'quick:'."

jq -n --arg r "$reason" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
warn "$reason"
exit 2
