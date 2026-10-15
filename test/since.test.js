// The follow-up cursor (v1.2). Each test failed before its fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { SLOT } from "../src/time.js";
import { answerTool } from "../src/tools.js";
import { FakeStorage, adsbRoutes, fakeNet, jsonResponse, makeEnv, zoneBody, zoneOfUrl } from "./fakes.js";

const T = Date.parse("2026-10-15T06:00:00Z");
const at = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

/** A snapshot with only what recent_events and jamming_now read. */
function snap(lastSlot, log = []) {
  return {
    as_of: at(lastSlot + 50_000),
    last_slot: at(lastSlot),
    log,
    status: { zones: [], controls: { level: "clean" } },
  };
}
const ev = (zone, openedSlot, closedSlot = null) => ({
  zone,
  name: zone,
  opened: at(openedSlot),
  onset: at(openedSlot - SLOT),
  offset: closedSlot === null ? null : at(closedSlot - 5 * SLOT),
  closed: closedSlot === null ? null : at(closedSlot),
  open: closedSlot === null,
  peak_pct: 20,
  sun: "QUIET",
  after_gap: false,
  end_unknown: false,
});
const recent = (s, args, now = Date.parse(s.last_slot) + 60_000) => answerTool("recent_events", args, s, now);
const errCode = (res) => res.structuredContent?.error?.code;

test("a late tick: next_since is the last sample's slot, so the next tick's onset is not lost", async () => {
  const h = makeEnv();
  let levant = 0;
  let late = false;
  const routes = adsbRoutes();
  routes["api.adsb.lol"] = (u) => {
    if (late) {
      late = false;
      h.advance(11 * 60_000); // the run was so late that the snapshot is built after the next slot boundary
    }
    const id = zoneOfUrl(u);
    return jsonResponse(zoneBody(id, 40, id === "levant" ? Math.round(levant * 40) : 0));
  };
  const net = fakeNet(routes, h.storage);
  try {
    for (let i = 0; i < 3; i++) {
      await h.tick();
      h.advance(SLOT);
    }
    levant = 0.3;
    late = true;
    await h.tick(); // first degraded sample, posted for the slot just ended, snapshot built 11 min late
    const first = answerTool("recent_events", {}, h.court.store.loadSnapshot(), h.now).structuredContent;
    assert.ok(Date.parse(first.as_of) > Date.parse(first.last_slot ?? first.next_since) + SLOT);
    await h.tick(); // the next run samples the current slot and records the onset there
    const next = answerTool("recent_events", { since: first.next_since }, h.court.store.loadSnapshot(), h.now).structuredContent;
    assert.deepEqual(next.events.map((e) => e.zone), ["levant"]);
  } finally {
    net.restore();
  }
});

test("the cursor never moves backwards when a stale snapshot answers", () => {
  const fresh = recent(snap(T + 5 * SLOT, [ev("levant", T + 5 * SLOT)]), { since: at(T) }).structuredContent;
  assert.equal(fresh.next_since, at(T + 5 * SLOT));
  // The snapshot lags, the clock doesn't.
  const stale = recent(snap(T + 3 * SLOT), { since: fresh.next_since }, T + 5 * SLOT + 60_000).structuredContent;
  assert.equal(stale.next_since, fresh.next_since);
  assert.deepEqual(recent(snap(T + 5 * SLOT, [ev("levant", T + 5 * SLOT)]), { since: stale.next_since }).structuredContent.events, []);
});

test("since pages oldest first by recording slot, cutting only between slots, and says when it truncated", () => {
  const a = T + SLOT;
  const b = T + 2 * SLOT;
  // Log order as views builds it: by opened, newest first. The B rows are old events that closed at B.
  const log = [
    ...Array.from({ length: 30 }, (_, i) => ev(`a${i}`, a)),
    ...Array.from({ length: 30 }, (_, i) => ev(`b${i}`, T - 5 * 86400_000, b)),
  ];
  const s = snap(b, log);
  const p1 = recent(s, { since: at(T) }).structuredContent;
  assert.equal(p1.events.length, 30);
  assert.ok(p1.events.every((e) => e.zone.startsWith("a")));
  assert.equal(p1.truncated, true);
  assert.equal(p1.next_since, at(a));
  const p2 = recent(s, { since: p1.next_since }).structuredContent;
  assert.equal(p2.events.length, 30);
  assert.ok(p2.events.every((e) => e.zone.startsWith("b")));
  assert.equal(p2.truncated, false);
  assert.equal(p2.next_since, at(b));
  assert.match(recent(s, { since: at(T) }).content[0].text, /more to fetch/);
});

