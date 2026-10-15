// Drives the Worker with the official MCP SDK client over Streamable HTTP, against an in-memory Durable Object.
import { RULES } from "../src/method.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker, { resetCache } from "../src/index.js";
import { FakeKV, KEY, adsbRoutes, fakeNet, jsonResponse, makeEnv, zoneBody, zoneOfUrl } from "./fakes.js";

async function connect(env, headers = { Authorization: `Bearer ${KEY}` }) {
  const transport = new StreamableHTTPClientTransport(new URL("https://jc.example/mcp"), {
    fetch: (url, init) => worker.fetch(new Request(url, init), env),
    requestInit: { headers },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return { client, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}
const code = (res) => res.structuredContent?.error?.code;
const realNow = Date.now;
after(() => {
  Date.now = realNow;
});

/** An env that has run `n` ticks with Baltic at 30% bad and an onset in the Levant. */
async function seeded(n = 6, vars = {}) {
  resetCache();
  const h = makeEnv(vars);
  let tick = 0;
  const routes = adsbRoutes();
  routes["api.adsb.lol"] = (u) => {
    const id = zoneOfUrl(u);
    const bad = id === "baltic" ? 12 : id === "levant" && tick >= 3 ? 12 : 0;
    return jsonResponse(zoneBody(id, 40, bad));
  };
  const net = fakeNet(routes, h.storage);
  await h.ticks(n, (i) => (tick = i));
  net.restore();
  Date.now = () => h.now; // the Worker reads the wall clock for the stale-sample warning; keep it on the test clock
  return h;
}

test("lists the five tools, read-only", async () => {
  const { client } = await connect(makeEnv().env);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["jamming_now", "recent_events", "court_record", "explain", "list_zones"]);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint));
});

test("before the first tick every data tool says NOT_READY; list_zones still works", async () => {
  resetCache();
  const { call } = await connect(makeEnv().env);
  for (const [name, args] of [["jamming_now", {}], ["recent_events", {}], ["court_record", { zone: "baltic" }], ["explain", { zone: "baltic" }]]) {
    const res = await call(name, args);
    assert.equal(code(res), "NOT_READY", name);
    assert.equal(res.isError, true);
  }
  const zones = await call("list_zones");
  assert.equal(zones.structuredContent.zones.length, 20);
});

test("jamming_now summarises non-clear zones, and answers one zone in detail", async () => {
  const h = await seeded();
  const { call } = await connect(h.env);
  const all = await call("jamming_now");
  assert.equal(
    all.content[0].text,
    "Jammed now: Baltic (Gotland to Kaliningrad) 30% of 40; Eastern Mediterranean and Levant 30% of 40. 10 other sentinels clear. Controls clean. As of 00:50 UTC. Next check: since=2026-10-15T00:50:00Z.",
  );
  assert.deepEqual(all.structuredContent.jammed.map((z) => z.zone), ["baltic", "levant"]);
  assert.equal(all.structuredContent.clear_count, 10);
  const one = await call("jamming_now", { zone: "levant" });
  assert.equal(one.structuredContent.state, "JAMMED");
  assert.equal(one.structuredContent.since, "2026-10-15T00:30:00Z");
  assert.equal(one.structuredContent.pct, 30);
  assert.equal(one.structuredContent.usual_pct, null);
  assert.equal(one.structuredContent.usual_reason, "warming up (1 of 7 days)");
  assert.equal(one.structuredContent.source, "lol");
});

test("recent_events, court_record and explain", async () => {
  const h = await seeded();
  const { call } = await connect(h.env);
  const ev = await call("recent_events", { hours: 24 });
  assert.deepEqual(ev.structuredContent.events.map((e) => [e.zone, e.onset]), [
    ["levant", "2026-10-15T00:30:00Z"],
    ["baltic", null],
  ]);
  assert.equal(Object.hasOwn(ev.structuredContent.events[0], "push_on"), false);
  assert.match(ev.content[0].text, /^2 events in the last 24 h\. /);
  assert.equal((await call("recent_events", { zone: "ctl_london" })).structuredContent.events.length, 0);
  const rec = await call("court_record", { zone: "baltic" });
  assert.deepEqual(rec.structuredContent.summary, { days: 0, red_days: 0, comparable_days: 0, agreements: 0, mean_abs_diff_pp: null });
  const ex = await call("explain", { zone: "levant" });
  assert.equal(ex.structuredContent.recent.length, 6);
  assert.equal(ex.structuredContent.thresholds.bad, "NIC under 7");
  // The rule text comes from config.js through method.js, the same words the page uses.
  for (const k of Object.keys(RULES)) assert.equal(ex.structuredContent.thresholds[k], RULES[k]);
  assert.match(ex.content[0].text, /consistent with interference/);
});

