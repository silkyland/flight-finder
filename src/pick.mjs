#!/usr/bin/env node
/**
 * Rank scraped itineraries with Jev and print the pick.
 *
 *   node src/pick.mjs --in out/cnx-nrt.json [--origin CNX] [--dest NRT]
 *
 * Why the CLI and not a tool call: the whole point is that the itinerary list never
 * enters the agent's context. This script reads the file, posts it to Jev, and only
 * the verdicts come back — see the "rate win, not a token win" note in use-jev's README.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    a[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return a;
}

const args = parseArgs(process.argv);
const inPath = args.in || "out/cnx-nrt.json";
if (!existsSync(inPath)) {
  console.error(`pick: no such file ${inPath} — run src/scrape.mjs first`);
  process.exit(2);
}

const data = JSON.parse(readFileSync(inPath, "utf8"));
const flights = data.flights;
if (!flights.length) {
  console.error("pick: the scrape produced no itineraries");
  process.exit(1);
}

/**
 * Traveller preferences. Jev has no memory and no tools — everything it judges is in the
 * state, so anything the traveller cares about has to be stated here explicitly. Accepts
 * --prefs "a; b; c" or --prefs-file prefs.txt (one per line, # comments allowed).
 */
const preferences = (() => {
  if (args["prefs-file"]) {
    return readFileSync(args["prefs-file"], "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  }
  if (args.prefs) return args.prefs.split(";").map((s) => s.trim()).filter(Boolean);
  return [];
})();

const hhmm = (min) => (min == null ? "?" : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`);

/** One human-readable line per itinerary, used both as the state and as choice criteria. */
const describe = (f) => {
  const lay = f.layovers.length
    ? f.layovers.map((l) => `${hhmm(l.minutes)} at ${l.airport}`).join("; ")
    : "none";
  return (
    `${f.currency} ${f.price.toLocaleString("en-US")} | ${f.airlines.join(" + ")} | ` +
    `${f.departTime} -> ${f.arriveTime} (${f.arriveDate}) | ${f.durationLabel} | ` +
    `${f.stops === 0 ? "nonstop" : `${f.stops} stop${f.stops > 1 ? "s" : ""}`} | ` +
    `layover: ${lay} | ${f.co2Kg} kg CO2e`
  );
};

const cheapest = Math.min(...flights.map((f) => f.price));
const fastest = Math.min(...flights.map((f) => f.durationMin ?? Infinity));

// The trip the prices actually describe. Prefer the dates read back off the page: if
// Google overrode the request, the request is not what the fares are for.
const sIso = data.searchedDates?.departureIso ?? null;
const sRet = data.searchedDates?.returnIso ?? null;
const trip =
  sRet && data.searchedNights != null
    ? `${data.searchedNights} nights (${sIso} out, ${sRet} back)`
    : data.returnDate && data.nights != null
      ? `${data.nights} nights (${data.date} out, ${data.returnDate} back)`
      : "one way";

const mismatch =
  data.returnDate && sRet && data.returnDate !== sRet
    ? `requested return ${data.returnDate} but the page searched ${sRet}`
    : !data.returnDate && sRet
      ? `no trip length was requested — Google chose ${data.searchedNights} nights (${sIso} -> ${sRet})`
      : null;

const state = {
  task:
    `Pick the single best ${data.returnDate ? "round-trip" : "one-way"} itinerary from ` +
    `${data.route}, departing ${data.date}${data.returnDate ? ` and returning ${data.returnDate}` : ""} ` +
    `— a trip of ${trip}. A solo leisure traveller, economy cabin, no loyalty programme, ` +
    `price paid in cash.`,
  currency: data.currency,
  route: data.route,
  depart_date: data.date,
  return_date: data.returnDate,
  trip_length: trip,
  // What Google actually searched. If this disagrees with the request, the prices
  // describe a different trip than the one being planned.
  searched_dates: data.searchedDates ?? null,
  trip_length_verified: mismatch ? `NO — ${mismatch}` : "yes — the page searched the requested dates",
  cheapest_price: cheapest,
  shortest_duration_min: fastest,
  // Stated by the traveller. Treat these as hard constraints where they can be honoured
  // and as strong preferences otherwise — they outrank the general comfort heuristic.
  preferences: preferences.length
    ? preferences
    : ["none stated — judge on price, total time, stops, connection length and civilised hours alone"],
  notes: [
    `Prices are round-trip totals in ${data.currency}, as quoted by Google Flights.`,
    "All times are local. An arrival date later than the departure date means an overnight flight.",
    "A layover is a connection on the same ticket; a long layover is time spent in an airport, not in the destination.",
    "CO2e is a per-passenger estimate and is a tie-breaker at most.",
  ],
  itineraries: flights.map((f) => ({ id: f.id, detail: describe(f) })),
};

const criteria = Object.fromEntries(flights.map((f) => [f.id, describe(f)]));

const PREF = "Honour the traveller's `preferences` from the state: treat them as hard constraints wherever the options allow it, and as strong tie-breakers otherwise. If a preference cannot be satisfied by anything in the list, say so by choosing the option that violates it least.";

const questions = {
  // The documented trap: a choice always ranks something first, so ask whether a good
  // option exists at all and read that verdict before trusting the pick.
  has_good_option: {
    type: "noul",
    instructions:
      `Looking at the \`itineraries\` in the state, does at least one of them represent a genuinely good way to fly this route on this date for THIS traveller — one they would be happy to book — rather than all of them being poor compromises or violating their \`preferences\`?`,
  },
  best_overall: {
    type: "choice",
    instructions:
      `Which single itinerary in \`itineraries\` is the best overall choice, weighing total price against total door-to-door time, number of stops, how civilised the departure and arrival hours are, and the length of any layover? ${PREF}`,
    criteria,
  },
  best_budget: {
    type: "choice",
    instructions:
      `If paying the least money were the only real priority — while still reaching the destination the same day or the next morning, and still respecting any hard constraint in \`preferences\` — which itinerary in \`itineraries\` should be booked? ${PREF}`,
    criteria,
  },
  best_schedule: {
    type: "choice",
    instructions:
      `If a comfortable schedule were the only real priority — a reasonable departure hour, an arrival that does not destroy the first day, and no punishing connection — which itinerary in \`itineraries\` should be booked? ${PREF}`,
    criteria,
  },
  worst_value: {
    type: "choice",
    instructions:
      `Which itinerary in \`itineraries\` looks like the worst value once you account for everything it costs in time and inconvenience, not just its price? ${PREF}`,
    criteria,
  },
  cheapest_value: {
    type: "score",
    instructions:
      `Rate the overall value of the cheapest itinerary in \`itineraries\` — the one at \`cheapest_price\` — as a booking decision for this traveller, all things considered. ${PREF}`,
    criteria: [
      "You would regret booking this",
      "Acceptable only if nothing better exists",
      "A fair deal you would take without much thought",
      "Clearly better than the alternatives",
      "The obvious pick at this price",
    ],
  },
};

const outDir = dirname(inPath);
mkdirSync(outDir, { recursive: true });
const qPath = join(outDir, "questions.generated.json");
const sPath = join(outDir, "state.generated.json");
writeFileSync(qPath, JSON.stringify(questions, null, 2));
writeFileSync(sPath, JSON.stringify(state, null, 2));

// Resolve the CLI: prefer a real install on PATH, fall back to the clone.
function jevBin() {
  try {
    execFileSync("command", ["-v", "use-jev"], { shell: true, stdio: "pipe" });
    return { cmd: "use-jev", pre: [] };
  } catch {
    const clone = join(homedir(), ".agents", "mcp", "use-jev", "cli.mjs");
    if (existsSync(clone)) return { cmd: process.execPath, pre: [clone] };
    return null;
  }
}

const bin = jevBin();
if (!bin) {
  console.error("pick: no use-jev CLI found (PATH or ~/.agents/mcp/use-jev/cli.mjs)");
  process.exit(1);
}

console.error(`pick: ${flights.length} itineraries -> jev (state ${JSON.stringify(state).length} bytes)`);

let raw;
try {
  raw = execFileSync(bin.cmd, [...bin.pre, "judge", "--questions-file", qPath, "--state-file", sPath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (err) {
  // exit 3 = something escalated. The verdicts are still on stdout and still worth reading.
  if (err.stdout) raw = err.stdout;
  else {
    console.error(`pick: jev failed — ${err.message}`);
    process.exit(1);
  }
}

const result = JSON.parse(raw);
const byId = Object.fromEntries(result.verdicts.map((v) => [v.id, v]));
const rank = (id) => {
  const v = byId[id];
  // A choice verdict carries `distribution` (option id -> probability); the score
  // verdict carries the same field keyed by level index.
  if (v && v.type === "choice" && v.distribution) {
    return Object.entries(v.distribution).sort((a, b) => b[1] - a[1]);
  }
  return [];
};

const pct = (p) => `${(p * 100).toFixed(1)}%`;
const flightOf = (id) => flights.find((f) => f.id === id);

console.log("");
console.log(`  trip: ${data.route} · ${trip}`);
if (mismatch) {
  console.log(`  !! ${mismatch}`);
  console.log(`     every price below is for that trip, not the one you asked for`);
}
console.log(`Jev ${result.model} · ${flights.length} candidates · ${result.latencyMs} ms · state ${result.stateTokens} tokens`);
if (preferences.length) {
  console.log(`  preferences honoured: ${preferences.join(" · ")}`);
} else {
  console.log("  preferences: none stated — ranking on price, time, stops and hours alone");
}
console.log("");

const gate = byId.has_good_option;
if (gate) {
  const pass = gate.answer >= 0.5;
  console.log(`  presence check (has_good_option): ${gate.answer.toFixed(2)}  -> ${pass ? "a good option exists" : "NOTHING here is genuinely good"}`);
  if (gate.escalate) console.log(`    (escalated: ${gate.reason ?? "low confidence"} — treat as a hint)`);
  console.log("");
}

const sections = [
  ["best overall", "best_overall"],
  ["cheapest viable", "best_budget"],
  ["best schedule", "best_schedule"],
  ["worst value", "worst_value"],
];

for (const [label, id] of sections) {
  const v = byId[id];
  if (!v) continue;
  if (v.type !== "choice") {
    console.log(`  ${label}: ${JSON.stringify(v.answer)}`);
    continue;
  }
  const top = rank(id);
  const win = flightOf(v.answer);
  console.log(`  ${label}  ->  ${v.answer}  (${pct(top[0]?.[1] ?? 0)}${v.escalate ? ", escalated" : ""})`);
  if (win) console.log(`      ${describe(win)}`);
  const rest = top.slice(1, 4).filter(([k, p]) => k !== v.answer && p > 0);
  if (rest.length) console.log(`      runners-up: ${rest.map(([k, p]) => `${k} ${pct(p)}`).join(", ")}`);
  console.log("");
}

const sv = byId.cheapest_value;
if (sv) {
  // The score verdict's legend is an object keyed by level index, not a string.
  const label = sv.legend && sv.legend[String(sv.answer)];
  console.log(`  cheapest_value (score): ${sv.answer}${label ? ` — "${label}"` : ""}${sv.escalate ? "  [escalated]" : ""}`);
  if (sv.distribution) {
    const spread = Object.entries(sv.distribution)
      .filter(([, p]) => p > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([lvl, p]) => `L${lvl} ${pct(p)}`);
    console.log(`      spread: ${spread.join(", ")}`);
  }
  if (sv.escalate) console.log(`      reason: ${sv.reason} — ${sv.hint ?? "treat as a prior, not a decision"}`);
  console.log("");
}

const pick = byId.best_overall?.answer;
if (pick) {
  const f = flightOf(pick);
  console.log("─".repeat(72));
  console.log(`  BOOK ${pick}: ${f.airlines.join(" + ")} — ${f.currency} ${f.price.toLocaleString("en-US")}`);
  console.log(`  ${f.departTime} ${f.departDate}  ->  ${f.arriveTime} ${f.arriveDate}  ·  ${f.durationLabel}  ·  ${f.stops} stop(s)`);
  if (f.layovers.length) console.log(`  layover: ${f.layovers.map((l) => `${hhmm(l.minutes)} at ${l.airport}`).join("; ")}`);
  console.log(`  segments: ${f.segments.map((s) => `${s.carrier}${s.flight} ${s.from}-${s.to}`).join("  ")}`);
  console.log("─".repeat(72));
}
if (result.escalated) {
  console.log("\n  NOTE: at least one verdict escalated — read it as a prior, not a decision.");
}

// Mirror the CLI's own contract: 3 when something escalated, 0 when every verdict stands.
process.exitCode = result.escalated ? 3 : 0;
