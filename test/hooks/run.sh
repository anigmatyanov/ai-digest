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
# Offline Prisma renders SQL from a file and opens no connection; the word `migrate` used to
# put it in the danger zone and fail it closed. Keyed on the absence of a database endpoint,
# so the same subcommand pointed at a live database stays blocked.
#
# Measured: with the carve-out removed, exactly ONE of these turns red — `migrate diff
# --from-empty`. `validate` and `generate` carry no `migrate` and never entered the danger
# zone, so they are regression pins, not evidence for this change. The two `expect 2` cases
# are the ones that matter in the other direction: they prove the carve-out is not a bypass.
expect 0 "prisma: migrate diff from-empty"   $G "$(cjson 'prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script')"
expect 0 "prisma: validate"                  $G "$(cjson 'prisma validate')"
expect 0 "prisma: generate"                  $G "$(cjson 'prisma generate')"
expect 2 "block: migrate diff --from-url"    $G "$(cjson 'prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel prisma/schema.prisma')"
expect 2 "block: diff with shadow db url"    $G "$(cjson 'prisma migrate diff --from-empty --to-schema s.prisma --shadow-database-url postgres://x')"
expect 2 "block: diff from config datasource" $G "$(cjson 'prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script')"
expect 2 "block: prisma migrate dev"         $G "$(cjson 'prisma migrate dev --name init')"
# neonctl read verbs pass, mutating ones do not. Added after the guard blocked `neonctl me`
# during Neon setup: a false block on an inspection command is how a rail gets switched off
# for good. NOTE: this file cannot be written by a shell heredoc — the guard judges the whole
# command text, and the delete cases above appear inside it. Use a file-writing tool.
# `gh api` GETs pass, anything that makes gh switch to POST does not. Added 2026-08-29
# after the guard blocked a lookup of an action's commit SHA while CI was being written.
expect 0 "gh api: plain GET"                   $G "$(cjson 'gh api repos/actions/checkout/git/ref/tags/v5 --jq .object.sha')"
expect 0 "gh api: compound GET loop"           $G "$(cjson 'for r in a b; do gh api repos/$r --jq .id; done')"
expect 0 "gh: pr list is a read"               $G "$(cjson 'gh pr list --state open')"
expect 0 "gh: run view is a read"              $G "$(cjson 'gh run view 12345 --log-failed')"
expect 2 "gh api: -X POST is not a read"       $G "$(cjson 'gh api repos/x/y/issues -X POST')"
expect 2 "gh api: -f implies POST"             $G "$(cjson 'gh api repos/x/y/issues -f title=bug')"
expect 2 "gh: read prefixed onto an effect"    $G "$(cjson 'gh pr list && gh workflow run digest.yml')"
expect 2 "gh: secret set is not a read"        $G "$(cjson 'gh secret set ANTHROPIC_API_KEY --body xxx')"
# Naming a subject is not performing an action. Every one of these was a real false block
# during E-001 setup: the guard keyed on bare `telegram`, `publish` and `vercel`, so a
# package name, a grep and a filename all landed in the danger zone and failed closed.
expect 0 "mention: pnpm --filter .../telegram add" $G "$(cjson 'pnpm --filter @ai-digest/telegram add -D @types/node')"
expect 0 "mention: loop naming the telegram pkg" $G "$(cjson 'for pkg in db llm connectors telegram; do echo $pkg; done')"
expect 0 "mention: grep -rn publish"           $G "$(cjson 'grep -rn publish packages/')"
expect 0 "mention: cat vercel.json"            $G "$(cjson 'cat vercel.json')"
expect 0 "housekeeping: pnpm install"          $G "$(cjson 'pnpm install')"
# An exemption that can be PREFIXED onto an arbitrary command is a bypass, not an
# exemption. Both of these passed on the first version of the pnpm carve-out and blocked
# at merge-base — a regression found by review, not by the battery, which is why they are
# pinned here now. Bare `vercel` deploys the current directory and needs no sub-verb.
expect 2 "bypass attempt: pnpm install && live run" $G "$(cjson 'pnpm install && pnpm digest:run --no-dry-run')"
expect 2 "bypass attempt: pnpm add && vercel deploy" $G "$(cjson 'pnpm add zod && vercel deploy --prod')"
expect 2 "bare vercel deploys the cwd"         $G "$(cjson 'vercel')"
expect 2 "npx vercel deploys the cwd"          $G "$(cjson 'npx vercel')"
# ...but publish in executable position is an action, not a mention.
expect 2 "action: ./publish.sh"                $G "$(cjson './publish.sh')"