test("both texts carry the cursor, for clients that only pass text to the model", () => {
  const s = snap(T + SLOT, [ev("levant", T + SLOT)]);
  assert.match(recent(s, { since: at(T) }).content[0].text, /Next check: since=2026-10-15T06:10:00Z\.$/);
  assert.match(recent(s, {}).content[0].text, /Next check: since=2026-10-15T06:10:00Z\.$/);
  const now = answerTool("jamming_now", {}, s, T + SLOT + 60_000);
  assert.match(now.content[0].text, /Next check: since=2026-10-15T06:10:00Z\.$/);
  assert.equal(now.structuredContent.next_since, "2026-10-15T06:10:00Z");
});

test("since: impossible dates, hours together with since, offsets, a zone filter and the 30-day horizon", () => {
  const s = snap(T + SLOT, [ev("levant", T + SLOT), ev("baltic", T + SLOT)]);
  assert.equal(errCode(recent(s, { since: "2026-02-30T00:00:00Z" })), "INVALID_INPUT");
  assert.equal(errCode(recent(s, { since: "2026-10-15T24:00:00Z" })), "INVALID_INPUT");
  assert.equal(errCode(recent(s, { since: at(T), hours: 5 })), "INVALID_INPUT");
  const off = recent(s, { since: "2026-10-15T08:00:00+02:00", zone: "levant" }).structuredContent;
  assert.equal(off.since, at(T));
  assert.deepEqual(off.events.map((e) => e.zone), ["levant"]);
  assert.match(recent(s, { since: at(T) }).content[0].text, /since 2026-10-15 06:00 UTC/);
  const old = recent(s, { since: at(T - 40 * 86400_000) });
  assert.match(old.content[0].text, /History only goes back 30 days\./);
});

test("an orphaned open event is closed with its end marked unknown", async () => {
  const h = makeEnv();
  const routes = adsbRoutes({ baltic: 0.3 });
  const net = fakeNet(routes, h.storage);
  try {
    for (let i = 0; i < 2; i++) {
      await h.tick();
      h.advance(SLOT);
    }
    const state = JSON.parse(h.rows("SELECT v FROM meta WHERE k = 'state'")[0].v);
    delete state.zones.baltic; // as after a zone is removed and re-added
    h.court.store.setMeta("state", JSON.stringify(state));
    for (let i = 0; i < 2; i++) {
      await h.tick();
      h.advance(SLOT);
    }
    const [orphan] = h.rows("SELECT * FROM events WHERE zone = 'baltic' AND offset_ts IS NOT NULL");
    assert.equal(orphan.orphaned, 1);
    assert.equal(orphan.closed_ts, orphan.offset_ts);
    const res = answerTool("recent_events", {}, h.court.store.loadSnapshot(), h.now);
    const closed = res.structuredContent.events.find((e) => e.closed);
    assert.equal(closed.end_unknown, true);
    assert.match(res.content[0].text, /ended \(time unknown\)/);
  } finally {
    net.restore();
  }
});

test("a v1.1 events table gains the new columns instead of failing every tick", () => {
  const storage = new FakeStorage();
  storage.sql.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, zone TEXT NOT NULL, opened_ts INTEGER NOT NULL,
    onset_ts INTEGER, offset_ts INTEGER, peak_pct REAL, peak_n INTEGER, sun TEXT, push_on TEXT, push_off TEXT,
    after_gap INTEGER NOT NULL DEFAULT 0)`);
  new Store(storage);
  const cols = storage.sql.exec("PRAGMA table_info(events)").toArray().map((c) => c.name);
  assert.ok(cols.includes("closed_ts") && cols.includes("orphaned"));
  new Store(storage); // a second start changes nothing
});

test("a since in the future is refused instead of moving the cursor past events still to come", () => {
  const out = recent(snap(T), { since: "2099-01-01T00:00:00Z" }).structuredContent;
  assert.equal(out.error.code, "INVALID_INPUT");
  assert.match(out.error.message, /future/);
});

test("a single-zone jamming_now carries the cursor too, so a follow-up can start from it", () => {
  const s = snap(T);
  s.status.zones = [{ id: "baltic", name: "Baltic", role: "sentinel", state: "JAMMED", since: at(T - 6 * SLOT), stale: false, pct: 30, n: 40, usual_pct: null, usual_reason: "warming up", worse_than_usual: false, source: "lol" }];
  const out = answerTool("jamming_now", { zone: "baltic" }, s, T + 60_000);
  assert.equal(out.structuredContent.next_since, at(T));
  assert.match(out.content[0].text, new RegExp(`Next check: since=${at(T)}\\.$`));
});

test("a zone the snapshot doesn't have yet answers NOT_READY instead of crashing", () => {
  for (const name of ["jamming_now", "explain"]) {
    const out = answerTool(name, { zone: "baltic" }, snap(T), T + 60_000);
    assert.equal(out.structuredContent.error.code, "NOT_READY", name);
  }
});
