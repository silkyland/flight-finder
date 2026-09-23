# flight-finder

Scrape Google Flights for a route, then let **Jev** pick the itinerary worth booking.

```
./find.sh CNX NRT 2026-10-15 10        # 10 nights
./find.sh HKT SIN 2026-11-03 4 SGD     # 4 nights, priced in SGD
```

Origin, destination, date, trip length and currency are all arguments — nothing is
hard-coded to a route. `CNX` / `NRT` in the examples are just placeholders. Nights comes
before currency because you nearly always want it and rarely want the latter.

## Trip length is not optional

**Always pass the number of nights.** Without it Google silently invents a return date,
and every price you get back is for a trip nobody chose. A bare
`Flights from CNX to NRT on 2026-10-15` search comes back as a **15–19 Oct** round trip:
4 nights, picked by Google.

That is not a rounding error. Cheapest CNX→NRT round trip, departing 2026-10-15:

| nights | return | cheapest | vs Google's default |
|---|---|---|---|
| 3 | 2026-10-18 | THB 16,114 | same |
| **5** | **2026-10-20** | **THB 14,940** | **−7%** |
| 7 | 2026-10-22 | THB 15,164 | −6% |
| 10 | 2026-10-25 | THB 17,782 | **+10%** |
| 14 | 2026-10-29 | THB 15,164 | −6% |

A 19% spread between the cheapest and dearest trip length — and the length Google picks
by default (4 nights) is not the cheap one. Ranking itineraries before fixing the trip
length is ranking the wrong question.

So the tool does two things about it:

- `--days N` or `--return YYYY-MM-DD` (and `RETURN=` through `find.sh`) set it explicitly.
- It **reads the dates back out of the page** afterwards and compares. `searchedDates` and
  `searchedNights` in the JSON record what was actually searched; if that disagrees with
  what you asked for, `scrape.mjs` and `pick.mjs` both say so out loud rather than
  quietly reporting fares for the wrong trip:

  ```
  scrape: WARNING — no trip length given, so Google chose one:
          2026-10-15 -> 2026-10-19 (4 nights). Every price below is for THAT trip.
  ```

The dates are read from two places on purpose: the visible inputs give a display string
(`Thu, Oct 15`) and the "Track prices" aria-label carries unambiguous ISO dates
(`departing 2026-10-15 and returning 2026-10-19`). Arithmetic uses the ISO pair, so a
missing one yields `null` rather than a silently wrong number.

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

- **Prices are a snapshot** and move. They are round-trip totals for the trip length you
  pass, economy, one adult. One-way is not implemented — Google defaults to a round trip,
  and the query would need a different form.
- **The trip length is a single number, not a date range.** Scanning several lengths or
  several departure dates and comparing them is not implemented; run the tool per date and
  compare, or ask for it.
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
