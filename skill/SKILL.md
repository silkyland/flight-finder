---
name: flight-finder
description: >-
  Find flights and pick the best one by scraping Google Flights without a browser and having Jev
  judge the itineraries. Use for finding flights between two airports, comparing fares, deciding
  which ticket to book, checking whether a quoted price is good, finding the cheapest travel
  dates across a season, and working out which destination is cheapest when the traveller has not
  chosen one yet. Triggers include "find flights", "cheapest flight to X", "best ticket",
  "which date is cheapest", "is this a good price", "where can I fly cheaply from here",
  "cheap getaway", and the Thai forms "หา flight", "หาตั๋วเครื่องบิน", "ตั๋วไป", "ราคาตั๋ว",
  "ช่วงไหนถูก", "บินไปไหนดี", "ตั๋วถูก ๆ". Works two ways: the flight-finder MCP tools
  (search_flights, rank_flights, scan_dates) when the server is connected, otherwise the CLI in
  ~/Sites/Onboards/flight-finder — see the CLI fallback section, and do not give up just because
  the MCP tools are missing.
---

# flight-finder

Scrapes Google Flights from the initial HTML — no browser, no headless Chrome — then lets Jev
pick between the alternatives. Answers three different questions, and mixing them up is the main
way to get a bad answer:

- **Which flight should I book on this date?** → `rank_flights`
- **When is it cheap?** → `scan_dates`
- **Which destination, when they have not picked one?** → `sweep.sh` (CLI only for now)

## Two ways to reach it — try the tools, fall back to the CLI

If the `flight-finder` MCP tools are available, use them. If they are **not** — this skill is
shared across several agents and the MCP server is registered per agent, so it may well be
missing — do not stop. The same logic runs from the repo:

```bash
cd ~/Sites/Onboards/flight-finder
./find.sh CNX XIY 2026-12-11 4                                  # one date, judged
./scan.sh --from CNX --to XIY --from-date 2026-11-01 \
          --to-date 2027-02-28 --nights 4 --step 4              # a season, as a table
./sweep.sh --from CNX --to sea --dates 2026-11-10,2026-12-08 \
           --nights 4                                           # many destinations, judged
```

All three wrappers resolve `node` themselves, so they work even when the agent's PATH is minimal.
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

One itinerary often wins several of those categories at once, which is common on thin routes. When
that happens the later slots come back as `{ id, probability, escalate, same_as: "pick" }` instead
of repeating the full record — read `same_as` to find the slot that holds the detail. It is the
same flight, not a missing one.

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

**`step_days` also locks the weekday.** A 7-day step lands on the same day of the week all the way
across the range, so "the cheapest date" really means "the cheapest Tuesday" — or whatever weekday
`from_date` happens to be. Check it before interpreting anything:

```bash
date -j -f %Y-%m-%d 2026-11-01 +%A      # macOS: 2026-11-01 = Sunday
```

When a date is actually going to be quoted, re-scan that winner with `step_days: 1` over a single
month. A month is cheap to scan (28 searches) and it turns "cheapest Sunday" into "cheapest day" —
worth doing before putting a number in front of a traveller.

### `search_flights` — the raw data

```
search_flights { from, to, date, nights | return_date, currency? }
```

Every parsed itinerary for one date. Use it when the caller genuinely needs the list (a
spreadsheet, a comparison table). **Do not use it as a first step to then decide yourself** — that
is what `rank_flights` is for, and calling `search_flights` first and then reasoning over the
result throws away the entire saving.

### `sweep.sh` — which destination