# Help output is inert for every command. Enumerating safe verbs one at a time was the
# wrong shape of rule — `neonctl roles --help` was the second false block in two commands.
expect 0 "help: neonctl roles --help"        $G "$(cjson 'neonctl roles --help')"
expect 0 "help: vercel deploy --help"        $G "$(cjson 'vercel deploy --help')"
expect 0 "help: gh workflow run --help"      $G "$(cjson 'gh workflow run --help')"
expect 0 "help: prisma migrate --help"       $G "$(cjson 'npx prisma migrate --help')"
expect 0 "neonctl me"                        $G "$(cjson 'neonctl me')"
expect 0 "neonctl projects list"             $G "$(cjson 'neonctl projects list')"
expect 0 "neonctl connection-string"         $G "$(cjson 'neonctl connection-string --project-id x --pooled')"
expect 0 "neonctl read verb in zsh -lc"      $G "$(cjson "zsh -lc 'neonctl me | head -5'")"
expect 2 "block: neonctl projects delete"    $G "$(cjson 'neonctl projects delete --project-id x')"
expect 2 "block: neonctl roles reset-pw"     $G "$(cjson 'neonctl roles reset-password --project-id x --name owner')"
expect 2 "block: ambiguous publish shape"    $G "$(cjson 'node dist/publish-everything.js --now')"
expect 0 "bypass: ALLOW_LIVE_EFFECTS=1"      $G "$(cjson 'ALLOW_LIVE_EFFECTS=1 pnpm digest:run --profile profiles/ai-lifehacks.ts')"

