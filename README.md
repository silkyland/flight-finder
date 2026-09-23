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
- **Jev does not know the traveller.** It has no memory and no tools; everything it judges
  is in the state. Add preferences (baggage, visa, airline blacklist, "I hate red-eyes") to
  the `notes` array in `pick.mjs` and they will be honoured. They are not there yet.
- **Not a booking tool.** It ranks; it does not hold a fare.

## Requirements

Node 20+ (uses global `fetch`). No dependencies. Needs a `use-jev` CLI — either on `PATH`
or at `~/.agents/mcp/use-jev/cli.mjs` — with a configured backend; check with
`use-jev doctor`.
