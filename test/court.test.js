// Drives the Durable Object through scripted sampler runs with a fake clock and a routed fake network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/version.js";
import worker, { resetCache } from "../src/index.js";
import { BASE, FakeKV, KEY, adsbRoutes, fakeNet, jsonResponse, makeEnv, zoneBody, zoneOfUrl } from "./fakes.js";

async function withNet(routes, h, fn) {
  const net = fakeNet(routes, h.storage);
  try {
    await fn(net);
  } finally {
    net.restore();
  }
}

test("every upstream request is counted on the tick row, up to 42 when adsb.lol fails every zone", async () => {
  const h = makeEnv();
  await withNet(adsbRoutes({}, { lol: () => 500 }), h, async (net) => {
    await h.tick();
    const [tick] = h.rows("SELECT subreqs, ok_zones FROM ticks");
    assert.equal(tick.subreqs, net.calls.length);
    assert.ok(tick.subreqs <= 42);
    assert.equal(tick.ok_zones, 20);
  });
});

test("first ticks: stores 20 samples, acquires silently, and saves a snapshot", async () => {
  const h = makeEnv();
  await withNet(adsbRoutes({ baltic: 0.3 }), h, async (net) => {
    await h.ticks(3);
    assert.equal(h.rows("SELECT COUNT(*) AS n FROM samples")[0].n, 60);
    assert.equal(net.to("api.adsb.lol").length, 60);
    const [ev] = h.rows("SELECT * FROM events");
    assert.equal(ev.zone, "baltic");
    assert.equal(ev.onset_ts, null);
    const snap = JSON.parse(h.rows("SELECT v FROM meta WHERE k = 'snapshot'")[0].v);
    assert.equal(snap.last_slot, "2026-10-15T00:20:00Z");
    assert.equal(snap.status.zones.find((z) => z.id === "baltic").state, "JAMMED");
    assert.equal(snap.status.zones.find((z) => z.id === "ctl_london").state, "CLEAR");
    // User-Agent and the hex privacy rule
    assert.match(net.to("api.adsb.lol")[0].init.headers["User-Agent"], new RegExp(`^jammer-court/${VERSION} \\(\\+https://`));
    const dump = JSON.stringify(h.rows("SELECT * FROM samples")) + JSON.stringify(snap);
    assert.equal(dump.includes("baltic-0"), false);
  });
});

test("idempotent: the same slot twice commits once, in exactly one transaction, with no writes during fetches", async () => {
  const h = makeEnv();
  await withNet(adsbRoutes(), h, async (net) => {
    await h.tick();
    const tx = h.storage.transactions;
    assert.equal(tx, 1);
    const writesAtFetch = new Set(net.calls.map((c) => c.writes));
    assert.equal(writesAtFetch.size, 1, "a storage write happened between fetches");
    const fetched = net.calls.length;
    await h.tick();
    assert.equal(h.storage.transactions, tx);
    assert.equal(net.calls.length, fetched);
    assert.equal(h.rows("SELECT COUNT(*) AS n FROM ticks")[0].n, 1);
  });
});

test("an onset is logged at its run start, and 6 clear samples close it at theirs, each with the tick that recorded it", async () => {
  const h = makeEnv();
  let levant = 0;
  const routes = adsbRoutes();
  routes["api.adsb.lol"] = (u) => {
    const id = zoneOfUrl(u);
    return jsonResponse(zoneBody(id, 40, id === "levant" ? Math.round(levant * 40) : 0));
  };
  await withNet(routes, h, async (net) => {
    await h.ticks(3); // acquire CLEAR everywhere
    levant = 0.3;
    await h.ticks(3);
    const [open] = h.rows("SELECT * FROM events WHERE zone = 'levant'");
    assert.equal(open.onset_ts, Date.parse("2026-10-15T00:30:00Z"));
    assert.equal(open.opened_ts, Date.parse("2026-10-15T00:40:00Z"));
    assert.equal(open.sun, "QUIET");
    levant = 0;
    await h.ticks(7);
    const [ev] = h.rows("SELECT * FROM events WHERE zone = 'levant'");
    assert.equal(ev.offset_ts, Date.parse("2026-10-15T01:00:00Z"));
    assert.equal(ev.closed_ts, Date.parse("2026-10-15T01:50:00Z"));
    assert.equal(ev.peak_pct, 30);
  });
});

test("a re-onset soon after an offset opens a second event", async () => {
  const h = makeEnv();
  const plan = [0, 0, 0.3, 0.3, 0, 0, 0, 0, 0, 0, 0.3, 0.3, 0, 0, 0, 0, 0, 0];
  let i = 0;
  const routes = adsbRoutes();
  routes["api.adsb.lol"] = (u) => {
    const id = zoneOfUrl(u);
    return jsonResponse(zoneBody(id, 40, id === "levant" ? Math.round(plan[i] * 40) : 0));
  };
  await withNet(routes, h, async (net) => {
    await h.ticks(plan.length, (k) => (i = k));
    const evs = h.rows("SELECT onset_ts, offset_ts FROM events WHERE zone = 'levant' ORDER BY id");
    assert.equal(evs.length, 2);
    assert.ok(evs.every((e) => e.onset_ts !== null && e.offset_ts !== null));
  });
});