# ── git-branch-delete-guard ─────────────────────────────────────────────────────
#
# The cases that need real branches (delivered-to-main vs genuinely unmerged) are not here:
# a battery must not create and destroy branches in the repo it is run from. They were
# exercised live when the guard was written — a squash-merged epic branch passed, a branch
# holding a file main never received was refused by name. What IS pinned here is the shape
# handling, which is where a rewrite would break it silently.
B=git-branch-delete-guard.sh
expect 0 "listing branches is not a deletion"  $B "$(cjson 'git branch')"
expect 0 "git branch -vv is not a deletion"    $B "$(cjson 'git branch -vv')"
expect 0 "remote deletion is out of scope"     $B "$(cjson 'git push origin --delete some-branch')"
expect 0 "unknown local branch is left to git" $B "$(cjson 'git branch -D no-such-branch-here')"
expect 2 "deletion with no branch named"       $B "$(cjson 'git branch -D')"

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
expect 0 "scratch: /tmp passes"               $E "$(fj "/tmp/scratch.txt")" "$MINE"
expect 0 "scratch: /private/tmp passes"       $E "$(fj "/private/tmp/claude-501/s/note.md")" "$MINE"
expect 0 "scratch: /dev/null passes"          $E "$(fj "/dev/null")" "$MINE"
# is_scratch moved into _paths.sh (E-005) and grew the /dev entries the Bash rail needs.
# That is an observable change to THIS hook too, so it is pinned here and not only in the
# Bash block: /dev/tty and /dev/fd/3 were denied by this hook before the shared library.
expect 0 "scratch: /dev/tty passes (shared)"  $E "$(fj "/dev/tty")" "$MINE"
expect 0 "scratch: /dev/fd/3 passes (shared)" $E "$(fj "/dev/fd/3")" "$MINE"
# The deny message names the session scratchpad as an acceptable place and this hook used
# to refuse it. Found by replaying the session log through the Bash rail; fixed for both.
expect 0 "scratch: the session job tmp dir"  $E "$(fj "$HOME/.claude/jobs/09f37764/tmp/c5.mjs")" "$MINE"
expect 2 "block: job state.json is not tmp"  $E "$(fj "$HOME/.claude/jobs/09f37764/state.json")" "$MINE"
expect 2 "block: sub-agent into main tree"    $E "$(fj "$ROOT/packages/core/src/x.ts")" "$MINE"
expect 2 "block: sub-agent into other tree"   $E "$(fj "$ROOT/.claude/worktrees/_probe_other/x.ts")" "$MINE"
expect 2 "block: .. traversal out"            $E "$(fj "$MINE/../../../CLAUDE.md")" "$MINE"
# Until 2026-08-29 the hook waved through every path outside the repository, so a sub-agent
# could write into a sibling project on the Desktop or into a dotfile. Measured, not
# theorised: probe files created in ~/Desktop and in ~/Desktop/_LMS both succeeded.
# These five were green when they should have been red.
expect 2 "block: sibling project under HOME"  $E "$(fj "$HOME/some-other-project/src/x.ts")" "$MINE"
expect 2 "block: a dotfile under HOME"        $E "$(fj "$HOME/.zshrc")" "$MINE"
expect 2 "block: a system path"               $E "$(fj "/etc/hosts")" "$MINE"
expect 2 "block: .. traversal to a sibling"   $E "$(fj "$MINE/../../../../sibling/x.ts")" "$MINE"
expect 2 "block: the repo's parent directory" $E "$(fj "$(dirname "$ROOT")/x.ts")" "$MINE"
rmdir "$ROOT/.claude/worktrees/_probe_mine" "$ROOT/.claude/worktrees/_probe_other" 2>/dev/null

# ── bash-write-path-guard ───────────────────────────────────────────────────────
#
# E-005. The failure mode this block guards against is NOT a missed write — it is a FALSE
# BLOCK. Writing through the shell appears in every second command in this project (`>`,
# `>>`, `tee`, `sed -i`, `cp`, `mv`), and a naive matcher on `>` fails `2>&1` — measured at
# 313 of the 6062 commands in this project's session log, one command in twenty. A rail
# that refuses `grep x > /dev/null` gets switched off within the hour, and then the write
# it was meant to stop goes through as well. So the green cases below outnumber the red
# ones on purpose: each one is a form that LOOKS like a write and is not.
#
# The 15 `expect 2` cases were shown red on commit A, where the hook was registered and
# reachable but its body was `exit 0`. Every `expect 0` case was green in that same run —
# which is the point: a hook that denies nothing and a hook that denies everything both
# print a number, and only the split between the two halves shows that it DISCRIMINATES.
W=bash-write-path-guard.sh
mkdir -p "$ROOT/.claude/worktrees/_probe_mine"
MINE="$ROOT/.claude/worktrees/_probe_mine"
bj() { printf '{"agent_id":"a1","tool_input":{"command":%s}}' "$(jq -Rn --arg c "$1" '$c')"; }

