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
# TEXT THAT DESCRIBES A COMMAND IS NOT THE COMMAND (added 2026-08-29, E-012). A commit
# message quoting a blocked command, and a heredoc writing a doc that mentions one, were
# refused four times in one session — the fourth being the commit that described this very
# defect. The earlier note here said no fix keeps the guard honest. That was too strong: it
# is true of the command string as a whole and false of two specific spans inside it, which
# are data by construction and never reach a shell as code. So everything below matches
# against `judged` (see judge_text), which is `$cmd` minus exactly:
#   * heredoc BODIES — but only when the terminator is actually present later in the text,
#     and only when the heredoc does not feed an interpreter (`bash <<EOF … EOF` is code and
#     stays judged in full);
#   * the QUOTED argument of -m / --message / -F / --file. The flag itself survives, so
#     `gh api -F` still disqualifies the read carve-out and `vercel deploy --prod -m "…"`
#     is still blocked.
#   Named limits of that narrowing: text passed through any other flag (`gh release create
#   -n "…"`, `curl -d`) is still judged; a heredoc body that IS executed via a form this
#   does not recognise is still judged (that is the safe direction); and the deny message
#   always prints the ORIGINAL command, never the judged one.
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

# ── phase 0: reduce the command to the part that can execute ────────────────────
#
# See "TEXT THAT DESCRIBES A COMMAND IS NOT THE COMMAND" above for why. Two awk passes,
# both deliberately conservative — every ambiguity resolves towards KEEPING text, because
# keeping text can only cause a false block (one retry) while dropping it can hide an
# effect.
#
# Pass 1, line-oriented, drops heredoc bodies. Two conditions guard it:
#   * the terminator must actually appear on a later line. Without that check `node -e
#     'x = 1 << SHIFT'` reads as an unterminated heredoc and swallows the rest of the
#     command — the guard would go quiet on exactly the input that abuses it.
#   * the line must not start an interpreter. `bash <<EOF … EOF` is code with a funny
#     quoting style, not data.
# Pass 2 works on the WHOLE text, not per line: a commit message with a blank line in it is
# one quoted token spanning several lines, and a per-line scanner loses everything after
# the first newline — which is the common shape of the very messages that were refused.
judge_text() {
  printf '%s' "$1" \
    | awk -v q="'" '
        { L[NR] = $0 }
        END {
          hd = "<<-?[ \t]*(\"[^\"]*\"|" q "[^" q "]*" q "|[A-Za-z_][A-Za-z0-9_-]*)"
          interp = "(^|[;&|][ \t]*)(sudo[ \t]+|env[ \t]+)?(bash|sh|zsh|ksh|dash|node|deno|bun|python|python3|perl|ruby|awk|psql|mysql|ssh|eval|xargs)([ \t]|$)"
          i = 1
          while (i <= NR) {
            line = L[i]
            if (line ~ interp) { print line; i++; continue }
            if (match(line, hd)) {
              d = substr(line, RSTART, RLENGTH)
              sub(/^<<-?[ \t]*/, "", d); gsub(/"/, "", d); gsub(q, "", d)
              stop = 0
              for (j = i + 1; j <= NR; j++) {
                t = L[j]; sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t)
                if (t == d) { stop = j; break }
              }
              if (stop > 0) { print line; i = stop + 1; continue }
            }
            print line; i++
          }
        }' \
    | awk -v q="'" '
        function scrub(s,   n,i,ch,qc,raw,quoted,toks,qf,res,prev,j,t,len) {
          len = length(s); n = 0; i = 1
          while (i <= len) {
            ch = substr(s, i, 1)
            if (ch == " " || ch == "\t" || ch == "\n") { n++; toks[n] = ch; qf[n] = 0; i++; continue }
            raw = ""; quoted = 0
            while (i <= len) {
              ch = substr(s, i, 1)
              if (ch == " " || ch == "\t" || ch == "\n") break
              if (ch == "\"" || ch == q) {
                qc = ch; quoted = 1; raw = raw ch; i++
                while (i <= len) { ch = substr(s, i, 1); raw = raw ch; i++; if (ch == qc) break }
                continue
              }
              raw = raw ch; i++
            }
            n++; toks[n] = raw; qf[n] = quoted
          }
          res = ""; prev = ""
          for (j = 1; j <= n; j++) {
            t = toks[j]
            if (t == " " || t == "\t" || t == "\n") { res = res t; continue }
            if (qf[j] && (prev == "-m" || prev == "--message" || prev == "-F" || prev == "--file")) res = res "\"\""
            else if (t ~ /^(--message|--file)=/) res = res substr(t, 1, index(t, "="))
            else res = res t
            prev = t
          }
          return res
        }
        { buf = buf $0 "\n" }
        END { printf "%s", scrub(buf) }'
}
judged="$(judge_text "$cmd")"
# If the reduction produced nothing at all, judge the original: an empty result means the
# parse went wrong, and a guard that inspects an empty string approves everything.
[[ -z "${judged//[[:space:]]/}" ]] && judged="$cmd"

