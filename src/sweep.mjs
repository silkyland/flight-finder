#!/usr/bin/env node
/**
 * Price one origin against many destinations on the same departure dates and print the table.
 *
 *   node src/sweep.mjs --from CNX --to southeast --dates 2026-11-10,2026-12-08 --nights 4
 *   node src/sweep.mjs --from CNX --to KUL,SIN,HKG --date 2026-11-10 --nights 4
 *
 * A trip length is required — see sweepDestinations() in src/lib/sweep.mjs for why.
 */

import { writeFileSync } from "node:fs";
import { sweepDestinations, rankDestinations, summariseSweep, resolveDestinations, GROUPS } from "./lib/sweep.mjs";
import { dateRange } from "./lib/scan.mjs";

function parseArgs(argv) {
  const out = { prefs: [], rank: true, dates: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--from": out.from = next(); break;
      case "--to": out.to = next(); break;
      case "--date": out.dates.push(next()); break;
      case "--dates": out.dates.push(...String(next()).split(",").map((s) => s.trim()).filter(Boolean)); break;
      case "--from-date": out.fromDate = next(); break;
      case "--to-date": out.toDate = next(); break;
      case "--step": out.stepDays = Number(next()); break;
      case "--max-dates": out.maxDates = Number(next()); break;
      case "--nights": out.nights = Number(next()); break;
      case "--return": out.returnDate = next(); break;
      case "--currency": out.currency = next(); break;
      case "--concurrency": out.concurrency = Number(next()); break;
      case "--tolerance": out.tolerance = Number(next()); break;
      case "--threshold": out.threshold = Number(next()); break;
      case "--prefs": out.prefs.push(...String(next()).split(";").map((s) => s.trim()).filter(Boolean)); break;
      case "--no-rank": out.rank = false; break;
      case "--out": out.out = next(); break;
      case "-h": case "--help": out.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

const groupNames = Object.keys(GROUPS).join(", ");
const args = parseArgs(process.argv.slice(2));

// A season is just a dense list of dates. `--from-date/--to-date/--step` is the convenient way to
// ask "when this winter?" without typing eighteen dates, and it reuses the same per-date pricing.
if ((args.fromDate || args.toDate) && !args.dates.length) {
  if (!args.fromDate || !args.toDate) throw new Error("--from-date and --to-date go together");
  const range = dateRange(args.fromDate, args.toDate, args.stepDays ?? 7);
  if (!range.length) throw new Error("--from-date/--to-date produced no departure dates");
  args.dates = args.maxDates ? range.slice(0, args.maxDates) : range;
}

if (args.help || !args.from || !args.to || !args.dates.length) {
  console.log(`usage: ./sweep.sh --from CNX --to <groups|codes> (--dates 2026-11-10,2026-12-08 | \\
                    --from-date 2026-11-01 --to-date 2027-02-28 [--step 7] [--max-dates 18]) --nights 4
       [--currency THB] [--prefs "no overnight layovers; carry-on only"]
       [--concurrency 3] [--tolerance 1.4] [--threshold 0.5] [--no-rank] [--out FILE]

  --to takes a comma list of group names (${groupNames})
  or of IATA codes (KUL,SIN,HKG), or a mix of both. To name a code the built-in index does not
  know, append the name with "=": KUL=Kuala Lumpur=Malaysia — never with a comma, which
  separates destinations.
  Every destination is priced on the SAME departure dates, so the fares are comparable across
  destinations. A season costs one search per destination per date, so narrow --to or widen --step.

  (or: node src/sweep.mjs … — ./sweep.sh just finds node for you)`);
  process.exit(args.help ? 0 : 2);
}

const money = (n) => (n == null ? "—" : n.toLocaleString("en-US"));
const pad = (s, n) => String(s).padEnd(n);

const destinations = resolveDestinations(args.to);
const { rows, warnings, meta } = await sweepDestinations({
  from: args.from,
  destinations,
  dates: args.dates,
  nights: args.nights ?? null,
  returnDate: args.returnDate ?? null,
  currency: args.currency ?? "THB",
  concurrency: args.concurrency ?? 3,
  tolerance: args.tolerance ?? 1.4,
});

const withData = rows.filter((r) => r.best);
const sorted = [...withData].sort((a, b) => a.best.price - b.best.price);

console.log(
  `\n  sweep: ${meta.route} -> ${meta.destinations} destinations · ${meta.nights} nights · ` +
    `${meta.currency} · departing ${meta.departures.join(", ")}`,
);
console.log(
  `  coverage: ${meta.destinationsWithData} of ${meta.destinations} destinations returned data` +
    `${meta.destinationsUnknown ? ` (${meta.destinationsUnknown} unknown)` : ""}`,
);
if (args.prefs.length) console.log(`  preferences: ${args.prefs.join(" | ")}`);

console.log(
  `\n  ${pad("dest", 5)} ${pad("city", 24)} ${pad("best date", 12)} ${pad("fare", 8)} ${pad("cheap", 8)} ` +
    `${pad("fastest", 8)} n  itinerary`,
);
console.log(`  ${"-".repeat(116)}`);
for (const r of sorted) {
  const f = r.best;
  console.log(
    `  ${pad(r.to, 5)} ${pad(`${r.city ?? ""}${r.country ? `, ${r.country}` : ""}`.slice(0, 23), 24)} ` +
      `${pad(r.best_date, 12)} ${pad(money(f.price), 8)} ${pad(money(r.cheapest?.price), 8)} ` +
      `${pad(r.fastest?.durationLabel ?? "—", 8)} ${pad(r.itineraries, 3)} ` +
      `${f.airlines.join("+")} · ${f.durationLabel} · ${f.stops === 0 ? "nonstop" : `${f.stops} stop`}` +
      `${f.layovers?.length ? ` (${f.layovers.map((l) => `${l.minutes}m ${l.airport}`).join(", ")})` : ""}`,
  );
}

const unknown = rows.filter((r) => r.unknown).map((r) => r.to);
if (unknown.length) {
  console.log(`\n  UNKNOWN (no result markup on any sampled date — not "unreachable"): ${unknown.join(", ")}`);
}
const failed = rows.filter((r) => r.all_failed).map((r) => r.to);
if (failed.length) console.log(`\n  not priced (request failed): ${failed.join(", ")}`);

for (const w of warnings) console.log(`\n  note: ${w}`);

let summary = null;
if (args.rank !== false && withData.length >= 2) {
  const { result } = await rankDestinations(rows, meta, { preferences: args.prefs, threshold: args.threshold ?? null });
  summary = summariseSweep(result, rows);
  console.log(
    `\nJev ${summary.model} · ${withData.length} destinations · ${summary.latencyMs} ms · ` +
      `state ${summary.stateTokens} tokens`,
  );
  if (summary.gate) {
    console.log(
      `  presence check (has_good_option): ${summary.gate.probability?.toFixed(2)}` +
        `${summary.gate.escalate ? "  [escalated — a hint, not a verdict]" : ""}`,
    );
  }
  const show = (label, e) => {
    if (!e) return;
    const f = e.row.best ?? e.row.cheapest;
    console.log(
      `\n  ${pad(label, 22)} -> ${e.code} ${e.row.city ?? ""}${e.probability != null ? `  (${(e.probability * 100).toFixed(0)}%)` : ""}` +
        `${e.escalate ? "  [escalated]" : ""}`,
    );
    if (f) {
      console.log(
        `      ${f.currency} ${money(f.price)} on ${e.row.best_date} | ${f.airlines.join(" + ")} | ` +
          `${f.departTime} -> ${f.arriveTime} | ${f.durationLabel} | ` +
          `${f.stops === 0 ? "nonstop" : `${f.stops} stop(s)`}`,
      );
    }
  };
  show("best destination", summary.pick);
  for (const r of summary.runnersUp) show("runner-up", r);
  show("best value", summary.best_value_destination);
  show("worst value", summary.worst_value_destination);
  if (summary.cheapest_destination_value) {
    const cv = summary.cheapest_destination_value;
    console.log(
      `\n  cheapest destination value (score): ${cv.score}${cv.legend ? ` — "${cv.legend}"` : ""}` +
        `${cv.escalate ? "  [escalated]" : ""}`,
    );
  }
  if (summary.escalated) console.log("\n  NOTE: at least one verdict escalated — read it as a prior, not a decision.");
} else if (withData.length < 2) {
  console.log(`\n  only ${withData.length} destination(s) returned data — nothing to rank.`);
}

if (args.out) {
  writeFileSync(args.out, JSON.stringify({ meta, rows, warnings, jev: summary }, null, 2));
  console.log(`\n  wrote ${args.out}`);
}

process.exitCode = summary?.escalated ? 3 : 0;
