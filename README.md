# flight-finder

Scrape Google Flights for a route, then let **Jev** pick the itinerary worth booking.

```
./find.sh CNX NRT 2026-10-15
./find.sh HKT SIN 2026-11-03 SGD
```

Origin, destination, date and currency are all arguments — nothing is hard-coded to a
route. `CNX` / `NRT` in the examples are just placeholders.

## Why Jev is in here at all

Ranking a dozen itineraries is a *judgment over text*, and the interesting part is not
arithmetic — it is knowing that a 15-hour layover in Hong Kong is worse than paying
2,000 baht more, or that two nonstops at the same price are not the same flight if one
lands at 11:25 PM. That is exactly the shape Jev is for.

The other half of the design matters just as much: **the itinerary list never enters the
agent's context.** `src/pick.mjs` reads the JSON off disk and posts it to `use-jev judge`
as a subprocess. Only the verdicts come back. A judgment pasted into a tool call would
travel through the context twice; this way it travels through zero times.

## Pipeline

```
src/scrape.mjs   Google Flights HTML  ->  out/<route>-<date>.json
src/pick.mjs     that JSON            ->  use-jev judge  ->  the pick
find.sh          both, in order
```

`out/questions.generated.json` and `out/state.generated.json` are written on every run so
you can read exactly what was asked and exactly what Jev saw.

### Scraping without a browser

Google Flights renders client-side, so the obvious move is a headless browser. It is not
needed: the initial HTML already contains, per itinerary, an accessibility description

> Leaves Chiang Mai International Airport at 8:25 AM on Thursday, October 15 and arrives
> at Narita International Airport at 8:05 PM on Thursday, October 15. Total duration
> 9 hr 40 min. Layover (1 of 1) is a 2 hr layover at Don Mueang International Airport in
> Bangkok.

the exact price in an aria-label (`aria-label="16108 Thai baht"`), and the flight numbers
in a booking URL (`itinerary=CNX-DMK-FD-3438-20261015,DMK-NRT-XJ-606-20261015`). Splitting
the page on `<li` gives one chunk per itinerary holding all three. No Chromium, no
Playwright, ~1 second per route.

Two things worth knowing if you edit the parser:

- **Google emits each itinerary more than once** (desktop markup plus a hidden duplicate),
  so raw card count is roughly double the real one. `scrape.mjs` collapses on
  price + airlines + times + duration + stops + layover airports.
- **A connection under an hour has no "hr" in it** — `is a 55 min layover at ...`. A regex
  that requires `(\d+) hr` silently drops it, which is how the THAI itinerary first came
  back with `stops=1` and no layover.

## The questions

Six questions in **one** call, which is the point — one call with many questions beats
many calls by an order of magnitude.

| question | type | what it decides |
|---|---|---|
| `has_good_option` | `noul` | is anything here actually worth booking |
| `best_overall` | `choice` | the pick, weighing price against time and comfort |
| `best_budget` | `choice` | the pick if only money matters |
| `best_schedule` | `choice` | the pick if only comfort matters |
| `worst_value` | `choice` | what looks cheap but is not |
| `cheapest_value` | `score` | how good the cheapest option really is |

`has_good_option` is not decoration. A `choice` always ranks something first because its
probabilities sum to 1 — so if nothing in the list fits, a bare `choice` still returns a
confident-looking winner. Pairing it with a presence `noul` and reading that first is the
documented way to avoid acting on nonsense.

`worst_value` exists because a ranker that only ever returns the best option is hard to
trust. Asking for the worst gives you something to check it against.

## Traveller preferences

Jev has no memory and no tools — it only knows what is written into the state. A preference
that is not stated does not exist as far as the ranking is concerned, so they are a
parameter:

```bash
node src/pick.mjs --in out/cnx-nrt.json --prefs "no low-cost carriers; at most one stop; 20kg bag included"
node src/pick.mjs --in out/cnx-nrt.json --prefs-file prefs.txt
PREFS="no red-eyes; depart after 10am" ./find.sh CNX NRT 2026-10-15
```

`prefs.example.txt` has a starter set. They are stated as hard constraints, and the
questions tell Jev to honour them as such.

The effect is not cosmetic. Same 11 itineraries, CNX→NRT 2026-10-15:

| | no preferences | "full-service only, no arrival after 10 PM, at most one stop, 20kg bag" |
|---|---|---|
| `has_good_option` | 0.87 — a good option exists | **0.35 — nothing here is genuinely good** |
| `best_overall` | f01, 89% | **f11 (THAI), 50%, escalated** |
| price | THB 16,114 | THB 33,625 |

Two things are worth noticing. The pick moves off the cheap low-cost option to the
full-service one at double the fare — and it does so **unconfidently**, because THAI still
arrives at 6:20 AM on a 55-minute connection, so the constraint set is not actually
satisfiable on this date. The presence check is what surfaces that instead of letting the
`choice` hand back a confident-looking winner. That drop from 0.87 to 0.35 is the whole
reason `has_good_option` is in the batch.

## Reading the output

```
  best overall  ->  f01  (74.0%)
      THB 16,114 | Thai AirAsia + Thai AirAsia X | 8:25 AM -> 8:05 PM | 9 hr 40 min ...
      runners-up: f02 23.0%, f11 2.0%
```

The percentages are Jev's distribution over the options. Two caveats:

- **`escalate: true` means it is your call.** The verdict is still there as a prior worth
  reading, but the model was not confident enough to decide. The `cheapest_value` score
  escalates most runs for a real reason: the distribution sits across two adjacent levels,
  so "clearly better than the alternatives" and "the obvious pick at this price" are both
  defensible. That is information, not a failure.
- **A `score` answer can land between levels** (e.g. `2.91`), which is what `score` is for.

`pick.mjs` exits with Jev's own code: `0` when every verdict stands, `3` when something
escalated, so you can branch on it in a script.

## Limits

- **Prices are a snapshot** and move. Round-trip totals as Google quotes them, economy,
  one adult; Google's default is a round trip, so a one-way search needs the URL changed.
- **Scraping a rendered Google page is inherently brittle.** The three signals above are
  stable and well-labelled, but Google can change markup at any time. If `count` drops to
  0, the HTML format moved — check `out/` and re-derive the regexes.
- **Jev does not know the traveller unless you tell it.** It has no memory and no tools;
  everything it judges is in the state. Preferences go through `--prefs` / `--prefs-file`
  (see above) — anything not stated there is simply not considered.
- **Baggage, alliance and fare conditions are not in the scraped data.** Google Flights
  exposes price, times, duration, stops, connection airports and CO2, and that is all. So
  a preference like "20kg bag included" is honoured by inference from the airline, not from
  the fare rules — check it on the booking page before you pay.
- **Not a booking tool.** It ranks; it does not hold a fare.

## Requirements

Node 20+ (uses global `fetch`). No dependencies. Needs a `use-jev` CLI — either on `PATH`
or at `~/.agents/mcp/use-jev/cli.mjs` — with a configured backend; check with
`use-jev doctor`.
