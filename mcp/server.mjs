#!/usr/bin/env node
/**
 * flight-finder MCP server.
 *
 * Three tools, in increasing order of "how much of this should never reach your context":
 *
 *   search_flights  one date, every itinerary parsed — the raw data, for when you need it
 *   rank_flights    one date, judged by Jev — returns the winner, not the shortlist
 *   scan_dates      many dates, priced in one pass — answers "when is it cheap?"
 *
 * The point of rank_flights and scan_dates is that the candidate list is handed to the Jev CLI
 * as a file, so the itineraries never travel through the model's context. That is the whole
 * saving; if you call search_flights and then paste the list back, you have thrown it away.
 *
 * Talks the protocol on stdout, logs on stderr. Nothing else may write to stdout.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { searchFlights, rankFlights, summarise, describe, tripLabel } from "../src/lib/flights.mjs";
import { scanDates, rankDates, summariseDates, brief } from "../src/lib/scan.mjs";

const NAME = "flight-finder";
const VERSION = "0.1.0";

const log = (...a) => process.stderr.write(`[${NAME}] ${a.join(" ")}\n`);

/* ------------------------------------------------------------------ shared schema bits */

const P = {
  from: { type: "string", description: "Origin airport IATA code, e.g. CNX." },
  to: { type: "string", description: "Destination airport IATA code, e.g. XIY." },
  date: { type: "string", description: "Departure date, YYYY-MM-DD." },
  nights: {
    type: "integer",
    minimum: 0,
    maximum: 400,
    description:
      "Trip length in nights. STRONGLY RECOMMENDED. If neither nights nor return_date is given, " +
      "Google invents a trip length and every price describes a trip nobody chose.",
  },
  return_date: {
    type: "string",
    description: "Return date YYYY-MM-DD. Alternative to nights; give one or the other.",
  },
  currency: {
    type: "string",
    description: "Currency for quoted prices, e.g. THB, USD, CNY. Defaults to THB.",
  },
  preferences: {
    type: "array",
    items: { type: "string" },
    description:
      "The traveller's own constraints, in plain language, one per entry — e.g. " +
      '["no overnight connections", "avoid Chinese carriers", "must arrive before 6pm", ' +
      '"carry-on only"]. These are passed to Jev and change the answer. Omit if none were stated; ' +
      "do not invent preferences on the traveller's behalf.",
  },
  threshold: {
    type: "number",
    minimum: 0,
    maximum: 1,
    description:
      "Jev confidence threshold, 0-1. Below it, a verdict is returned as a prior with " +
      "escalate=true rather than as a decision. Default 0.5.",
  },
};

const required = (...k) => k;

const TOOLS = [
  {
    name: "search_flights",
    description:
      "Scrape every itinerary Google Flights shows for one route on one date, without a browser. " +
      "Returns the raw parsed list (price, airlines, times, duration, stops, layovers, CO2e, " +
      "flight numbers). Use when the caller genuinely needs the full list; for a decision use " +
      "rank_flights instead, which keeps this list out of your context. Always pass nights or " +
      "return_date.",
    inputSchema: {
      type: "object",
      properties: {
        from: P.from,
        to: P.to,
        date: P.date,
        nights: P.nights,
        return_date: P.return_date,
        currency: P.currency,
      },
      required: required("from", "to", "date"),
      additionalProperties: false,
    },
  },
  {
    name: "rank_flights",
    description:
      "Scrape one route/date and have Jev pick the best itinerary, returning the winner and the " +
      "close alternatives rather than the whole list. Answers 'which flight should I book?'. " +
      "Includes a presence check (does a good option exist at all?) because a ranked choice always " +
      "puts something first. Escalated verdicts are priors, not decisions. Always pass nights or " +
      "return_date, and pass the traveller's preferences if they stated any.",
    inputSchema: {
      type: "object",
      properties: {
        from: P.from,
        to: P.to,
        date: P.date,
        nights: P.nights,
        return_date: P.return_date,
        currency: P.currency,
        preferences: P.preferences,
        threshold: P.threshold,
        include_all: {
          type: "boolean",
          description:
            "Also return the full parsed itinerary list. Off by default, because the list is what " +
            "Jev exists to keep out of your context.",
        },
      },
      required: required("from", "to", "date"),
      additionalProperties: false,
    },
  },
  {
    name: "scan_dates",
    description:
      "Price one route across a range of departure dates in a single pass and report which dates " +
      "are cheap — the tool for 'find me a good price this winter'. Returns one row per date " +
      "(cheapest, fastest, and a 'sweet spot': the cheapest itinerary that is not an unreasonably " +
      "long journey), then optionally has Jev judge which DATE is the best booking. " +
      "A trip length is REQUIRED here: without it Google returns a different trip length per date " +
      "and the prices are not comparable. Some dates may come back UNKNOWN — see the warnings.",
    inputSchema: {
      type: "object",
      properties: {
        from: P.from,
        to: P.to,
        from_date: { type: "string", description: "First departure date to price, YYYY-MM-DD." },
        to_date: { type: "string", description: "Last departure date to price, YYYY-MM-DD." },
        nights: P.nights,
        return_date: P.return_date,
        currency: P.currency,
        step_days: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          description: "Days between sampled departure dates. Default 7 (one per week).",
        },
        max_dates: {
          type: "integer",
          minimum: 2,
          maximum: 40,
          description: "Cap on how many dates to price. Default 12.",
        },
        concurrency: {
          type: "integer",
          minimum: 1,
          maximum: 6,
          description: "Parallel requests to Google. Default 3; higher is faster and ruder.",
        },
        tolerance: {
          type: "number",
          minimum: 1,
          maximum: 3,
          description:
            "How much longer than the shortest journey an itinerary may be and still count as the " +
            "'sweet spot'. Default 1.4 (40% longer). Raise it to tolerate longer journeys.",
        },
        rank: {
          type: "boolean",
          description:
            "Also have Jev judge which departure date is the best booking. Default true. Set false " +
            "for a pure price table.",
        },
        preferences: P.preferences,
        threshold: P.threshold,
      },
      required: required("from", "to", "from_date", "to_date"),
      additionalProperties: false,
    },
  },
];

