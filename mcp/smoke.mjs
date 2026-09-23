#!/usr/bin/env node
/**
 * Drive mcp/server.mjs over stdio exactly as a host would, and print what comes back.
 * Not part of the deliverable — a smoke test for the tool surface.
 *
 *   node mcp/smoke.mjs list
 *   node mcp/smoke.mjs search CNX XIY 2026-12-10 4
 *   node mcp/smoke.mjs rank   CNX XIY 2026-12-10 4
 *   node mcp/smoke.mjs scan   CNX XIY 2026-12-01 2026-12-29 4 7 4
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, "server.mjs")],
  stderr: "inherit",
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const [cmd, ...rest] = process.argv.slice(2);
const call = async (name, args) => {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text ?? "").join("\n");
  console.log(`\n===== ${name} (${Date.now() - t0}ms) isError=${!!res.isError} =====`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
};

if (cmd === "list" || !cmd) {
  const { tools } = await client.listTools();
  for (const t of tools) {
    console.log(`\n## ${t.name}\n${t.description}\n`);
    console.log("  args:", Object.keys(t.inputSchema.properties ?? {}).join(", "));
    console.log("  required:", (t.inputSchema.required ?? []).join(", "));
  }
} else if (cmd === "search") {
  const [from, to, date, nights, currency] = rest;
  await call("search_flights", { from, to, date, nights: nights ? Number(nights) : undefined, currency });
} else if (cmd === "rank") {
  const [from, to, date, nights, currency] = rest;
  await call("rank_flights", { from, to, date, nights: nights ? Number(nights) : undefined, currency });
} else if (cmd === "scan") {
  const [from, to, fromDate, toDate, nights, step, max] = rest;
  await call("scan_dates", {
    from, to, from_date: fromDate, to_date: toDate,
    nights: nights ? Number(nights) : undefined,
    step_days: step ? Number(step) : undefined,
    max_dates: max ? Number(max) : undefined,
  });
} else {
  console.log("unknown command", cmd);
}

await client.close();
