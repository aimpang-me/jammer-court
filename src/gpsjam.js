// The accuracy witness: gpsjam.org's daily per-cell counts, summed over each zone's H3 cells, and the agreement score.
import { COMPARABLE_GJ_N, COMPARABLE_N, GPSJAM_MAX_BYTES, RED_PCT } from "./config.js";

const HEADER = "hex,count_good_aircraft,count_bad_aircraft";

export const gpsjamUrl = (day) => `https://gpsjam.org/data/${day}-h3_4.csv`;

/**
 * Feed the CSV one line at a time; line() returns false when the parse must stop.
 * Both sides of the comparison are fractions of aircraft observations, never distinct airframes.
 * @param {Record<string,string[]>} zoneCells
 */
export function createAggregator(zoneCells, { maxBytes = GPSJAM_MAX_BYTES } = {}) {
  const zoneOf = new Map();
  for (const [zone, cells] of Object.entries(zoneCells)) for (const c of cells) zoneOf.set(c, zone);
  const perZone = {};
  let bytes = 0;
  let header = false;
  let failed = null;
  return {
    line(raw) {
      if (failed) return false;
      bytes += raw.length + 1;
      if (bytes > maxBytes) {
        failed = "TOO_LARGE";
        return false;
      }
      const s = raw.trim();
      if (!header) {
        if (s !== HEADER) {
          failed = "FORMAT_CHANGED";
          return false;
        }
        header = true;
        return true;
      }
      if (!s) return true;
      const [cell, good, bad] = s.split(",");
      const zone = zoneOf.get(cell);
      if (!zone) return true;
      const g = Number(good);
      const b = Number(bad);
      if (!Number.isFinite(g) || !Number.isFinite(b)) return true;
      const z = (perZone[zone] ??= { gj_k: 0, gj_n: 0 });
      z.gj_k += b;
      z.gj_n += g + b;
      return true;
    },
    result() {
      if (failed) return { ok: false, code: failed };
      if (!header) return { ok: false, code: "EMPTY" };
      return { ok: true, perZone };
    },
  };
}

// The aggregator's own refusals. A retry won't change them, so that day is done; anything else (404, network) retries.
const FINAL_CODES = new Set(["FORMAT_CHANGED", "TOO_LARGE", "EMPTY"]);
/** gpsjam's file is done for that day: read, or refused in a way a retry won't change. */
export const isFinalGpsjam = (g) => g.ok || FINAL_CODES.has(g.code);

/**
 * One zone-day against gpsjam: comparable when we saw at least 100 aircraft samples and gpsjam at least 50
 * cell-aircraft. agree is red vs not red on both sides; diff is the absolute difference in percentage points.
 * @param {{n:number|null, pct:number|null, gj_n:number|null, gj_pct:number|null}} r
 */
export function judgeDay(r) {
  const comparable = r.n >= COMPARABLE_N && r.gj_n >= COMPARABLE_GJ_N && r.pct != null && r.gj_pct != null;
  return {
    comparable,
    agree: comparable ? r.pct > RED_PCT === r.gj_pct > RED_PCT : null,
    diff: comparable ? Math.abs(r.pct - r.gj_pct) : null,
  };
}

/**
 * Comparable count, agreements and mean absolute difference (percentage points) over rows that carry judgeDay's fields.
 * @param {{comparable:boolean, agree:boolean|null, diff:number|null}[]} judged
 */
export function tally(judged) {
  const c = judged.filter((r) => r.comparable);
  return { comparable: c.length, agree: c.filter((r) => r.agree).length, mad: c.length ? c.reduce((t, r) => t + r.diff, 0) / c.length : null };
}

/** tally per zone and overall. @param {{zone:string, comparable:boolean, agree:boolean|null, diff:number|null}[]} judged */
export function agreement(judged) {
  const zones = [...new Set(judged.map((r) => r.zone))];
  return { perZone: Object.fromEntries(zones.map((z) => [z, tally(judged.filter((r) => r.zone === z))])), overall: tally(judged) };
}