# ── phase 1: is this even in the danger zone? ───────────────────────────────────
#
# Match the ACTION, not the mention. The first version keyed on bare `telegram`, `publish`
# and `vercel`, which put `pnpm --filter @ai-digest/telegram add -D @types/node` in the
# danger zone and then failed it closed. That was the third false block in a session, and
# the pattern behind all three is the same: a word that names a subject is not evidence of
# an effect. `packages/telegram`, a variable called publish, a file named vercel.json —
# all inert. What is dangerous is a verb applied to them.
if ! printf '%s\n' "$judged" | grep -qiE \
  'digest:run|digest-run|pipeline[[:space:]]+(run|publish)|--publish|--no-dry-run|--live|api\.telegram\.org|sendMessage|(^|[[:space:];&|])(npx[[:space:]]+)?vercel([[:space:]]|$)|--prod|gh[[:space:]]+(workflow[[:space:]]+run|release[[:space:]]+create|api|(secret|variable)[[:space:]]+(set|delete))|neonctl|prisma[[:space:]]+(migrate|db[[:space:]]+push)|/api/revalidate|(^|[;&|][[:space:]]*)(node|npx|bun|deno|bash|sh|\./)[[:space:]]*[^[:space:]]*publish'; then
  exit 0
fi

# Package-manager housekeeping is not a pipeline run. `pnpm add`, `pnpm install` and
# `pnpm --filter <pkg> add` reach the danger zone only through the package name.
# ANCHORED to the entire command, not matched as a substring.
#
# The first version of this exemption exited 0 as soon as a package-manager verb appeared
# ANYWHERE in the command, so `pnpm install && pnpm digest:run --no-dry-run` and
# `pnpm add zod && vercel deploy --prod` both walked past phase 2 — verified against the
# previous revision, which blocked both. An exemption that can be prefixed onto an
# arbitrary command is not an exemption, it is a bypass.
if printf '%s\n' "$judged" | grep -qE '^[[:space:]]*pnpm([[:space:]]+--filter[[:space:]]+[^[:space:];&|]+)?[[:space:]]+(add|install|remove|update|why|list|ls|outdated)([[:space:]]+[^;&|]*)?$'; then
  exit 0
fi

# ── phase 2: strict, fail-closed ────────────────────────────────────────────────

# Help output is inert for every command there is. Blocking it was the second false
# positive in two commands (`neonctl roles --help`), and enumerating safe verbs one at a
# time is the wrong shape of rule: a guard that has to be taught each inspection command
# separately gets disabled long before the list is complete.
if printf '%s\n' "$judged" | grep -qE '(^|[[:space:]])(--help|-h|help)([[:space:]]|$|.$)'; then
  exit 0
fi