/* ------------------------------------------------------------------ tool implementations */

/** One date, every itinerary. */
async function toolSearch(args) {
  const { payload, warnings } = await searchFlights({
    from: args.from,
    to: args.to,
    date: args.date,
    nights: args.nights ?? null,
    returnDate: args.return_date ?? null,
    currency: args.currency ?? "THB",
  });
  return {
    route: payload.route,
    date: payload.date,
    return_date: payload.returnDate,
    trip: tripLabel(payload),
    currency: payload.currency,
    count: payload.count,
    searched_dates: payload.searchedDates,
    warnings,
    itineraries: payload.flights.map((f) => ({
      ...brief(f),
      summary: describe(f),
    })),
  };
}

/** One date, judged. */
async function toolRank(args) {
  const prefs = args.preferences ?? [];
  const { payload, warnings } = await searchFlights({
    from: args.from,
    to: args.to,
    date: args.date,
    nights: args.nights ?? null,
    returnDate: args.return_date ?? null,
    currency: args.currency ?? "THB",
  });
  if (!payload.count) {
    return {
      route: payload.route,
      date: payload.date,
      trip: tripLabel(payload),
      count: 0,
      warnings,
      note: "Nothing was parsed, so there was nothing to judge. Read the warnings before concluding the route is unserved.",
    };
  }

  const { result, stderr } = await rankFlights(payload, {
    preferences: prefs,
    threshold: args.threshold ?? null,
  });
  const s = summarise(result, payload.flights);

  const flight = (o) => (o ? { ...brief(o.flight), summary: describe(o.flight), probability: o.probability, escalate: o.escalate } : null);

  const out = {
    route: payload.route,
    date: payload.date,
    return_date: payload.returnDate,
    trip: tripLabel(payload),
    currency: payload.currency,
    itineraries_found: payload.count,
    preferences: prefs.length ? prefs : "none stated",
    warnings,
    jev: { model: s.model, latency_ms: s.latencyMs, state_tokens: s.stateTokens, escalated: s.escalated },
    gate: s.gate,
    pick: flight(s.pick),
    runners_up: s.runnersUp.map((r) => ({
      id: r.id,
      probability: r.probability,
      summary: describe(r.flight),
    })),
    best_budget: flight(s.best_budget),
    best_schedule: flight(s.best_schedule),
    worst_value: flight(s.worst_value),
    cheapest_value: s.cheapest_value,
    reading: s.escalated
      ? "At least one verdict escalated: treat the affected picks as priors, not decisions. The gate says whether a good option exists at all — read it before the ranking."
      : "No verdict escalated.",
  };
  if (args.include_all) out.all_itineraries = payload.flights.map((f) => ({ ...brief(f), summary: describe(f) }));
  if (stderr && /error|warn/i.test(stderr)) out.jev_stderr = stderr.slice(0, 2000);
  return out;
}

/** The few fields worth repeating when a flight is only a reference point in a row. */
const tiny = (f) =>
  f && { id: f.id, price: f.price, airlines: f.airlines, durationLabel: f.durationLabel, stops: f.stops };

