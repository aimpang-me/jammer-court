// Pure measurement rules: which aircraft count, how a zone sample is classed, what "usual" means, and the daily rollup.
import {
  ARTEFACT_TYPES,
  BAD_NIC,
  CLEAR_P,
  DEGRADED_MIN_BAD,
  DEGRADED_MIN_TYPES,
  DEGRADED_P,
  GREEN_PCT,
  MAX_SEEN_POS_S,
  MIN_ALT_FT,
  NOISY_CONTROLS,
  RED_PCT,
  USUAL_MIN_DAYS,
  USUAL_WINDOW_MS,
  WILSON_MIN,
} from "./config.js";
import { DAY, HOUR, dayOf } from "./time.js";
import { ZONE_BY_ID } from "./zones.js";

/** @returns {null|"not_v2"|"no_nic"|"low_or_ground"|"stale_pos"|"artefact_type"} null means the aircraft counts. */
export function ineligibleReason(a) {
  if (a.version !== 2) return "not_v2";
  if (typeof a.nic !== "number") return "no_nic";
  if (typeof a.alt !== "number" || a.alt < MIN_ALT_FT) return "low_or_ground";
  if (typeof a.seenPos !== "number" || a.seenPos > MAX_SEEN_POS_S) return "stale_pos";
  if (a.type && ARTEFACT_TYPES.includes(a.type)) return "artefact_type";
  return null;
}

export function wilsonLower(k, n, z = 1.96) {
  if (n <= 0 || k <= 0) return 0;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/** @returns {"UNKNOWN"|"CLEAR"|"MIXED"|"DEGRADED"} */
export function classify({ n_elig, n_bad, types_bad }, minN) {
  if (!n_elig || n_elig < minN) return "UNKNOWN";
  const p = n_bad / n_elig;
  if (
    p >= DEGRADED_P &&
    n_bad >= DEGRADED_MIN_BAD &&
    types_bad >= DEGRADED_MIN_TYPES &&
    wilsonLower(n_bad, n_elig) >= WILSON_MIN
  ) {
    return "DEGRADED";
  }
  return p < CLEAR_P ? "CLEAR" : "MIXED";
}

/**
 * One sample per zone, in zone order. Each hex counts once per tick: its position is taken from the first response
 * (zone order) that contained it, and it is assigned to the nearest centre among the zones whose responses contained it.
 * Hex codes live only inside this function.
 * @param {{id:string,lat:number,lon:number,min_n:number}[]} zones
 * @param {({zone:string,ok:true,src:string,aircraft:object[]}|{zone:string,ok:false,src:string,code:string})[]} fetches
 */
export function sampleZones(zones, fetches, slot) {
  const byZone = new Map(fetches.map((f) => [f.zone, f]));
  const seen = new Map(); // hex -> { a, candidates: Set<zoneIndex> }
  zones.forEach((z, i) => {
    const f = byZone.get(z.id);
    if (!f?.ok) return;
    for (const a of f.aircraft) {
      const entry = seen.get(a.hex);
      if (entry) entry.candidates.add(i);
      else seen.set(a.hex, { a, candidates: new Set([i]) });
    }
  });
  const assigned = zones.map(() => []);
  for (const { a, candidates } of seen.values()) {
    let best = -1;
    let bestD = Infinity;
    for (const i of candidates) {
      const d = distanceKm(a.lat, a.lon, zones[i].lat, zones[i].lon);
      if (d < bestD) [best, bestD] = [i, d];
    }
    assigned[best].push(a);
  }
  return zones.map((z, i) => {
    const f = byZone.get(z.id);
    if (!f?.ok) {
      return { zone: z.id, slot, src: f?.src ?? "none", n_all: 0, n_elig: 0, n_bad: 0, n_nic0: 0, types_bad: 0, cls: "UNKNOWN" };
    }
    const elig = assigned[i].filter((a) => ineligibleReason(a) === null);
    const bad = elig.filter((a) => a.nic < BAD_NIC);
    const counts = {
      n_all: assigned[i].length,
      n_elig: elig.length,
      n_bad: bad.length,
      n_nic0: bad.filter((a) => a.nic === 0).length,
      types_bad: new Set(bad.map((a) => a.type).filter(Boolean)).size,
    };
    return { zone: z.id, slot, src: f.src, ...counts, cls: classify(counts, z.min_n) };
  });
}

/** Great-circle distance in km (also used by tools/gen-cells.mjs). */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/**
 * "Usual" for a zone at an hour: the median sample fraction over the last 14 days of that hour's non-UNKNOWN samples.
 * @param {{slot:number,n_elig:number,n_bad:number,cls:string}[]} rows that zone's samples
 * @returns {{pct:number|null, days:number, reason:string|null}} pct is a fraction (0..1)
 */
export function usualPct(rows, hourUTC, now) {
  const from = now - USUAL_WINDOW_MS;
  const ps = [];
  const days = new Set();
  for (const r of rows) {
    if (r.cls === "UNKNOWN" || !r.n_elig || r.slot < from || r.slot > now) continue;
    if (Math.floor((r.slot % DAY) / HOUR) !== hourUTC) continue;
    ps.push(r.n_bad / r.n_elig);
    days.add(dayOf(r.slot));
  }
  if (days.size < USUAL_MIN_DAYS) {
    return { pct: null, days: days.size, reason: `warming up (${days.size} of ${USUAL_MIN_DAYS} days)` };
  }
  ps.sort((a, b) => a - b);
  const mid = ps.length >> 1;
  return { pct: ps.length % 2 ? ps[mid] : (ps[mid - 1] + ps[mid]) / 2, days: days.size, reason: null };
}

/** Fraction bad over several samples, pooled by counts. */
export function pooledP(rows) {
  let k = 0;
  let n = 0;
  for (const r of rows) {
    k += r.n_bad;
    n += r.n_elig;
  }
  return n ? k / n : null;
}

/** gpsjam's colour lines, applied to a percentage. */
export function category(pct) {
  if (pct == null) return null;
  if (pct < GREEN_PCT) return "green";
  return pct > RED_PCT ? "red" : "yellow";
}

/** Daily rows for every zone, aircraft-sample weighted over that day's non-UNKNOWN samples. */
export function rollupDay(day, daySamples, zones) {
  return zones.map((z) => {
    let k = 0;
    let n = 0;
    let samples = 0;
    let degraded = 0;
    for (const s of daySamples) {
      if (s.zone !== z.id || s.cls === "UNKNOWN") continue;
      k += s.n_bad;
      n += s.n_elig;
      samples += 1;
      if (s.cls === "DEGRADED") degraded += 1;
    }
    const pct = n ? (100 * k) / n : null;
    return { day, zone: z.id, k, n, pct, cat: category(pct), samples, degraded };
  });
}

/** The control zones DEGRADED in one tick's samples; NOISY_CONTROLS or more of them make the tick "controls noisy". */
export const degradedControls = (samples) => samples.filter((s) => s.cls === "DEGRADED" && ZONE_BY_ID.get(s.zone).role === "control");
export const controlsNoisy = (samples) => degradedControls(samples).length >= NOISY_CONTROLS;