# ── writes that land outside the repository (the 15) ──
expect 2 "w: sed -i into a sibling project"   $W "$(bj "sed -i '' 's/x/y/' \$HOME/other-project/file.ts")" "$MINE"
expect 2 "w: redirect into HOME"              $W "$(bj "echo test > \$HOME/notes.txt")" "$MINE"
expect 2 "w: append into quoted HOME"         $W "$(bj "echo test >> \"\$HOME/notes.txt\"")" "$MINE"
expect 2 "w: redirect into ~"                 $W "$(bj 'echo test > ~/notes.txt')" "$MINE"
expect 2 "w: tee after a pipe"                $W "$(bj "printf x | tee \$HOME/other/x.log")" "$MINE"
expect 2 "w: cp destination outside"          $W "$(bj "cp fixtures/a.json \$HOME/other-project/a.json")" "$MINE"
expect 2 "w: mv destination outside"          $W "$(bj 'mv dist/x.js ~/Desktop/x.js')" "$MINE"
expect 2 "w: install with a flag argument"    $W "$(bj "install -m 644 x \$HOME/bin/x")" "$MINE"
expect 2 "w: redirect into a system path"     $W "$(bj 'echo x > /etc/hosts')" "$MINE"
expect 2 "w: .. traversal out of the repo"    $W "$(bj 'echo x > ../../../../sibling/x.ts')" "$MINE"
expect 2 "w: mkdir -p outside"                $W "$(bj "mkdir -p \$HOME/other/newdir")" "$MINE"
expect 2 "w: dd of= outside"                  $W "$(bj "dd if=/dev/zero of=\$HOME/other/blob")" "$MINE"
expect 2 "w: cd out, then a relative write"   $W "$(bj "cd \$HOME/other && echo x > y.txt")" "$MINE"
expect 2 "w: redirect with 2>&1 alongside"    $W "$(bj "pnpm test > \$HOME/log.txt 2>&1")" "$MINE"
expect 2 "w: ln linkname outside"             $W "$(bj "ln -s /etc/passwd \$HOME/link")" "$MINE"
# The 16th, and NOT part of the commit-A transcript: found by an adversarial sweep after the
# implementation was already green. `cd ~` carries no `~/` and no token-initial slash, so the
# phase-1 test waved the whole command through before the lexer ever saw it. Red on the
# phase-1 regex as it stood at commit B's first draft; the fix is in that regex.
expect 2 "w: bare ~ in cd, then a write"      $W "$(bj 'cd ~ && echo x > n.txt')" "$MINE"
# 17th, also post-commit-A and also from the sweep: pushd moves the base exactly as cd does
# and was not tracked, so this was a miss. popd and a bare/rotating pushd must not be guessed.
expect 2 "w: pushd moves the base too"        $W "$(bj 'pushd ~ > /dev/null && echo x > n.txt')" "$MINE"

# ── scratch: outside the repository and harmless ──
expect 0 "s: /tmp"                            $W "$(bj 'echo test > /tmp/scratch.txt')" "$MINE"
expect 0 "s: TMPDIR"                          $W "$(bj "echo test > \"\$TMPDIR/probe.txt\"")" "$MINE"
expect 0 "s: /private/tmp"                    $W "$(bj 'echo test > /private/tmp/probe.txt')" "$MINE"
expect 0 "s: /dev/null"                       $W "$(bj 'pnpm verify > /dev/null 2>&1')" "$MINE"
expect 0 "s: 2>/dev/null"                     $W "$(bj 'ls /nope 2>/dev/null')" "$MINE"
expect 0 "s: &>/dev/null"                     $W "$(bj 'ls /nope &>/dev/null')" "$MINE"
expect 0 "s: &>> into /tmp"                   $W "$(bj 'ls /nope &>> /tmp/log.txt')" "$MINE"
expect 0 "s: <> read-write on a lock file"    $W "$(bj 'exec 3<> /tmp/lock')" "$MINE"
# The one denial the session-log replay produced that was not a write into another tree.
expect 0 "s: the session scratchpad"          $W "$(bj "cat > $HOME/.claude/jobs/09f37764/tmp/c5.mjs")" "$MINE"
# The dominant backup pattern in this project's log: copy out to /tmp, edit, copy back.
expect 0 "s: backup out to /tmp"              $W "$(bj 'cp packages/core/src/x.ts /tmp/g.bak')" "$MINE"
expect 0 "s: restore from /tmp"               $W "$(bj 'cp /tmp/g.bak packages/core/src/x.ts')" "$MINE"

