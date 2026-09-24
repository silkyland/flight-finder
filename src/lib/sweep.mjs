/**
 * Multi-destination sweep — price one origin against many destinations on the same set of
 * departure dates, then let Jev judge which destination is the best trip for the money.
 *
 * The three libs answer three different questions and share no state:
 *   flights.mjs — which itinerary, on this date?
 *   scan.mjs    — which date, on this route?
 *   sweep.mjs   — which destination, out of many?
 *
 * The comparison is only meaningful because every destination is priced on the SAME departure
 * dates, at the same trip length and currency, in one pass. Spread the destinations across
 * different dates and the ranking becomes an artefact of the calendar rather than of the fares —
 * the same trap `scanDates` refuses to fall into with dates.
 *
 * The destination list is a candidate set, not the set of everything reachable from the origin.
 * A destination that is absent has not been priced, which is not the same as being expensive.
 */

import { searchFlights, runJev, scoreOut, PREF_RULE } from "./flights.mjs";
import { summariseRow, mapLimit, median } from "./scan.mjs";
/* ------------------------------------------------------------------ candidate sets */

/**
 * Preset destination groups, as [IATA, city, country]. Chosen for "plausibly reachable from a
 * Thai regional airport on a low-cost ticket", not for completeness — the sweep is only as good
 * as the net it casts, so the net is deliberately wide and the caller can pass their own list.
 */
export const GROUPS = {
  sea: [
    ["KUL", "Kuala Lumpur", "Malaysia"],
    ["PEN", "Penang", "Malaysia"],
    ["BKI", "Kota Kinabalu", "Malaysia"],
    ["SIN", "Singapore", "Singapore"],
    ["HAN", "Hanoi", "Vietnam"],
    ["SGN", "Ho Chi Minh City", "Vietnam"],
    ["DAD", "Da Nang", "Vietnam"],
    ["RGN", "Yangon", "Myanmar"],
    ["MDL", "Mandalay", "Myanmar"],
    ["LPQ", "Luang Prabang", "Laos"],
    ["VTE", "Vientiane", "Laos"],
    ["PNH", "Phnom Penh", "Cambodia"],
    ["MNL", "Manila", "Philippines"],
    ["DPS", "Denpasar (Bali)", "Indonesia"],
  ],
  china: [
    ["KMG", "Kunming", "China"],
    ["CAN", "Guangzhou", "China"],
    ["SZX", "Shenzhen", "China"],
    ["PVG", "Shanghai", "China"],
    ["HGH", "Hangzhou", "China"],
    ["NKG", "Nanjing", "China"],
    ["WUH", "Wuhan", "China"],
    ["CSX", "Changsha", "China"],
    ["CKG", "Chongqing", "China"],
    ["XIY", "Xi'an", "China"],
    ["CTU", "Chengdu", "China"],
    ["PEK", "Beijing", "China"],
  ],
  eastasia: [
    ["HKG", "Hong Kong", "China"],
    ["MFM", "Macao", "China"],
    ["TPE", "Taipei", "China"],
    ["KHH", "Kaohsiung", "China"],
    ["ICN", "Seoul", "South Korea"],
    ["PUS", "Busan", "South Korea"],
    ["NRT", "Tokyo", "Japan"],
    ["KIX", "Osaka", "Japan"],
    ["FUK", "Fukuoka", "Japan"],
  ],
  southasia: [
    ["DEL", "Delhi", "India"],
    ["CCU", "Kolkata", "India"],
    ["CMB", "Colombo", "Sri Lanka"],
    ["MLE", "Male", "Maldives"],
    ["DAC", "Dhaka", "Bangladesh"],
  ],
};

GROUPS.all = [...GROUPS.sea, ...GROUPS.china, ...GROUPS.eastasia, ...GROUPS.southasia];

/** code -> {city, country}, so a bare `--to HAN` still gets named in the state Jev reads. */
const INDEX = new Map();
for (const [code, city, country] of GROUPS.all) INDEX.set(code, { city, country });

/** Normalise `GROUPS` triples, `{code,city,country}` objects, or `"KUL,Kuala Lumpur,Malaysia"` / bare `"KUL"` strings. */
export function normaliseDestinations(list) {
  return list.map((d) => {
    let code = null;
    let city = null;
    let country = null;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      code = d.code ?? d.to;
      city = d.city ?? null;
      country = d.country ?? null;
    } else if (Array.isArray(d)) {
      [code, city = null, country = null] = d;
    } else {
      const parts = String(d).split(",").map((s) => s.trim());
      [code, city = null, country = null] = parts;
    }
    const upper = String(code).toUpperCase();
    const known = INDEX.get(upper);
    return {
      code: upper,
      city: city || known?.city || null,
      country: country || known?.country || null,
    };
  });
}

