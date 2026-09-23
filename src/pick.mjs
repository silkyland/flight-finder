#!/usr/bin/env node
/**
 * Rank scraped itineraries with Jev and print the pick.
 *
 *   node src/pick.mjs --in out/cnx-nrt.json [--prefs "a; b"] [--prefs-file prefs.txt]
 *
 * Why the CLI and not a tool call: the whole point is that the itinerary list never enters
 * the agent's context. This reads the file, posts it to Jev, and only the verdicts come
 * back — see the "rate win, not a token win" note in use-jev's README.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { rankFlights, summarise, describe, hhmm, tripLabel } from "./lib/flights.mjs";

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
if (!data.flights?.length) {
  console.error("pick: the scrape produced no itineraries");
  process.exit(1);
}

/**
 * Traveller preferences. Jev has no memory and no tools — everything it judges is in the
 * state, so anything the traveller cares about has to be stated explicitly. Accepts
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

const outDir = dirname(inPath);
mkdirSync(outDir, { recursive: true });

let run;
try {
  run = await rankFlights(data, { preferences });
} catch (err) {
  console.error(`pick: ${err.message}`);
  process.exit(1);
}

// Keep the generated question and state files on disk so a human can read exactly what was
// asked and exactly what Jev saw.
writeFileSync(join(outDir, "questions.generated.json"), JSON.stringify(run.questions, null, 2));
writeFileSync(join(outDir, "state.generated.json"), JSON.stringify(run.state, null, 2));

const s = summarise(run.result, data.flights);
const pct = (p) => (p == null ? "n/a" : `${(p * 100).toFixed(1)}%`);

console.log(`  trip: ${data.route} · ${tripLabel(data)}`);
if (data.returnDate && data.searchedDates?.returnIso && data.returnDate !== data.searchedDates.returnIso) {
  console.log(`  !! requested return ${data.returnDate} but the page searched ${data.searchedDates.returnIso}`);
} else if (!data.returnDate && data.searchedDates?.returnIso) {
  console.log(`  !! no trip length was requested — Google chose ${data.searchedNights} nights`);
  console.log("     every price below is for that trip, not the one you asked for");
}
console.log(`Jev ${s.model} · ${data.flights.length} candidates · ${s.latencyMs} ms · state ${s.stateTokens} tokens`);
console.log(
  preferences.length
    ? `  preferences honoured: ${preferences.join(" · ")}`
    : "  preferences: none stated — ranking on price, time, stops and hours alone",
);
console.log("");

if (s.gate) {
  console.log(
    `  presence check (has_good_option): ${s.gate.probability.toFixed(2)}  -> ` +
      `${s.gate.probability >= 0.5 ? "a good option exists" : "NOTHING here is genuinely good"}`,
  );
  if (s.gate.escalate) console.log(`    (escalated: ${s.gate.reason ?? "low confidence"} — treat as a hint)`);
  console.log("");
}

for (const [label, key] of [
  ["best overall", "pick"],
  ["cheapest viable", "best_budget"],
  ["best schedule", "best_schedule"],
  ["worst value", "worst_value"],
]) {
  const v = key === "pick" ? s.pick : s[key];
  if (!v) continue;
  console.log(`  ${label}  ->  ${v.id}  (${pct(v.probability)}${v.escalate ? ", escalated" : ""})`);
  if (v.flight) console.log(`      ${describe(v.flight)}`);
  if (key === "pick" && s.runnersUp.length) {
    console.log(`      runners-up: ${s.runnersUp.map((r) => `${r.id} ${pct(r.probability)}`).join(", ")}`);
  }
  console.log("");
}

if (s.cheapest_value) {
  const c = s.cheapest_value;
  console.log(`  cheapest_value (score): ${c.score}${c.legend ? ` — "${c.legend}"` : ""}${c.escalate ? "  [escalated]" : ""}`);
  if (c.escalate) console.log(`      reason: ${c.reason} — ${c.hint ?? "treat as a prior, not a decision"}`);
  console.log("");
}

if (s.pick?.flight) {
  const f = s.pick.flight;
  console.log("─".repeat(72));
  console.log(`  BOOK ${f.id}: ${f.airlines.join(" + ")} — ${f.currency} ${f.price.toLocaleString("en-US")}`);
  console.log(`  ${f.departTime} ${f.departDate}  ->  ${f.arriveTime} ${f.arriveDate}  ·  ${f.durationLabel}  ·  ${f.stops} stop(s)`);
  if (f.layovers.length) console.log(`  layover: ${f.layovers.map((l) => `${hhmm(l.minutes)} at ${l.airport}`).join("; ")}`);
  console.log(`  segments: ${f.segments.map((x) => `${x.carrier}${x.flight} ${x.from}-${x.to}`).join("  ")}`);
  console.log("─".repeat(72));
}
if (s.escalated) console.log("\n  NOTE: at least one verdict escalated — read it as a prior, not a decision.");

// Mirror the CLI's own contract: 3 when something escalated, 0 when every verdict stands.
process.exitCode = s.escalated ? 3 : 0;
