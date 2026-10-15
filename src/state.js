// The zone state machine (spec 3.5). The only code that builds a ZoneState. Pure: one sample in, next state out.
import { ACQUIRE_RUN, OFFSET_RUN, ONSET_RUN, STALE_MS } from "./config.js";
import { SLOT } from "./time.js";

/**
 * @typedef {{cls:string, start:number, last:number, len:number, maxP:number, maxN:number}} Run
 *   consecutive 10-minute slots with the same class; a missing slot or another class ends it
 * @typedef {{openedTs:number, onsetTs:number|null, peakP:number, peakN:number, gapped:boolean}} OpenEvent
 *   onsetTs is null when the zone was already jammed when watching began
 * @typedef {{mode:"ACQUIRING"|"CLEAR"|"JAMMED", since:number|null, run:Run|null, lastDataSlot:number|null,
 *   event:OpenEvent|null}} ZoneState  event is set exactly when mode is JAMMED
 * @typedef {{kind:"acquired", mode:"CLEAR"|"JAMMED", at:number}
 *   | {kind:"onset", at:number} | {kind:"offset", at:number, event:OpenEvent}} Transition
 */

/** @returns {ZoneState} */
export function initialZoneState() {
  return { mode: "ACQUIRING", since: null, run: null, lastDataSlot: null, event: null };
}

/** No non-UNKNOWN sample for 2 h. A zone that never had data is acquiring, not stale. */
export function isStale(z, slot) {
  return z.lastDataSlot !== null && slot - z.lastDataSlot >= STALE_MS;
}

/**
 * @param {ZoneState} prev
 * @param {{slot:number, cls:string, n_elig:number, n_bad:number}} s
 * @returns {{next: ZoneState, transition: Transition|null}}
 */
export function advance(prev, s) {
  const p = s.n_elig ? s.n_bad / s.n_elig : 0;
  const r = prev.run;
  const run =
    r && r.cls === s.cls && s.slot === r.last + SLOT
      ? { ...r, last: s.slot, len: r.len + 1, ...(p > r.maxP ? { maxP: p, maxN: s.n_elig } : {}) }
      : { cls: s.cls, start: s.slot, last: s.slot, len: 1, maxP: p, maxN: s.n_elig };

  let next = { ...prev, run };
  if (s.cls !== "UNKNOWN") {
    const cameBack = prev.lastDataSlot !== null && s.slot - prev.lastDataSlot > STALE_MS;
    next.lastDataSlot = s.slot;
    if (next.event) {
      next.event = { ...next.event, gapped: next.event.gapped || cameBack };
      if (p > next.event.peakP) next.event = { ...next.event, peakP: p, peakN: s.n_elig };
    }
  }

  const jam = (onsetTs) => ({
    ...next,
    mode: "JAMMED",
    since: run.start,
    event: { openedTs: s.slot, onsetTs, peakP: run.maxP, peakN: run.maxN, gapped: false },
  });

  if (prev.mode === "ACQUIRING") {
    if (run.cls === "CLEAR" && run.len >= ACQUIRE_RUN) {
      return { next: { ...next, mode: "CLEAR", since: run.start }, transition: { kind: "acquired", mode: "CLEAR", at: run.start } };
    }
    if (run.cls === "DEGRADED" && run.len >= ACQUIRE_RUN) {
      return { next: jam(null), transition: { kind: "acquired", mode: "JAMMED", at: run.start } };
    }
  } else if (prev.mode === "CLEAR") {
    if (run.cls === "DEGRADED" && run.len >= ONSET_RUN) {
      return { next: jam(run.start), transition: { kind: "onset", at: run.start } };
    }
  } else if (prev.mode === "JAMMED") {
    if (run.cls === "CLEAR" && run.len >= OFFSET_RUN) {
      return {
        next: { ...next, mode: "CLEAR", since: run.start, event: null },
        transition: { kind: "offset", at: run.start, event: next.event },
      };
    }
  }
  return { next, transition: null };
}