# ── file-descriptor duplication is not a redirect. 313 commands in the log carry `2>&1` ──
expect 0 "fd: 1>&2"                           $W "$(bj 'echo /etc/x 1>&2')" "$MINE"
expect 0 "fd: >&2"                            $W "$(bj 'echo /etc/x >&2')" "$MINE"
expect 0 "fd: >&- closes a descriptor"        $W "$(bj 'echo /etc/x >&-')" "$MINE"
expect 0 "fd: 0<&3"                           $W "$(bj 'cat /etc/hosts 0<&3')" "$MINE"

# ── pipes and reads ──
expect 0 "r: a pipe is not a redirect"        $W "$(bj 'cat /etc/hosts | wc -l')" "$MINE"
expect 0 "r: |& is not a redirect"            $W "$(bj 'cat /etc/hosts |& wc -l')" "$MINE"
expect 0 "r: < reads"                         $W "$(bj 'cat < /etc/hosts')" "$MINE"
expect 0 "r: <<< is a here-string"            $W "$(bj 'grep x <<< "/etc/passwd"')" "$MINE"
expect 0 "r: reading a sibling project"       $W "$(bj "cat \$HOME/other/README.md")" "$MINE"
expect 0 "r: ls outside"                      $W "$(bj 'ls ~/Desktop')" "$MINE"
expect 0 "r: cp FROM outside, INTO the repo"  $W "$(bj "cp \$HOME/other/x .")" "$MINE"

# ── `>` that is not a redirect: quotes, comparison operators, JS arrows ──
expect 0 "q: > inside double quotes"          $W "$(bj 'echo "write it with tee > /etc/x"')" "$MINE"
expect 0 "q: > inside a commit message"       $W "$(bj 'git commit -m "guard /etc/hosts > out"')" "$MINE"
expect 0 "q: grep for a write form"           $W "$(bj "grep -rn 'sed -i' .claude/hooks/")" "$MINE"
expect 0 "q: [[ ]] comparison"                $W "$(bj '[[ "$a" > "$b" ]]')" "$MINE"
expect 0 "q: [[ ]] comparison, path in test"  $W "$(bj '[[ -f /etc/hosts && "$a" > "$b" ]]')" "$MINE"
expect 0 "q: (( )) arithmetic"                $W "$(bj '(( 5 > 3 )) && echo /etc/ok')" "$MINE"
expect 0 "q: awk field comparison"            $W "$(bj "awk '\$1 > 3' /etc/passwd")" "$MINE"
expect 0 "q: find -newer"                     $W "$(bj 'find . -newer /etc/hosts')" "$MINE"
expect 0 "q: sed with a | separator"          $W "$(bj "sed -i '' 's|/etc/x|y|' packages/core/src/x.ts")" "$MINE"
# 157 commands in the log carry `=>`. A lexer that does not drop the heredoc body reads the
# `>` of a fat arrow as a redirect, and `/^[A-Z_]+=/` as an absolute path outside the repo.
expect 0 "q: JS arrow inside -e"              $W "$(bj "node -e 'const a = l.filter((c) => /^[A-Z_]+=/.test(c)); console.log(a)'")" "$MINE"
HD=$'cat <<EOF\n$HOME/other/f > $HOME/other/g\nEOF'
expect 0 "q: heredoc body is data"            $W "$(bj "$HD")" "$MINE"
HV=$'x=$(cat <<EOF\n$HOME/other/f\nEOF\n)'
expect 0 "q: heredoc into a variable"         $W "$(bj "$HV")" "$MINE"
expect 0 "q: process substitution"            $W "$(bj 'diff <(cat /etc/hosts) <(cat /etc/services)')" "$MINE"
expect 0 "q: >(...) is not a redirect"        $W "$(bj 'cat /etc/hosts | tee >(wc -l) > /dev/null')" "$MINE"
expect 0 "q: a comment mentioning a path"     $W "$(bj 'ls /etc # writes to $HOME/x, allegedly')" "$MINE"

