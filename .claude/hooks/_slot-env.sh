# shellcheck shell=bash
# The `.env` of one agent worktree. Sourced by intercept-agent-worktree.sh.
#
# WHY THIS IS A SEPARATE FILE: the hook's body cannot be exercised by the battery — it
# creates a git worktree, runs `pnpm install` and talks to Neon. What CAN be exercised is
# the decision made here, namely WHICH database a slot ends up pointing at, and that
# decision is the whole of E-015. A case that cannot run is not a gate.
#
# WHY IT EXISTS AT ALL: until 2026-08-29 the hook did `ln -s "$REPO_ROOT/.env" "$path/.env"`.
# Measured that day: every agent worktree's DATABASE_URL resolved to the main tree's
# database, while the Neon branch the hook created for the slot sat unused. The first epic
# needing a migration in its own worktree would have applied it to the shared database, and
# live-effects-guard.sh would not have stopped it — that guard judges the SHAPE of a
# command, not its target.
#
# THE RULE THIS FILE ENFORCES: a wrong DATABASE_URL is worse than a missing one. When the
# Neon branch cannot be provisioned, the slot's .env carries NO DATABASE_URL at all rather
# than inheriting the shared value. Same decision as docs/setup.md § 2.7, second application.
#
# SECRETS: the rendered file is written straight to disk, mode 600, and is never echoed.
# The note returned to the hook names the Neon branch and the host — both of which
# scripts/db-status.mjs already prints — and never the connection string.
#
# NAMED LIMITS (deliberate, not oversights):
#   * Only DATABASE_URL and DATABASE_URL_UNPOOLED are per-slot. ANTHROPIC_API_KEY and the
#     Telegram tokens stay shared on purpose: they are about access, not isolation.
#   * Stripping is line-based, so a multi-line quoted DATABASE_URL value would leave its
#     continuation lines behind. Connection strings are single-line; nothing here produces
#     a multi-line one.
#   * `slot_db_host` splits the authority at the first "/" and the last "@" before it. A
#     password containing an unescaped "/" parses wrong. Neon percent-encodes passwords.
#   * `neonctl` is called without --project-id, exactly as the hook did before. With more
#     than one Neon project it cannot resolve one, the read returns empty, and the slot ends
#     up with no DATABASE_URL — the safe direction.
#   * The slot .env is regenerated on every dispatch, including a re-dispatch onto a live
#     worktree. If Neon is unreachable at that moment, a previously good file is replaced by
#     one with no DATABASE_URL. Safe, but it does mean the file is generated output: the
#     header says so.

# Host of a connection string, or the empty string. Never returns credentials.
#
# By authority rather than by the whole string, for the same reason as
# packages/db/src/client.ts: a password or database name containing "-pooler" would
# otherwise wave a direct connection through as if it were the pooled one.
slot_db_host() {
  local u="${1:-}"
  case "$u" in
    *://*) u="${u#*://}" ;;
    *) return 0 ;;
  esac
  u="${u%%\?*}" # query first: it may contain "/"
  u="${u%%/*}"  # authority
  u="${u##*@}"  # drop userinfo
  printf '%s' "${u%%:*}"
}

# Is this pair safe to write into a slot's .env? Mirrors the checks scripts/db-status.mjs
# makes, but BEFORE the value is written rather than after — db:status is run by a human
# who already has the wrong string in place.
slot_db_pair_ok() {
  local pooled="${1:-}" direct="${2:-}" ph dh
  [ -n "$pooled" ] && [ -n "$direct" ] || return 1
  case "$pooled" in postgres*) ;; *) return 1 ;; esac
  case "$direct" in postgres*) ;; *) return 1 ;; esac
  ph="$(slot_db_host "$pooled")"
  dh="$(slot_db_host "$direct")"
  [ -n "$ph" ] && [ -n "$dh" ] || return 1
  case "$ph" in *-pooler*) ;; *) return 1 ;; esac # pooled must be the pooler
  case "$dh" in *-pooler*) return 1 ;; esac       # direct must not be
  [ "${ph/-pooler/}" = "$dh" ] || return 1        # and both must be one endpoint
  return 0
}

_slot_env_header() {
  printf '# Generated per worktree by .claude/hooks/intercept-agent-worktree.sh. Do not edit:\n'
  printf '# it is rewritten on every dispatch. Slot branch: %s\n' "${1:-<unknown>}"
  printf '# A symlink to the main tree used to live here, which meant every agent shared one\n'
  printf '# database. See docs/epics/E-015-worktree-env-points-at-its-own-neon-branch.md.\n'
  printf '\n'
}

_slot_env_strip_db() {
  sed -E '/^[[:space:]]*(export[[:space:]]+)?DATABASE_URL(_UNPOOLED)?[[:space:]]*=/d'
}

