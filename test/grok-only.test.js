// Jammer Court is only for Grok Bot (spec v1.2): no phone pushes, and Grok Bot can ask what changed since its last answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { answerTool } from "../src/tools.js";
import { adsbRoutes, fakeNet, jsonResponse, makeEnv, zoneBody, zoneOfUrl } from "./fakes.js";

const SOURCES = new Set(["api.adsb.lol", "opendata.adsb.fi", "services.swpc.noaa.gov", "gpsjam.org"]);

/** Levant's bad fraction per tick is read from `levant()`; everything else is clean. */
function levantRoutes(levant, extra = () => 0) {
  const routes = adsbRoutes();
  routes["api.adsb.lol"] = (u) => {
    const id = zoneOfUrl(u);
    return jsonResponse(zoneBody(id, 40, id === "levant" ? Math.round(levant() * 40) : extra(id)));
  };
  return routes;
}

const ask = (h, args) => answerTool("recent_events", args, h.court.store.loadSnapshot(), h.now);

test("S6: a day with onsets, offsets, noisy controls and adsb.lol refusing contacts only the four data sources", async () => {
  const h = makeEnv({}, Date.parse("2026-10-14T23:30:20Z"));
  let levant = 0;
  let noisy = false;
  let refuse = false;
  const routes = levantRoutes(() => levant, (id) => (noisy && ["ctl_london", "ctl_frankfurt"].includes(id) ? 12 : 0));
  const lol = routes["api.adsb.lol"];
  routes["api.adsb.lol"] = (u, init, k) => (refuse ? 403 : lol(u, init, k));
  const net = fakeNet(routes, h.storage);
  try {
    await h.ticks(3);
    levant = 0.3;
    noisy = true;
    await h.ticks(3);
    levant = 0;
    noisy = false;
    await h.ticks(7);
    refuse = true;
    await h.ticks(4);
    const hosts = new Set(net.calls.map((c) => c.host));
    assert.deepEqual([...hosts].filter((x) => !SOURCES.has(x)), []);
    assert.equal(h.rows("SELECT COUNT(*) AS n FROM events WHERE zone = 'levant' AND offset_ts IS NOT NULL")[0].n, 1);
  } finally {
    net.restore();
  }
});

test("/health is configured with only an API key", async () => {
  const h = makeEnv();
  const res = await worker.fetch(new Request("https://jc.example/health"), h.env);
  assert.equal((await res.json()).configured, true);
});

test("recent_events since: returns what was recorded after Grok Bot's last answer, by recording time, never twice", async () => {
  const h = makeEnv();
  let levant = 0;
  const net = fakeNet(levantRoutes(() => levant), h.storage);
  try {
    await h.ticks(3); // acquire CLEAR
    levant = 0.3;
    await h.ticks(1); // first degraded sample: the run starts here
    const before = ask(h, {}).structuredContent.next_since;
    await h.ticks(1); // second degraded sample: onset recorded now, onset time is the earlier run start
    const first = ask(h, { since: before }).structuredContent;
    assert.deepEqual(first.events.map((e) => [e.zone, e.offset]), [["levant", null]]);
    assert.ok(Date.parse(first.events[0].onset) <= Date.parse(before), "the onset time is not after since");
    assert.deepEqual(ask(h, { since: first.next_since }).structuredContent.events, []);

    levant = 0;
    await h.ticks(3);
    const mid = ask(h, { since: first.next_since }).structuredContent;
    assert.deepEqual(mid.events, []);
    await h.ticks(3); // sixth clear sample: offset recorded now, offset time is three ticks back
    const ended = ask(h, { since: mid.next_since }).structuredContent.events;
    assert.equal(ended.length, 1);
    assert.ok(ended[0].closed > ended[0].offset);
    assert.ok(Date.parse(ended[0].offset) < Date.parse(mid.next_since), "the offset time precedes since");
  } finally {
    net.restore();
  }
});

test("recent_events since must be a time", async () => {
  const h = makeEnv();
  const net = fakeNet(adsbRoutes(), h.storage);
  try {
    await h.ticks(1);
    for (const since of ["yesterday", 5, ""]) {
      const res = ask(h, { since });
      assert.equal(res.isError, true);
      assert.equal(res.structuredContent.error.code, "INVALID_INPUT");
    }
  } finally {
    net.restore();
  }
});
