#!/usr/bin/env bash
# End-to-end: scrape Google Flights, then let Jev pick the best itinerary.
#
#   ./find.sh CNX NRT 2026-10-15
#   ./find.sh HKT SIN 2026-11-03 SGD
#   PREFS="no low-cost carriers; at most one stop" ./find.sh CNX NRT 2026-10-15
#
# Origin and destination are any IATA codes — nothing is hard-coded to a route.
set -euo pipefail

FROM="${1:?usage: ./find.sh <ORIGIN> <DEST> <YYYY-MM-DD> [CURRENCY]}"
TO="${2:?usage: ./find.sh <ORIGIN> <DEST> <YYYY-MM-DD> [CURRENCY]}"
DATE="${3:?usage: ./find.sh <ORIGIN> <DEST> <YYYY-MM-DD> [CURRENCY]}"
CURRENCY="${4:-THB}"
PREFS="${PREFS:-}"

cd "$(dirname "$0")"
SLUG="$(echo "${FROM}-${TO}" | tr 'A-Z' 'a-z')"
OUT="out/${SLUG}-${DATE}.json"

node src/scrape.mjs --from "$FROM" --to "$TO" --date "$DATE" --currency "$CURRENCY" --out "$OUT"
echo

# Optional traveller preferences, semicolon-separated in $PREFS.
PREF_ARG=()
[ -n "$PREFS" ] && PREF_ARG=(--prefs "$PREFS")

# pick.mjs exits with Jev's own code: 0 = every verdict stands, 3 = something escalated.
# Propagate it deliberately rather than letting `set -e` turn it into an accidental abort.
set +e
node src/pick.mjs --in "$OUT" "${PREF_ARG[@]}"
code=$?
set -e
if [ "$code" -eq 3 ]; then
  echo
  echo "find.sh: exit 3 — at least one verdict escalated, so the pick is a prior, not a decision."
fi
exit "$code"