# The text of a slot's .env: shared file on stdin, slot file on stdout.
#
# Pure — no filesystem, no network, no globals. This is the function the battery leans on,
# because "which DATABASE_URL does the slot get" is decided entirely here.
slot_env_render() {
  local label="${1:-}" pooled="${2:-}" direct="${3:-}"
  _slot_env_header "$label"
  _slot_env_strip_db
  if slot_db_pair_ok "$pooled" "$direct"; then
    printf '\n# The Neon branch belonging to this slot.\n'
    printf 'DATABASE_URL="%s"\n' "$pooled"
    printf 'DATABASE_URL_UNPOOLED="%s"\n' "$direct"
  else
    printf '\n# DATABASE_URL is deliberately ABSENT here. The Neon branch for this slot could\n'
    printf '# not be provisioned (neonctl missing, unauthenticated, or it returned a pair that\n'
    printf '# failed validation). Inheriting the shared value would silently point a migration\n'
    printf '# at the main database, and a wrong DATABASE_URL is worse than a missing one.\n'
    printf '# See docs/setup.md § 2.7. Offline runs (--fixtures) do not need it.\n'
  fi
}

# Same, for a secondary env file (.env.local). The slot's pair lives in .env only: one copy
# of a secret, not two. Next.js reads .env.local at HIGHER precedence than .env, so leaving
# a shared DATABASE_URL in it would quietly undo everything above.
slot_env_render_stripped() {
  _slot_env_header "${1:-}"
  _slot_env_strip_db
  printf '\n# Database variables are stripped from this file on purpose: the slot pair lives\n'
  printf '# in .env, and .env.local would override it.\n'
}

# The Neon branch for this slot, as "<pooled>\n<direct>". Non-zero when it cannot be had.
#
# The binary is indirected through SLOT_ENV_NEONCTL so the battery can substitute a fake:
# a test must never reach the network, and it must certainly never create a real branch.
slot_neon_provision() {
  local branch="${1:-}" bin="${SLOT_ENV_NEONCTL:-neonctl}" pooled direct
  [ -n "$branch" ] || return 1
  command -v "$bin" >/dev/null 2>&1 || return 1
  # Creating a branch that already exists fails, and that is fine: a re-dispatch onto a live
  # worktree must still get its connection strings. The reads below are the real test.
  "$bin" branches create --name "$branch" >/dev/null 2>&1
  pooled="$("$bin" connection-string "$branch" --pooled 2>/dev/null | tr -d '[:space:]')"
  direct="$("$bin" connection-string "$branch" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$pooled" ] && [ -n "$direct" ] || return 1
  printf '%s\n%s\n' "$pooled" "$direct"
}

# Write one slot env file. `rm -f` on the target is what removes the old symlink — writing
# through it would have edited the main tree's .env, which is the accident this whole file
# is about.
slot_env_write() {
  local shared="${1:-}" target="${2:-}" render="${3:-}" tmp
  shift 3
  tmp="$(mktemp "${target}.XXXXXX" 2>/dev/null)" || return 1
  chmod 600 "$tmp" 2>/dev/null
  if [ -f "$shared" ]; then
    "$render" "$@" <"$shared" >"$tmp" || { rm -f "$tmp"; return 1; }
  else
    "$render" "$@" </dev/null >"$tmp" || { rm -f "$tmp"; return 1; }
  fi
  rm -f "$target"
  mv "$tmp" "$target" || { rm -f "$tmp"; return 1; }
}

# Provision a worktree's env files and print a one-line, secret-free note for the hook's
# deny message. Non-zero only when the file could not be written at all.
slot_env_provision() {
  local repo_root="${1:-}" slot_path="${2:-}" branch="${3:-}"
  local pooled="" direct="" urls=""

  if urls="$(slot_neon_provision "$branch")"; then
    pooled="$(printf '%s\n' "$urls" | sed -n 1p)"
    direct="$(printf '%s\n' "$urls" | sed -n 2p)"
  fi

  if ! slot_env_write "$repo_root/.env" "$slot_path/.env" slot_env_render "$branch" "$pooled" "$direct"; then
    printf 'could not write %s/.env — this slot has NO isolated DATABASE_URL' "$slot_path"
    return 1
  fi

  if [ -f "$repo_root/.env.local" ]; then
    slot_env_write "$repo_root/.env.local" "$slot_path/.env.local" slot_env_render_stripped "$branch" || true
  fi

  if slot_db_pair_ok "$pooled" "$direct"; then
    printf 'DATABASE_URL in this worktree points at the Neon branch %s (host %s), not at the shared database' \
      "$branch" "$(slot_db_host "$pooled")"
  else
    printf 'DATABASE_URL is NOT provisioned for this slot and is ABSENT from its .env — a wrong one is worse than none. Offline runs (--fixtures) are unaffected; a migration has nowhere to go, deliberately'
  fi
}