# Reading and inspecting is always fine — it is how an agent learns what publishing does.
if printf '%s' "$judged" | grep -qE '^[[:space:]]*(cat|less|head|tail|bat|grep|rg|sed -n|awk|ls|find|wc|git (log|diff|show|status|grep)|node --check|bash -n|jq)[[:space:]]'; then
  exit 0
fi

# neonctl read-only verbs. Added after the guard blocked `neonctl me` and
# `neonctl projects list` — both pure reads. The rail is against accident, not a sandbox:
# a false block that costs a retry on every inspection command trains people to disable it.
# `connection-string` is read-only but PRINTS A SECRET; allowed because the setup flow
# needs it, and because a value the owner can already read from the Neon console is not
# protected by refusing to print it here.
if printf '%s\n' "$judged" | grep -qE '(^|[[:space:];&|(]|zsh -lc .|bash -c .)neonctl[[:space:]]+(me|projects[[:space:]]+(list|get)|branches[[:space:]]+(list|get)|databases[[:space:]]+list|roles[[:space:]]+list|operations[[:space:]]+list|connection-string)([[:space:]]|$|.$)'; then
  if ! printf '%s\n' "$judged" | grep -qE 'neonctl[[:space:]]+[a-z-]+[[:space:]]+(create|delete|update|set|reset|restore|rename)'; then
    exit 0
  fi
fi

# `gh api` reads. Added 2026-08-29 after the guard blocked a lookup of an action's commit
# SHA while writing CI — a pure GET against a public repository. `gh api` is in the danger
# list because it CAN mutate, but it mutates only when told to: a method flag, or a field
# flag (-f/-F/--field/--raw-field/--input), which makes gh switch to POST on its own. With
# none of those present the call is a GET, and refusing GETs is how the rail gets disabled.
# The read verbs of the porcelain commands ride along for the same reason.
if printf '%s\n' "$judged" | grep -qE '(^|[[:space:];&|(])gh[[:space:]]+(api[[:space:]]|(pr|run|repo|workflow|secret|release|issue|cache)[[:space:]]+(list|view|status|diff)([[:space:]]|$))'; then
  # A mutating shape anywhere in the command disqualifies the whole thing — the carve-out
  # must not become a prefix that smuggles an effect in behind a harmless read.
  if ! printf '%s\n' "$judged" | grep -qE '(-X|--method)[[:space:]]*(POST|PUT|PATCH|DELETE)|[[:space:]](-f|-F|--field|--raw-field|--input)[[:space:]]|gh[[:space:]]+[a-z-]+[[:space:]]+(run|create|delete|set|merge|edit|close|upload|sync)([[:space:]]|$)'; then
    exit 0
  fi
fi

case "$judged" in
  *"--dry-run"*|*"--fixtures"*)
    # A dry run is the sanctioned path — unless it also carries a publish flag.
    if printf '%s' "$judged" | grep -qE '\-\-publish|\-\-no-dry-run|\-\-live'; then
      deny "Blocked: the command combines --dry-run with a publishing flag, so its real effect is ambiguous.
  command: $cmd
Run the pipeline with --dry-run --fixtures and nothing else. Publishing belongs to CI."
    fi
    exit 0
    ;;
esac

if printf '%s' "$judged" | grep -qiE 'digest:run|digest-run|pipeline run'; then
  deny "Blocked: a pipeline run without --dry-run may publish to the real channel and write to the real database.
  command: $cmd
Use: pnpm digest:run --profile profiles/_test.ts --fixtures --dry-run
See CLAUDE.md § Команды. Publishing is done by CI on a schedule, never from an agent session."
fi

if printf '%s' "$judged" | grep -qiE '\-\-publish|api\.telegram\.org|sendMessage|pipeline publish'; then
  deny "Blocked: this command would send a message through the Telegram Bot API.
  command: $cmd
A post to a channel cannot be unsent. Render the issue instead (--dry-run) and inspect the markdown."
fi

if printf '%s' "$judged" | grep -qiE '(^|[[:space:];&|])vercel[[:space:]]+(deploy|--prod|promote|alias)'; then
  deny "Blocked: deploying the site from an agent session.
  command: $cmd
