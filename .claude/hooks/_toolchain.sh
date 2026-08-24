# shellcheck shell=bash
# Sourced by hooks. Makes node 24 and pnpm reachable regardless of the session's PATH.
#
# WHY: this machine's PATH carries Node v20.15 (EOL) while the project needs Node 24, and
# pnpm exists only as a corepack shim. A hook that shells out to `pnpm` without this ends
# up either running the wrong Node or reporting "pnpm: command not found" — and the hook
# then looks broken when the real fault is the environment. See CLAUDE.md § Окружение.
#
# NAMED LIMIT: this resolves Homebrew's node@24 on Apple Silicon and a corepack shim in
# the usual places. It does not install anything, and it does not fix a broken node@20/22
# brew formula — it simply prefers a working node@24 over whatever is in PATH.

_hook_prepend_path() { [[ -d "$1" ]] && PATH="$1:$PATH"; }

for _p in /opt/homebrew/opt/node@24/bin /usr/local/opt/node@24/bin; do
  _hook_prepend_path "$_p"
done
for _p in "$HOME/.local/bin" "$HOME/.local/share/corepack/bin" "$HOME/Library/pnpm"; do
  _hook_prepend_path "$_p"
done
export PATH
unset _p

# Last resort: drive pnpm through corepack when no shim is on PATH.
if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
  pnpm() { COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm "$@"; }
fi