test("input errors: unknown zone, bad numbers, unknown keys, missing zone", async () => {
  const h = await seeded(2);
  const { call } = await connect(h.env);
  assert.equal(code(await call("jamming_now", { zone: "atlantis" })), "UNKNOWN_ZONE");
  assert.equal(code(await call("recent_events", { hours: 0 })), "INVALID_INPUT");
  assert.equal(code(await call("recent_events", { hours: 721 })), "INVALID_INPUT");
  assert.equal(code(await call("court_record", { zone: "baltic", days: 2.5 })), "INVALID_INPUT");
  assert.equal(code(await call("jamming_now", { zone: "baltic", extra: 1 })), "INVALID_INPUT");
  assert.equal(code(await call("explain", {})), "INVALID_INPUT");
});

test("auth, size cap, batches and methods", async () => {
  const env = makeEnv().env;
  const post = (headers, body) => worker.fetch(new Request("https://jc.example/mcp", { method: "POST", headers, body }), env);
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal((await post({}, init)).status, 401);
  assert.equal((await post({ Authorization: "Bearer wrong-key-wrong-key-x" }, init)).status, 401);
  assert.equal((await post({ "X-API-Key": KEY }, init)).status, 200);
  assert.equal((await post({ Authorization: `Bearer ${KEY}` }, "x".repeat(16 * 1024 + 1))).status, 413);
  assert.equal((await post({ Authorization: `Bearer ${KEY}` }, JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]))).status, 400);
  const get = await worker.fetch(new Request("https://jc.example/mcp", { headers: { Authorization: `Bearer ${KEY}` } }), env);
  assert.equal(get.status, 405);
  const noKey = makeEnv({ API_KEY: "short" }).env;
  assert.equal((await worker.fetch(new Request("https://jc.example/mcp", { method: "POST", body: init }), noKey)).status, 503);
  await assert.rejects(connect(env, { Authorization: "Bearer nope" }));
});

test("public page and JSON routes, and PUBLIC_PAGE=false hides them", async () => {
  const h = await seeded();
  const get = (path, env = h.env, headers = {}) => worker.fetch(new Request(`https://jc.example${path}`, { headers }), env);
  const page = await get("/");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Jammer Court<\/title>/);
  assert.match(html, /Unprotected mode/);
  assert.match(html, /Controls \(should be quiet\)/);
  assert.match(html, /adsb\.lol<\/a> \(ODbL\)/);
  for (const k of ["eligible", "bad", "degraded", "clear", "offset"]) assert.ok(html.includes(RULES[k]), `page lacks rule ${k}`);
  const status = await (await get("/api/status.json")).json();
  assert.equal(status.zones.length, 20);
  const log = await (await get("/api/log.json")).json();
  assert.equal(log.events.length, 2);
  const rec = await (await get("/api/record.json")).json();
  assert.deepEqual(rec.criteria.map((c) => c.id), ["S1", "S2", "S3", "S4", "S5", "S7"]);
  assert.equal(JSON.stringify([status, log, rec]).includes("baltic-1"), false);
  const health = await (await get("/health")).json();
  assert.deepEqual(health, { ok: true, configured: true, last_slot: "2026-10-15T00:50:00Z" });
  assert.equal((await get("/nope")).status, 404);

  resetCache();
  const hidden = await seeded(1, { PUBLIC_PAGE: "false" });
  assert.equal((await get("/", hidden.env)).status, 401);
  assert.equal((await get("/api/status.json", hidden.env)).status, 401);
  assert.equal((await get("/", hidden.env, { Authorization: `Bearer ${KEY}` })).status, 200);
});

test("with KV bound, reads never reach the Durable Object", async () => {
  resetCache();
  const kv = new FakeKV();
  const h = await seeded(2, { SNAPSHOT: kv });
  let hits = 0;
  const real = h.env.COURT.get;
  h.env.COURT.get = (...a) => {
    hits++;
    return real(...a);
  };
  const { call } = await connect(h.env);
  await call("jamming_now");
  await worker.fetch(new Request("https://jc.example/api/status.json"), h.env);
  await worker.fetch(new Request("https://jc.example/"), h.env);
  assert.equal(hits, 0);
  const html = await (await worker.fetch(new Request("https://jc.example/"), h.env)).text();
  assert.equal(html.includes("Unprotected mode"), false);
});

test("the page before the first tick says so", async () => {
  resetCache();
  const h = makeEnv();
  const html = await (await worker.fetch(new Request("https://jc.example/"), h.env)).text();
  assert.match(html, /No sample yet/);
  assert.equal((await worker.fetch(new Request("https://jc.example/api/status.json"), h.env)).status, 503);
});

test("recent_events since over JSON-RPC: the cursor round-trips and nothing repeats", async () => {
  const h = await seeded();
  const { call } = await connect(h.env);
  const first = await call("recent_events", { since: "2026-10-15T00:00:00Z" });
  assert.deepEqual(first.structuredContent.events.map((e) => e.zone), ["baltic", "levant"]);
  const cursor = first.structuredContent.next_since;
  assert.equal(cursor, "2026-10-15T00:50:00Z");
  assert.ok(first.content[0].text.endsWith(`Next check: since=${cursor}.`));
  const again = await call("recent_events", { since: cursor });
  assert.deepEqual(again.structuredContent.events, []);
  assert.equal(again.structuredContent.next_since, cursor);
});
