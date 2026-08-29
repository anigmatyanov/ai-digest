#!/usr/bin/env bash
# PreToolUse hook on Bash. Blocks a sub-agent from WRITING outside the repository through
# the shell, the way enforce-subagent-worktree.sh already blocks it through Write/Edit.
#
# WHY: the file rail closed the Write/Edit door in August 2026 and said so in its own NAMED
# LIMITS — `echo > file` and `sed -i` walked straight past it. Measured on this machine
# 2026-08-29 from a sub-agent session: a Write to $HOME was refused by name, and
# `echo probe > $HOME/_probe.txt` in the very next command succeeded. One door, two rules.
#
# SCOPE: only sessions that carry `.agent_id` (i.e. sub-agents). The parent session installs
# a toolchain into ~/.local/bin by design and is never judged here.
#
# THE RISK IS THE FALSE BLOCK, NOT THE MISS. Writing through the shell is in every second
# command in this project. Measured over its session log — 6062 unique Bash commands — 313
# carry `2>&1`, 157 carry `=>`, 74 carry a heredoc and 74 carry `[[`. A matcher keyed on the
# character `>` refuses one command in twenty for no reason at all, and live-effects-guard.sh
# has already shown what that costs: three false blocks in one session, and a rail people
# reach to switch off. So this hook parses tokens, tracks quotes, heredoc bodies, `[[ ]]`
# and `(( ))`, and expands exactly four variables.
#
# FAIL-OPEN, BY CONSTRUCTION, NOT AS A LAST `else`. There is no danger zone here that a
# command has to argue its way out of. A deny happens at ONE point: the target was
# positively resolved to an absolute path, that path is outside $REPO_ROOT, and it is not
# scratch. Ambiguity anywhere upstream — an unknown variable, an unrecognised form, a `cd`
# that could not be resolved — is simply the absence of a resolved target, i.e. a pass.
# This is the opposite of live-effects-guard.sh on purpose: the cost of its error is a post
# in a real channel that cannot be unsent, the cost of this one is a file in a neighbouring
# folder. Where a write form IS recognised but the target cannot be resolved, the hook says
# so on stderr and passes — a silent fail-open is indistinguishable from a dead hook.
#
# WHAT COUNTS AS A WRITE (v1): redirections `>`, `>>`, `>|`, `N>`, `&>`, `&>>`, `<>`, and
# `>&` when what follows is not a descriptor; `tee`; `sed`/`gsed` only with `-i`;
# `cp`/`mv`/`install` (last operand, or `-t`); `ln` (link name); `dd of=`; `mkdir`; `touch`.
# Leading assignments and the wrappers env/command/nohup/time/builtin/sudo are skipped.
#
# NAMED LIMITS — forms that DO write and are deliberately not caught. The list is short on
# purpose (the house rule from git-add-pathspec-guard.sh): it grows when an agent actually
# tries one of these, not in anticipation.
#   * `curl -o`, `wget -O/-P`, `tar -C/-f`, `unzip -d`, `rsync`, `truncate`, `patch -o`,
#     `perl -i`, `sponge`, `awk '{print > f}'`
#   * another layer of execution: `bash -c`, `eval`, `xargs`, `python3 -c`, `node -e`,
#     a repo script that writes when invoked by an innocuous name
#   * `git -C <dir>`
#   * a target reached through a variable the hook does not expand: `t=~/x; echo p > "$t"`
#     resolves in the shell and not here. Pinned as `expect 0` in the battery.
#   * a write inside `$( )` or backticks: the substitution is consumed, not parsed
#   * `$PWD` expands to the cwd the hook was handed, so a `$PWD` used after a `cd` resolves
#     to the wrong directory — inwards, i.e. it passes
#   * symlinks: normalisation is lexical, exactly as in the file rail
#   * `rm`/`rmdir` are OUT OF SCOPE, not missed: deleting is not writing, and the epic says
#     "write". See the epic's Notes for the proposal to file that separately.
#
# DELIBERATE ASYMMETRY WITH THE FILE RAIL: this hook stops at the REPOSITORY boundary. The
# file rail additionally defends the WORKTREE boundary — it refuses a sub-agent writing into
# the main tree or into a sibling's worktree, and this one does not. Pinned by a case in
# test/hooks/run.sh so the difference is a decision on record rather than an oversight.
#
# NOT A SANDBOX. This is a backstop against a mistyped absolute path. `bash -c` behind a
# variable defeats it, and is meant to: real isolation is a sandbox, not a hook.
#
# KILL SWITCH: .claude/hooks/bash-write-path-guard.disabled — file only. There is
# deliberately NO environment bypass: a bypass an agent can read out of the deny message
# stops being a rail the first time the agent is in a hurry.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=_paths.sh
source "$(dirname "${BASH_SOURCE[0]}")/_paths.sh"
payload="$(cat)"
warn() { printf '%s\n' "$*" >&2; }

