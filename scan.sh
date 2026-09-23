#!/usr/bin/env bash
# Price one route across many departure dates — the wrapper that makes src/scan.mjs runnable
# from any agent, without assuming node is on PATH.
#
#   ./scan.sh --from CNX --to XIY --from-date 2026-11-01 --to-date 2027-02-28 --nights 4 --step 4
#   ./scan.sh --from CNX --to XIY --from-date 2026-11-01 --to-date 2027-02-28 --nights 4 \
#             --prefs "no overnight layovers; carry-on only"
#
# A trip length is REQUIRED (--nights or --return): without one Google returns a different trip
# length per departure date and the prices are not comparable. All flags are passed straight
# through — run with --help for the full list.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/node-path.sh"

# scan.mjs exits 3 when Jev escalated a verdict, which is a result, not a failure — so capture
# the code rather than letting `set -e` abort on it.
set +e
"$NODE" "$HERE/src/scan.mjs" "$@"
code=$?
set -e
exit "$code"