Deployment happens from CI. If you need to see the site, run the dev server on your slot port."
fi

if printf '%s' "$judged" | grep -qiE 'gh[[:space:]]+workflow[[:space:]]+run|gh[[:space:]]+release[[:space:]]+create|gh[[:space:]]+api[[:space:]]+.*(-X|--method)[[:space:]]*(POST|PUT|PATCH|DELETE)'; then
  deny "Blocked: triggering a workflow or mutating GitHub state from an agent session.
  command: $cmd
Report what needs to run and let the owner trigger it."
fi

# Repository secrets. Found 2026-08-29 by a test written for the `gh api` carve-out: this
# shape was never in the danger zone at all, so an agent session could have written a
# production secret and nothing would have objected. The owner runs this one by hand — the
# value has to come from somewhere, and an agent that can read a key into a command line
# can also read it into a log.
if printf '%s' "$judged" | grep -qiE 'gh[[:space:]]+(secret|variable)[[:space:]]+(set|delete)'; then
  deny "Blocked: writing a repository secret or variable from an agent session.
  command: $cmd
Secrets are set by the owner. Print the exact command to run and stop there — see docs/setup.md."
fi

if printf '%s' "$judged" | grep -qiE 'prisma[[:space:]]+(migrate[[:space:]]+(deploy|reset)|db[[:space:]]+push)'; then
  deny "Blocked: a schema-mutating Prisma command outside a dry run.
  command: $cmd
Inside a worktree, DATABASE_URL must point at this slot's Neon branch, not the shared one —
and .env silently supplies the shared value when the variable is unset. Pin the target inline
in the command, and use \`prisma migrate dev\` against your own branch."
fi

# Offline Prisma commands. Added 2026-08-29 while E-007 was being written: `prisma migrate
# diff --from-empty --to-schema-datamodel --script` renders SQL from a schema file and opens
# no connection at all, but the word `migrate` put it in the danger zone and it failed closed.
#
# The carve-out is keyed on the ABSENCE of a database endpoint, not on the subcommand: `diff`
# with `--from-url` or `--to-url` does connect, so it stays blocked. `validate`, `format` and
# `generate` are file-only and ride along.
if printf '%s\n' "$judged" | grep -qE 'prisma[[:space:]]+(migrate[[:space:]]+diff|validate|format|generate)([[:space:]]|$)'; then
  # `--from-config-datasource` reads the URL out of prisma.config.ts and connects. It was
  # missed on the first pass and found by reading the CLI's own help output — the exact
  # reason a carve-out must enumerate what disqualifies it rather than trust a subcommand.
  if ! printf '%s\n' "$judged" | grep -qE '\-\-(from|to)-url|\-\-shadow-database-url|\-\-(from|to)-migrations|\-\-(from|to)-config-datasource'; then
    exit 0
  fi
fi