deny() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  warn "$1"
  exit 2
}

[[ -f "$REPO_ROOT/.claude/hooks/bash-write-path-guard.disabled" ]] && {
  warn "[bash-write-path-guard] DISABLED by kill-switch file — Bash writes outside the repository are NOT blocked."; exit 0; }
# Fail OPEN without jq, like the other path rails: a missing parser must not stop all work.
command -v jq >/dev/null 2>&1 || exit 0

agent_id="$(printf '%s' "$payload" | jq -r '.agent_id // ""' 2>/dev/null)"
[[ -z "$agent_id" ]] && exit 0   # parent session — not our business

cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null)"
[[ -z "$cmd" ]] && exit 0

# ── phase 1: could this command name anything outside the repository at all? ─────
#
# A target that resolves outside must be absolute, or start at ~ / $HOME / $TMPDIR, or climb
# with `../`. Nothing else can leave the tree. Measured on the session log: 544 of 6062
# commands (9%) get past this line, so the lexer below runs on one command in eleven.
# A token-INITIAL slash is what matters — `packages/core` and `./scripts/x` are inert.
#
# `~` is matched at a word head, NOT as `~/`. Found by an adversarial sweep after the first
# implementation: `cd ~ && echo x > n.txt` writes into $HOME and carries no `~/` and no
# token-initial slash, so it never reached the lexer at all. A cheap phase-1 test is worth
# having; one that is cheap because it is wrong is not.
if ! printf '%s' "$cmd" | LC_ALL=C grep -qE '(^|[^A-Za-z0-9_.+-])[/~]|\$\{?HOME|\$\{?TMPDIR|(^|[^A-Za-z0-9_.])\.\./'; then
  exit 0
fi