When the traveller has **not** named a destination ("somewhere cheap from here", "where can I fly
for a weekend"), ranking itineraries is the wrong question. Sweep many destinations at once:

```bash
./sweep.sh --from CNX --to sea --dates 2026-11-10,2026-12-08 --nights 4
./sweep.sh --from CNX --to KUL,CAN,HAN,SIN --from-date 2026-11-01 --to-date 2027-02-28 \
           --step 7 --nights 4
```

`--to` takes group names (`sea`, `china`, `eastasia`, `southasia`, `all`), IATA codes, or a mix.
Every destination is priced on the **same** departure dates, so the fares are directly comparable —
that is the whole point, and it is why the destinations must share one date list. A season costs
one search per destination per date, so narrow `--to` or widen `--step`; the CLI warns above 240
pairs. It reports, per destination, the cheapest date found, the fare, the fastest journey and the
spread across sampled dates, then has Jev judge which destination is the best trip. Read `gate`
first, exactly as with the other two.

**The cheapest destination is often cheap for a bad reason.** In a 40-destination sweep from CNX,
Guangzhou, Taipei and Seoul all ranked near the top — and all three were after-midnight departures
(21:10→00:45, 00:25→04:55, 00:10→07:10). They were cheap because of the hour, not the route. Always
report departure and arrival times beside the price, or the shortlist will mislead.

The sweep is **CLI only** for now; there is no `sweep_destinations` MCP tool. Do not tell the
traveller the capability does not exist — run `./sweep.sh`.

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

**Some routes return nothing on every date, and the fix is to change the origin.** A sweep of 20
snow-relevant Chinese cities from CNX returned data for only **4**; the other 16 produced no
markup on any sampled date, including cities that certainly have service (Changchun, Shenyang,
Dalian, Urumqi, Zhangjiajie, Lijiang). Re-running the same destinations from **BKK** returned
**7 of 12** — and 36 of 36 dates for Harbin. Bangkok simply has a far larger China network, so
Google pre-renders those pages and does not pre-render the CNX ones.

So when a whole *route* fails rather than a date, do not report the destination as unreachable and
do not give up. Re-price it from the hub the traveller would realistically connect through
(BKK, KUL, SIN, HKG), price the short hop from their real origin separately, and add the two up.
Then say plainly that the total is a sum of two tickets, with the self-transfer risk that implies.

You still cannot tell whether "no markup anywhere" means no service or no pre-render. Say which
one you do not know rather than picking one.

## What this cannot tell you

The scraped data is what Google Flights renders on the results page. It does **not** include:

- **Baggage allowance** — the fare class behind the price is unknown
- **Alliance / frequent-flyer earning** — irrelevant to a cash-bought economy seat anyway
- **Fare conditions** — refundability, change fees, seat selection
- **Booking links** — the tool gives you flight numbers, not a checkout URL
- **One-way searches** — round trips only, in practice
- **Multi-city / open-jaw** — there is no way to price "fly into A, home from B", which is exactly
  what a two-country trip wants. Price the legs as round trips and say plainly that the result is
  an **upper bound**: a real open-jaw ticket is usually cheaper and saves a day of backtracking.

If any of those decide the booking, say that the tool cannot answer it rather than implying the
price is the whole story. Prices also move daily: treat a difference of a few percent as noise.

## Two-country trips: price the hub, not the far end

When the traveller wants two countries in one trip, do not price a round trip to the further one.
Price a round trip to the **hub** plus a round trip on the short regional hop, and compare that
against going direct.

A real case: CNX → Istanbul + Tbilisi, 7 days. Istanbul round trip came to THB 30,205 and the
nonstop Istanbul–Tbilisi hop to THB 8,174 — **THB 38,379 for both countries**. Flying to Tbilisi
directly was THB 39,029 *and* 17h25 with two stops. So the two-country trip was cheaper than the
one-country trip, because the far end is served only by long two-stop itineraries while the hub has
a short single-stop one. The counter-intuitive result is the useful one; do not assume the extra
country costs extra.

Price the hop separately and add it up, rather than reasoning about what it "should" cost.

### The same rule catches the opposite trap: a short hop that costs more than the long-haul

The rule cuts both ways. A short regional hop between two **non-hub** cities can be *dearer* than the
long-haul the traveller already flew, because the only itinerary routes back through the hub.

A real case: CNX → Udon Thani, THB 4,134 nonstop 1h05. The onward Udon Thani → Vientiane hop priced
at **THB 9,474–10,080** — more than flying CNX → Vientiane directly at THB 9,070, for a distance a
bus covers in an hour. There is no direct Udon–Vientiane flight; the itinerary is
`FD3355 UTH-DMK` + wait + `FD1040 DMK-VTE`, i.e. it flies back north to Don Mueang first. Stacking
the legs came to THB 13,608, roughly triple the land route. The layover was also **not constant**:
1h30 on some dates and 9h40 on the cheapest ones.

So: **never assume the shorter leg is the cheaper leg.** Whenever a trip is really "fly to a nearby
city, then continue overland or onward", price that onward leg on its own before recommending it —
and if it is a surface crossing rather than a flight, say plainly that the tool did not price it.

## A long layover is not automatically dead time

Jev scores a 19-hour layover as time wasted, because that is what it is for a traveller who stays in
the terminal. But a long layover at a hub is also a **stopover** — enough time to leave the airport,
see the city, and sleep in a real bed. The tool cannot tell the difference, and it does not know
whether the traveller can even enter the transit country.

A real case: CNX → Istanbul on Etihad, THB 22,145, 31h40 total with **19h40 at Abu Dhabi**. Jev
scored it 0.17/4 — "you would regret booking this". But the layover runs 13:05 → 08:45 the next
morning, which is ~16 usable hours: an afternoon, an evening and a night. That is a city, not a
delay. When a verdict punishes a long layover, check three things before repeating it:

1. **Can the traveller leave the airport?** Not every nationality is visa-free, and a transit visa
   usually has to be arranged with the airline *before* travel. If it is not approved, the layover
   genuinely is dead time — and that is the whole risk of the ticket.
2. **What are the clock times in the transit city?** A 19h40 layover spanning an afternoon and a
   night is worth far more than one spanning 22:00–18:00. Work it out from the arrival time plus
   the layover duration, and mind the time zones.
3. **What does the stopover cost?** Visa + hotel + transfers can equal the entire fare saving. In
   that case the honest framing is "you get the extra city at no net cost", not "you saved money".

Report it as a choice, not as a verdict: the same ticket is bad for someone who will stay airside
and good for someone who will not. Say which assumption the tool made.

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

**"I want a cheap trip abroad from Chiang Mai — low cost, but a good experience"**

```
./sweep.sh --from CNX --to all --dates 2026-11-10,2026-12-08,2027-01-12 --nights 4
./sweep.sh --from CNX --to KUL,CAN,HAN,SIN,HKG,PVG --from-date 2026-11-01 \
           --to-date 2027-02-28 --step 7 --nights 4          # then deepen the shortlist
./scan.sh --from CNX --to KUL --from-date 2027-02-01 --to-date 2027-02-28 \
          --nights 4 --step 1 --max 28                        # daily, on the winner only
```

Three stages, because one is not enough: sweep wide to find the cheap cluster, sweep the shortlist
across a season to find real dates, then scan the winner **daily** to find the actual cheapest day.
Report the fare next to the departure and arrival times, or the after-midnight options will look
like the best deals. State the trip length you assumed, and say that baggage is not in the price.

## CLI fallback

When the MCP server is not connected, the same logic runs from the repo:

```bash
cd ~/Sites/Onboards/flight-finder
./find.sh CNX XIY 2026-12-11 4            # <ORIGIN> <DEST> <DATE> [NIGHTS] [CURRENCY]
PREFS="no overnight layovers" ./find.sh CNX XIY 2026-12-11 4

# the scan, as a table
./scan.sh --from CNX --to XIY --from-date 2026-11-01 --to-date 2027-02-28 \
          --nights 4 --step 4 --max 32
./scan.sh --from CNX --to XIY --from-date 2026-11-01 --to-date 2027-02-28 \
          --nights 4 --prefs "no overnight layovers; carry-on only"

# many destinations at once, as a table
./sweep.sh --from CNX --to all --dates 2026-11-10,2026-12-08 --nights 4
./sweep.sh --from CNX --to sea --from-date 2026-11-01 --to-date 2027-02-28 --step 7 --nights 4
```

All three resolve `node` themselves and exit 3 when a verdict escalated, so they can be used in
scripts. Exit 3 is a *result*, not a failure — read the table, and check which verdict escalated.
See `README.md` in that directory for the parser details.
