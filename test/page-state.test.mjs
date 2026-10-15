// Offline: no network, and Jev is switched off, so this passes on a machine without it.
// The fixtures keep only what the classifier reads from real pages captured 2026-09-29.
process.env.FLIGHT_FINDER_NO_JEV = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyByMarkers, diagnoseEmptyPage, emptyState, blockGuard } from "../src/lib/page-state.mjs";

const page = (title, body) =>
  `<html><head><title>${title}</title><script>var x="g-recaptcha";</script></head><body>${body}</body></html>`;

// CNX-LYR: route resolved, result list left to JavaScript.
const DEFERRED = page(
  "Chiang Mai to Longyearbyen | Google Flights",
  "<div>Loading results</div><span>CNX · Chiang Mai</span><span>LYR · Longyearbyen</span>",
);
// CNX-QQZ: unknown code, Google falls back to its landing page.
const UNRESOLVED = page(
  "Find Cheap Flights Worldwide &amp; Book Your Ticket - Google Flights",
  "<span>Chiang Mai</span><input placeholder='Where to?'>",
);

test("a resolved search with no result list is deferred, and retryable", () => {
  assert.equal(classifyByMarkers({ html: DEFERRED, from: "CNX", to: "LYR" }).cause, "deferred");
});

test("an unknown airport code is not_understood, not UNKNOWN", () => {
  assert.equal(classifyByMarkers({ html: UNRESOLVED, from: "CNX", to: "QQZ" }).cause, "not_understood");
});

test("recaptcha inside a script does not count as a block", () => {
  assert.notEqual(classifyByMarkers({ html: DEFERRED, from: "CNX", to: "LYR" }).cause, "blocked");
});

test("blocks and consent walls are recognised from status, URL or visible text", () => {
  const c = (p) => classifyByMarkers({ html: "", from: "CNX", to: "NRT", ...p }).cause;
  assert.equal(c({ status: 429 }), "blocked");
  assert.equal(c({ finalUrl: "https://www.google.com/sorry/index?continue=x" }), "blocked");
  assert.equal(c({ html: page("x", "Our systems have detected unusual traffic") }), "blocked");
  assert.equal(c({ finalUrl: "https://consent.google.com/ml?continue=x" }), "consent");
});

test("an unfamiliar page stays unrecognised when Jev is unavailable", async () => {
  const html = page("Chiang Mai to Tokyo | Google Flights", "Something went wrong.");
  const d = await diagnoseEmptyPage({ html, status: 200, finalUrl: "", from: "CNX", to: "NRT" });
  assert.equal(d.cause, "unrecognised");
  assert.equal(d.source, "markers (jev unavailable)");
  assert.equal(d.retryable, true);
});

test("only retryable causes count as UNKNOWN", () => {
  const row = (cause) => emptyState({ count: 0, pageHadResultMarkup: false, emptyPage: { cause } });
  assert.equal(row("deferred").unknown, true);
  assert.equal(row("not_understood").unknown, false);
  assert.equal(row("blocked").unknown, false);
});

test("a block stops every later fetch in the run", () => {
  const guard = blockGuard();
  guard.check();
  guard.note({ emptyPage: { cause: "blocked", evidence: "HTTP 429" } });
  assert.throws(() => guard.check(), /skipped — Google started blocking/);
});