# ── phase 2: lex the command ────────────────────────────────────────────────────
#
# One pass in awk (already a dependency of the file rail's normaliser). Emits tab-separated
# records: SEP at every command separator, SUB at a subshell paren, WRD <flag> <text> for a
# word and TGT <flag> <text> for the target of a write redirection. <flag> is R when the
# text was resolved with nothing left to expand, U when something was dropped ($VAR, `…`,
# $(…)) — a U target is never judged.
#
# Bash 3.2 on this machine: no mapfile, no associative arrays. Plain arrays only.
TAB=$'\t'
lex() {
  printf '%s' "$cmd" | awk -v HOMEV="$HOME" -v TMPV="${TMPDIR:-}" -v PWDV="$PWD" -v SQ="'" '
function emit(kind, flag, txt) {
  if (txt ~ /\n/ || txt ~ /\t/) { flag = "U"; gsub(/[\n\t]/, " ", txt) }
  printf "%s\t%s\t%s\n", kind, flag, txt
}
function sep() { pend = 0; print "SEP\t\t" }
function isdelim(ch) {
  return (ch == "" || ch == " " || ch == "\t" || ch == "\n" || ch == ";" || ch == "&" || ch == "|" || ch == "(" || ch == ")" || ch == "<" || ch == ">")
}
function flushw() {
  if (!have) return
  if (word == "[[") condd++
  else if (word == "]]") { if (condd > 0) condd-- }
  if (pendhd) { hqn++; hq[hqn] = word; hqs[hqn] = pendhdstrip; pendhd = 0 }
  else if (pend) { emit("TGT", wf, word); pend = 0 }
  else emit("WRD", wf, word)
  word = ""; wf = "R"; have = 0
}
function expandv(name, nexti) {
  if (name == "HOME" && HOMEV != "") { word = word HOMEV; return nexti }
  if (name == "TMPDIR" && TMPV != "") { word = word TMPV; return nexti }
  if (name == "PWD" && PWDV != "") { word = word PWDV; return nexti }
  wf = "U"; word = word "$"
  return nexti
}
function dollar(p,   c2, j, dep, ch, name, k) {
  c2 = substr(S, p + 1, 1)
  if (c2 == "(") {
    j = p + 2; dep = 1
    while (j <= n && dep > 0) { ch = substr(S, j, 1); if (ch == "(") dep++; else if (ch == ")") dep--; j++ }
    wf = "U"; word = word "$"
    return j
  }
  if (c2 == "{") {
    k = index(substr(S, p + 2), "}")
    if (k == 0) { wf = "U"; word = word "$"; return p + 2 }
    name = substr(S, p + 2, k - 1)
    return expandv(name, p + 2 + k)
  }
  if (c2 ~ /^[A-Za-z_]$/) {
    j = p + 1; name = ""
    while (j <= n && substr(S, j, 1) ~ /^[A-Za-z0-9_]$/) { name = name substr(S, j, 1); j++ }
    return expandv(name, j)
  }
  wf = "U"; word = word "$"
  return p + 2
}
function btick(p,   j) {
  j = p + 1
  while (j <= n && substr(S, j, 1) != "`") j++
  wf = "U"; word = word "$"
  return (j <= n) ? j + 1 : n + 1
}
function skipparen(p,   j, dep, ch) {
  j = p; dep = 1
  while (j <= n && dep > 0) { ch = substr(S, j, 1); if (ch == "(") dep++; else if (ch == ")") dep--; j++ }
  return j
}
function gt(p,   d, j, ch, digits) {
  d = substr(S, p + 1, 1)
  if (d == "(") { flushw(); return skipparen(p + 2) }       # >(...) process substitution
  # A leading run of digits immediately before the operator is a descriptor, not a word.
  if (have && wf == "R" && word ~ /^[0-9]+$/) { word = ""; have = 0 } else flushw()
  if (d == ">") {
    if (substr(S, p + 2, 1) == "(") return skipparen(p + 3)
    pend = 1; return p + 2
  }
  if (d == "|") { pend = 1; return p + 2 }
  if (d == "&") {
    j = p + 2; digits = ""
    while (j <= n && substr(S, j, 1) ~ /^[0-9]$/) { digits = digits substr(S, j, 1); j++ }
    ch = substr(S, j, 1)
    if (digits != "" && isdelim(ch)) return j                # 2>&1 — descriptor duplication
    if (digits == "" && ch == "-") return j + 1              # >&-  — descriptor close
    pend = 1; return p + 2                                   # >& file — a real write
  }
  pend = 1; return p + 1
}
function lt(p,   d, e, j) {
  d = substr(S, p + 1, 1)
  if (d == "(") { flushw(); return skipparen(p + 2) }       # <(...) process substitution
  if (have && wf == "R" && word ~ /^[0-9]+$/) { word = ""; have = 0 } else flushw()
  if (d == "<") {
    e = substr(S, p + 2, 1)
    if (e == "<") return p + 3                               # <<< here-string, a read
    if (e == "-") { pendhd = 1; pendhdstrip = 1; return p + 3 }
    pendhd = 1; pendhdstrip = 0; return p + 2
  }
  if (d == ">") { pend = 1; return p + 2 }                   # <> opens for writing too
  if (d == "&") { j = p + 2; while (j <= n && substr(S, j, 1) ~ /^[0-9]$/) j++; if (substr(S, j, 1) == "-") j++; return j }
  return p + 1                                               # < read
}
BEGIN { RS = "\001" }
{
  S = $0; n = length(S); i = 1
  q = 0; word = ""; wf = "R"; have = 0
  pend = 0; pendhd = 0; pendhdstrip = 0
  condd = 0; arith = 0; hqn = 0; hqi = 0; inhd = 0
  while (i <= n) {
    c = substr(S, i, 1)
    prevc = (i > 1) ? substr(S, i - 1, 1) : ""
    if (inhd) {                                              # heredoc body: data, not code
      k = index(substr(S, i), "\n")
      if (k == 0) { ln = substr(S, i); i = n + 1 } else { ln = substr(S, i, k - 1); i = i + k }
      if (hdstrip) sub(/^[ \t]+/, "", ln)
      if (ln == hddelim) inhd = 0
      continue
    }
    if (q == 1) {                                            # inside single quotes
      if (c == SQ) q = 0; else { word = word c; have = 1 }
      i++; continue
    }
    if (q == 2) {                                            # inside double quotes
      if (c == "\\") {
        d2 = substr(S, i + 1, 1)
        if (d2 == "$" || d2 == "`" || d2 == "\"" || d2 == "\\") { word = word d2; have = 1; i += 2; continue }
        if (d2 == "\n") { i += 2; continue }
        word = word c; have = 1; i++; continue
      }
      if (c == "\"") { q = 0; i++; continue }
      if (c == "`") { i = btick(i); continue }
      if (c == "$") { i = dollar(i); have = 1; continue }
      word = word c; have = 1; i++; continue
    }
    if (c == "\\") {                                         # unquoted from here on
      d2 = substr(S, i + 1, 1)
      if (d2 == "\n") { i += 2; continue }
      if (d2 == "") { i++; continue }
      word = word d2; have = 1; i += 2; continue
    }
    if (c == SQ) { q = 1; have = 1; i++; continue }
    if (c == "\"") { q = 2; have = 1; i++; continue }
    if (c == "`") { i = btick(i); have = 1; continue }
    if (c == "$") {
      d2 = substr(S, i + 1, 1)
      if (d2 == SQ) { q = 1; have = 1; i += 2; continue }
      if (d2 == "\"") { q = 2; have = 1; i += 2; continue }
      i = dollar(i); have = 1; continue
    }
    # ~ expands only unquoted and only at the head of a word. ~user does not expand.
    if (c == "~" && have == 0) {
      d2 = substr(S, i + 1, 1)
      if (d2 == "/" || isdelim(d2)) { word = word HOMEV; have = 1; i++; continue }
      word = word c; have = 1; i++; continue
    }
    if (c == " " || c == "\t") { flushw(); i++; continue }
    if (c == "#" && have == 0 && (i == 1 || prevc == " " || prevc == "\t" || prevc == "\n" || prevc == ";" || prevc == "&" || prevc == "|" || prevc == "(")) {
      k = index(substr(S, i), "\n")
      if (k == 0) i = n + 1; else i = i + k - 1
      continue
    }
    if (c == "\n") {
      flushw(); sep(); i++
      if (hqn > hqi) { hqi++; hddelim = hq[hqi]; hdstrip = hqs[hqi]; inhd = 1 }
      continue
    }
    if (condd == 0 && arith == 0) {
      if (c == ">") { i = gt(i); continue }
      if (c == "<") { i = lt(i); continue }
      if (c == "&") {
        d2 = substr(S, i + 1, 1)
        if (d2 == ">") {
          flushw(); pend = 1
          i += (substr(S, i + 2, 1) == ">") ? 3 : 2          # &> and &>>
          continue
        }
        flushw(); sep()
        i += (d2 == "&") ? 2 : 1
        continue
      }
      if (c == "|") {
        d2 = substr(S, i + 1, 1)
        flushw(); sep()
        i += (d2 == "|" || d2 == "&") ? 2 : 1
        continue
      }
      if (c == ";") { flushw(); sep(); i++; if (substr(S, i, 1) == ";") i++; continue }
      if (c == "(") {
        flushw()
        if (substr(S, i + 1, 1) == "(") { arith++; i += 2; continue }
        emit("SUB", "(", ""); i++; continue
      }
      if (c == ")") { flushw(); emit("SUB", ")", ""); i++; continue }
    } else if (arith > 0 && c == ")" && substr(S, i + 1, 1) == ")") {
      flushw(); arith--; i += 2; continue
    }
    word = word c; have = 1; i++
  }
  flushw(); sep()
}
'
}

