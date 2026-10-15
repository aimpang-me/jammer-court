import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAlert, parseAlerts, sunVerdict } from "../src/sun.js";
import { HOUR } from "../src/time.js";
import { SWPC_ALERTS } from "./fixtures/swpc-alerts.js";

test("classifies live-shaped SWPC items by product id, ignoring unrelated ones", () => {
  assert.deepEqual(SWPC_ALERTS.map(classifyAlert), ["xray_m5", "burst_10cm", "kp5", null, "storm", "proton"]);
  assert.equal(classifyAlert({ product_id: "K04A", message: "ALERT: Geomagnetic K-index of 4" }), null);
  assert.equal(classifyAlert({ product_id: "K07W", message: "" }), "kp5");
  assert.equal(classifyAlert({ product_id: "ZZZZ", message: "WARNING: Geomagnetic Storm Category G2" }), "storm");
  assert.equal(classifyAlert({ product_id: "ZZZZ", message: "SUMMARY: 10cm Radio Burst" }), "burst_10cm");
  assert.equal(classifyAlert(null), null);
});

test("parseAlerts reads issue times as UTC and drops junk", () => {
  const alerts = parseAlerts([...SWPC_ALERTS, { product_id: "XM5A", issue_datetime: "bad" }, "nope"]);
  assert.equal(alerts.length, 5);
  assert.deepEqual(alerts[0], { productId: "XM5A", issued: Date.parse("2026-10-14T15:09:12Z"), kind: "xray_m5" });
  assert.equal(parseAlerts({ not: "an array" }), null);
});

test("verdict uses the 24 h before onset, and goes UNKNOWN when SWPC is stale", () => {
  const alerts = parseAlerts(SWPC_ALERTS);
  const onset = Date.parse("2026-10-14T20:00:00Z");
  const now = onset + HOUR;
  const v = sunVerdict({ alerts, at: onset, swpcOkTs: now - HOUR, now, controlsNoisy: false });
  assert.equal(v.verdict, "ACTIVE");
  assert.deepEqual(v.kinds, ["burst_10cm", "kp5", "xray_m5"]);
  assert.equal(v.text, "Sun active (10 cm radio burst, K-index 5+, M5+ flare).");
  const noisy = sunVerdict({ alerts, at: onset, swpcOkTs: now, now, controlsNoisy: true });
  assert.equal(noisy.text, "Sun active and controls noisy: possible space weather.");
  const later = Date.parse("2026-10-16T12:00:00Z");
  const quiet = sunVerdict({ alerts, at: later, swpcOkTs: later, now: later, controlsNoisy: false });
  assert.deepEqual(quiet, { verdict: "QUIET", kinds: [], text: "Sun quiet." });
  const stale = sunVerdict({ alerts, at: onset, swpcOkTs: now - 3 * HOUR - 1, now, controlsNoisy: false });
  assert.deepEqual(stale, { verdict: "UNKNOWN", kinds: [], text: "Sun check unavailable." });
  assert.equal(sunVerdict({ alerts, at: onset, swpcOkTs: null, now, controlsNoisy: false }).verdict, "UNKNOWN");
  // An alert issued after the onset doesn't count.
  const before = sunVerdict({ alerts, at: Date.parse("2026-10-14T15:00:00Z"), swpcOkTs: now, now, controlsNoisy: false });
  assert.deepEqual(before.kinds, ["kp5"]);
});
