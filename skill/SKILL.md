---
name: flight-finder
description: >-
  Find flights and pick the best one by scraping Google Flights without a browser and having Jev
  judge the itineraries. Use for finding flights between two airports, comparing fares, deciding
  which ticket to book, checking whether a quoted price is good, and finding the cheapest travel
  dates across a season. Triggers include "find flights", "cheapest flight to X", "best ticket",
  "which date is cheapest", "is this a good price", and the Thai forms "หา flight", "หาตั๋วเครื่องบิน",
  "ตั๋วไป", "ราคาตั๋ว", "ช่วงไหนถูก". Works two ways: the flight-finder MCP tools (search_flights,
  rank_flights, scan_dates) when the server is connected, otherwise the CLI in
  ~/Sites/BareProj/flight-finder — see the CLI fallback section, and do not give up just because
  the MCP tools are missing.
---

# flight-finder

Scrapes Google Flights from the initial HTML — no browser, no headless Chrome — then lets Jev
pick between the itineraries. Answers two different questions, and mixing them up is the main
way to get a bad answer:

- **Which flight should I book on this date?** → `rank_flights`
- **When is it cheap?** → `scan_dates`

## Two ways to reach it — try the tools, fall back to the CLI

If the `flight-finder` MCP tools are available, use them. If they are **not** — this skill is
shared across several agents and the MCP server is registered per agent, so it may well be
missing — do not stop. The same logic runs from the repo:

```bash
cd ~/Sites/BareProj/flight-finder
./find.sh CNX XIY 2026-12-11 4                                  # one date, judged
./scan.sh --from CNX --to XIY --from-date 2026-11-01 \
          --to-date 2027-02-28 --nights 4 --step 4              # a season, as a table
```

Both wrappers resolve `node` themselves, so they work even when the agent's PATH is minimal.
Requires only Node 20+ and a `use-jev` install; no build step. The one real cost of the CLI
route is that the itinerary list lands in your context, so Jev's saving is lost — the *judgment*
is the same, only the token economics differ. See the CLI fallback section at the end for flags.

## The one rule that matters most: always state the trip length

Pass `nights` (or `return_date`) on **every** call.

If you do not, Google silently invents a return date. A bare search for "on 2026-10-15" comes
back as a **15–19 Oct round trip** — four nights nobody asked for — and every price then
describes that trip. The tool will warn you when this happens, but the warning is a symptom of a
call you should not have made.

For a request like "5 days 4 nights", pass `nights: 4`. Days and nights are not the same thing:
5 days / 4 nights is `nights: 4`.

`scan_dates` **refuses to run** without a trip length, because comparing dates priced at
different trip lengths is meaningless rather than merely inaccurate.

## The tools

### `rank_flights` — which ticket to book

```
rank_flights { from, to, date, nights | return_date, currency?, preferences?, threshold?, include_all? }
```

Returns the winning itinerary, the close runners-up, a budget pick, a schedule pick, the worst
value, and a presence check. **Do not set `include_all`** unless the caller actually wants the
whole list — the entire point is that the list stays out of your context.

### `scan_dates` — when is it cheap

```
scan_dates { from, to, from_date, to_date, nights | return_date, currency?, step_days?, max_dates?, concurrency?, tolerance?, rank? }
```

Prices one route across many departure dates in a single pass. One row per date, with:

- `cheapest` — the lowest fare on that date
- `fastest` — the shortest journey
- `sweet_spot` — **the one to quote.** The cheapest itinerary that is not an unreasonably long
  journey (within `tolerance`, default 40% of the shortest). A THB 8,518 fare that takes 26 hours
  with a 21-hour airport layover is not a deal, and `sweet_spot` exists to say so.
- `sweet_spot_costs_extra` — what choosing it over the bare cheapest costs

Rows come back sorted by sweet-spot price. `step_days: 7` gives one sample per week, which is
usually the right resolution for a season. Raise `max_dates` to cover more of the range.

### `search_flights` — the raw data

```
search_flights { from, to, date, nights | return_date, currency? }
```

Every parsed itinerary for one date. Use it when the caller genuinely needs the list (a
spreadsheet, a comparison table). **Do not use it as a first step to then decide yourself** — that
is what `rank_flights` is for, and calling `search_flights` first and then reasoning over the
result throws away the entire saving.

## Passing the traveller's preferences

If the traveller stated any constraint, pass it through in `preferences` as an array of plain
sentences, in their own terms:

