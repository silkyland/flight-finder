# Resolve a node to run with, and export it as $NODE.
#
# Sourced by find.sh and scan.sh. This skill is shared across agents, and some of them launch
# commands with a minimal PATH where a bare `node` does not exist — failing with a clear message
# beats failing with "command not found" halfway through a scrape.
#
# Not executable on its own; source it.

NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  for candidate in \
    "$HOME"/.workbuddy-ai/binaries/node/versions/*/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node
  do
    if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  echo "$(basename "$0"): no node found on PATH or in the usual install locations — need Node 20+." >&2
  exit 127
fi
export NODE
