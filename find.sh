#!/usr/bin/env bash
# End-to-end: scrape Google Flights, then let Jev pick the best itinerary.
#
#   ./find.sh CNX NRT 2026-10-15 10          # 10 nights
#   ./find.sh HKT SIN 2026-11-03 4 SGD       # 4 nights, priced in SGD
#   RETURN=2026-12-28 ./find.sh CNX NRT 2026-12-20
#   PREFS="no low-cost carriers; at most one stop" ./find.sh CNX NRT 2026-10-15 10
#
# Origin and destination are any IATA codes — nothing is hard-coded to a route.
# Nights comes before currency because you nearly always want it and rarely want the
# latter. ALWAYS pass a trip length: without one Google invents a return date (a bare
# "on 2026-10-15" search comes back as a 15-19 Oct round trip) and every price is then
# for a trip of its choosing, not yours.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/node-path.sh"

FROM="${1:?usage: ./find.sh <ORIGIN> <DEST> <YYYY-MM-DD> [NIGHTS] [CURRENCY]}"
TO="${2:?usage: ./find.sh <ORIGIN> <DEST> <YYYY-MM-DD> [NIGHTS] [CURRENCY]}"
DATE="${3:?usage: ./find.sh <ORIGIN> <DEST> <YYYY-MM-DD> [NIGHTS] [CURRENCY]}"
NIGHTS="${4:-}"
CURRENCY="${5:-THB}"
PREFS="${PREFS:-}"
RETURN="${RETURN:-}"

cd "$HERE"
SLUG="$(echo "${FROM}-${TO}" | tr 'A-Z' 'a-z')"
if [ -n "$RETURN" ]; then
  OUT="out/${SLUG}-${DATE}-to-${RETURN}.json"
elif [ -n "$NIGHTS" ]; then
  OUT="out/${SLUG}-${DATE}-${NIGHTS}n.json"
else
  OUT="out/${SLUG}-${DATE}.json"
fi

DATE_ARG=()
if [ -n "$RETURN" ]; then
  DATE_ARG=(--return "$RETURN")
elif [ -n "$NIGHTS" ]; then
  DATE_ARG=(--days "$NIGHTS")
fi

# macOS ships bash 3.2, where `set -u` plus an empty array is an "unbound variable"
# error. The ${arr[@]+"${arr[@]}"} idiom is the portable way to expand a maybe-empty array.
"$NODE" src/scrape.mjs --from "$FROM" --to "$TO" --date "$DATE" --currency "$CURRENCY" \
  ${DATE_ARG[@]+"${DATE_ARG[@]}"} --out "$OUT"
echo

# Optional traveller preferences, semicolon-separated in $PREFS.
PREF_ARG=()
[ -n "$PREFS" ] && PREF_ARG=(--prefs "$PREFS")

# pick.mjs exits with Jev's own code: 0 = every verdict stands, 3 = something escalated.
# Propagate it deliberately rather than letting `set -e` turn it into an accidental abort.
set +e
"$NODE" src/pick.mjs --in "$OUT" ${PREF_ARG[@]+"${PREF_ARG[@]}"}
code=$?
set -e
if [ "$code" -eq 3 ]; then
  echo
  echo "find.sh: exit 3 — at least one verdict escalated, so the pick is a prior, not a decision."
fi
exit "$code"