```json
{ "preferences": ["no overnight layovers", "avoid Chinese carriers", "must land before 6pm", "carry-on only"] }
```

Preferences are handed to Jev, which treats them as hard constraints where possible and strong
tie-breakers otherwise. They genuinely change the answer: on a fixed set of 11 itineraries,
adding preferences moved the pick from THB 16,114 to THB 33,625 and dropped "a good option
exists" from 0.87 to 0.35.

**Never invent preferences.** If the traveller did not say, omit the field — the ranking then
judges on price, total time, stops, connection length and civilised hours alone, and says so.

## Reading the output

**Read `gate` first.** A ranked choice always puts something first, because its probabilities sum
to 1 — something wins even when everything is bad. `gate` (`has_good_option`) is the check that
this is not happening: it answers whether *any* option is genuinely good. If the gate is low,
the ranking is picking the least-bad compromise, and saying "the best option is X" without that
context is misleading.

**`escalate: true` means the answer is a prior, not a decision.** It means Jev's confidence fell
below the threshold. Report it as a lean, not as a verdict, and say why (`reason` is usually
`unsure`). When several verdicts escalate, the honest answer is often "this route has no good
option on this date" — which the gate will usually already be telling you.

**`probability` is not a percentage of correctness.** It is how the options rank against each
other. 0.92 over a weak field is still a weak field.

## UNKNOWN dates are not unavailable dates

Google only sometimes pre-renders the result list into the HTML it serves. When it does not, the
page contains no itineraries even though the route is served — the tool retries three times and
then reports the date as **UNKNOWN** (`unknown: true`, listed in `unknown_dates`).

Never describe an UNKNOWN date as "no flights", "sold out", or "expensive". It is unknown. Say so
and, if it matters, suggest checking that date in a browser.

Coverage is genuinely patchy, and it is not uniform: a full CNX→XIY winter scan returned data
for **18 of 30** sampled dates, but only **2 of 10** in February. Whole weeks can go missing, so
never assume a gap in the table means the season is covered. Always report `coverage` alongside a
scan, and if a specific period matters (Chinese New Year, school holidays), say plainly whether
that period actually got sampled.

## What this cannot tell you

The scraped data is what Google Flights renders on the results page. It does **not** include:

- **Baggage allowance** — the fare class behind the price is unknown
- **Alliance / frequent-flyer earning** — irrelevant to a cash-bought economy seat anyway
- **Fare conditions** — refundability, change fees, seat selection
- **Booking links** — the tool gives you flight numbers, not a checkout URL
- **One-way searches** — round trips only, in practice

If any of those decide the booking, say that the tool cannot answer it rather than implying the
price is the whole story. Prices also move daily: treat a difference of a few percent as noise.

## Worked examples

**"Find me a good price CNX→XIY this winter, 5 days 4 nights"**

```
scan_dates { from: "CNX", to: "XIY", from_date: "2026-11-01", to_date: "2027-02-28",
             nights: 4, step_days: 7, max_dates: 17, rank: true }
```

Then report: the cheapest sweet-spot date, the pick_date and its probability, the gate, and the
coverage. Note whether Chinese New Year (mid-Feb 2027) is inside the range, since it moves prices.

**"Which flight should I book CNX→XIY on 2026-12-11?"**

```
rank_flights { from: "CNX", to: "XIY", date: "2026-12-11", nights: 4 }
```

Report the pick with its airline, times, duration, stops and layover — plus the gate, and whether
anything escalated.

**"Is THB 12,000 a good price for that?"** — this needs `scan_dates` for the surrounding weeks,
not a single-date lookup. A price is only good or bad relative to the alternatives.

## CLI fallback

When the MCP server is not connected, the same logic runs from the repo:

```bash
cd ~/Sites/BareProj/flight-finder
./find.sh CNX XIY 2026-12-11 4            # <ORIGIN> <DEST> <DATE> [NIGHTS] [CURRENCY]
PREFS="no overnight layovers" ./find.sh CNX XIY 2026-12-11 4

# the scan, as a table
./scan.sh --from CNX --to XIY --from-date 2026-11-01 --to-date 2027-02-28 \
          --nights 4 --step 4 --max 32
./scan.sh --from CNX --to XIY --from-date 2026-11-01 --to-date 2027-02-28 \
          --nights 4 --prefs "no overnight layovers; carry-on only"
```

Both resolve `node` themselves and exit 3 when a verdict escalated, so they can be used in
scripts. See `README.md` in that directory for the parser details.