/** Many dates, priced. */
async function toolScan(args) {
  const prefs = args.preferences ?? [];
  const { rows, warnings, meta } = await scanDates({
    from: args.from,
    to: args.to,
    fromDate: args.from_date,
    toDate: args.to_date,
    nights: args.nights ?? null,
    returnDate: args.return_date ?? null,
    currency: args.currency ?? "THB",
    stepDays: args.step_days ?? 7,
    maxDates: args.max_dates ?? 12,
    concurrency: args.concurrency ?? 3,
    tolerance: args.tolerance ?? 1.4,
  });

  const withData = rows.filter((r) => r.count);
  const sorted = [...withData].sort((a, b) => (a.sweet_spot?.price ?? Infinity) - (b.sweet_spot?.price ?? Infinity));

  const out = {
    route: meta.route,
    trip_length: `${meta.nights} nights`,
    currency: meta.currency,
    step_days: meta.stepDays,
    coverage: {
      dates_requested: meta.datesRequested,
      dates_priced: meta.datesPriced,
      dates_with_data: meta.datesWithData,
      dates_unknown: meta.datesUnknown,
    },
    warnings,
    rows: sorted.map((r) => ({
      date: r.date,
      return_date: r.returnDate,
      itineraries: r.count,
      unknown: r.unknown || undefined,
      // The sweet spot carries full detail because it is the one being recommended; the other
      // two are reference points, so they stay small or the row triples in size for no gain.
      sweet_spot: r.sweet_spot,
      cheapest: tiny(r.cheapest),
      fastest: tiny(r.fastest),
      sweet_spot_costs_extra: r.sweet_spot_extra,
      sweet_spot_minutes_saved: r.sweet_spot_minutes_saved,
      median_price: r.median_price,
    })),
    cheapest_by_sweet_spot: sorted[0] ? { date: sorted[0].date, price: sorted[0].sweet_spot?.price ?? null } : null,
  };

  const unknownDates = rows.filter((r) => r.unknown).map((r) => r.date);
  if (unknownDates.length) {
    out.unknown_dates = unknownDates;
    out.unknown_note =
      "These dates returned no itinerary markup at all, so they are UNKNOWN rather than " +
      "unavailable or expensive. Google's no-JavaScript view is partial. Do not present them as " +
      "sold out or as having no flights.";
  }

  if (args.rank !== false && withData.length >= 2) {
    const { result } = await rankDates(rows, meta, { preferences: prefs, threshold: args.threshold ?? null });
    const ds = summariseDates(result, rows);
    out.jev = { model: ds.model, latency_ms: ds.latencyMs, state_tokens: ds.stateTokens, escalated: ds.escalated };
    out.gate = ds.gate;
    out.pick_date = ds.pick && { date: ds.pick.date, probability: ds.pick.probability, escalate: ds.pick.escalate, itinerary: ds.pick.itinerary };
    out.runners_up_dates = ds.runnersUp.map((r) => ({ date: r.date, probability: r.probability, itinerary: r.itinerary }));
    out.best_price_date = ds.best_price_date && { date: ds.best_price_date.date, probability: ds.best_price_date.probability, itinerary: ds.best_price_date.itinerary };
    out.worst_value_date = ds.worst_value_date && { date: ds.worst_value_date.date, itinerary: ds.worst_value_date.itinerary };
    out.cheapest_date_value = ds.cheapest_date_value;
  } else if (withData.length < 2) {
    out.rank_skipped = `only ${withData.length} date(s) returned data, so there was nothing to compare`;
  }

  out.reading =
    "Rows are sorted by the sweet-spot price (the cheapest itinerary that is not an unreasonably " +
    "long journey), not by the bare cheapest fare. Fares move daily: treat a few percent as noise. " +
    "The gate, when present, says whether any date is genuinely good value — read it before the pick.";
  return out;
}

const HANDLERS = {
  search_flights: toolSearch,
  rank_flights: toolRank,
  scan_dates: toolScan,
};

/* ------------------------------------------------------------------ server wiring */

const server = new Server(
  { name: NAME, version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  const started = Date.now();
  try {
    const out = await handler(args ?? {});
    log(`${name} ok in ${Date.now() - started}ms`);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    log(`${name} FAILED in ${Date.now() - started}ms: ${e.message}`);
    return {
      content: [
        {
          type: "text",
          text:
            `${name} failed: ${e.message}\n\n` +
            "If this mentions the jev CLI, check that use-jev is installed (`use-jev --version`) " +
            "or that ~/.agents/mcp/use-jev/cli.mjs exists.",
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready — ${TOOLS.length} tools: ${TOOLS.map((t) => t.name).join(", ")}`);
