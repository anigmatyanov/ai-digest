# shellcheck shell=bash
# Sourced by hooks. The three path predicates shared by the two write-path rails:
# enforce-subagent-worktree.sh (file tools) and bash-write-path-guard.sh (Bash).
#
# WHY SHARED: both rails answer the same question — "is this target outside the repository,
# and if so, is it scratch?" Two copies of that answer do not diverge on the day they are
# written. They diverge on the third edit, silently, and then Write and `echo >` disagree
# about what a sub-agent may do — which is the exact confusion E-005 exists to remove.
#
# NO SIDE EFFECTS ON LOAD: function definitions only. A sourced file that runs anything at
# load time cannot be sourced from a hook that has already consumed its stdin.

# Lexical normalisation: collapse `.` and `..` without touching the filesystem, so a
# non-existent target is still judged correctly. Expects an ABSOLUTE path — it always emits
# one. Symlinks are NOT resolved (see the NAMED LIMITS of both callers).
norm_path() {
  printf '%s' "$1" | awk -F/ '{n=0; for(i=1;i<=NF;i++){ if($i=="."||$i==""){continue} else if($i==".."){ if(n>0) n-- } else { p[++n]=$i } } s=""; for(j=1;j<=n;j++) s=s"/"p[j]; if(s=="") s="/"; print s}'
}

# Scratch space: paths outside the repository that damage nothing and are refused at the
# cost of a retry on every legitimate temporary file.
#
# The /dev entries beyond null/stdout/stderr were added for the Bash rail (E-005): a shell
# command redirects to /dev/stdin, /dev/tty, /dev/zero and /dev/fd/3 in ways a file tool
# never does. This is a real, if small, behaviour change for the file rail too, and it is
# pinned by a case in test/hooks/run.sh. The list is enumerated rather than blanket
# `/dev/*` on purpose: `dd of=/dev/disk0` is not a temporary file.
is_scratch() {
  case "$1" in
    /dev/null|/dev/zero|/dev/random|/dev/urandom) return 0 ;;
    /dev/stdin|/dev/stdout|/dev/stderr|/dev/tty) return 0 ;;
    /dev/fd/*) return 0 ;;
    /tmp|/private/tmp|/var/folders|/private/var/folders) return 0 ;;
    /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) return 0 ;;
  esac
  # The session scratchpad. Both rails' deny message tells the agent that "temporary files
  # belong in $TMPDIR or the session scratchpad", and then both refused the scratchpad —
  # found 2026-08-29 by replaying this project's session log through the Bash rail, where
  # `cat > ~/.claude/jobs/<session>/tmp/c5.mjs` was the only denial that was not a genuine
  # write into someone else's tree. A rail whose message names a location it then refuses is
  # the kind that gets switched off. Only the `tmp/` subdirectory: state.json and
  # timeline.jsonl next to it are harness state, not scratch.
  # NAMED LIMIT: matched by path shape, so another session's jobs/<id>/tmp is allowed too.
  if [[ -n "${HOME:-}" ]]; then
    case "$1" in
      "$HOME"/.claude/jobs/*/tmp | "$HOME"/.claude/jobs/*/tmp/*) return 0 ;;
    esac
  fi
  local t="${TMPDIR:-}"
  [[ -n "$t" && ( "$1" == "${t%/}" || "$1" == "${t%/}"/* ) ]] && return 0
  return 1
}

# The deny paragraph for "outside the repository". Kept in one place so the two rails say
# the same thing; callers append their own tool-specific tail after it.
#   $1 — normalised target, $2 — repository root
outside_repo_reason() {
  printf '%s\n' "Blocked: sub-agents must not write outside the repository.
  target: $1
That path is not under $2 — it is a sibling project, a personal file or a system
location, and writing there corrupts work this repository cannot see or review. Temporary
files belong in \$TMPDIR or the session scratchpad. If you meant a project file, use a
path inside your own worktree."
}
