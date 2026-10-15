import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addDays,
  nightsBetween,
  parseFlights,
  splitChunks,
  fieldDates,
  verdictRanker,
} from "../src/lib/flights.mjs";

const html = readFileSync(new URL("./fixtures/cards.html", import.meta.url), "utf8");

test("parseFlights reads price, times, layover and segments from a real card", () => {
  const [f] = parseFlights(splitChunks(html), "CNX", "CKG", "THB");
  assert.equal(f.price, 8395);
  assert.equal(f.currency, "THB");
  assert.deepEqual(f.airlines, ["China Southern"]);
  assert.equal(f.departTime, "3:20 PM");
  assert.equal(f.arriveTime, "12:15 AM");
  assert.equal(f.durationMin, 475);
  assert.equal(f.stops, 1);
  assert.equal(f.layovers[0].minutes, 195);
  assert.match(f.layovers[0].airport, /Guangzhou/);
  assert.deepEqual(
    f.segments.map((s) => `${s.carrier}${s.flight} ${s.from}-${s.to}`),
    ["CZ8328 CNX-CAN", "CZ2326 CAN-CKG"],
  );
});

test("parseFlights collapses the duplicated itinerary lists Google renders", () => {
  const flights = parseFlights(splitChunks(html), "CNX", "CKG", "THB");
  assert.equal(flights.length, 1);
  assert.equal(flights[0].id, "f01");
});

test("fieldDates reads the visible date inputs", () => {
  const d = fieldDates(html);
  assert.equal(d.departure, "Thu, Dec 10");
  assert.equal(d.return, "Sun, Dec 13");
});

test("date helpers", () => {
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.equal(nightsBetween("2026-12-10", "2026-12-13"), 3);
  assert.equal(nightsBetween(null, "2026-12-13"), null);
});

test("verdictRanker orders a choice distribution and tolerates other types", () => {
  const { byId, rank } = verdictRanker({
    verdicts: [
      { id: "a", type: "choice", distribution: { x: 0.2, y: 0.7, z: 0.1 } },
      { id: "b", type: "score", answer: 3 },
    ],
  });
  assert.deepEqual(rank("a").map(([k]) => k), ["y", "x", "z"]);
  assert.deepEqual(rank("b"), []);
  assert.deepEqual(rank("missing"), []);
  assert.equal(byId.b.answer, 3);
});
