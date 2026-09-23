#!/usr/bin/env node
/**
 * Price one route across many departure dates and print the table.
 *
 *   node src/scan.mjs --from CNX --to XIY --from-date 2026-11-01 --to-date 2027-02-28 \
 *                     --nights 4 [--step 7] [--max 12] [--currency THB] [--prefs "a; b"] [--no-rank]
 *
 * A trip length is required — see scanDates() in src/lib/scan.mjs for why.
 */

import { writeFileSync } from "node:fs";
import { scanDates, rankDates, summariseDates } from "./lib/scan.mjs";

function parseArgs(argv) {
  const out = { prefs: [], rank: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--from": out.from = next(); break;
      case "--to": out.to = next(); break;
      case "--from-date": out.fromDate = next(); break;
      case "--to-date": out.toDate = next(); break;
      case "--nights": out.nights = Number(next()); break;
      case "--return": out.returnDate = next(); break;
      case "--currency": out.currency = next(); break;
      case "--step": out.stepDays = Number(next()); break;
      case "--max": out.maxDates = Number(next()); break;
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

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.from || !args.to || !args.fromDate || !args.toDate) {
  console.log(`usage: ./scan.sh --from CNX --to XIY --from-date 2026-11-01 --to-date 2027-02-28 --nights 4
       [--step 7] [--max 12] [--currency THB] [--prefs "no overnight layovers; carry-on only"]
       [--concurrency 3] [--tolerance 1.4] [--threshold 0.5] [--no-rank] [--out FILE]

  (or: node src/scan.mjs … — ./scan.sh just finds node for you)`);
  process.exit(args.help ? 0 : 2);
}

const money = (n) => (n == null ? "—" : n.toLocaleString("en-US"));
const pad = (s, n) => String(s).padEnd(n);

const { rows, warnings, meta } = await scanDates({
  from: args.from,
  to: args.to,
  fromDate: args.fromDate,
  toDate: args.toDate,
  nights: args.nights ?? null,
  returnDate: args.returnDate ?? null,
  currency: args.currency ?? "THB",
  stepDays: args.stepDays ?? 7,
  maxDates: args.maxDates ?? 12,
  concurrency: args.concurrency ?? 3,
  tolerance: args.tolerance ?? 1.4,
});

const withData = rows.filter((r) => r.count);
const sorted = [...withData].sort((a, b) => (a.sweet_spot?.price ?? Infinity) - (b.sweet_spot?.price ?? Infinity));

console.log(`\n  scan: ${meta.route} · ${meta.nights} nights · ${meta.currency} · every ${meta.stepDays} days`);
console.log(
  `  coverage: ${meta.datesWithData} of ${meta.datesPriced} dates returned data` +
    `${meta.datesUnknown ? ` (${meta.datesUnknown} unknown)` : ""}` +
    `${meta.datesRequested > meta.datesPriced ? ` · ${meta.datesRequested - meta.datesPriced} not priced` : ""}`,
);
if (args.prefs.length) console.log(`  preferences: ${args.prefs.join(" | ")}`);

console.log(`\n  ${pad("depart", 12)} ${pad("return", 12)} ${pad("sweet", 9)} ${pad("cheapest", 9)} ${pad("fastest", 9)} n  itinerary`);
console.log(`  ${"-".repeat(94)}`);
for (const r of sorted) {
  const s = r.sweet_spot;
  console.log(
    `  ${pad(r.date, 12)} ${pad(r.returnDate, 12)} ${pad(money(s?.price), 9)} ${pad(money(r.cheapest?.price), 9)} ` +
      `${pad(r.fastest?.durationLabel ?? "—", 9)} ${pad(r.count, 2)} ${s ? `${s.airlines.join("+")} · ${s.durationLabel} · ${s.stops === 0 ? "nonstop" : `${s.stops} stop`}` : "—"}`,
  );
}

const unknownDates = rows.filter((r) => r.unknown).map((r) => r.date);
if (unknownDates.length) {
  console.log(`\n  UNKNOWN (Google returned no result markup — not "no flights"): ${unknownDates.join(", ")}`);
}

for (const w of warnings) console.log(`\n  note: ${w}`);

let summary = null;
if (args.rank !== false && withData.length >= 2) {
  const { result } = await rankDates(rows, meta, { preferences: args.prefs, threshold: args.threshold ?? null });
  summary = summariseDates(result, rows);
  console.log(`\nJev ${summary.model} · ${withData.length} dates · ${summary.latencyMs} ms · state ${summary.stateTokens} tokens`);
  if (summary.gate) {
    console.log(
      `  presence check (has_good_option): ${summary.gate.probability?.toFixed(2)}` +
        `${summary.gate.escalate ? "  [escalated — a hint, not a verdict]" : ""}`,
    );
  }
  const show = (label, e) => {
    if (!e) return;
    console.log(
      `\n  ${pad(label, 18)} -> ${e.date}${e.probability != null ? `  (${(e.probability * 100).toFixed(0)}%)` : ""}` +
        `${e.escalate ? "  [escalated]" : ""}`,
    );
    if (e.itinerary) {
      console.log(
        `      ${e.itinerary.currency} ${money(e.itinerary.price)} | ${e.itinerary.airlines.join(" + ")} | ` +
          `${e.itinerary.departTime} -> ${e.itinerary.arriveTime} | ${e.itinerary.durationLabel} | ` +
          `${e.itinerary.stops === 0 ? "nonstop" : `${e.itinerary.stops} stop(s)`}`,
      );
    }
  };
  show("best date", summary.pick);
  for (const r of summary.runnersUp) show("runner-up", r);
  show("best price date", summary.best_price_date);
  show("worst value date", summary.worst_value_date);
  if (summary.cheapest_date_value) {
    const cv = summary.cheapest_date_value;
    console.log(
      `\n  cheapest date value (score): ${cv.score}${cv.legend ? ` — "${cv.legend}"` : ""}` +
        `${cv.escalate ? "  [escalated]" : ""}`,
    );
  }
  if (summary.escalated) console.log("\n  NOTE: at least one verdict escalated — read it as a prior, not a decision.");
} else if (withData.length < 2) {
  console.log(`\n  only ${withData.length} date(s) returned data — nothing to rank.`);
}

if (args.out) {
  writeFileSync(args.out, JSON.stringify({ meta, rows, warnings, jev: summary }, null, 2));
  console.log(`\n  wrote ${args.out}`);
}

process.exitCode = summary?.escalated ? 3 : 0;
