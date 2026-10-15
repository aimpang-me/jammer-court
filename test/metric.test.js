import { test } from "node:test";
import assert from "node:assert/strict";
import {
  category,
  classify,
  ineligibleReason,
  pooledP,
  rollupDay,
  sampleZones,
  usualPct,
  wilsonLower,
} from "../src/metric.js";
import { ZONES } from "../src/zones.js";
import { DAY, HOUR, SLOT } from "../src/time.js";
import { T0, ac, crowd } from "./helpers.js";

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} vs ${b}`);

test("Wilson lower bound known answers", () => {
  near(wilsonLower(13, 59), 0.1335);
  near(wilsonLower(3, 20), 0.0524);
  near(wilsonLower(5, 20), 0.1119);
  assert.equal(wilsonLower(0, 30), 0);
  assert.equal(wilsonLower(0, 0), 0);
});

test("each eligibility rule", () => {
  assert.equal(ineligibleReason(ac()), null);
  assert.equal(ineligibleReason(ac({ version: 0 })), "not_v2");
  assert.equal(ineligibleReason(ac({ version: null })), "not_v2");
  assert.equal(ineligibleReason(ac({ nic: null })), "no_nic");
  assert.equal(ineligibleReason(ac({ alt: null })), "low_or_ground");
  assert.equal(ineligibleReason(ac({ alt: 999 })), "low_or_ground");
  assert.equal(ineligibleReason(ac({ alt: 1000 })), null);
  assert.equal(ineligibleReason(ac({ seenPos: 61 })), "stale_pos");
  assert.equal(ineligibleReason(ac({ seenPos: null })), "stale_pos");
  assert.equal(ineligibleReason(ac({ seenPos: 60 })), null);
  for (const t of ["A359", "A35K", "A388"]) assert.equal(ineligibleReason(ac({ type: t })), "artefact_type");
  assert.equal(ineligibleReason(ac({ type: null })), null);
});

test("class boundaries", () => {
  const c = (n_elig, n_bad, types_bad = 2, min = 8) => classify({ n_elig, n_bad, types_bad }, min);
  assert.equal(c(30, 3), "DEGRADED"); // p exactly 0.10
  assert.equal(c(40, 2), "MIXED"); // 5% exactly is not clear
  assert.equal(c(41, 2), "CLEAR"); // 4.9%
  assert.equal(c(20, 2), "MIXED"); // 10% but only 2 bad
  assert.equal(c(20, 4, 1), "MIXED"); // a single type never corroborates
  assert.equal(c(7, 3, 2, 8), "UNKNOWN"); // under min_n
  assert.equal(classify({ n_elig: 0, n_bad: 0, types_bad: 0 }, 0), "UNKNOWN");
});

test("the Wilson gate is a backstop: with 3 or more bad at 10% or more, its lower bound is always at least 0.02", () => {
  // Spec 7.2 asks for "a Wilson value just below 0.02". No such sample passes the other DEGRADED rules, so pin that fact
  // (docs/METHOD.md says so) and check the gate itself still works on its own inputs.
  for (let n = 3; n <= 400; n++) {
    for (let k = Math.max(3, Math.ceil(0.1 * n)); k <= n; k++) assert.ok(wilsonLower(k, n) >= 0.02, `${k}/${n}`);
  }
  assert.ok(wilsonLower(1, 10) < 0.02);
  assert.equal(classify({ n_elig: 4, n_bad: 3, types_bad: 2 }, 4), "DEGRADED");
});

test("sampleZones counts, and failed zones are UNKNOWN", () => {
  const z = ZONES.slice(0, 2); // baltic, gulf_finland
  const slot = T0;
  const fetches = [
    { zone: "baltic", ok: true, src: "lol", aircraft: [...crowd(20, 4, { lat: 57, lon: 20 }), ac({ version: 0 }), ac({ type: "A359", nic: 0 })] },
    { zone: "gulf_finland", ok: false, src: "none", code: "http_503" },
  ];
  const [b, g] = sampleZones(z, fetches, slot);
  assert.deepEqual(
    { n_all: b.n_all, n_elig: b.n_elig, n_bad: b.n_bad, n_nic0: b.n_nic0, types_bad: b.types_bad, cls: b.cls, src: b.src },
    { n_all: 22, n_elig: 20, n_bad: 4, n_nic0: 4, types_bad: 4, cls: "DEGRADED", src: "lol" },
  );
  assert.equal(g.cls, "UNKNOWN");
  assert.equal(g.src, "none");
  assert.equal(g.n_all, 0);
  assert.equal(b.slot, slot);
});

test("dedupe: an aircraft in two responses counts once, in the nearest zone that returned it, by its first position", () => {
  const z = [ZONES.find((x) => x.id === "gulf_finland"), ZONES.find((x) => x.id === "vilnius")];
  const shared = ac({ hex: "dup", lat: 59.9, lon: 25.4, nic: 0 }); // near Gulf of Finland centre
  const moved = { ...shared, lat: 54.8, lon: 25.3 }; // later response says near Vilnius
  const fetches = [
    { zone: "gulf_finland", ok: true, src: "lol", aircraft: [shared] },
    { zone: "vilnius", ok: true, src: "lol", aircraft: [moved] },
  ];
  const [gf, vn] = sampleZones(z, fetches, T0);
  assert.equal(gf.n_all, 1);
  assert.equal(vn.n_all, 0);
  // The first response's position decides: put the first position near Vilnius instead.
  const first = { ...shared, lat: 54.7, lon: 25.3 };
  const [gf2, vn2] = sampleZones(z, [
    { zone: "gulf_finland", ok: true, src: "lol", aircraft: [first] },
    { zone: "vilnius", ok: true, src: "lol", aircraft: [{ ...shared }] },
  ], T0);
  assert.equal(gf2.n_all, 0);
  assert.equal(vn2.n_all, 1);
  // A zone whose response did not contain it can't take it, even if nearer.
  const [gf3, vn3] = sampleZones(z, [
    { zone: "gulf_finland", ok: true, src: "lol", aircraft: [first] },
    { zone: "vilnius", ok: false, src: "none", code: "http_500" },
  ], T0);
  assert.equal(gf3.n_all, 1);
  assert.equal(vn3.cls, "UNKNOWN");
});

test("usualPct warms up for 7 days, then takes the same-hour median over 14 days", () => {
  const now = T0 + 20 * DAY + 5 * HOUR;
  const row = (dayBack, p, cls = "MIXED", hour = 5) => ({
    slot: T0 + (20 - dayBack) * DAY + hour * HOUR,
    n_elig: 100,
    n_bad: Math.round(p * 100),
    cls,
  });
  const six = [1, 2, 3, 4, 5, 6].map((d) => row(d, 0.2));
  assert.deepEqual(usualPct(six, 5, now), { pct: null, days: 6, reason: "warming up (6 of 7 days)" });
  const rows = [...six, row(7, 0.3), row(8, 0.1), row(3, 0.9, "UNKNOWN"), row(2, 0.9, "MIXED", 6), row(15, 0.9)];
  const u = usualPct(rows, 5, now);
  assert.equal(u.days, 8);
  assert.equal(u.reason, null);
  near(u.pct, 0.2);
});

test("pooledP pools counts, not fractions", () => {
  near(pooledP([{ n_bad: 1, n_elig: 10 }, { n_bad: 9, n_elig: 90 }, { n_bad: 0, n_elig: 0 }]), 0.1);
  assert.equal(pooledP([]), null);
});

test("category lines", () => {
  assert.equal(category(1.99), "green");
  assert.equal(category(2), "yellow");
  assert.equal(category(10), "yellow");
  assert.equal(category(10.01), "red");
  assert.equal(category(null), null);
});

test("rollupDay sums non-UNKNOWN samples per zone", () => {
  const day = "2026-10-15";
  const s = (zone, i, n_elig, n_bad, cls) => ({ zone, slot: T0 + i * SLOT, n_elig, n_bad, cls });
  const rows = rollupDay(day, [
    s("baltic", 0, 50, 10, "DEGRADED"),
    s("baltic", 1, 60, 5, "MIXED"),
    s("baltic", 2, 0, 0, "UNKNOWN"),
    s("ctl_london", 0, 40, 0, "CLEAR"),
  ], ZONES);
  const b = rows.find((r) => r.zone === "baltic");
  assert.deepEqual(b, { day, zone: "baltic", k: 15, n: 110, pct: (100 * 15) / 110, cat: "red", samples: 2, degraded: 1 });
  const l = rows.find((r) => r.zone === "ctl_london");
  assert.equal(l.cat, "green");
  const empty = rows.find((r) => r.zone === "punjab");
  assert.deepEqual(empty, { day, zone: "punjab", k: 0, n: 0, pct: null, cat: null, samples: 0, degraded: 0 });
  assert.equal(rows.length, ZONES.length);
});
