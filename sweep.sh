#!/usr/bin/env bash
# Price one origin against many destinations on the same departure dates — the wrapper that
# makes src/sweep.mjs runnable from any agent, without assuming node is on PATH.
#
#   ./sweep.sh --from CNX --to southeast --dates 2026-11-10,2026-12-08 --nights 4
#   ./sweep.sh --from CNX --to KUL,SIN,HKG --date 2026-11-10 --nights 4 \
#              --prefs "no overnight layovers; carry-on only"
#
# A trip length is REQUIRED (--nights or --return): without one Google returns a different trip
# length per departure date and the destinations are not priced on comparable trips. All flags
# are passed straight through — run with --help for the full list.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/node-path.sh"

# sweep.mjs exits 3 when Jev escalated a verdict, which is a result, not a failure — so capture
# the code rather than letting `set -e` abort on it.
set +e
"$NODE" "$HERE/src/sweep.mjs" "$@"
code=$?
set -e
exit "$code"
