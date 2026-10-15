// recent_events paging as pure functions (SPEC.md 6.4): no repeat, no gap, the cursor never moves backwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsInWindow, eventsSince, recordedAt } from "../src/cursor.js";
import { SLOT, iso } from "../src/time.js";

const T = Date.parse("2026-10-15T06:00:00Z");
const ev = (id, opened, closed = null) => ({ id, opened: iso(opened), closed: closed === null ? null : iso(closed), open: closed === null });

test("an event is placed by the tick that last recorded it: closed, else opened", () => {
  assert.equal(recordedAt(ev("a", T)), T);
  assert.equal(recordedAt(ev("a", T, T + 3 * SLOT)), T + 3 * SLOT);
});

test("eventsSince: oldest first, strictly after the cursor, and the cursor never moves backwards", () => {
  const log = [ev("c", T + 2 * SLOT), ev("b", T, T + SLOT), ev("a", T - SLOT)];
  const page = eventsSince(log, T - SLOT, T + 2 * SLOT, 50);
  assert.deepEqual(page.events.map((e) => e.id), ["b", "c"]);
  assert.equal(page.cursor, T + 2 * SLOT);
  assert.equal(page.truncated, false);
  assert.equal(eventsSince(log, T + 9 * SLOT, T + 2 * SLOT, 50).cursor, T + 9 * SLOT, "a stale snapshot");
});

test("eventsSince: a full page is cut between slots, and following the cursor visits every event once", () => {
  const log = [];
  for (let k = 0; k < 7; k++) for (let z = 0; z < 20; z++) log.push(ev(`${k}-${z}`, T + k * SLOT));
  const seen = [];
  let cursor = T - SLOT;
  for (let calls = 0; calls < 10; calls++) {
    const page = eventsSince(log, cursor, T + 6 * SLOT, 50);
    const slots = new Set(page.events.map(recordedAt));
    if (page.truncated) assert.ok(!slots.has(recordedAt(log.find((e) => recordedAt(e) > page.cursor))), "a slot was split");
    seen.push(...page.events.map((e) => e.id));
    assert.ok(page.cursor >= cursor);
    cursor = page.cursor;
    if (!page.truncated) break;
  }
  assert.equal(seen.length, log.length);
  assert.equal(new Set(seen).size, log.length);
});

test("eventsSince: one slot bigger than a page is returned whole rather than as an empty page", () => {
  const log = Array.from({ length: 60 }, (_, i) => ev(`e${i}`, T));
  const page = eventsSince(log, T - SLOT, T, 50);
  assert.equal(page.events.length, 60);
  assert.equal(page.cursor, T);
  assert.equal(page.truncated, true);
});

test("eventsInWindow: open events always, closed ones recorded in the window, newest first, at most a page", () => {
  const log = [ev("open", T - 9 * SLOT), ev("new", T, T + SLOT), ev("old", T - 9 * SLOT, T - 8 * SLOT)];
  assert.deepEqual(eventsInWindow(log, T, 50).map((e) => e.id), ["open", "new"]);
  assert.equal(eventsInWindow(log, 0, 2).length, 2);
});