# ── phase 3: judge what the lexer resolved ──────────────────────────────────────

eff_cwd="$PWD"          # same source as the file rail: the cwd the hook was handed
eff_unknown=0
sub_n=0
sub_cwd=(); sub_unk=()
segn=0
seg_w=(); seg_f=()

reset_seg() { segn=0; seg_w=(); seg_f=(); }
sub_push() { sub_cwd[$sub_n]="$eff_cwd"; sub_unk[$sub_n]="$eff_unknown"; sub_n=$((sub_n + 1)); }
sub_pop() {
  [[ $sub_n -gt 0 ]] || return 0
  sub_n=$((sub_n - 1)); eff_cwd="${sub_cwd[$sub_n]}"; eff_unknown="${sub_unk[$sub_n]}"
}

# A target is judged only if it can still be a path after expansion. Anything carrying a
# glob, a bracket, a residual `$` or a shell metacharacter is a fragment the lexer read out
# of something that was never a filename — the second line of defence behind quote tracking
# against `=>` and `/^[A-Z_]+=/` in a JS snippet.
implausible() {
  case "$1" in
    "" | "-") return 0 ;;
  esac
  printf '%s' "$1" | LC_ALL=C grep -q '[][{}()*?\|;&<>$`]' && return 0
  return 1
}

