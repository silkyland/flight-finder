/**
 * Shared implementation behind the CLI (src/scrape.mjs, src/pick.mjs) and the MCP server
 * (mcp/server.mjs). One implementation, three front doors — so a fix in the parser cannot
 * land in the CLI and miss the server.
 *
 * The scraping works without a browser because Google ships, per itinerary, an
 * accessibility description ("Leaves ... at 8:25 AM ... Total duration 9 hr 40 min ...
 * Layover (1 of 1) is a 2 hr layover at ..."), the exact price in an aria-label, and the
 * flight numbers in a booking URL — all in the initial HTML.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GOOGLE = "https://www.google.com/travel/flights";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ date helpers */

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function nightsBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);
}

export const isIsoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isIata = (s) => typeof s === "string" && /^[A-Za-z]{3}$/.test(s);

/* ------------------------------------------------------------------ parsing */

function decode(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&minus;/g, "-");
}

const toText = (frag) =>
  decode(frag.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

const toMin = (h, m) => (h ? Number(h) * 60 : 0) + (m ? Number(m) : 0);

/** Google labels the price span like aria-label="16108 Thai baht" role="text". */
const PRICE_RE = /aria-label="(\d+)\s+([A-Za-z ]+?)"\s+role="text"/;

const CURRENCY_CODES = {
  "thai baht": "THB",
  "us dollars": "USD",
  "euros": "EUR",
  "singapore dollars": "SGD",
  "japanese yen": "JPY",
  "hong kong dollars": "HKD",
  "pounds sterling": "GBP",
  "british pounds": "GBP",
  "australian dollars": "AUD",
  "chinese yuan": "CNY",
  "korean won": "KRW",
  "malaysian ringgit": "MYR",
  "vietnamese dong": "VND",
  "indonesian rupiah": "IDR",
  "taiwanese dollars": "TWD",
  "new taiwan dollars": "TWD",
  "indian rupees": "INR",
  "uae dirhams": "AED",
};

/** Split the page into one chunk per itinerary. */
function splitCards(html) {
  return html
    .split(/(?=<li\b)/)
    .filter((c) => PRICE_RE.test(c) && /Leaves [^<]{40,600}?Select flight/.test(c));
}

function parseCard(chunk, from, to, fallbackCurrency) {
  const priceM = chunk.match(PRICE_RE);
  if (!priceM) return null;
  const priceLabel = priceM[2].trim();
  const currency = CURRENCY_CODES[priceLabel.toLowerCase()] || fallbackCurrency;

  const desc = toText((chunk.match(/Leaves [^<]{40,700}?Select flight/) || [""])[0]);
  const text = toText(chunk);

  // Segments: "itinerary=CNX-DMK-FD-3438-20261015,DMK-NRT-XJ-606-20261015"
  const itin = chunk.match(/itinerary=([A-Z0-9,\-]+)/);
  const segments = itin
    ? itin[1].split(",").map((s) => {
        const m = s.match(/^([A-Z]{3})-([A-Z]{3})-([A-Z0-9]{2})-(\d+)-(\d{8})$/);
        return m ? { from: m[1], to: m[2], carrier: m[3], flight: m[4], date: m[5] } : { raw: s };
      })
    : [];

  // Times / duration / layovers come from the accessibility description.
  const dep = desc.match(/Leaves .*? at (\d{1,2}:\d{2}\s*[AP]M) on ([^,]+,\s*[A-Za-z]+ \d+)/);
  const arr = desc.match(/arrives at .*? at (\d{1,2}:\d{2}\s*[AP]M) on ([^,]+,\s*[A-Za-z]+ \d+)/);
  const dur = desc.match(/Total duration (\d+) hr(?: (\d+) min)?/);

  const layovers = [];
  // The hours part is optional: a short connection reads "is a 55 min layover at ...".
  const layRe = /Layover \((\d+) of (\d+)\) is a (?:(\d+) hr)?\s*(?:(\d+) min)?\s*layover at ([^.]+)\./g;
  let lm;
  while ((lm = layRe.exec(desc))) {
    layovers.push({
      index: Number(lm[1]),
      of: Number(lm[2]),
      minutes: toMin(lm[3], lm[4]),
      airport: lm[5].trim(),
    });
  }

  // Airline names sit between the arrival date and the duration in the card text.
  const airM = text.match(/on (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d+ ([^0-9]+?) \d+ hr/);
  const airlines = airM ? airM[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean) : [];

  const stopsM = text.match(/(Nonstop|\d+ stops?)\b/);
  const stops = !stopsM ? null : /Nonstop/i.test(stopsM[1]) ? 0 : Number(stopsM[1].match(/\d+/)[0]);

  const co2M = text.match(/([\d,]+) kg CO2e/);
  const tripM = text.match(/\b(round trip|one way|one-way)\b/i);

  return {
    id: null,
    price: Number(priceM[1]),
    currency,
    priceLabel,
    tripType: tripM ? tripM[1].toLowerCase().replace("-", " ") : null,
    airlines,
    departTime: dep ? dep[1].replace(/\s+/g, " ") : null,
    departDate: dep ? dep[2].trim() : null,
    arriveTime: arr ? arr[1].replace(/\s+/g, " ") : null,
    arriveDate: arr ? arr[2].trim() : null,
    durationMin: dur ? toMin(dur[1], dur[2]) : null,
    durationLabel: dur ? `${dur[1]} hr${dur[2] ? ` ${dur[2]} min` : ""}` : null,
    stops,
    layovers,
    co2Kg: co2M ? Number(co2M[1].replace(/,/g, "")) : null,
    route: [from, to],
    segments,
  };
}

/**
 * Read the dates Google actually searched back out of the page. Never assume the query was
 * honoured — this is the check that catches Google substituting its own trip length.
 *
 * Two sources, deliberately: the visible inputs give a display string ("Thu, Oct 15") and
 * the "Track prices" aria-label carries unambiguous ISO dates. Date arithmetic uses the
 * ISO pair; the display pair is only for matching what a human sees.
 */
function fieldDates(page) {
  const grab = (ph) => {
    const m = page.match(new RegExp(`value="([^"]+)"\\s+placeholder="${ph}"`));
    return m ? m[1] : null;
  };
  const iso = page.match(/departing (\d{4}-\d{2}-\d{2}) and returning (\d{4}-\d{2}-\d{2})/);
  return {
    departure: grab("Departure"),
    return: grab("Return"),
    departureIso: iso ? iso[1] : null,
    returnIso: iso ? iso[2] : null,
  };
}

// Google renders the itinerary list more than once (desktop + a hidden duplicate), so the
// same flight shows up two or three times. Collapse on the fields that identify it.
const sig = (f) =>
  [f.price, f.airlines.join("+"), f.departTime, f.arriveTime, f.durationMin, f.stops,
   f.layovers.map((l) => l.airport).join("|")].join("~");

/**
 * Did this page contain any itinerary markup at all?
 *
 * This is the difference between "the route has no flights" and "Google gave us a page whose
 * result list it expects JavaScript to fill in". Both parse to zero itineraries, but only one
 * of them is a fact about the route — and the two must never be reported the same way.
 */
const hasResultMarkup = (html) => /Select flight/.test(html) || /itinerary=/.test(html);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch one Google Flights page, with the timeout applied to the request itself. */
async function fetchPage(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`Google Flights returned HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ search */

/**
 * Scrape one route + trip length.
 *
 * Always pass `nights` or `returnDate`. Without one Google invents a return date and every
 * price describes a trip nobody chose — see `warnings` in the result.
 *
 * @returns {{payload: object, warnings: string[]}}
 */
export async function searchFlights({
  from,
  to,
  date,
  nights = null,
  returnDate = null,
  currency = "THB",
  timeoutMs = 45000,
} = {}) {
  const warnings = [];
  const FROM = String(from || "").toUpperCase();
  const TO = String(to || "").toUpperCase();
  const CURRENCY = String(currency || "THB").toUpperCase();

  if (!isIata(FROM) || !isIata(TO)) throw new Error("from and to must be 3-letter IATA codes");
  if (!isIsoDate(date)) throw new Error("date must be YYYY-MM-DD");

  let RETURN = returnDate;
  if (!RETURN && nights != null) {
    const n = Number(nights);
    if (!Number.isInteger(n) || n < 0 || n > 400) throw new Error("nights must be an integer 0-400");
    RETURN = addDays(date, n);
  }
  if (RETURN && !isIsoDate(RETURN)) throw new Error("returnDate must be YYYY-MM-DD");
  if (RETURN && RETURN < date) throw new Error(`returnDate ${RETURN} is before date ${date}`);

  const query = RETURN
    ? `Flights from ${FROM} to ${TO} on ${date} returning ${RETURN}`
    : `Flights from ${FROM} to ${TO} on ${date}`;
  const url = `${GOOGLE}?q=${encodeURIComponent(query)}&hl=en&curr=${CURRENCY}`;

  // Google pre-renders the result list into the HTML only sometimes; when it does not, the
  // page parses to zero itineraries even though the route is served. Retry before believing it.
  let html = "";
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    attempts += 1;
    html = await fetchPage(url, timeoutMs);
    if (hasResultMarkup(html)) break;
    if (attempts < maxAttempts) await sleep(700 * attempts);
  }

  const actual = fieldDates(html);
  if (!actual.return) {
    warnings.push(
      "The page shows no return date, so this is a ONE-WAY search. Prices are one-way, not round trip.",
    );
  } else if (!RETURN) {
    // The trap: Google happily invents a trip length, and every price then describes a trip
    // nobody chose. Say the length out loud instead of letting it pass silently.
    const n = nightsBetween(actual.departureIso, actual.returnIso);
    warnings.push(
      `No trip length was given, so Google chose one: ` +
        `${actual.departureIso ?? actual.departure} -> ${actual.returnIso ?? actual.return}` +
        `${n != null ? ` (${n} nights)` : ""}. Every price is for THAT trip. ` +
        `Pass nights or returnDate to control it.`,
    );
  } else if (actual.returnIso && actual.returnIso !== RETURN) {
    warnings.push(
      `Asked to return ${RETURN} but the page searched ${actual.returnIso}. ` +
        "Google overrode the return date; the prices are for its choice, not yours.",
    );
  }

  const seen = new Map();
  for (const f of splitCards(html).map((c) => parseCard(c, FROM, TO, CURRENCY)).filter(Boolean)) {
    const k = sig(f);
    if (!seen.has(k)) seen.set(k, f);
  }
  const flights = [...seen.values()].map((f, i) => ({
    ...f,
    id: `f${String(i + 1).padStart(2, "0")}`,
  }));

  const markup = hasResultMarkup(html);
  if (!flights.length) {
    if (!markup) {
      warnings.push(
        `Google returned a page with no itinerary markup at all (after ${attempts} attempt${attempts > 1 ? "s" : ""}). ` +
          "This is NOT evidence the route has no flights: the no-JavaScript view is partial and " +
          "Google sometimes defers the whole result list to JavaScript. Treat this date as UNKNOWN, " +
          "not as unavailable, and confirm it in a browser before concluding anything.",
      );
    } else {
      warnings.push(
        "The page contained itinerary markup but none of it matched the parser — the page layout " +
          "has probably changed. Check the source URL before trusting an empty result.",
      );
    }
  }

  const payload = {
    route: `${FROM}-${TO}`,
    date,
    returnDate: RETURN,
    nights: nightsBetween(date, RETURN),
    searchedDates: actual,
    searchedNights: nightsBetween(actual.departureIso, actual.returnIso),
    currency: CURRENCY,
    scrapedAt: new Date().toISOString(),
    source: url,
    attempts,
    pageHadResultMarkup: markup,
    count: flights.length,
    flights,
  };
  return { payload, warnings };
}

/* ------------------------------------------------------------------ presentation */

export const hhmm = (min) =>
  min == null ? "?" : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;

/** One human-readable line per itinerary, used as both state text and choice criteria. */
export function describe(f) {
  const lay = f.layovers.length
    ? f.layovers.map((l) => `${hhmm(l.minutes)} at ${l.airport}`).join("; ")
    : "none";
  return (
    `${f.currency} ${f.price.toLocaleString("en-US")} | ${f.airlines.join(" + ")} | ` +
    `${f.departTime} -> ${f.arriveTime} (${f.arriveDate}) | ${f.durationLabel} | ` +
    `${f.stops === 0 ? "nonstop" : `${f.stops} stop${f.stops > 1 ? "s" : ""}`} | ` +
    `layover: ${lay} | ${f.co2Kg} kg CO2e`
  );
}

export function tripLabel(payload) {
  const s = payload.searchedDates || {};
  if (s.returnIso && payload.searchedNights != null) {
    return `${payload.searchedNights} nights (${s.departureIso} out, ${s.returnIso} back)`;
  }
  if (payload.returnDate && payload.nights != null) {
    return `${payload.nights} nights (${payload.date} out, ${payload.returnDate} back)`;
  }
  return "one way";
}

/* ------------------------------------------------------------------ jev */

export const PREF_RULE =
  "Honour the traveller's `preferences` from the state: treat them as hard constraints " +
  "wherever the options allow it, and as strong tie-breakers otherwise. If a preference " +
  "cannot be satisfied by anything in the list, choose the option that violates it least.";

export function buildState(payload, preferences = []) {
  const prices = payload.flights.map((f) => f.price);
  return {
    task:
      `Pick the single best ${payload.returnDate ? "round-trip" : "one-way"} itinerary from ` +
      `${payload.route}, departing ${payload.date}` +
      `${payload.returnDate ? ` and returning ${payload.returnDate}` : ""} ` +
      `— a trip of ${tripLabel(payload)}. A solo leisure traveller, economy cabin, ` +
      `no loyalty programme, price paid in cash.`,
    currency: payload.currency,
    route: payload.route,
    depart_date: payload.date,
    return_date: payload.returnDate,
    trip_length: tripLabel(payload),
    searched_dates: payload.searchedDates ?? null,
    cheapest_price: prices.length ? Math.min(...prices) : null,
    shortest_duration_min: Math.min(
      ...payload.flights.map((f) => f.durationMin ?? Infinity),
    ),
    preferences: preferences.length
      ? preferences
      : ["none stated — judge on price, total time, stops, connection length and civilised hours alone"],
    notes: [
      `Prices are round-trip totals in ${payload.currency}, as quoted by Google Flights.`,
      "All times are local. An arrival date later than the departure date means an overnight flight.",
      "A layover is a connection on the same ticket; a long layover is time spent in an airport, not in the destination.",
      "CO2e is a per-passenger estimate and is a tie-breaker at most.",
    ],
    itineraries: payload.flights.map((f) => ({ id: f.id, detail: describe(f) })),
  };
}

export function buildQuestions(payload, preferences = []) {
  const criteria = Object.fromEntries(payload.flights.map((f) => [f.id, describe(f)]));
  return {
    // The documented trap: a choice always ranks something first because its probabilities
    // sum to 1, so ask whether a good option exists at all and read that verdict first.
    has_good_option: {
      type: "noul",
      instructions:
        "Looking at the `itineraries` in the state, does at least one of them represent a " +
        "genuinely good way to fly this route on this date for THIS traveller — one they " +
        "would be happy to book — rather than all of them being poor compromises or " +
        "violating their `preferences`?",
    },
    best_overall: {
      type: "choice",
      instructions:
        "Which single itinerary in `itineraries` is the best overall choice, weighing total " +
        "price against total door-to-door time, number of stops, how civilised the departure " +
        "and arrival hours are, and the length of any layover? " + PREF_RULE,
      criteria,
    },
    best_budget: {
      type: "choice",
      instructions:
        "If paying the least money were the only real priority — while still reaching the " +
        "destination the same day or the next morning, and still respecting any hard " +
        "constraint in `preferences` — which itinerary in `itineraries` should be booked? " + PREF_RULE,
      criteria,
    },
    best_schedule: {
      type: "choice",
      instructions:
        "If a comfortable schedule were the only real priority — a reasonable departure " +
        "hour, an arrival that does not destroy the first day, and no punishing connection — " +
        "which itinerary in `itineraries` should be booked? " + PREF_RULE,
      criteria,
    },
    worst_value: {
      type: "choice",
      instructions:
        "Which itinerary in `itineraries` looks like the worst value once you account for " +
        "everything it costs in time and inconvenience, not just its price? " + PREF_RULE,
      criteria,
    },
    cheapest_value: {
      type: "score",
      instructions:
        "Rate the overall value of the cheapest itinerary in `itineraries` — the one at " +
        "`cheapest_price` — as a booking decision for this traveller, all things considered. " + PREF_RULE,
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

/** Locate the jev CLI: a real install on PATH first, then the clone. */
export function jevBin() {
  const clone = join(homedir(), ".agents", "mcp", "use-jev", "cli.mjs");
  if (existsSync(clone)) return { cmd: process.execPath, pre: [clone] };
  return { cmd: "use-jev", pre: [] };
}

/**
 * Run one questions/state pair through the jev CLI as a subprocess.
 *
 * A subprocess rather than an MCP tool call on purpose: the candidate list then never
 * travels through the agent's context, which is the only way the saving is real.
 *
 * exit 3 means something escalated. The verdicts are still on stdout and still worth
 * reading, so that is not treated as a failure.
 */
export async function runJev(questions, state, threshold = null) {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const dir = mkdtempSync(join(tmpdir(), "ff-jev-"));
  const qPath = join(dir, "questions.json");
  const sPath = join(dir, "state.json");
  writeFileSync(qPath, JSON.stringify(questions, null, 2));
  writeFileSync(sPath, JSON.stringify(state, null, 2));

  const bin = jevBin();
  return new Promise((resolve, reject) => {
    execFile(
      bin.cmd,
      [...bin.pre, "judge", "--questions-file", qPath, "--state-file", sPath],
      {
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(threshold != null ? { JEV_CONFIDENCE_THRESHOLD: String(threshold) } : {}),
        },
      },
      (err, stdout, stderrOut) => {
        if (stdout && stdout.trim()) {
          try {
            resolve({ result: JSON.parse(stdout), stderr: stderrOut });
          } catch (e) {
            reject(new Error(`could not parse jev output: ${e.message}`));
          }
          return;
        }
        reject(new Error(err ? `${err.message}\n${stderrOut || ""}` : "jev produced no output"));
      },
    );
  });
}

/** Rank the itineraries of one already-scraped payload. */
export async function rankFlights(payload, { preferences = [], threshold = null } = {}) {
  const state = buildState(payload, preferences);
  const questions = buildQuestions(payload, preferences);
  const { result, stderr } = await runJev(questions, state, threshold);
  return { result, stderr, state, questions };
}

/**
 * Normalise a `score` verdict.
 *
 * The answer is a level index but may land *between* levels (3.62 is a real answer), and the
 * legend is an object keyed by level index — so an exact lookup returns nothing. Snap to the
 * nearest level for the label, and carry the raw score so nothing is lost.
 */
export function scoreOut(sv) {
  if (!sv) return null;
  const levels = sv.legend && typeof sv.legend === "object" ? sv.legend : null;
  const nearest = typeof sv.answer === "number" ? Math.round(sv.answer) : null;
  return {
    score: sv.answer,
    nearest_level: nearest,
    legend: levels && nearest != null ? levels[String(nearest)] ?? null : null,
    levels,
    escalate: sv.escalate,
    reason: sv.reason ?? null,
    hint: sv.hint ?? null,
  };
}

/** Turn a jev result into the shape both the CLI and the MCP server report. */
export function summarise(result, flights) {
  const byId = Object.fromEntries(result.verdicts.map((v) => [v.id, v]));
  const rank = (id) => {
    const v = byId[id];
    if (v && v.type === "choice" && v.distribution) {
      return Object.entries(v.distribution).sort((a, b) => b[1] - a[1]);
    }
    return [];
  };
  const flightOf = (id) => flights.find((f) => f.id === id) || null;

  const pickId = byId.best_overall?.answer ?? null;
  const out = {
    model: result.model,
    latencyMs: result.latencyMs,
    stateTokens: result.stateTokens,
    escalated: result.escalated,
    gate: byId.has_good_option
      ? { probability: byId.has_good_option.answer, escalate: byId.has_good_option.escalate,
          reason: byId.has_good_option.reason ?? null }
      : null,
    pick: pickId ? { id: pickId, flight: flightOf(pickId),
      probability: rank("best_overall")[0]?.[1] ?? null,
      escalate: byId.best_overall.escalate } : null,
    runnersUp: rank("best_overall").slice(1, 4)
      .filter(([k, p]) => k !== pickId && p > 0)
      .map(([id, p]) => ({ id, probability: p, flight: flightOf(id) })),
  };

  for (const key of ["best_budget", "best_schedule", "worst_value"]) {
    const v = byId[key];
    if (!v) continue;
    out[key] = { id: v.answer, probability: rank(key)[0]?.[1] ?? null,
      escalate: v.escalate, flight: flightOf(v.answer) };
  }

  out.cheapest_value = scoreOut(byId.cheapest_value);
  return out;
}
