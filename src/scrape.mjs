#!/usr/bin/env node
/**
 * Scrape Google Flights for one route + date and emit candidate itineraries as JSON.
 *
 *   node src/scrape.mjs --from CNX --to NRT --date 2026-10-15 [--currency THB] [--out f.json]
 *
 * --from / --to are any IATA codes; CNX and NRT are just the defaults used in the
 * examples. Nothing here is route-specific.
 *
 * Why this works without a browser: Google ships an accessibility description per
 * itinerary ("Leaves ... at 8:25 AM ... Total duration 9 hr 40 min ... Layover (1 of 1)
 * is a 2 hr layover at ...") plus the exact price in an aria-label, all in the initial
 * HTML. The results are therefore parseable with regex, no headless Chromium needed.
 */

const GOOGLE = "https://www.google.com/travel/flights";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const a = { currency: "THB" };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const key = k.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    a[key] = val;
  }
  return a;
}

const args = parseArgs(process.argv);
const FROM = (args.from || "CNX").toUpperCase();
const TO = (args.to || "NRT").toUpperCase();
const DATE = args.date || new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10);
const CURRENCY = (args.currency || "THB").toUpperCase();

if (!/^[A-Z]{3}$/.test(FROM) || !/^[A-Z]{3}$/.test(TO)) {
  console.error("scrape: --from and --to must be 3-letter IATA codes");
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error("scrape: --date must be YYYY-MM-DD");
  process.exit(2);
}

/**
 * Return date. Without one, Google silently invents a trip length — a bare
 * "on 2026-10-15" search came back as a 15-19 Oct round trip, and every price in it was
 * for a 5-day trip nobody asked for. So: pass --return, or --days, and read the real
 * dates back out of the page afterwards rather than assuming the query was honoured.
 */
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let RETURN = args.return || null;
if (!RETURN && args.days) {
  const n = Number(args.days);
  if (!Number.isInteger(n) || n < 0 || n > 400) {
    console.error("scrape: --days must be an integer between 0 and 400");
    process.exit(2);
  }
  RETURN = addDays(DATE, n);
}
if (RETURN && !/^\d{4}-\d{2}-\d{2}$/.test(RETURN)) {
  console.error("scrape: --return must be YYYY-MM-DD");
  process.exit(2);
}
if (RETURN && RETURN < DATE) {
  console.error(`scrape: --return ${RETURN} is before --date ${DATE}`);
  process.exit(2);
}

const query = RETURN
  ? `Flights from ${FROM} to ${TO} on ${DATE} returning ${RETURN}`
  : `Flights from ${FROM} to ${TO} on ${DATE}`;

const url = `${GOOGLE}?q=${encodeURIComponent(query)}&hl=en&curr=${CURRENCY}`;

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

