// Small builders shared by the pure-module tests.
import { SLOT } from "../src/time.js";

export const T0 = Date.parse("2026-10-15T00:00:00Z");
let seq = 0;

/** A clean, eligible airliner; override any field. */
export function ac(over = {}) {
  seq += 1;
  return { hex: `h${seq}`, version: 2, nic: 8, alt: 35000, seenPos: 1, type: "B738", lat: 57, lon: 20, ...over };
}

/** n aircraft of which `bad` have nic 0, spread over `types` types. */
export function crowd(n, bad, { types = ["B738", "A320", "B77W", "E190"], lat = 57, lon = 20 } = {}) {
  return Array.from({ length: n }, (_, i) =>
    ac({ nic: i < bad ? 0 : 8, type: types[i % types.length], lat, lon }),
  );
}

/** A ZoneSample with a class, for state-machine tests. */
export function sample(cls, slotIndex, { zone = "baltic", n_elig = 40, n_bad = cls === "DEGRADED" ? 12 : 0 } = {}) {
  return {
    zone,
    slot: T0 + slotIndex * SLOT,
    src: cls === "UNKNOWN" ? "none" : "lol",
    n_all: n_elig,
    n_elig: cls === "UNKNOWN" ? 0 : n_elig,
    n_bad: cls === "UNKNOWN" ? 0 : n_bad,
    n_nic0: 0,
    types_bad: n_bad ? 3 : 0,
    cls,
  };
}
