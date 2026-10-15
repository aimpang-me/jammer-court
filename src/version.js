// The release, and a fingerprint of everything the sampler and the Worker must agree on: the release (which fixes the
// shape of a posted sample), the zones and their gpsjam cells. The sampler stops with "version mismatch" when its
// fingerprint differs from the deployed Worker's (SPEC.md 4.4). package.json carries the same release (a test checks).
import { ZONE_CELLS } from "./zone_cells.js";
import { ZONES } from "./zones.js";

export const VERSION = "1.4.1";

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export const SAMPLER_VERSION = fnv1a(JSON.stringify({ VERSION, ZONES, ZONE_CELLS }));
