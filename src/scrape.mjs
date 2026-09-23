#!/usr/bin/env node
/**
 * Scrape Google Flights for one route + trip length and emit candidate itineraries as JSON.
 *
 *   node src/scrape.mjs --from CNX --to NRT --date 2026-10-15 --days 5 [--currency THB] [--out f.json]
 *
 * --from / --to are any IATA codes; CNX and NRT are just the defaults in the examples.
 * Nothing here is route-specific. All the work lives in src/lib/flights.mjs so the MCP
 * server shares one implementation with this CLI.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { searchFlights, tripLabel } from "./lib/flights.mjs";

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const key = k.slice(2);
    a[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return a;
}

const args = parseArgs(process.argv);
const DATE = args.date || new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10);

let out;
try {
  out = await searchFlights({
    from: args.from || "CNX",
    to: args.to || "NRT",
    date: DATE,
    nights: args.days ?? null,
    returnDate: args.return || null,
    currency: args.currency || "THB",
  });
} catch (err) {
  console.error(`scrape: ${err.message}`);
  process.exit(2);
}

const { payload, warnings } = out;
for (const w of warnings) console.error(`scrape: WARNING — ${w}`);

const json = JSON.stringify(payload, null, 2);
if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, json);
  console.error(`scrape: ${payload.count} itineraries, ${tripLabel(payload)} -> ${args.out}`);
} else {
  process.stdout.write(json + "\n");
}
