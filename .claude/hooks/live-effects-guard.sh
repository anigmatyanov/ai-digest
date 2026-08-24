#!/usr/bin/env bash
# PreToolUse hook on Bash. Refuses commands that would have real, outward-facing effects.
#
# WHY THIS EXISTS AND WHY IT IS FIRST: in the reference project the worst an agent could do
# was drop a dev database. Here it can post to a real Telegram channel, deploy a site, or
# run the pipeline against the production Neon branch. Those are irreversible and public.
# A hook that rejects a command which does not exist yet is harmless; a hook added after an
# agent has already posted to the channel is useless. Publishing is CI's job, on a
# schedule — never an agent session's.
#
# DECISION SHAPE: two phases.
#   1. Cheap relevance test. Commands that cannot possibly have an outward effect pass
#      immediately — this is the overwhelming majority, and blocking them would make the
#      repo unusable.
#   2. For anything in the danger zone, parse strictly and FAIL CLOSED on ambiguity. The
#      cost of a false block is one retry with an explanation. The cost of a false pass is
#      a post in a real channel that cannot be unsent.
#
# NAMED LIMITS — forms this does NOT catch (it inspects the command string, so anything
# that hides the effect behind another layer of execution is out of reach):
#   * `bash -c "$(printf ...)"`, `eval`, base64-decoded payloads
#   * a script in the repo that publishes internally when invoked by an innocuous name
#   * an HTTP call written directly against api.telegram.org with a token from a file
#   * `xargs`-driven invocations
#   These are limits, not oversights: the hook is a rail against accident, not a sandbox
#   against a determined actor.
#
# ESCAPE HATCH: ALLOW_LIVE_EFFECTS=1 as an environment prefix. It is deliberately NOT
# mentioned in any sub-agent prompt — the owner uses it knowingly, from the main session.
#
# KILL SWITCH: .claude/hooks/live-effects-guard.disabled

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

[[ -f "$REPO_ROOT/.claude/hooks/live-effects-guard.disabled" ]] && {
  warn "[live-effects-guard] DISABLED by kill-switch file — real publishing is NOT blocked."; exit 0; }
command -v jq >/dev/null 2>&1 || exit 0

cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null)"
[[ -z "$cmd" ]] && exit 0

# The escape hatch is read from the command text, not the ambient environment: the owner
# types it in front of the command they mean to run, once.
[[ "$cmd" =~ (^|[[:space:];&|])ALLOW_LIVE_EFFECTS=1([[:space:]]) ]] && {
  warn "[live-effects-guard] bypassed via ALLOW_LIVE_EFFECTS=1 — this command may have real, irreversible effects."
  exit 0; }

# ── phase 1: is this even in the danger zone? ───────────────────────────────────
if ! printf '%s' "$cmd" | grep -qiE 'digest:run|digest-run|pipeline (run|publish)|--publish|publish|telegram|api\.telegram\.org|vercel|gh (workflow|api|release)|neonctl|prisma (migrate|db push)|revalidate|sendMessage'; then
  exit 0
fi

# ── phase 2: strict, fail-closed ────────────────────────────────────────────────

# Reading and inspecting is always fine — it is how an agent learns what publishing does.
if printf '%s' "$cmd" | grep -qE '^[[:space:]]*(cat|less|head|tail|bat|grep|rg|sed -n|awk|ls|find|wc|git (log|diff|show|status|grep)|node --check|bash -n|jq)[[:space:]]'; then
  exit 0
fi

case "$cmd" in
  *"--dry-run"*|*"--fixtures"*)
    # A dry run is the sanctioned path — unless it also carries a publish flag.
    if printf '%s' "$cmd" | grep -qE '\-\-publish|\-\-no-dry-run|\-\-live'; then
      deny "Blocked: the command combines --dry-run with a publishing flag, so its real effect is ambiguous.
  command: $cmd
Run the pipeline with --dry-run --fixtures and nothing else. Publishing belongs to CI."
    fi
    exit 0
    ;;
esac

if printf '%s' "$cmd" | grep -qiE 'digest:run|digest-run|pipeline run'; then
  deny "Blocked: a pipeline run without --dry-run may publish to the real channel and write to the real database.
  command: $cmd
Use: pnpm digest:run --profile profiles/_test.ts --fixtures --dry-run
See CLAUDE.md § Команды. Publishing is done by CI on a schedule, never from an agent session."
fi

if printf '%s' "$cmd" | grep -qiE '\-\-publish|api\.telegram\.org|sendMessage|pipeline publish'; then
  deny "Blocked: this command would send a message through the Telegram Bot API.
  command: $cmd
A post to a channel cannot be unsent. Render the issue instead (--dry-run) and inspect the markdown."
fi

if printf '%s' "$cmd" | grep -qiE '(^|[[:space:];&|])vercel[[:space:]]+(deploy|--prod|promote|alias)'; then
  deny "Blocked: deploying the site from an agent session.
  command: $cmd
Deployment happens from CI. If you need to see the site, run the dev server on your slot port."
fi

if printf '%s' "$cmd" | grep -qiE 'gh[[:space:]]+workflow[[:space:]]+run|gh[[:space:]]+release[[:space:]]+create|gh[[:space:]]+api[[:space:]]+.*(-X|--method)[[:space:]]*(POST|PUT|PATCH|DELETE)'; then
  deny "Blocked: triggering a workflow or mutating GitHub state from an agent session.
  command: $cmd
Report what needs to run and let the owner trigger it."
fi

if printf '%s' "$cmd" | grep -qiE 'prisma[[:space:]]+(migrate[[:space:]]+(deploy|reset)|db[[:space:]]+push)'; then
  deny "Blocked: a schema-mutating Prisma command outside a dry run.
  command: $cmd
Inside a worktree, DATABASE_URL must point at this slot's Neon branch, not the shared one —
and .env silently supplies the shared value when the variable is unset. Pin the target inline
in the command, and use \`prisma migrate dev\` against your own branch."
fi

if printf '%s' "$cmd" | grep -qiE 'neonctl[[:space:]]+(branches[[:space:]]+delete|projects[[:space:]]+delete|databases[[:space:]]+delete)'; then
  deny "Blocked: deleting a Neon branch, database or project.
  command: $cmd
/finish-branch removes the slot's branch when the work merges. Nothing else should delete one."
fi

# In the danger zone, matched none of the sanctioned shapes: fail closed.
deny "Blocked: this command touches publishing, deployment or database state, and does not match a
known-safe shape, so the guard cannot tell whether its effects are real.
  command: $cmd
If it is genuinely safe, say what it does and let the owner run it, or re-issue it in a form the
guard recognises (--dry-run / --fixtures, or a read-only inspection command).
See .claude/hooks/live-effects-guard.sh § NAMED LIMITS."
