// The shape check for a sample posted to /ingest (SPEC.md 4.4). It mirrors what observe() returns, so a
// posted sample can't reach planTick in a form observe() would never produce.
import { FI_PAUSE_MS, LOL_AUTH_PAUSE_MS } from "./config.js";
import { KIND_LABELS } from "./sun.js";
import { SLOT } from "./time.js";
import { ZONES, ZONE_BY_ID } from "./zones.js";

export const MAX_INGEST = 2 * 1024 * 1024; // the body limit also bounds the aircraft and alert lists

const num = (v) => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v) => v === null || num(v);
const str = (v, max) => typeof v === "string" && v.length <= max;
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const code = (v) => num(v) || str(v, 200);

function aircraftOk(a) {
  return (
    obj(a) &&
    str(a.hex, 16) &&
    num(a.lat) &&
    num(a.lon) &&
    numOrNull(a.version) &&
    numOrNull(a.nic) &&
    numOrNull(a.alt) &&
    numOrNull(a.seenPos) &&
    (a.type === null || str(a.type, 16))
  );
}

function zoneOk(f, i) {
  if (!obj(f) || f.zone !== ZONES[i].id || typeof f.ok !== "boolean" || !str(f.src, 8)) return false;
  if (!f.ok) return f.code === undefined || code(f.code);
  return Array.isArray(f.aircraft) && f.aircraft.every(aircraftOk);
}

function swpcOk(s, due) {
  if (!due.swpc) return s === null;
  if (s === null) return true;
  if (!obj(s) || typeof s.ok !== "boolean") return false;
  if (!s.ok) return code(s.code);
  return (
    Array.isArray(s.alerts) &&
    s.alerts.every((a) => obj(a) && str(a.productId, 64) && num(a.issued) && Object.hasOwn(KIND_LABELS, a.kind))
  );
}

function gpsjamOk(g, due) {
  if (!due.gpsjamDay) return g === null;
  if (g === null) return true;
  if (!obj(g) || g.day !== due.gpsjamDay || typeof g.ok !== "boolean") return false;
  if (!g.ok) return code(g.code);
  return (
    obj(g.perZone) &&
    Object.entries(g.perZone).every(([z, v]) => ZONE_BY_ID.has(z) && obj(v) && num(v.gj_k) && num(v.gj_n) && v.gj_k >= 0 && v.gj_n >= v.gj_k)
  );
}

/** @returns {string|null} what is wrong with the body's top level, checked before its slot and due are compared */
export function checkEnvelope(body) {
  if (!obj(body) || !num(body.slot) || !obj(body.due) || !obj(body.obs) || !num(body.ms)) return "body needs slot, due, obs and ms";
  return null;
}

/** A post is taken for the current slot or the one before it, since GitHub often starts scheduled runs late. */
export const slotOpen = (slot, current) => slot === current || slot === current - SLOT;

/** Only the two known pauses, never longer than the sampler itself would set them. */
export const clampPauses = ({ lolUntil, fiUntil }, now) => ({
  lolUntil: Math.min(lolUntil, now + LOL_AUTH_PAUSE_MS),
  fiUntil: Math.min(fiUntil, now + FI_PAUSE_MS),
});

/** The posted due is the one the Worker computes for that slot, field by field. */
export const sameDue = (a, b) => a.swpc === b.swpc && a.gpsjamDay === b.gpsjamDay && a.rollupDay === b.rollupDay;

/** @returns {string|null} what is wrong with a posted body, or null when it can be recorded */
export function checkIngest(body, due) {
  const o = body.obs;
  if (!Array.isArray(o.zones) || o.zones.length !== ZONES.length || !o.zones.every(zoneOk)) return "obs.zones must be one result per zone, in zone order";
  if (!swpcOk(o.swpc ?? null, due)) return "obs.swpc does not match what is due";
  if (!gpsjamOk(o.gpsjam ?? null, due)) return "obs.gpsjam does not match what is due";
  if (typeof o.lolAuthFailed !== "boolean" || typeof o.lolOk !== "boolean") return "obs.lolAuthFailed and obs.lolOk must be booleans";
  if (!obj(o.pauses) || !num(o.pauses.lolUntil) || !num(o.pauses.fiUntil)) return "obs.pauses needs lolUntil and fiUntil";
  if (!str(o.notes, 500)) return "obs.notes must be a short string";
  if (!num(o.requests) || o.requests < 0) return "obs.requests must be a count";
  return null;
}
