/**
 * Multi-date scanning — price one route across a range of departure dates, then let Jev judge
 * which DATE is worth booking.
 *
 * This lives beside flights.mjs rather than inside it because it asks a different question:
 * flights.mjs compares itineraries *within* one date, this compares dates *against each other*.
 * The MCP server and any future CLI share this file, same as flights.mjs.
 *
 * A scan MUST be given a trip length. If it is not, Google picks a different return date per
 * departure date and the resulting prices are not comparable — see `scanDates`.
 */

import {
  searchFlights,
  runJev,
  addDays,
  nightsBetween,
  tripLabel,
  scoreOut,
  PREF_RULE,
} from "./flights.mjs";

/** Every `stepDays`-th departure date in [fromDate, toDate], inclusive. */
export function dateRange(fromDate, toDate, stepDays = 7) {
  const out = [];
  if (!fromDate || !toDate || toDate < fromDate) return out;
  const step = Math.max(1, Math.trunc(stepDays));
  for (let d = fromDate; d <= toDate; d = addDays(d, step)) out.push(d);
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight at once, preserving input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const width = Math.min(Math.max(1, limit), items.length);
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export const median = (nums) => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Trim an itinerary to the fields worth carrying across many dates. */
export function brief(f) {
  if (!f) return null;
  return {
    id: f.id,
    price: f.price,
    currency: f.currency,
    airlines: f.airlines,
    departTime: f.departTime,
    arriveTime: f.arriveTime,
    arriveDate: f.arriveDate,
    durationMin: f.durationMin,
    durationLabel: f.durationLabel,
    stops: f.stops,
    layovers: f.layovers,
    co2Kg: f.co2Kg,
    segments: (f.segments ?? []).map((s) =>
      s.raw ? s.raw : `${s.carrier}${s.flight} ${s.from}-${s.to}`,
    ),
  };
}

/**
 * Reduce one date's payload to the three itineraries that matter.
 *
 * `sweet_spot` is the cheapest itinerary whose total duration is within `tolerance` of the
 * shortest journey on that date — i.e. the cheapest option that is not a slog. It is a plain
 * rule on purpose: a human can audit it, unlike a blended score.
 */
export function summariseRow(payload, tolerance = 1.4) {
  const fs = payload.flights ?? [];
  const base = {
    date: payload.date,
    returnDate: payload.returnDate,
    nights: payload.nights,
    currency: payload.currency,
    count: fs.length,
  };
  if (!fs.length) return { ...base, cheapest: null, fastest: null, sweet_spot: null };

  const byPrice = [...fs].sort((a, b) => a.price - b.price);
  const timed = fs.filter((f) => f.durationMin != null).sort((a, b) => a.durationMin - b.durationMin);
  const cheapest = byPrice[0];
  const fastest = timed[0] ?? null;

  const cap = fastest ? fastest.durationMin * tolerance : Infinity;
  const sweet = byPrice.find((f) => f.durationMin != null && f.durationMin <= cap) ?? cheapest;

  return {
    ...base,
    median_price: median(fs.map((f) => f.price)),
    price_spread: byPrice[byPrice.length - 1].price - cheapest.price,
    cheapest: brief(cheapest),
    fastest: brief(fastest),
    sweet_spot: brief(sweet),
    // What trading up from the bare cheapest to the sweet spot costs / saves.
    sweet_spot_extra: sweet.price - cheapest.price,
    sweet_spot_minutes_saved:
      cheapest.durationMin != null && sweet.durationMin != null
        ? cheapest.durationMin - sweet.durationMin
        : null,
    tolerance,
  };
}

/**
 * Price one route across many departure dates.
 *
 * `nights` or `returnDate` is REQUIRED: without a fixed trip length Google returns a different
 * trip length per date and the prices cannot be compared. This is enforced, not warned about.
 *
 * @returns {{rows: object[], warnings: string[], meta: object}}
 */
export async function scanDates({
  from,
  to,
  fromDate,
  toDate,
  nights = null,
  returnDate = null,
  currency = "THB",
  stepDays = 7,
  maxDates = 12,
  concurrency = 3,
  timeoutMs = 45000,
  tolerance = 1.4,
} = {}) {
  if (nights == null && !returnDate) {
    throw new Error(
      "scan_dates needs `nights` or `return_date`. Without a fixed trip length Google picks a " +
        "different return date for each departure date, so the prices are not comparable.",
    );
  }

  const warnings = [];
  let dates = dateRange(fromDate, toDate, stepDays);
  if (!dates.length) throw new Error("from_date/to_date produced no departure dates");
  if (dates.length > maxDates) {
    warnings.push(
      `the range covered ${dates.length} departure dates; only the first ${maxDates} were priced ` +
        `(raise max_dates, or widen step_days, to cover more).`,
    );
    dates = dates.slice(0, maxDates);
  }

  const rows = await mapLimit(dates, concurrency, async (d) => {
    try {
      const { payload, warnings: w } = await searchFlights({
        from,
        to,
        date: d,
        nights,
        returnDate,
        currency,
        timeoutMs,
      });
      const row = summariseRow(payload, tolerance);
      row.searchedDates = payload.searchedDates;
      row.searchedNights = payload.searchedNights;
      // A date Google gave us no result markup for is UNKNOWN, not empty. Keep the two apart
      // all the way to the report, or a missing render reads as "this date is unavailable".
      row.unknown = payload.count === 0 && !payload.pageHadResultMarkup;
      if (payload.unpriced?.length) row.unpriced = payload.unpriced;
      if (w.length) row.warnings = w;
      return row;
    } catch (e) {
      return { date: d, count: 0, error: e.message };
    }
  });

  // Surface each distinct upstream warning once, not once per date. The "Price unavailable" one
  // names different flights on every date, so it would never dedupe — fold it into one line.
  const seen = new Set();
  const unpricedDates = rows.filter((r) => r.unpriced?.length);
  if (unpricedDates.length) {
    warnings.push(
      `${unpricedDates.length} of ${rows.length} dates also listed itineraries as "Price unavailable" ` +
        `(left out of the fares above): ${[...new Set(unpricedDates.flatMap((r) => r.unpriced))].slice(0, 6).join("; ")}.`,
    );
  }
  for (const r of rows) {
    for (const w of r.warnings ?? []) {
      if (/Price unavailable/.test(w)) continue;
      if (!seen.has(w)) {
        seen.add(w);
        warnings.push(w);
      }
    }
  }
  const failed = rows.filter((r) => r.error);
  if (failed.length) {
    warnings.push(`${failed.length} of ${rows.length} dates could not be priced: ${failed.map((r) => r.date).join(", ")}`);
  }
  const unknown = rows.filter((r) => !r.error && r.unknown);
  if (unknown.length) {
    warnings.push(
      `${unknown.length} of ${rows.length} dates returned no itinerary markup from Google at all ` +
        `(${unknown.map((r) => r.date).join(", ")}). Those dates are UNKNOWN, not unavailable or ` +
        "expensive — the no-JavaScript view is partial. Do not rank them against the dates that did " +
        "return data without checking them in a browser first.",
    );
  }
  const empty = rows.filter((r) => !r.error && !r.count && !r.unknown);
  if (empty.length) {
    warnings.push(`itinerary markup was present but unparseable for: ${empty.map((r) => r.date).join(", ")}`);
  }

  return {
    rows,
    warnings,
    meta: {
      route: `${String(from).toUpperCase()}-${String(to).toUpperCase()}`,
      currency: String(currency).toUpperCase(),
      nights: nights == null ? nightsBetween(fromDate, returnDate) : Number(nights),
      stepDays: Math.max(1, Math.trunc(stepDays)),
      datesRequested: dateRange(fromDate, toDate, stepDays).length,
      datesPriced: rows.length,
      datesWithData: rows.filter((r) => r.count).length,
      datesUnknown: rows.filter((r) => r.unknown).length,
      tolerance,
    },
  };
}

/* ------------------------------------------------------------------ jev over dates */

const priced = (r) => r.sweet_spot ?? r.cheapest ?? null;

/** One line per date, used as both state text and choice criteria. */
export function dateLine(r) {
  const f = priced(r);
  if (!f) return `${r.date}: no itinerary parsed`;
  const stops = f.stops === 0 ? "nonstop" : `${f.stops} stop${f.stops > 1 ? "s" : ""}`;
  const lay = f.layovers?.length
    ? ` | layover: ${f.layovers.map((l) => `${l.minutes}m at ${l.airport}`).join("; ")}`
    : "";
  return (
    `${f.currency} ${f.price.toLocaleString("en-US")} | ${f.airlines.join(" + ")} | ` +
    `${f.departTime} -> ${f.arriveTime} | ${f.durationLabel} | ${stops}${lay}`
  );
}

export function buildDateState(rows, meta, preferences = []) {
  const usable = rows.filter((r) => priced(r));
  const prices = usable.map((r) => priced(r).price);
  const lo = usable.length ? usable.reduce((a, b) => (priced(a).price <= priced(b).price ? a : b)) : null;
  const hi = usable.length ? usable.reduce((a, b) => (priced(a).price >= priced(b).price ? a : b)) : null;

  return {
    task:
      `Choose the single best DEPARTURE DATE on which to book a ${meta.nights}-night round trip ` +
      `${meta.route}. The dates below are the alternatives; each line is the best itinerary found ` +
      `on that date, chosen as the cheapest one that is not an unreasonably long journey. ` +
      `A solo leisure traveller, economy cabin, no loyalty programme, price paid in cash.`,
    route: meta.route,
    currency: meta.currency,
    trip_length: `${meta.nights} nights`,
    date_range: usable.length ? [usable[0].date, usable[usable.length - 1].date] : null,
    dates_priced: usable.length,
    cheapest_date: lo ? `${lo.date} at ${meta.currency} ${priced(lo).price.toLocaleString("en-US")}` : null,
    dearest_date: hi ? `${hi.date} at ${meta.currency} ${priced(hi).price.toLocaleString("en-US")}` : null,
    price_range: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    preferences: preferences.length
      ? preferences
      : ["none stated — judge on price, total time, stops, connection length and civilised hours alone"],
    notes: [
      `Prices are round-trip totals in ${meta.currency}, as quoted by Google Flights, and were ` +
        `scraped together in one pass, so they are directly comparable.`,
      "Fares move daily. Treat a difference of a few percent as noise, not as a signal.",
      "All times are local; an arrival date later than the departure date means an overnight flight.",
      "A long layover is time spent in an airport, not in the destination.",
    ],
    dates: usable.map((r) => ({ date: r.date, return_date: r.returnDate, detail: dateLine(r) })),
  };
}

export function buildDateQuestions(rows, meta, preferences = []) {
  const usable = rows.filter((r) => priced(r));
  const criteria = Object.fromEntries(usable.map((r) => [r.date, dateLine(r)]));
  return {
    has_good_option: {
      type: "noul",
      instructions:
        "Looking at the `dates` in the state, does at least one of these departure dates offer a " +
        "genuinely good price for this route and trip length for THIS traveller — a fare they " +
        "would be happy to pay — rather than all of them being expensive because of the season?",
    },
    best_date: {
      type: "choice",
      instructions:
        "Which single departure date is the best booking decision, weighing the fare against the " +
        "quality of the journey available on that date (total duration, stops, connection length, " +
        "civilised hours) and the fact that a cheaper date is worthless if the flights are poor? " +
        PREF_RULE,
      criteria,
    },
    best_price_date: {
      type: "choice",
      instructions:
        "If the fare were the only real priority — while still avoiding a journey so long or so " +
        "badly connected that it wrecks the trip — which departure date in `dates` should be " +
        "booked? " + PREF_RULE,
      criteria,
    },
    worst_value_date: {
      type: "choice",
      instructions:
        "Which departure date in `dates` looks like the worst value once you account for what the " +
        "fare buys in time and inconvenience, not just the number itself? " + PREF_RULE,
      criteria,
    },
    cheapest_date_value: {
      type: "score",
      instructions:
        "Rate the value of the cheapest departure date in `dates` — the one named at " +
        "`cheapest_date` — as a booking decision for this traveller, all things considered. " + PREF_RULE,
      criteria: [
        "You would regret booking this",
        "Acceptable only if nothing better exists",
        "A fair deal you would take without much thought",
        "Clearly better than the alternatives",
        "The obvious pick at this price",
      ],
    },
  };
}

/** Judge the dates with Jev. Candidates are dates, so this is one call, not one per date. */
export async function rankDates(rows, meta, { preferences = [], threshold = null } = {}) {
  const usable = rows.filter((r) => priced(r));
  if (usable.length < 2) {
    throw new Error(`need at least 2 priced dates to rank, got ${usable.length}`);
  }
  const state = buildDateState(rows, meta, preferences);
  const questions = buildDateQuestions(rows, meta, preferences);
  const { result, stderr } = await runJev(questions, state, threshold);
  return { result, stderr, state, questions };
}

/** Turn a date-ranking verdict into the shape the MCP server reports. */
export function summariseDates(result, rows) {
  const byId = Object.fromEntries(result.verdicts.map((v) => [v.id, v]));
  const rank = (id) => {
    const v = byId[id];
    if (v && v.type === "choice" && v.distribution) {
      return Object.entries(v.distribution).sort((a, b) => b[1] - a[1]);
    }
    return [];
  };
  const rowOf = (date) => rows.find((r) => r.date === date) ?? null;
  const entry = (date, probability, escalate) => {
    const r = rowOf(date);
    return r
      ? { date, probability: probability ?? null, escalate: escalate ?? false, itinerary: priced(r), row: r }
      : null;
  };

  const pickId = byId.best_date?.answer ?? null;
  const out = {
    model: result.model,
    latencyMs: result.latencyMs,
    stateTokens: result.stateTokens,
    escalated: result.escalated,
    gate: byId.has_good_option
      ? {
          probability: byId.has_good_option.answer,
          escalate: byId.has_good_option.escalate,
          reason: byId.has_good_option.reason ?? null,
        }
      : null,
    pick: pickId ? entry(pickId, rank("best_date")[0]?.[1], byId.best_date.escalate) : null,
    runnersUp: rank("best_date")
      .slice(1, 4)
      .filter(([k, p]) => k !== pickId && p > 0)
      .map(([date, p]) => entry(date, p, byId.best_date.escalate))
      .filter(Boolean),
  };

  for (const key of ["best_price_date", "worst_value_date"]) {
    const v = byId[key];
    if (!v) continue;
    out[key] = entry(v.answer, rank(key)[0]?.[1] ?? null, v.escalate);
  }

  out.cheapest_date_value = scoreOut(byId.cheapest_date_value);
  return out;
}
