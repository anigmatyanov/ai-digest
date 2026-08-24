#!/usr/bin/env bash
# Hook battery. Run: bash test/hooks/run.sh
#
# Every case here failed red at least once during development — this is not a formality.
# The git-add guard in particular shipped completely inert (a missing trailing newline
# meant `while read` never saw its only segment) and passed every dangerous command while
# looking healthy. That is the class of bug this file exists to keep out.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
pass=0; fail=0

# expect <want-exit> <label> <hook> <json>
expect() {
  local want="$1" label="$2" hook="$3" json="$4" cwd="${5:-$ROOT}"
  local got
  printf '%s' "$json" | (cd "$cwd" && bash "$ROOT/.claude/hooks/$hook") >/dev/null 2>&1
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1)); printf 'FAIL  %-46s want exit=%s got=%s\n' "$label" "$want" "$got"
  fi
}
cjson() { printf '{"tool_input":{"command":%s}}' "$(jq -Rn --arg c "$1" '$c')"; }

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq is required for the hook battery"; exit 0; }

# ── live-effects-guard ──────────────────────────────────────────────────────────
G=live-effects-guard.sh
expect 0 "safe: pnpm verify"                 $G "$(cjson 'pnpm verify')"
expect 0 "safe: sanctioned dry run"          $G "$(cjson 'pnpm digest:run --profile profiles/_test.ts --fixtures --dry-run')"
expect 0 "safe: reading publish source"      $G "$(cjson 'cat packages/telegram/src/publish.ts')"
expect 0 "safe: grep for telegram"           $G "$(cjson "grep -rn telegram packages/")"
expect 2 "block: run without --dry-run"      $G "$(cjson 'pnpm digest:run --profile profiles/ai-lifehacks.ts')"
expect 2 "block: --publish"                  $G "$(cjson 'pnpm digest:run --fixtures --publish')"
expect 2 "block: dry-run AND publish"        $G "$(cjson 'pnpm digest:run --fixtures --dry-run --publish')"
expect 2 "block: curl telegram api"          $G "$(cjson 'curl -X POST https://api.telegram.org/botX/sendMessage')"
expect 2 "block: vercel deploy --prod"       $G "$(cjson 'vercel deploy --prod')"
expect 2 "block: gh workflow run"            $G "$(cjson 'gh workflow run digest.yml')"
expect 2 "block: prisma migrate deploy"      $G "$(cjson 'npx prisma migrate deploy')"
expect 2 "block: neonctl branches delete"    $G "$(cjson 'neonctl branches delete main')"
expect 2 "block: ambiguous publish shape"    $G "$(cjson 'node dist/publish-everything.js --now')"
expect 0 "bypass: ALLOW_LIVE_EFFECTS=1"      $G "$(cjson 'ALLOW_LIVE_EFFECTS=1 pnpm digest:run --profile profiles/ai-lifehacks.ts')"

# ── git-add-pathspec-guard ──────────────────────────────────────────────────────
A=git-add-pathspec-guard.sh
expect 0 "safe: git add <path>"               $A "$(cjson 'git add packages/core/src/errors.ts')"
expect 0 "safe: git add <p1> <p2>"            $A "$(cjson 'git add a.ts b.ts')"
expect 0 "safe: git commit"                   $A "$(cjson "git commit -m x")"
expect 0 "safe: cat a file mentioning git add" $A "$(cjson 'cat .claude/hooks/git-add-pathspec-guard.sh')"
expect 2 "block: git add -A"                  $A "$(cjson 'git add -A')"
expect 2 "block: git add ."                   $A "$(cjson 'git add .')"
expect 2 "block: git add --all"               $A "$(cjson 'git add --all')"
expect 2 "block: git add -u"                  $A "$(cjson 'git add -u')"
expect 2 "block: bare git add"                $A "$(cjson 'git add')"
expect 2 "block: git add -A after &&"         $A "$(cjson 'pnpm verify && git add -A')"
expect 2 "block: git stage ."                 $A "$(cjson 'git stage .')"
expect 0 "bypass: SKIP_GIT_ADD_GUARD=1"       $A "$(cjson 'SKIP_GIT_ADD_GUARD=1 git add -A')"

# ── enforce-subagent-worktree ───────────────────────────────────────────────────
E=enforce-subagent-worktree.sh
mkdir -p "$ROOT/.claude/worktrees/_probe_mine" "$ROOT/.claude/worktrees/_probe_other"
MINE="$ROOT/.claude/worktrees/_probe_mine"
fj() { printf '{"agent_id":"a1","tool_input":{"file_path":"%s"}}' "$1"; }
expect 0 "parent session may write main tree" $E "$(printf '{"tool_input":{"file_path":"%s/packages/core/src/x.ts"}}' "$ROOT")"
expect 0 "sub-agent in its own worktree"      $E "$(fj "$MINE/src/x.ts")" "$MINE"
expect 0 "sub-agent writing outside the repo" $E "$(fj "/tmp/scratch.txt")" "$MINE"
expect 2 "block: sub-agent into main tree"    $E "$(fj "$ROOT/packages/core/src/x.ts")" "$MINE"
expect 2 "block: sub-agent into other tree"   $E "$(fj "$ROOT/.claude/worktrees/_probe_other/x.ts")" "$MINE"
expect 2 "block: .. traversal out"            $E "$(fj "$MINE/../../../CLAUDE.md")" "$MINE"
rmdir "$ROOT/.claude/worktrees/_probe_mine" "$ROOT/.claude/worktrees/_probe_other" 2>/dev/null

# ── intercept-agent-worktree (pass-through paths only; provisioning is not unit-testable) ──
I=intercept-agent-worktree.sh
aj() { printf '{"tool_input":{"subagent_type":"%s","description":"%s","prompt":"%s"}}' "$1" "$2" "$3"; }
expect 0 "pass: Explore is read-only"         $I "$(aj Explore 'search' 'find x')"
expect 0 "pass: Plan is read-only"            $I "$(aj Plan 'design' 'plan x')"
expect 0 "pass: quick: opt-out"               $I "$(aj general-purpose 'quick: fix typo' 'fix')"
expect 0 "pass: retry carries the marker"     $I "$(aj general-purpose 'add rss' '[managed-worktree: agent/rss] cd ...')"

# ── post-git-cleanup ────────────────────────────────────────────────────────────
C=post-git-cleanup.sh
expect 0 "cat mentioning git push does not sweep" $C '{"tool_input":{"command":"cat x.sh"},"tool_response":{"stdout":"git push"}}'

printf '\n%s: %d passed, %d failed\n' "hook battery" "$pass" "$fail"
[[ $fail -eq 0 ]] || exit 1
