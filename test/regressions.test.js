// Regression tests for the code review. Each failed before its fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePoint } from "../src/sources.js";
import { parseAlerts } from "../src/sun.js";
import { answerTool } from "../src/tools.js";
import { adsbRoutes, fakeNet, jsonResponse, makeEnv, zoneBody, zoneOfUrl } from "./fakes.js";

async function run(h, routes, count, before = () => {}) {
  const net = fakeNet(routes, h.storage);
  try {
    await h.ticks(count, before);
  } finally {
    net.restore();
  }
  return net;
}
const snapOf = (h) => JSON.parse(h.rows("SELECT v FROM meta WHERE k = 'snapshot'")[0].v);

test("jamming_now: a jammed zone whose last fetch failed is listed once, as jammed", async () => {
  const h = makeEnv();
  let fail = false;
  const routes = adsbRoutes({ baltic: 0.3 });
  const ok = routes["api.adsb.lol"];
  routes["api.adsb.lol"] = (u, i, n) => (fail && zoneOfUrl(u) === "baltic" ? 500 : ok(u, i, n));
  routes["opendata.adsb.fi"] = (u) => (zoneOfUrl(u) === "baltic" ? 500 : jsonResponse(zoneBody(zoneOfUrl(u), 40, 0, { key: "aircraft" })));
  await run(h, routes, 4, (i) => (fail = i === 3));
  const snap = snapOf(h);
  const res = answerTool("jamming_now", {}, snap, Date.parse(snap.last_slot));
  const s = res.structuredContent;
  assert.deepEqual(s.jammed.map((z) => z.zone), ["baltic"]);
  assert.deepEqual(s.no_data, []);
  assert.equal(s.clear_count, 11);
  assert.equal(res.content[0].text.includes("no data jets"), false);
});

test("an open event the zone state has lost doesn't wedge the tick", async () => {
  const h = makeEnv();
  const routes = adsbRoutes({ baltic: 0.3 });
  await run(h, routes, 2);
  const state = JSON.parse(h.rows("SELECT v FROM meta WHERE k = 'state'")[0].v);
  delete state.zones.baltic; // as after a zone is removed and re-added
  h.court.store.setMeta("state", JSON.stringify(state));
  await run(h, routes, 4);
  assert.equal(h.rows("SELECT COUNT(*) AS n FROM ticks WHERE notes LIKE '%error%'")[0].n, 0);
  assert.equal(h.rows("SELECT COUNT(*) AS n FROM events WHERE zone = 'baltic' AND offset_ts IS NULL")[0].n, 1);
  assert.equal(h.rows("SELECT COUNT(*) AS n FROM samples")[0].n, 120);
});

test("prototype keys can't slip past MCP validation", async () => {
  const h = makeEnv();
  await run(h, adsbRoutes(), 1);
  const snap = snapOf(h);
  for (const name of ["court_record", "explain"]) {
    const res = answerTool(name, JSON.parse('{"__proto__":{"zone":"nope"}}'), snap);
    assert.equal(res.structuredContent.error.code, "INVALID_INPUT", name);
  }
  assert.equal(answerTool("list_zones", { constructor: 1 }, null).structuredContent.error.code, "INVALID_INPUT");
});

test("a SWPC 200 that isn't an alert list is a failed poll, not a quiet Sun", () => {
  assert.equal(parseAlerts({ error: "maintenance" }), null);
  assert.deepEqual(parseAlerts([]), []);
});

test("recent_events always includes events that are still open, however old", async () => {
  const h = makeEnv();
  await run(h, adsbRoutes({ baltic: 0.3 }), 3);
  const snap = snapOf(h);
  const later = Date.parse(snap.last_slot) + 5 * 86400_000;
  const res = answerTool("recent_events", { hours: 1 }, { ...snap, as_of: new Date(later).toISOString() }, later);
  assert.deepEqual(res.structuredContent.events.map((e) => e.zone), ["baltic"]);
});

test("tools warn when the last sample is more than 30 minutes old", async () => {
  const h = makeEnv();
  await run(h, adsbRoutes(), 1);
  const snap = snapOf(h);
  const res = answerTool("jamming_now", {}, snap, Date.parse(snap.last_slot) + 40 * 60_000);
  assert.match(res.content[0].text, /^Warning: no sample since 2026-10-15 00:00 UTC\./);
  assert.equal(res.structuredContent.stale_snapshot, true);
});

test("parsePoint: ground, missing positions and odd bodies", () => {
  assert.equal(parsePoint({ ac: null }), null);
  assert.equal(parsePoint("nope"), null);
  const got = parsePoint({
    aircraft: [
      { hex: "a", lat: 1, lon: 2, alt_baro: "ground", nic: 0, version: 2, seen_pos: 1, t: "B738" },
      { hex: "b", lastPosition: { lat: 1, lon: 2 }, nic: 0 },
      { lat: 1, lon: 2 },
      { hex: "c", lat: 1, lon: 2, t: "" },
    ],
  });
  assert.deepEqual(got.map((a) => [a.hex, a.alt, a.type]), [["a", null, "B738"], ["c", null, null]]);
});

test("jamming_now lists a jammed control zone instead of hiding it", () => {
  const z = (id, role, state) => ({ id, name: id, role, state, stale: false, cls: state === "JAMMED" ? "DEGRADED" : "CLEAR", pct: state === "JAMMED" ? 50 : 1, n: 40, usual_pct: null, since: null });
  const snap = {
    as_of: "2026-10-15T00:10:30Z",
    last_slot: "2026-10-15T00:10:00Z",
    status: { zones: [z("baltic", "sentinel", "CLEAR"), z("ctl_london", "control", "JAMMED")], controls: { level: "clean" } },
  };
  const out = answerTool("jamming_now", {}, snap, Date.parse(snap.last_slot) + 60_000);
  assert.deepEqual(out.structuredContent.jammed.map((j) => j.zone), ["ctl_london"]);
  assert.match(out.content[0].text, /^Jammed now: ctl_london 50% of 40\./);
});

test("an INGEST_KEY that is set but too short refuses ingest instead of falling back to API_KEY", async () => {
  const { settingsFrom } = await import("../src/settings.js");
  const api = "a".repeat(24);
  assert.equal(settingsFrom({ API_KEY: api }).ingestKey, api);
  assert.equal(settingsFrom({ API_KEY: api, INGEST_KEY: "short" }).ingestKey, null);
  assert.equal(settingsFrom({ API_KEY: "short" }).apiKey, null);
});