function parseCard(chunk, i) {
  const priceM = chunk.match(PRICE_RE);
  if (!priceM) return null;
  const priceLabel = priceM[2].trim();
  const currency = CURRENCY_CODES[priceLabel.toLowerCase()] || CURRENCY;

  const desc = toText((chunk.match(/Leaves [^<]{40,700}?Select flight/) || [""])[0]);
  const text = toText(chunk);

  // Segments: "itinerary=CNX-DMK-FD-3438-20261015,DMK-NRT-XJ-606-20261015"
  const itin = chunk.match(/itinerary=([A-Z0-9,\-]+)/);
  const segments = itin
    ? itin[1].split(",").map((s) => {
        const m = s.match(/^([A-Z]{3})-([A-Z]{3})-([A-Z0-9]{2})-(\d+)-(\d{8})$/);
        return m
          ? { from: m[1], to: m[2], carrier: m[3], flight: m[4], date: m[5] }
          : { raw: s };
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
  const airlines = airM
    ? airM[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean)
    : [];

  const stopsM = text.match(/(Nonstop|\d+ stops?)\b/);
  const stops = !stopsM ? null : /Nonstop/i.test(stopsM[1]) ? 0 : Number(stopsM[1].match(/\d+/)[0]);

  const co2M = text.match(/([\d,]+) kg CO2e/);
  const tripM = text.match(/\b(round trip|one way|one-way)\b/i);

  return {
    id: `f${String(i + 1).padStart(2, "0")}`,
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
    route: [FROM, TO],
    segments,
  };
}

const res = await fetch(url, {
  headers: {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    Accept: "text/html,application/xhtml+xml",
  },
});
if (!res.ok) {
  console.error(`scrape: HTTP ${res.status} from Google Flights`);
  process.exit(1);
}
const html = await res.text();

/**
 * Read the dates Google actually searched back out of the page. Never assume the query
 * was honoured — this is the check that catches Google substituting its own trip length.
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
  const departure = grab("Departure");
  const ret = grab("Return");
  return {
    departure,
    return: ret,
    departureIso: iso ? iso[1] : null,
    returnIso: iso ? iso[2] : null,
  };
}

const actual = fieldDates(html);
if (!actual.return) {
  console.error(
    "scrape: WARNING — the page shows no return date, so this is a ONE-WAY search. " +
      "Prices below are one-way, not round trip.",
  );
} else if (!RETURN) {
  // The trap: Google happily invents a trip length, and every price then describes a
  // trip nobody chose. Say the length out loud instead of letting it pass silently.
  const nights =
    actual.departureIso && actual.returnIso
      ? Math.round(
          (new Date(`${actual.returnIso}T00:00:00Z`) - new Date(`${actual.departureIso}T00:00:00Z`)) / 864e5,
        )
      : null;
  console.error(
    `scrape: WARNING — no trip length given, so Google chose one: ` +
      `${actual.departureIso ?? actual.departure} -> ${actual.returnIso ?? actual.return}` +
      `${nights != null ? ` (${nights} nights)` : ""}. ` +
      `Every price below is for THAT trip. Pass --days N or --return YYYY-MM-DD to control it.`,
  );
} else if (actual.returnIso && actual.returnIso !== RETURN) {
  console.error(
    `scrape: WARNING — asked to return ${RETURN} but the page searched ${actual.returnIso}. ` +
      "Google overrode the return date; the prices are for its choice, not yours.",
  );
}

// Google renders the itinerary list more than once (desktop + a hidden duplicate), so
// the same flight shows up two or three times. Collapse on the fields that identify it.
const sig = (f) =>
  [f.price, f.airlines.join("+"), f.departTime, f.arriveTime, f.durationMin, f.stops, f.layovers.map((l) => l.airport).join("|")].join("~");

const seen = new Map();
for (const f of splitCards(html).map(parseCard).filter(Boolean)) {
  const k = sig(f);
  if (!seen.has(k)) seen.set(k, f);
}
const flights = [...seen.values()].map((f, i) => ({ ...f, id: `f${String(i + 1).padStart(2, "0")}` }));

const nightsBetween = (a, b) =>
  a && b ? Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5) : null;

const payload = {
  route: `${FROM}-${TO}`,
  // What was requested.
  date: DATE,
  returnDate: RETURN,
  nights: nightsBetween(DATE, RETURN),
  // What the page actually searched, which is the only thing the prices describe.
  // These two disagree whenever Google overrides the trip length.
  searchedDates: actual,
  searchedNights: nightsBetween(actual.departureIso, actual.returnIso),
  currency: CURRENCY,
  scrapedAt: new Date().toISOString(),
  source: url,
  count: flights.length,
  flights,
};

const json = JSON.stringify(payload, null, 2);
if (args.out) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, json);
  const trip = actual.return
    ? `${actual.departure} -> ${actual.return}${payload.nights != null ? ` (${payload.nights} nights)` : ""}`
    : `${actual.departure} (one way)`;
  console.error(`scrape: ${flights.length} itineraries, ${trip} -> ${args.out}`);
} else {
  process.stdout.write(json + "\n");
}