test("controls noisy: flagged in the tick notes and the snapshot", async () => {
  const h = makeEnv();
  let on = false;
  const routes = adsbRoutes();
  routes["api.adsb.lol"] = (u) => {
    const id = zoneOfUrl(u);
    const bad = on && ["levant", "ctl_london", "ctl_frankfurt"].includes(id) ? 12 : 0;
    return jsonResponse(zoneBody(id, 40, bad));
  };
  await withNet(routes, h, async (net) => {
    await h.ticks(2);
    on = true;
    await h.ticks(3);
    assert.match(h.rows("SELECT notes FROM ticks ORDER BY slot DESC")[0].notes, /controls_noisy/);
    const snap = JSON.parse(h.rows("SELECT v FROM meta WHERE k = 'snapshot'")[0].v);
    assert.equal(snap.status.controls.level, "noisy");
    assert.deepEqual(snap.status.controls.degraded, ["London", "Frankfurt"]);
  });
});

test("fallback: a 429 from adsb.lol sends the rest of the tick to adsb.fi, and the tick notes say so", async () => {
  const h = makeEnv();
  const routes = adsbRoutes({}, { lol: (u, k) => (k === 4 ? 429 : null) });
  await withNet(routes, h, async (net) => {
    await h.tick();
    const lol = net.to("api.adsb.lol").length;
    const fi = net.to("opendata.adsb.fi").length;
    assert.ok(lol >= 4 && lol <= 6, `lol calls ${lol}`); // up to 2 more were already in flight
    assert.equal(lol - 1 + fi, 20);
    const srcs = h.rows("SELECT src, COUNT(*) AS n FROM samples GROUP BY src");
    assert.equal(srcs.reduce((a, r) => a + r.n, 0), 20);
    assert.ok(srcs.some((r) => r.src === "fi"));
    const [t] = h.rows("SELECT * FROM ticks");
    assert.match(t.notes, /lol 200x\d+ 429x1/);
    assert.equal(t.ok_zones, 20);
  });
});

test("adsb.lol refusing three ticks in a row pauses it for an hour, and the tick notes say so", async () => {
  const h = makeEnv();
  const routes = adsbRoutes({}, { lol: () => 403 });
  await withNet(routes, h, async (net) => {
    await h.ticks(4);
    assert.equal(h.rows("SELECT COUNT(*) AS n FROM ticks WHERE notes LIKE '%lol_paused_1h%'")[0].n, 1);
    const lolCalls = net.to("api.adsb.lol").length;
    assert.equal(lolCalls, 60); // the fourth tick skipped adsb.lol
    assert.equal(net.to("opendata.adsb.fi").length, 80);
  });
});

test("every source down: UNKNOWN samples, and the tick still commits", async () => {
  const h = makeEnv();
  await withNet({}, h, async (net) => {
    await h.ticks(2);
    assert.equal(h.rows("SELECT COUNT(*) AS n FROM samples WHERE cls = 'UNKNOWN'")[0].n, 40);
    assert.equal(h.rows("SELECT ok_zones FROM ticks")[0].ok_zones, 0);
  });
});

test("rollup after midnight and the gpsjam comparison land in daily", async () => {
  const h = makeEnv({}, Date.parse("2026-10-14T23:30:20Z"));
  const routes = adsbRoutes({ baltic: 0.25 });
  const { ZONE_CELLS } = await import("../src/zone_cells.js");
  const [c1, c2] = ZONE_CELLS.baltic;
  routes["gpsjam.org"] = (u) => {
    assert.equal(u.pathname, "/data/2026-10-14-h3_4.csv");
    return new Response(`hex,count_good_aircraft,count_bad_aircraft\n${c1},60,30\n${c2},30,0\n${ZONE_CELLS.ctl_london[0]},90,0\n`);
  };
  await withNet(routes, h, async (net) => {
    await h.ticks(7); // 23:30 .. 00:30
    const d = h.rows("SELECT * FROM daily WHERE day = '2026-10-14' AND zone = 'baltic'")[0];
    assert.equal(d.k, 30);
    assert.equal(d.n, 120);
    assert.equal(d.cat, "red");
    assert.equal(d.gj_k, 30);
    assert.equal(d.gj_n, 120);
    assert.equal(d.gj_cat, "red");
    assert.equal(net.to("gpsjam.org").length, 1);
    const snap = JSON.parse(h.rows("SELECT v FROM meta WHERE k = 'snapshot'")[0].v);
    assert.deepEqual(snap.record.agreement.perZone.baltic, { comparable: 1, agree: 1, mad: 0 });
  });
});