/** Resolve a `--group` name, a comma list of codes, or a mix, to destination objects. */
export function resolveDestinations(spec) {
  const out = [];
  const seen = new Set();
  for (const raw of String(spec).split(",").map((s) => s.trim()).filter(Boolean)) {
    const group = GROUPS[raw.toLowerCase()];
    const items = group ? normaliseDestinations(group) : normaliseDestinations([raw]);
    for (const d of items) {
      if (seen.has(d.code)) continue;
      seen.add(d.code);
      out.push(d);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the sweep */

const cheapestOf = (rows, key) => {
  let best = null;
  for (const r of rows) {
    const f = r[key];
    if (!f) continue;
    if (!best || f.price < best.f.price) best = { f, row: r };
  }
  return best;
};

/**
 * Price one origin against many destinations on the same departure dates.
 *
 * @returns {{rows: object[], warnings: string[], meta: object}}
 */
export async function sweepDestinations({
  from,
  destinations,
  dates,
  nights = null,
  returnDate = null,
  currency = "THB",
  concurrency = 3,
  timeoutMs = 45000,
  tolerance = 1.4,
} = {}) {
  if (nights == null && !returnDate) {
    throw new Error(
      "sweep needs `nights` or `returnDate`. Without a fixed trip length Google picks a different " +
        "return date per departure date, so the destinations are not priced on comparable trips.",
    );
  }
  const dests = normaliseDestinations(destinations ?? []);
  if (!dests.length) throw new Error("no destinations given");
  const departures = (dates ?? []).filter(Boolean);
  if (!departures.length) throw new Error("no departure dates given");

  const FROM = String(from).toUpperCase();
  const pairs = [];
  for (const d of dests) for (const date of departures) pairs.push({ d, date });

  const pairRows = await mapLimit(pairs, concurrency, async ({ d, date }) => {
    try {
      const { payload } = await searchFlights({
        from: FROM,
        to: d.code,
        date,
        nights,
        returnDate,
        currency,
        timeoutMs,
      });
      const row = summariseRow(payload, tolerance);
      row.unknown = payload.count === 0 && !payload.pageHadResultMarkup;
      return { to: d.code, ...row };
    } catch (e) {
      return { to: d.code, date, count: 0, error: e.message };
    }
  });

  const rows = dests.map((d) => {
    const rs = pairRows.filter((r) => r.to === d.code);
    const priced = rs.filter((r) => r.sweet_spot ?? r.cheapest);
    const best = cheapestOf(priced, "sweet_spot") ?? cheapestOf(priced, "cheapest");
    const cheapest = cheapestOf(priced, "cheapest");
    const fastest = priced
      .filter((r) => r.fastest?.durationMin != null)
      .sort((a, b) => a.fastest.durationMin - b.fastest.durationMin)[0] ?? null;
    const sweetPrices = priced.map((r) => r.sweet_spot?.price).filter((n) => n != null);

    return {
      to: d.code,
      city: d.city,
      country: d.country,
      dates: rs.map((r) => ({
        date: r.date,
        returnDate: r.returnDate,
        count: r.count,
        unknown: r.unknown ?? false,
        error: r.error ?? null,
        cheapest: r.cheapest ?? null,
        sweet_spot: r.sweet_spot ?? null,
        fastest: r.fastest ?? null,
      })),
      best: best?.f ?? null,
      best_date: best?.row.date ?? null,
      best_return_date: best?.row.returnDate ?? null,
      cheapest: cheapest?.f ?? null,
      cheapest_date: cheapest?.row.date ?? null,
      fastest: fastest?.fastest ?? null,
      price_range: sweetPrices.length ? { min: Math.min(...sweetPrices), max: Math.max(...sweetPrices) } : null,
      median_price: median(sweetPrices),
      itineraries: rs.reduce((n, r) => n + (r.count ?? 0), 0),
      // UNKNOWN only when every sampled date for this destination lacked result markup.
      unknown: priced.length === 0 && rs.some((r) => r.unknown),
      all_failed: priced.length === 0 && rs.every((r) => r.error),
      errors: rs.filter((r) => r.error).map((r) => `${r.date}: ${r.error}`),
    };
  });

  const warnings = [];
  const unknown = rows.filter((r) => r.unknown);
  if (unknown.length) {
    warnings.push(
      `${unknown.length} of ${rows.length} destinations returned no itinerary markup from Google on ` +
        `any sampled date (${unknown.map((r) => r.to).join(", ")}). Those are UNKNOWN, not ` +
        "unreachable — the no-JavaScript view is partial. Check them in a browser before concluding.",
    );
  }
  const failed = rows.filter((r) => r.all_failed);
  if (failed.length) {
    warnings.push(`${failed.length} destinations could not be priced at all: ${failed.map((r) => r.to).join(", ")}`);
  }
  const partial = rows.filter((r) => !r.unknown && !r.all_failed && r.dates.some((d) => d.unknown));
  if (partial.length) {
    warnings.push(
      `some dates came back UNKNOWN for: ${partial.map((r) => r.to).join(", ")}. Their best price is ` +
        "the best of the dates that DID return data, so a cheaper date may exist unsampled.",
    );
  }

  return {
    rows,
    warnings,
    meta: {
      route: FROM,
      currency: String(currency).toUpperCase(),
      nights: nights == null ? null : Number(nights),
      departures,
      destinations: rows.length,
      destinationsWithData: rows.filter((r) => r.best).length,
      destinationsUnknown: unknown.length,
      tolerance,
    },
  };
}

/* ------------------------------------------------------------------ jev over destinations */

const priced = (r) => r.best ?? r.cheapest ?? null;

/** One line per destination, used as both state text and choice criteria. */
export function sweepLine(r) {
  const f = priced(r);
  if (!f) return r.unknown ? "no itinerary markup returned — UNKNOWN, not unreachable" : "no itinerary parsed";
  const stops = f.stops === 0 ? "nonstop" : `${f.stops} stop${f.stops > 1 ? "s" : ""}`;
  const lay = f.layovers?.length
    ? ` | layover: ${f.layovers.map((l) => `${l.minutes}m at ${l.airport}`).join("; ")}`
    : "";
  const spread =
    r.price_range && r.price_range.min !== r.price_range.max
      ? ` | over ${r.dates.filter((d) => !d.error).length} sampled dates: ${f.currency} ` +
        `${r.price_range.min.toLocaleString("en-US")}-${r.price_range.max.toLocaleString("en-US")}`
      : "";
  return (
    `${f.currency} ${f.price.toLocaleString("en-US")} | ${r.city ?? r.to}${r.country ? `, ${r.country}` : ""} | ` +
    `best of ${r.best_date} | ${f.airlines.join(" + ")} | ${f.departTime} -> ${f.arriveTime} | ` +
    `${f.durationLabel} | ${stops}${lay}${spread}`
  );
}

export function buildSweepState(rows, meta, preferences = []) {
  const usable = rows.filter((r) => priced(r));
  const byPrice = [...usable].sort((a, b) => priced(a).price - priced(b).price);
  const lo = byPrice[0] ?? null;
  const hi = byPrice[byPrice.length - 1] ?? null;
  const prices = usable.map((r) => priced(r).price);

  return {
    task:
      `Choose the single best international DESTINATION to fly to from ${meta.route} for a ` +
      `${meta.nights}-night round trip, departing on one of ${meta.departures.join(", ")}. ` +
      `The traveller wants a genuinely cheap low-cost fare AND a good experience — they are not ` +
      `willing to buy the cheapest ticket at the price of a ruined trip. A solo leisure traveller, ` +
      `economy cabin, no loyalty programme, price paid in cash.`,
    origin: meta.route,
    currency: meta.currency,
    trip_length: `${meta.nights} nights`,
    departure_dates_sampled: meta.departures,
    destinations_priced: usable.length,
    cheapest_destination: lo
      ? `${lo.city ?? lo.to} (${lo.to}) at ${meta.currency} ${priced(lo).price.toLocaleString("en-US")}`
      : null,
    dearest_destination: hi
      ? `${hi.city ?? hi.to} (${hi.to}) at ${meta.currency} ${priced(hi).price.toLocaleString("en-US")}`
      : null,
    price_range: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    preferences: preferences.length
      ? preferences
      : ["none stated — judge on price, total time, stops, connection length and civilised hours alone"],
    notes: [
      `Every destination was priced on the SAME departure dates at the same trip length, in ${meta.currency}, ` +
        "in one pass, so the prices are directly comparable across destinations.",
      "Prices are round-trip totals as quoted by Google Flights. Fares move daily; treat a few percent as noise.",
      "The destination list is a candidate set chosen for cheap reachability, not everything reachable. " +
        "An absent destination was not priced, which is not the same as being expensive.",
      "A destination with no direct service is reached through a connection, so its total duration " +
        "and its connection length say more about the experience than its price does.",
      "All times are local; an arrival date later than the departure date means an overnight flight.",
    ],
    destinations: usable.map((r) => ({
      code: r.to,
      city: r.city,
      country: r.country,
      best_date: r.best_date,
      detail: sweepLine(r),
    })),
  };
}

export function buildSweepQuestions(rows, meta, preferences = []) {
  const usable = rows.filter((r) => priced(r));
  const criteria = Object.fromEntries(usable.map((r) => [r.to, sweepLine(r)]));
  return {
    has_good_option: {
      type: "noul",
      instructions:
        "Looking at the `destinations` in the state, does at least one of them offer BOTH a " +
        "genuinely cheap fare AND a journey this traveller would call a good experience — rather " +
        "than all of them being either expensive or cheap-but-miserable?",
    },
    best_destination: {
      type: "choice",
      instructions:
        "Which single destination is the best trip to book, weighing the fare against what the " +
        "journey costs in time and comfort (total duration, stops, connection length, civilised " +
        "hours) and against what there is to do at the other end for a short break? A cheap fare " +
        "to a place reached by a 20-hour two-stop slog is not the good deal it looks like. " +
        PREF_RULE,
      criteria,
    },
    best_value_destination: {
      type: "choice",
      instructions:
        "If the fare were the only real priority — while still avoiding a destination reachable " +
        "only by a journey so long or so badly connected that it wrecks the trip — which " +
        "destination in `destinations` should be booked? " + PREF_RULE,
      criteria,
    },
    worst_value_destination: {
      type: "choice",
      instructions:
        "Which destination in `destinations` looks like the worst value once you account for what " +
        "the fare buys in time and inconvenience, not just the number itself? " + PREF_RULE,
      criteria,
    },
    cheapest_destination_value: {
      type: "score",
      instructions:
        "Rate the value of the cheapest destination in `destinations` — the one named at " +
        "`cheapest_destination` — as a trip to book for this traveller, all things considered. " +
        PREF_RULE,
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

/** Judge the destinations with Jev. Candidates are destinations, so this is one call, not one each. */
export async function rankDestinations(rows, meta, { preferences = [], threshold = null } = {}) {
  const usable = rows.filter((r) => priced(r));
  if (usable.length < 2) throw new Error(`need at least 2 priced destinations to rank, got ${usable.length}`);
  const state = buildSweepState(rows, meta, preferences);
  const questions = buildSweepQuestions(rows, meta, preferences);
  const { result, stderr } = await runJev(questions, state, threshold);
  return { result, stderr, state, questions };
}

/** Turn a destination-ranking verdict into the shape the CLI and MCP server report. */
export function summariseSweep(result, rows) {
  const byId = Object.fromEntries(result.verdicts.map((v) => [v.id, v]));
  const rank = (id) => {
    const v = byId[id];
    if (v && v.type === "choice" && v.distribution) {
      return Object.entries(v.distribution).sort((a, b) => b[1] - a[1]);
    }
    return [];
  };
  const rowOf = (code) => rows.find((r) => r.to === code) ?? null;
  const entry = (code, probability, escalate) => {
    const r = rowOf(code);
    return r ? { code, probability: probability ?? null, escalate: escalate ?? false, row: r } : null;
  };

  const pickId = byId.best_destination?.answer ?? null;
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
    pick: pickId ? entry(pickId, rank("best_destination")[0]?.[1], byId.best_destination.escalate) : null,
    runnersUp: rank("best_destination")
      .slice(1, 4)
      .filter(([k, p]) => k !== pickId && p > 0)
      .map(([code, p]) => entry(code, p, byId.best_destination.escalate))
      .filter(Boolean),
  };

  for (const key of ["best_value_destination", "worst_value_destination"]) {
    const v = byId[key];
    if (!v) continue;
    out[key] = entry(v.answer, rank(key)[0]?.[1] ?? null, v.escalate);
  }

  out.cheapest_destination_value = scoreOut(byId.cheapest_destination_value);
  return out;
}
