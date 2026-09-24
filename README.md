# flight-finder

Scrape Google Flights for a route, then let **Jev** pick the itinerary worth booking.

```
./find.sh CNX NRT 2026-10-15 10        # 10 nights
./find.sh HKT SIN 2026-11-03 4 SGD     # 4 nights, priced in SGD
./scan.sh --from CNX --to XIY --from-date 2026-11-01 --to-date 2027-02-28 --nights 4
./sweep.sh --from CNX --to southeast --dates 2026-11-10,2026-12-08 --nights 4
```

Origin, destination, date, trip length and currency are all arguments — nothing is
hard-coded to a route. `CNX` / `NRT` in the examples are just placeholders. Nights comes
before currency because you nearly always want it and rarely want the latter.

Repository: <https://github.com/silkyland/flight-finder> (MIT)

```bash
git clone https://github.com/silkyland/flight-finder.git
cd flight-finder && npm install
```

Needs Node 20+ and a [`use-jev`](https://github.com/silkyland/use-jev) install. There is also an
MCP server (`mcp/server.mjs`) and a skill (`skills/flight-finder/SKILL.md`) — see the two
sections further down.


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
src/lib/flights.mjs   the whole implementation — parsing, state, questions, jev, summary
src/lib/scan.mjs      multi-date pricing, and judging which DATE is worth booking

src/scrape.mjs        CLI wrapper:  Google Flights HTML  ->  out/<route>-<date>.json
src/pick.mjs          CLI wrapper:  that JSON  ->  use-jev judge  ->  the pick
find.sh               both, in order

mcp/server.mjs        the same implementation as an MCP server (3 tools)
mcp/smoke.mjs         drives the server over stdio, for testing
```

The CLI and the server share one module on purpose: a parser fix cannot land in one and
miss the other.

`out/questions.generated.json` and `out/state.generated.json` are written on every run so
you can read exactly what was asked and exactly what Jev saw.

## The MCP server

Three tools, in increasing order of how much should never reach the model's context:

| Tool | Question it answers | Context cost |
| --- | --- | --- |
| `search_flights` | What itineraries exist on this date? | the whole list |
| `rank_flights` | Which one should I book? | the winner + 3 runners-up |
| `scan_dates` | When is it cheap? | one row per date |

`rank_flights` and `scan_dates` hand the candidate list to the Jev CLI **as a file**, so the
itineraries never travel through the model's context. That is the entire saving — a caller
that then pulls the list back in has thrown it away.

```bash
node mcp/smoke.mjs list                                  # the tool surface
node mcp/smoke.mjs rank CNX XIY 2026-12-11 4             # one date, judged
node mcp/smoke.mjs scan CNX XIY 2026-11-20 2027-01-29 4 7 8
```

Registered in `~/.workbuddy-ai/mcp.json`. It uses the low-level `Server` with raw JSON
Schema rather than `McpServer.registerTool`, because the latter requires a zod schema and
this way the only dependency stays the SDK itself.

`scan_dates` **refuses to run** without a trip length. Comparing dates priced at different
trip lengths is not slightly wrong, it is meaningless.

### The no-JavaScript view is partial

Google pre-renders the result list into the HTML only *sometimes*. When it does not, the
page parses to zero itineraries even though the route is served — the date input is filled
in, the route is correct, and there is simply no result markup. It retries three times; it
is deterministic, not a race, and no URL variation fixes it (`curr`, `gl`, display-date
phrasing and one-way all return the same nothing).

So a zero is reported as **UNKNOWN**, never as "no flights". The two are different claims
and conflating them is how you tell someone a route does not exist. Coverage is genuinely
patchy: a CNX→XIY scan of 8 sampled dates returned data for 5.

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

## The skill

`skills/flight-finder/SKILL.md`, so it stays versioned with the code it describes. It carries
the operational rules an agent needs and cannot infer: state the trip length, pass the
traveller's own preferences verbatim, read the gate before the ranking, treat `escalate` as a
prior, and never call an UNKNOWN date unavailable.

### Installing it into an agent

There are **two independent layers**, and conflating them is the usual mistake:

| Layer | What it is | How it reaches an agent |
| --- | --- | --- |
| Skill | `skills/flight-finder/SKILL.md` in this repo | a **symlink** into the agent's skills directory |
| MCP server | `mcp/server.mjs`, one process | an **entry in that agent's MCP config** |

The skill is a plain directory, so installing it is one symlink — or a copy, if the agent
cannot follow links:

```bash
git clone https://github.com/silkyland/flight-finder.git ~/flight-finder
ln -s ~/flight-finder/skills/flight-finder ~/.<agent>/skills/flight-finder
```

Keep a single clone and symlink it everywhere. The skill documents the CLI that lives beside
it, so a copy drifts the moment the code moves; set `FLIGHT_FINDER_DIR` to the clone and the
commands work from any working directory.

The MCP layer is one config file **per agent**, and every agent spells it differently. The
common shape is `mcpServers` with `command` + `args`:

```json
{
  "mcpServers": {
    "flight-finder": {
      "command": "node",
      "args": ["/absolute/path/to/flight-finder/mcp/server.mjs"]
    }
  }
}
```

Use an **absolute path** for `server.mjs`, and a `node` that actually exists — agents often
launch MCP servers with a minimal `PATH`, so a bare `node` that works in your shell can fail in
theirs. `opencode` nests under `mcp` with `command` as an *array*; `codex` is TOML under
`[mcp_servers.<name>]`. Both take the same two values.

**The MCP is optional.** The skill's CLI route (`./find.sh`, `./scan.sh`, `./sweep.sh`) works in
any agent that can run bash, with no MCP registration at all — but the itinerary list then lands
in the agent's context, so Jev's token saving is lost. The judgment is identical; only the
economics change. That is why the skill leads with both routes instead of requiring the server.



## Sweeping many destinations

`find.sh` and `scan.sh` both need a destination. When the traveller has not chosen one —
"somewhere cheap from here", "where can I go for a long weekend" — the question is not which
itinerary but *which destination*, and `sweep.sh` answers that:

```bash
./sweep.sh --from CNX --to all --dates 2026-11-10,2026-12-08,2027-01-12 --nights 4
./sweep.sh --from CNX --to southeast --from-date 2026-11-01 --to-date 2027-02-28 --step 7 --nights 4
```

`--to` accepts group names (`southeast`, `china`, `eastasia`, `southasia`, `all`), IATA codes, or a mix
of both. A code outside the built-in index still works, it just arrives at Jev unnamed — which
weakens the judgement, because the model reasons about places rather than about three-letter codes.
Name it with `=`, never with a comma (a comma separates destinations):

```bash
./sweep.sh --from CNX --to "TBS=Tbilisi=Georgia,EVN=Yerevan=Armenia" --dates 2026-11-10 --nights 6
```

Every destination is priced on the **same** departure dates at the same trip length, in
one pass, which is the only reason the fares can be compared to each other — spread the
destinations across different dates and the ranking measures the calendar, not the routes.

Each row reports the cheapest date found, the fare, the fastest journey and the spread across the
sampled dates. Jev then judges which destination is the best *trip*, with the same
`has_good_option` gate as the other two front doors.

**The cheapest destination is often cheap for a bad reason.** A 40-destination sweep from CNX put
Guangzhou (THB 6,532), Taipei (THB 9,773) and Seoul (THB 10,546) near the top — and all three were
after-midnight departures: 21:10→00:45, 00:25→04:55, 00:10→07:10. They were cheap because of the
hour, not the route. Kuala Lumpur at THB 5,336 was cheaper *and* flew at 09:10→13:10, so nothing
had to be traded. Always print the times next to the price.

A season costs one search per destination per date, so `40 destinations × 18 dates` is 720
requests. The CLI warns above 240 pairs. The practical shape is three stages: sweep wide to find
the cheap cluster, sweep the shortlist across the season to find real dates, then `scan.sh` the
winner with `--step 1` over one month to find the actual cheapest day.

Note that `--step 7` also pins the **weekday** — a seven-day step samples the same day of the week
across the whole range, so "cheapest date" means "cheapest Sunday" unless `--from-date` says
otherwise. Check the weekday before quoting a date, and always deepen a winner with `--step 1`
before putting a number in front of someone.

`sweep.sh` is CLI-only for now; the MCP server exposes the other two front doors.


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
