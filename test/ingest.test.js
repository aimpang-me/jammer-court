// SPEC.md 4.4: every free aircraft feed refuses Cloudflare, so a GitHub job samples and posts to /ingest.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { SLOT } from "../src/time.js";
import { sampleOnce } from "../tools/sample.mjs";
import { KEY, adsbRoutes, fakeNet, jsonResponse, makeEnv } from "./fakes.js";
import { ZONE_CELLS } from "../src/zone_cells.js";

const BASE = "https://jc.example";

/** The fake network also routes the Worker's own host, so the sampler reaches the Worker under test. */
function net(h, routes = adsbRoutes()) {
  return fakeNet({ ...routes, "jc.example": (u, init) => worker.fetch(new Request(u, init), h.env) }, h.storage);
}

const sample = (h) => sampleOnce({ url: BASE, key: KEY, sleep: async () => {}, now: () => h.now });
const auth = { Authorization: `Bearer ${KEY}` };
const call = (h, init = {}) => worker.fetch(new Request(`${BASE}/ingest`, { ...init, headers: { ...auth, ...init.headers } }), h.env);
const post = (h, body) =>
  call(h, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const count = (h, table) => h.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

test("the Worker never fetches upstream by itself: /health, the page and the JSON routes make no outside calls", async () => {
  const h = makeEnv();
  const n = net(h);
  try {
    for (const path of ["/health", "/", "/api/status.json"]) await worker.fetch(new Request(`${BASE}${path}`), h.env);
    assert.equal(n.calls.filter((c) => c.host !== "jc.example").length, 0);
    assert.equal(count(h, "ticks"), 0);
  } finally {
    n.restore();
  }
});

test("/ingest refuses requests without the key", async () => {
  const h = makeEnv();
  for (const method of ["GET", "POST"]) {
    const res = await worker.fetch(new Request(`${BASE}/ingest`, { method, body: method === "POST" ? "{}" : undefined }), h.env);
    assert.equal(res.status, 401);
  }
  assert.equal(count(h, "ticks"), 0);
});

test("the sampler records a full tick through /ingest, then the same slot is skipped", async () => {
  const h = makeEnv();
  const n = net(h, adsbRoutes({ baltic: 0.3 }));
  try {
    const first = await sample(h);
    assert.equal(first.recorded, true);
    assert.equal(first.ok_zones, 20);
    assert.equal(count(h, "samples"), 20);
    const snap = h.court.store.loadSnapshot();
    assert.equal(snap.last_slot, "2026-10-15T00:00:00Z");
    assert.equal(snap.status.last_tick.ok_zones, 20);
    const lol = n.to("api.adsb.lol").length;
    const again = await sample(h);
    assert.equal(again.skipped, true);
    assert.equal(n.to("api.adsb.lol").length, lol, "a skipped slot fetches nothing");
    assert.equal(count(h, "samples"), 20);
  } finally {
    n.restore();
  }
});

test("sampler runs record zones, events, SWPC alerts and the gpsjam score", async () => {
  const alert = { product_id: "K05W", issue_datetime: "2026-10-15 00:05:00.000", message: "WARNING: Geomagnetic K-index of 5 expected" };
  const csv = `hex,count_good_aircraft,count_bad_aircraft\n${ZONE_CELLS.levant[0]},80,20\n${ZONE_CELLS.baltic[0]},90,10\n`;
  const routesFor = (levant) => ({
    ...adsbRoutes({ levant: levant() }),
    "services.swpc.noaa.gov": () => jsonResponse([alert]),
    "gpsjam.org": () => new Response(csv),
  });
  let levant = 0;
  const script = (i) => (levant = i >= 3 && i < 6 ? 0.3 : 0);
  const h = makeEnv();
  for (let i = 0; i < 14; i++) {
    script(i);
    const n = net(h, routesFor(() => levant));
    try {
      assert.equal((await sample(h)).recorded, true);
    } finally {
      n.restore();
    }
    h.advance(SLOT);
  }
  assert.equal(count(h, "ticks"), 14);
  assert.equal(count(h, "samples"), 14 * 20);
  const [ev] = h.rows("SELECT * FROM events WHERE zone = 'levant'");
  assert.equal(ev.onset_ts, Date.parse("2026-10-15T00:30:00Z"));
  assert.equal(ev.sun, "ACTIVE");
  assert.ok(ev.offset_ts !== null);
  assert.deepEqual(h.rows("SELECT product_id FROM space_alerts"), [{ product_id: "K05W" }]);
  assert.ok(h.rows("SELECT notes FROM ticks").some((t) => /gpsjam 2026-10-14 ok/.test(t.notes)));
  assert.deepEqual(h.rows("SELECT zone, gj_k, gj_n FROM daily WHERE gj_n > 0 ORDER BY zone"), [
    { zone: "baltic", gj_k: 10, gj_n: 100 },
    { zone: "levant", gj_k: 20, gj_n: 100 },
  ]);
});

test("/ingest rejects a stale slot, a changed due, bad shapes and oversized bodies, and writes nothing", async () => {
  const h = makeEnv();
  const plan = await (await call(h)).json();
  assert.equal(plan.slot, h.now - 20_000);
  const zones = (await import("../src/zones.js")).ZONES.map((z) => ({ zone: z.id, ok: false, src: "none", code: "lol_429" }));
  const obs = { zones, swpc: null, gpsjam: null, lolAuthFailed: false, lolOk: false, pauses: plan.pauses, notes: "lol 429x20", requests: 21 };
  if (plan.due.swpc) obs.swpc = { ok: false, code: 503 };
  const good = { slot: plan.slot, due: plan.due, obs, ms: 900 };
  const ac = { hex: "a1", lat: 33, lon: 35, version: 2, nic: 8, alt: 34000, seenPos: 1, type: "B738" };
  const withZone = (z) => ({ ...good, obs: { ...obs, zones: [z, ...zones.slice(1)] } });

  const cases = [
    [409, { ...good, slot: plan.slot - SLOT }],
    [409, { ...good, due: { ...plan.due, rollupDay: "2026-10-14" } }],
    [400, { ...good, obs: { ...obs, zones: zones.slice(1) } }],
    [400, { ...good, obs: { ...obs, zones: [...zones.slice(1), zones[0]] } }],
    [400, withZone({ zone: zones[0].zone, ok: "yes", src: "lol" })],
    [400, withZone({ zone: zones[0].zone, ok: true, src: "lol", aircraft: [{ ...ac, lat: "33" }] })],
    [400, withZone({ zone: zones[0].zone, ok: true, src: "lol", aircraft: [{ ...ac, hex: 5 }] })],
    [400, { ...good, obs: { ...obs, gpsjam: { day: "2026-10-14", ok: true, perZone: {} } } }],
    [400, { ...good, ms: "fast" }],
    [400, { ...good, obs: { ...obs, requests: undefined } }],
    [400, "not json"],
  ];
  for (const [status, body] of cases) {
    const res = await post(h, body);
    assert.equal(res.status, status, JSON.stringify(body).slice(0, 120));
  }
  const big = await post(h, "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal(big.status, 413);
  const wide = await post(h, "é".repeat(1.1 * 1024 * 1024)); // under the limit in characters, over it in bytes
  assert.equal(wide.status, 413);
  assert.equal(count(h, "ticks"), 0);
  assert.equal(count(h, "samples"), 0);

  const ok = await post(h, good);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { recorded: true, slot: "2026-10-15T00:00:00Z", ok_zones: 0, notes: "lol 429x20" });
});

test("the sampler reports a refused plan instead of fetching", async () => {
  const h = makeEnv();
  const n = net(h);
  try {
    await assert.rejects(sampleOnce({ url: BASE, key: "wrong-key-wrong-key!", sleep: async () => {}, now: () => h.now }), /401/);
    assert.equal(n.to("api.adsb.lol").length, 0);
  } finally {
    n.restore();
  }
});

// ---- fixes from the independent review of the sampler ----

/** A plan and a well-formed body for the current slot, built from the Worker's own plan. */
async function goodBody(h, over = {}) {
  const plan = await (await call(h)).json();
  const { ZONES } = await import("../src/zones.js");
  const obs = {
    zones: ZONES.map((z) => ({ zone: z.id, ok: false, src: "none", code: "lol_429" })),
    swpc: plan.due.swpc ? { ok: false, code: 503 } : null,
    gpsjam: null,
    lolAuthFailed: false,
    lolOk: false,
    pauses: plan.pauses,
    notes: "n",
    requests: 1,
    ...over,
  };
  return { plan, body: { slot: plan.slot, due: plan.due, obs, ms: 1 } };
}

test("a post for the previous slot is still recorded; two slots back is refused", async () => {
  const h = makeEnv();
  const { body } = await goodBody(h);
  h.advance(SLOT); // GitHub started the run late; it crossed the slot boundary
  const res = await post(h, body);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).recorded, true);
  const { body: second } = await goodBody(h);
  h.advance(2 * SLOT);
  assert.equal((await post(h, second)).status, 409);
});