judge() {
  local flag="$1" tok="$2" abs norm
  if [[ "$flag" != "R" ]]; then
    warn "[bash-write-path-guard] unresolved write target, passing: $tok"
    return 0
  fi
  implausible "$tok" && return 0
  abs="$tok"
  if [[ "$abs" != /* ]]; then
    if [[ $eff_unknown -eq 1 ]]; then
      warn "[bash-write-path-guard] relative write target after an unresolved cd, passing: $tok"
      return 0
    fi
    abs="$eff_cwd/$abs"
  fi
  norm="$(norm_path "$abs")"
  [[ "$norm" == "$REPO_ROOT"/* || "$norm" == "$REPO_ROOT" ]] && return 0
  is_scratch "$norm" && return 0
  deny "$(outside_repo_reason "$norm" "$REPO_ROOT")
  command: $cmd
This is a write through the shell — a redirection, tee, cp/mv/install/ln, dd, mkdir or
sed -i. The same path is refused to Write and Edit; going through Bash does not make it a
different rule. If the file really is temporary, put it in \$TMPDIR or /tmp."
}

# Operands of the current segment, with flags that carry a separate argument consumed.
# Fills ops_w/ops_f/ops_n, and tdir_w/tdir_f for an explicit -t / --target-directory.
collect_ops() {
  local argflags="$1" j w f dd=0
  ops_n=0; ops_w=(); ops_f=(); tdir_w=""; tdir_f=""
  j=$((idx + 1))
  while [[ $j -lt $segn ]]; do
    w="${seg_w[$j]:-}"; f="${seg_f[$j]:-}"
    if [[ $dd -eq 0 ]]; then
      if [[ "$w" == "--" ]]; then dd=1; j=$((j + 1)); continue; fi
      case "$w" in
        --target-directory=*) tdir_w="${w#--target-directory=}"; tdir_f="$f"; j=$((j + 1)); continue ;;
      esac
      if [[ "$w" == -?* ]]; then
        if [[ " $argflags " == *" $w "* ]]; then
          j=$((j + 1))
          if [[ $j -lt $segn ]]; then
            if [[ "$w" == "-t" || "$w" == "--target-directory" ]]; then
              tdir_w="${seg_w[$j]:-}"; tdir_f="${seg_f[$j]:-}"
            fi
            j=$((j + 1))
          fi
          continue
        fi
        j=$((j + 1)); continue
      fi
    fi
    if [[ -n "$w" ]]; then
      ops_w[$ops_n]="$w"; ops_f[$ops_n]="$f"; ops_n=$((ops_n + 1))
    fi
    j=$((j + 1))
  done
}

# The directory stack, for pushd/popd. Separate from the subshell stack: `( )` restores the
# base on exit, popd restores it on request, and the two nest independently.
ds_n=0
ds_cwd=(); ds_unk=()
ds_push() { ds_cwd[$ds_n]="$eff_cwd"; ds_unk[$ds_n]="$eff_unknown"; ds_n=$((ds_n + 1)); }
ds_pop() {
  if [[ $ds_n -gt 0 ]]; then
    ds_n=$((ds_n - 1)); eff_cwd="${ds_cwd[$ds_n]}"; eff_unknown="${ds_unk[$ds_n]}"
  else
    eff_unknown=1
  fi
}

# Move the effective base to $1, or mark it unknown when $1 cannot be resolved. `cd -`
# lands here as the implausible token "-", which is exactly the unknown case.
resolve_cwd() {
  local w="$1" f="$2"
  if [[ "$f" != "R" ]] || implausible "$w"; then eff_unknown=1; return 0; fi
  if [[ "$w" != /* ]]; then
    [[ $eff_unknown -eq 1 ]] && return 0
    w="$eff_cwd/$w"
  fi
  eff_cwd="$(norm_path "$w")"; eff_unknown=0
}

run_segment() {
  [[ $segn -gt 0 ]] || return 0
  local idx=0 w base last k
  while [[ $idx -lt $segn ]]; do
    w="${seg_w[$idx]:-}"
    case "$w" in
      [A-Za-z_]*=*) idx=$((idx + 1)); continue ;;
      env | command | nohup | time | builtin | sudo | then | else | do) idx=$((idx + 1)); continue ;;
    esac
    break
  done
  [[ $idx -lt $segn ]] || return 0
  base="${seg_w[$idx]:-}"; base="${base##*/}"

  case "$base" in
    cd)
      collect_ops ""
      if [[ $ops_n -eq 0 ]]; then eff_cwd="$HOME"; eff_unknown=0; return 0; fi
      resolve_cwd "${ops_w[0]}" "${ops_f[0]}"
      ;;
    # pushd moves the base exactly as cd does, and popd moves it back. Found by an
    # adversarial sweep, not by the log: `pushd ~ && echo x > n.txt` was a MISS, which is
    # the cheap error here, but a two-line one. `pushd` with no directory, or with +N/-N,
    # rotates the stack instead of pushing — that is an unknown base, not a guess.
    pushd)
      collect_ops ""
      ds_push
      if [[ $ops_n -eq 0 || "${ops_w[0]}" == +* ]]; then eff_unknown=1; return 0; fi
      resolve_cwd "${ops_w[0]}" "${ops_f[0]}"
      ;;
    popd) ds_pop ;;
    tee)
      collect_ops ""
      for ((k = 0; k < ops_n; k++)); do judge "${ops_f[$k]}" "${ops_w[$k]}"; done
      ;;
    sed | gsed)
      local inplace=0
      for ((k = idx + 1; k < segn; k++)); do
        w="${seg_w[$k]:-}"
        [[ "$w" == "--" ]] && break
        if [[ "$w" == --in-place* ]] || [[ "$w" =~ ^-[A-Za-z]*i ]]; then inplace=1; break; fi
      done
      [[ $inplace -eq 1 ]] || return 0
      # The first operand is the script (`s/x/y/`), or the backup suffix BSD sed takes as a
      # separate word after -i. Everything after it is a file sed rewrites in place.
      collect_ops "-e -f --expression --file"
      for ((k = 1; k < ops_n; k++)); do judge "${ops_f[$k]}" "${ops_w[$k]}"; done
      ;;
    cp | mv | install)
      collect_ops "-t --target-directory -m --mode -o --owner -g --group -S --suffix"
      if [[ -n "$tdir_w" ]]; then judge "$tdir_f" "$tdir_w"; return 0; fi
      [[ $ops_n -ge 2 ]] || return 0
      last=$((ops_n - 1)); judge "${ops_f[$last]}" "${ops_w[$last]}"
      ;;
    ln)
      collect_ops ""
      [[ $ops_n -ge 2 ]] || return 0
      last=$((ops_n - 1)); judge "${ops_f[$last]}" "${ops_w[$last]}"
      ;;
    dd)
      for ((k = idx + 1; k < segn; k++)); do
        w="${seg_w[$k]:-}"
        [[ "$w" == of=* ]] && judge "${seg_f[$k]:-}" "${w#of=}"
      done
      ;;
    mkdir | touch)
      collect_ops "-m --mode"
      for ((k = 0; k < ops_n; k++)); do judge "${ops_f[$k]}" "${ops_w[$k]}"; done
      ;;
  esac
}

while IFS="$TAB" read -r kind flag txt; do
  case "$kind" in
    WRD) seg_w[$segn]="$txt"; seg_f[$segn]="$flag"; segn=$((segn + 1)) ;;
    # A redirection target is judged where it appears: it is resolved before the command in
    # its own segment runs, so a `cd` in that same segment must not apply to it.
    TGT) judge "$flag" "$txt" ;;
    SEP) run_segment; reset_seg ;;
    # A `cd` inside ( … ) does not outlive the subshell. Without this, `(cd ~/x && cat y)`
    # followed by `echo z > w.txt` would judge w.txt against ~/x and refuse it.
    SUB)
      run_segment; reset_seg
      if [[ "$flag" == "(" ]]; then sub_push; else sub_pop; fi
      ;;
  esac
done < <(lex)

exit 0