test("SWPC is polled every third tick, and an alert in the 24 h before onset makes the Sun active", async () => {
  const h = makeEnv();
  let levant = 0;
  const routes = adsbRoutes();
  routes["api.adsb.lol"] = (u) => {
    const id = zoneOfUrl(u);
    return jsonResponse(zoneBody(id, 40, id === "levant" ? Math.round(levant * 40) : 0));
  };
  routes["services.swpc.noaa.gov"] = () =>
    jsonResponse([{ product_id: "K05A", issue_datetime: "2026-10-14 22:00:00.000", message: "ALERT: Geomagnetic K-index of 5" }]);
  await withNet(routes, h, async (net) => {
    await h.ticks(3);
    levant = 0.3;
    await h.ticks(3);
    assert.equal(net.to("services.swpc.noaa.gov").length, 2); // slots 00:00 and 00:30
    assert.equal(h.rows("SELECT sun FROM events")[0].sun, "ACTIVE");
  });
});

test("KV snapshot: written once per tick when bound", async () => {
  const kv = new FakeKV();
  const h = makeEnv({ SNAPSHOT: kv });
  await withNet(adsbRoutes(), h, async (net) => {
    await h.ticks(2);
    assert.equal(kv.puts, 2);
    assert.equal(JSON.parse(kv.map.get("snapshot")).last_slot, "2026-10-15T00:10:00Z");
  });
});

test("a KV failure after the commit still answers recorded, with a warning, and the sample stays", async () => {
  const kv = new FakeKV();
  kv.put = async () => {
    throw new Error("KV down");
  };
  const h = makeEnv({ SNAPSHOT: kv });
  await withNet(adsbRoutes(), h, async () => {
    const out = await h.tick();
    assert.equal(out.recorded, true);
    assert.match(out.warning, /KV snapshot was not updated: KV down/);
    assert.equal(h.court.store.lastSlot(), Date.parse("2026-10-15T00:00:00Z"));
    assert.equal(h.court.store.loadSnapshot().last_slot, "2026-10-15T00:00:00Z");
  });
});

test("a commit that throws is logged on the tick row, answered 500, and leaves the slot open for a retry", async () => {
  const h = makeEnv();
  await withNet(adsbRoutes(), h, async () => {
    h.court.store.commit = () => {
      throw new Error("disk on fire");
    };
    await assert.rejects(h.tick(), /ingest refused: 500/);
    assert.match(h.rows("SELECT notes FROM ticks")[0].notes, /error: disk on fire/);
    assert.equal(h.court.store.lastSlot(), null);
  });
});

test("commit re-checks the slot inside its transaction, so a racing second tick writes nothing", async () => {
  const h = makeEnv();
  await withNet(adsbRoutes(), h, async () => {
    await h.tick();
    const slot = h.court.store.lastSlot();
    const writes = h.storage.writes;
    assert.equal(h.court.store.commit({ slot, samples: [{}] }, h.now), false);
    assert.equal(h.storage.writes, writes);
  });
});

const mcp = (env, key, name, args = {}) =>
  worker.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
  );

test("a KV read that throws falls back to the Durable Object's snapshot instead of failing the request", async () => {
  const kv = new FakeKV();
  const h = makeEnv({ SNAPSHOT: kv });
  await withNet(adsbRoutes(), h, async () => {
    await h.tick();
    kv.get = async () => {
      throw new Error("429 Too Many Requests");
    };
    resetCache();
    const res = await mcp(h.env, KEY, "jamming_now");
    assert.equal(res.status, 200);
    assert.match((await res.json()).result.content[0].text, /Next check: since=2026-10-15T00:00:00Z/);
    const page = await worker.fetch(new Request(`${BASE}/api/status.json`), h.env);
    assert.equal(page.status, 200);
  });
  resetCache();
});

test("a snapshot rebuild that fails after the commit answers recorded, with a warning, not a retryable 500", async () => {
  const h = makeEnv();
  await withNet(adsbRoutes(), h, async () => {
    h.court.refreshSnapshot = () => {
      throw new Error("row too big");
    };
    const out = await h.tick();
    assert.equal(out.recorded, true);
    assert.match(out.warning, /snapshot was not rebuilt: row too big/);
    assert.equal(h.court.store.lastSlot(), Date.parse("2026-10-15T00:00:00Z"));
    assert.match(h.rows("SELECT notes FROM ticks")[0].notes, /error: row too big/);
  });
});

test("with INGEST_KEY set, the key Grok Bot holds can read but can't post samples", async () => {
  const grok = "g".repeat(24);
  const h = makeEnv({ API_KEY: grok, INGEST_KEY: KEY }); // the fake sampler posts with KEY
  await withNet(adsbRoutes(), h, async () => {
    assert.equal((await h.tick()).recorded, true);
    const asGrok = await worker.fetch(new Request(`${BASE}/ingest`, { headers: { Authorization: `Bearer ${grok}` } }), h.env);
    assert.equal(asGrok.status, 401);
    assert.equal((await mcp(h.env, grok, "list_zones")).status, 200);
    assert.equal((await mcp(h.env, KEY, "list_zones")).status, 401);
  });
});
