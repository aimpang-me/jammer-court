import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, initialZoneState, isStale } from "../src/state.js";
import { SLOT } from "../src/time.js";
import { T0, sample } from "./helpers.js";

/** Feeds [cls, slotIndex] pairs through the machine; returns the final state and every transition. */
function run(steps, start = initialZoneState()) {
  let st = start;
  const transitions = [];
  for (const [cls, i, opts] of steps) {
    const r = advance(st, sample(cls, i, opts));
    st = r.next;
    if (r.transition) transitions.push(r.transition);
  }
  return { st, transitions };
}
const seq = (cls, from, count) => Array.from({ length: count }, (_, k) => [cls, from + k]);

test("acquisition is silent: two CLEAR samples land in CLEAR", () => {
  const { st, transitions } = run([["CLEAR", 0], ["CLEAR", 1]]);
  assert.equal(st.mode, "CLEAR");
  assert.deepEqual(transitions, [{ kind: "acquired", mode: "CLEAR", at: T0 }]);
  assert.equal(st.event, null);
});

test("acquisition into JAMMED opens an event with no onset time", () => {
  const { st, transitions } = run([["DEGRADED", 0], ["DEGRADED", 1]]);
  assert.equal(st.mode, "JAMMED");
  assert.deepEqual(transitions, [{ kind: "acquired", mode: "JAMMED", at: T0 }]);
  assert.equal(st.event.onsetTs, null);
  assert.equal(st.event.openedTs, T0 + SLOT);
});

test("one sample is not enough to acquire", () => {
  const { st } = run([["CLEAR", 0], ["DEGRADED", 1], ["CLEAR", 2]]);
  assert.equal(st.mode, "ACQUIRING");
});

const clear = () => run([["CLEAR", 0], ["CLEAR", 1]]).st;

test("onset needs two consecutive DEGRADED slots and is dated at the run start", () => {
  const { st, transitions } = run([["DEGRADED", 5], ["DEGRADED", 6]], clear());
  assert.equal(st.mode, "JAMMED");
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].kind, "onset");
  assert.equal(transitions[0].at, T0 + 5 * SLOT);
  assert.equal(st.since, T0 + 5 * SLOT);
  assert.equal(st.event.onsetTs, T0 + 5 * SLOT);
});

test("MIXED, UNKNOWN or a missing slot breaks a run", () => {
  for (const middle of [[["MIXED", 6]], [["UNKNOWN", 6]], []]) {
    const { st, transitions } = run([["DEGRADED", 5], ...middle, ["DEGRADED", 7]], clear());
    assert.equal(st.mode, "CLEAR", JSON.stringify(middle));
    assert.equal(transitions.length, 0);
  }
});

test("offset needs six consecutive CLEAR slots, dated at the run start", () => {
  const jammed = run([["DEGRADED", 5], ["DEGRADED", 6]], clear()).st;
  const five = run([...seq("CLEAR", 7, 5), ["MIXED", 12], ["CLEAR", 13]], jammed);
  assert.equal(five.st.mode, "JAMMED");
  const six = run(seq("CLEAR", 7, 6), jammed);
  assert.equal(six.st.mode, "CLEAR");
  assert.equal(six.transitions.length, 1);
  const t = six.transitions[0];
  assert.equal(t.kind, "offset");
  assert.equal(t.at, T0 + 7 * SLOT);
  assert.equal(t.event.onsetTs, T0 + 5 * SLOT);
  assert.equal(t.event.gapped, false);
  assert.equal(six.st.event, null);
});

test("an open event tracks its peak, including the samples of the onset run", () => {
  const { st } = run(
    [["DEGRADED", 5, { n_elig: 40, n_bad: 20 }], ["DEGRADED", 6, { n_elig: 40, n_bad: 8 }], ["DEGRADED", 7, { n_elig: 50, n_bad: 15 }]],
    clear(),
  );
  assert.equal(st.event.peakP, 0.5);
  assert.equal(st.event.peakN, 40);
});

test("stale after 2 h without data; the state is kept; an offset after the gap is flagged", () => {
  const jammed = run([["DEGRADED", 5], ["DEGRADED", 6]], clear()).st;
  const quiet = run(seq("UNKNOWN", 7, 12), jammed).st; // slots 7..18, last data at 6
  assert.equal(isStale(quiet, T0 + 17 * SLOT), false); // 1 h 50 min
  assert.equal(isStale(quiet, T0 + 18 * SLOT), true); // 2 h
  assert.equal(quiet.mode, "JAMMED");
  const back = run(seq("CLEAR", 19, 6), quiet);
  assert.equal(isStale(back.st, T0 + 24 * SLOT), false);
  assert.equal(back.transitions[0].kind, "offset");
  assert.equal(back.transitions[0].event.gapped, true);
});

test("data coming back after a gap without a stale period is not a gap", () => {
  const jammed = run([["DEGRADED", 5], ["DEGRADED", 6]], clear()).st;
  const back = run([...seq("UNKNOWN", 7, 11), ...seq("CLEAR", 18, 6)], jammed); // last data 6, back at 18 = exactly 2 h
  assert.equal(back.transitions[0].event.gapped, false);
});

test("a never-seen zone is not stale, just acquiring", () => {
  assert.equal(isStale(initialZoneState(), T0), false);
});