test("posted pauses are clamped, so a bad body can't stop adsb.lol for good", async () => {
  const h = makeEnv();
  const { body } = await goodBody(h);
  body.obs.pauses = { lolUntil: 1e300, fiUntil: 1e300 };
  assert.equal((await post(h, body)).status, 200);
  h.advance(SLOT);
  const plan = await (await call(h)).json();
  assert.ok(plan.pauses.lolUntil <= h.now + 3600_000);
  assert.ok(plan.pauses.fiUntil <= h.now + 30 * 60_000);
  assert.deepEqual(Object.keys(plan.pauses).sort(), ["fiUntil", "lolUntil"]);
});

test("a body without due is a 400, and a long SWPC alert list is accepted", async () => {
  const h = makeEnv();
  const { body } = await goodBody(h);
  assert.equal((await post(h, { ...body, due: undefined })).status, 400);
  if (body.due.swpc) {
    const alerts = Array.from({ length: 800 }, (_, i) => ({ productId: `K05W${i}`, issued: h.now - i * 60_000, kind: "kp5" }));
    body.obs.swpc = { ok: true, alerts };
  }
  assert.equal((await post(h, body)).status, 200);
});

test("the sampler stops on a version mismatch instead of posting", async () => {
  const h = makeEnv();
  const n = fakeNet(
    {
      ...adsbRoutes(),
      "jc.example": async (u, init) => {
        const res = await worker.fetch(new Request(u, init), h.env);
        if ((init?.method ?? "GET") !== "GET") return res;
        const plan = await res.json();
        return new Response(JSON.stringify({ ...plan, version: "other" }), { headers: { "Content-Type": "application/json" } });
      },
    },
    h.storage,
  );
  try {
    await assert.rejects(sample(h), /version mismatch/);
    assert.equal(n.to("api.adsb.lol").length, 0);
  } finally {
    n.restore();
  }
});

test("the sampler retries a POST that fails on the network, and re-plans once after a 409", async () => {
  const h = makeEnv();
  let posts = 0;
  const n = fakeNet(
    {
      ...adsbRoutes(),
      "jc.example": (u, init) => {
        if (init?.method === "POST" && ++posts === 1) return "throw";
        if (init?.method === "POST" && posts === 2) {
          h.advance(2 * SLOT); // the first plan is now too old
        }
        return worker.fetch(new Request(u, init), h.env);
      },
    },
    h.storage,
  );
  try {
    const out = await sample(h);
    assert.equal(out.recorded, true);
    assert.equal(out.slot, "2026-10-15T00:20:00Z");
    assert.equal(posts, 3);
  } finally {
    n.restore();
  }
});