# ── inside the repository ──
expect 0 "i: relative write in the worktree"  $W "$(bj 'echo x > src/generated.ts')" "$MINE"
expect 0 "i: sed -i on a relative path"       $W "$(bj "sed -i '' 's/x/y/' packages/core/src/x.ts")" "$MINE"
expect 0 "i: mkdir inside the worktree"       $W "$(bj 'mkdir -p packages/core/src/sub')" "$MINE"
expect 0 "i: >| clobber, relative"            $W "$(bj 'echo x >| out.txt')" "$MINE"
expect 0 "i: cd inside, then write"           $W "$(bj 'cd packages/core && echo x > src/y.ts')" "$MINE"
expect 0 "i: pushd inside, then write"        $W "$(bj 'pushd packages/core && echo x > src/y.ts')" "$MINE"
expect 0 "i: popd restores the base"          $W "$(bj 'pushd ~ > /dev/null && popd > /dev/null && echo x > n.txt')" "$MINE"
expect 0 "i: a rotating pushd is unknown"     $W "$(bj 'pushd > /dev/null && echo x > n.txt')" "$MINE"
expect 0 "i: cd - is unknown, so it passes"   $W "$(bj 'cd ~ && cd - && echo x > n.txt')" "$MINE"
# DELIBERATE ASYMMETRY, pinned so nobody later reads "parity with Write" wider than it was
# built: the Bash rail stops at the REPOSITORY boundary. The file rail also defends the
# WORKTREE boundary — this same target is `expect 2` in the enforce-subagent-worktree block
# above. Widening the Bash rail to match is a separate decision, not a bug fix.
expect 0 "i: into the main tree (asymmetry)"  $W "$(bj "echo x > $ROOT/packages/core/src/x.ts")" "$MINE"

# ── fail-open, by construction and by name (acceptance criterion 4) ──
# A deny happens at exactly one point: the target RESOLVED to an absolute path that is
# outside the repository and is not scratch. Every other outcome — an unknown variable, an
# unparsed form, another layer of execution — is an absent target, i.e. a pass. The cost
# asymmetry is the reason: live-effects-guard.sh fails CLOSED because its error is a post
# in a real channel; here it is a file in a neighbouring folder.
expect 0 "o: unknown variable in the target"  $W "$(bj 'echo x > "$SOME_DIR/out.txt"')" "$MINE"
expect 0 "o: path through an assignment"      $W "$(bj 't=~/Desktop/x; echo probe > "$t"')" "$MINE"
expect 0 "o: bash -c hides the redirect"      $W "$(bj "bash -c \"echo x > \$HOME/y\"")" "$MINE"
expect 0 "o: python3 -c opens the file"       $W "$(bj "python3 -c \"open('\$HOME/x','w')\"")" "$MINE"
expect 0 "o: curl -o is not in the v1 list"   $W "$(bj "curl -o \$HOME/x https://example.com/f")" "$MINE"
expect 0 "o: xargs hides the command"         $W "$(bj "xargs -I{} cp {} \$HOME/other/")" "$MINE"

# ── the parent session is out of scope (acceptance criterion 5) ──
# All three are real commands from this project's session log, run by the owner to install
# the toolchain. They write outside the repository on purpose, and the agent_id gate — not
# a path exception — is what lets them through. That gate is load-bearing, not decorative.
expect 0 "p: mkdir -p ~/.local/bin"           $W "$(cjson 'mkdir -p ~/.local/bin')" "$MINE"
expect 0 "p: ln -sf into ~/.local/bin"        $W "$(cjson 'ln -sf /opt/homebrew/x ~/.local/bin/pnpm')" "$MINE"
expect 0 "p: redirect into HOME"              $W "$(cjson "echo test > \$HOME/notes.txt")" "$MINE"
rmdir "$ROOT/.claude/worktrees/_probe_mine" 2>/dev/null

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