# The cleanup step of /finish-branch. Added 2026-08-29 (E-012): the refusal below named
# /finish-branch as the sanctioned path and then refused the command /finish-branch step 4
# prescribes, so every merge needed the owner's ALLOW_LIVE_EFFECTS=1. A guard that forbids
# the process it points at is not a rail, it is a detour sign.
#
# BY STATE, NOT BY NAME — the same shape as git-branch-delete-guard.sh. This hook cannot
# know that /finish-branch invoked it, and it must not try: a carve-out keyed on the branch
# NAME would mean anyone who calls a branch `agent/anything` can drop a neighbour's
# database. What it checks instead is the one thing that is only true AFTER the cleanup has
# already happened, and cannot be arranged by naming:
#   * the name is agent/<slug>;
#   * `git worktree list` has no worktree on it — step 4 removes the worktree first;
#   * no slot directory still holds it — step 4 releases the slot next.
# Both live checks say "a neighbour is working on this", and both are read from the MAIN
# worktree: this file is executed from inside whichever worktree made the call, and the
# slot registry exists only in the main tree.
#
# NAMED LIMITS: the branch must be spelled literally. `neonctl branches delete "$BR"` is
# refused — the hook cannot resolve a caller's shell variable, and guessing is the opposite
# of checking — which is why .claude/commands/finish-branch.md writes the name out. A short
# flag before the name (`-y agent/x`) consumes it as a flag value and fails closed.
# `projects delete` and `databases delete` are out of scope of the carve-out entirely.
neon_branch_delete_is_orphan_cleanup() {
  local seg t names br mt wtlist f skip
  names=""
  while IFS= read -r seg; do
    # shellcheck disable=SC2086  # deliberate word-splitting: this is the tokenizer
    set -- $seg
    [ "${1:-}" = "neonctl" ] && [ "${2:-}" = "branches" ] && [ "${3:-}" = "delete" ] || continue
    shift 3 2>/dev/null || continue
    skip=0
    for t in "$@"; do
      if [ "$skip" = "1" ]; then skip=0; continue; fi
      case "$t" in
        --*=*) ;;
        --*) skip=1 ;;
        -?) skip=1 ;;
        -*) ;;
        *) names="$names $(printf '%s' "$t" | tr -d "\"'")" ;;
      esac
    done
  done <<SEGMENTS
$(printf '%s\n' "$1" | tr ';&|' '\n')
SEGMENTS

  names="$(printf '%s' "$names" | tr -s ' ' | sed 's/^ //;s/ $//')"
  [ -z "$names" ] && return 1

  mt="$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
  [ -z "$mt" ] && return 1
  wtlist="$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null)"

  for br in $names; do
    printf '%s' "$br" | grep -qE '^agent/[a-z0-9][a-z0-9._-]*$' || return 1
    printf '%s\n' "$wtlist" | grep -qx "branch refs/heads/$br" && return 1
    for f in "$mt"/.claude/worktrees/.slots/*/branch; do
      [ -f "$f" ] || continue
      [ "$(cat "$f" 2>/dev/null)" = "$br" ] && return 1
    done
  done
  return 0
}

if printf '%s' "$judged" | grep -qiE 'neonctl[[:space:]]+(branches[[:space:]]+delete|projects[[:space:]]+delete|databases[[:space:]]+delete)'; then
  # Disqualifiers first, in the shape the `gh api` carve-out already uses: a project or
  # database deletion, or any other neonctl mutation riding along, voids the whole command.
  # Everything else dangerous has already been refused by the time control reaches here —
  # the vercel, workflow, secret and prisma denials are all above — so the carve-out cannot
  # be used to smuggle a second effect in behind a sanctioned first one.
  if ! printf '%s\n' "$judged" | grep -qE 'neonctl[[:space:]]+(projects|databases)[[:space:]]+delete|neonctl[[:space:]]+[a-z-]+[[:space:]]+(create|update|set|reset|reset-password|restore|rename)'; then
    if neon_branch_delete_is_orphan_cleanup "$judged"; then
      warn "[live-effects-guard] the named agent/<slug> branches have no worktree and no slot — this is /finish-branch cleanup."
      exit 0
    fi
  fi
  deny "Blocked: deleting a Neon branch, database or project.
  command: $cmd
/finish-branch step 4 deletes the slot's branch after the worktree is removed and the slot
released; that shape is allowed, and it needs the branch spelled out literally as
agent/<slug>. Anything else — a live worktree or a held slot on that branch, a name outside
agent/<slug>, a project or database deletion — is refused."
fi

# In the danger zone, matched none of the sanctioned shapes: fail closed.
deny "Blocked: this command touches publishing, deployment or database state, and does not match a
known-safe shape, so the guard cannot tell whether its effects are real.
  command: $cmd
If it is genuinely safe, say what it does and let the owner run it, or re-issue it in a form the
guard recognises (--dry-run / --fixtures, or a read-only inspection command).
See .claude/hooks/live-effects-guard.sh § NAMED LIMITS."
