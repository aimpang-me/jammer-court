// The tick's brain. Pure: (memory, observations, context) in, one TickPlan out. store.commit() writes the plan verbatim.
import { LOL_AUTH_PAUSE_MS, LOL_AUTH_STREAK, WRITES_GUARD } from "./config.js";
import { isFinalGpsjam } from "./gpsjam.js";
import { category, controlsNoisy as noisy, rollupDay, sampleZones } from "./metric.js";
import { advance, initialZoneState } from "./state.js";
import { sunVerdict } from "./sun.js";
import { DAY, SLOT, dayOf } from "./time.js";
import { ZONES } from "./zones.js";

/**
 * Everything the tick carries between slots, stored as one JSON value. Only store.commit() writes it.
 * @typedef {{zones:Record<string,import("./state.js").ZoneState>, swpcOkTs:number|null, gpsjamDay:string|null,
 *   rolledDay:string|null, lolAuthStreak:number, pauses:{lolUntil:number, fiUntil:number}}} Memory
 */
export function initialMemory() {
  return {
    zones: Object.fromEntries(ZONES.map((z) => [z.id, initialZoneState()])),
    swpcOkTs: null,
    gpsjamDay: null,
    rolledDay: null,
    lolAuthStreak: 0,
    pauses: { lolUntil: 0, fiUntil: 0 },
  };
}

/**
 * What this tick must fetch or roll up besides the zones.
 * @returns {{swpc:boolean, gpsjamDay:string|null, rollupDay:string|null}}
 */
export function dueThisTick(memory, slot) {
  const minuteOfDay = (slot % DAY) / 60_000;
  const yesterday = dayOf(slot - DAY);
  return {
    swpc: (slot / SLOT) % 3 === 0 || memory.swpcOkTs === null,
    gpsjamDay: minuteOfDay >= 30 && minuteOfDay < 720 && memory.gpsjamDay !== yesterday ? yesterday : null,
    rollupDay: minuteOfDay >= 10 && memory.rolledDay !== yesterday ? yesterday : null,
  };
}

/**
 * @param {{slot:number, now:number, due:ReturnType<typeof dueThisTick>, memory:Memory, obs:object, ctx:object,
 *   ms:number}} input
 */
export function planTick({ slot, now, due, memory, obs, ctx, ms }) {
  const samples = sampleZones(ZONES, obs.zones, slot);
  const newAlerts = obs.swpc?.ok ? obs.swpc.alerts : [];
  const swpcOkTs = obs.swpc?.ok ? now : memory.swpcOkTs;
  const alerts = [...ctx.alerts, ...newAlerts];

  const controlsNoisy = noisy(samples);

  const zones = {};
  const events = [];
  for (const s of samples) {
    const prev = memory.zones[s.zone] ?? initialZoneState();
    const { next, transition: t } = advance(prev, s);
    zones[s.zone] = next;
    if (!t) continue;
    if (t.kind === "acquired") {
      if (t.mode === "JAMMED") events.push({ op: "open", zone: s.zone, openedTs: slot, onsetTs: null, sun: null });
    } else if (t.kind === "onset") {
      const sun = sunVerdict({ alerts, at: t.at, swpcOkTs, now, controlsNoisy });
      events.push({ op: "open", zone: s.zone, openedTs: slot, onsetTs: t.at, sun: sun.verdict });
    } else {
      events.push({
        op: "close",
        zone: s.zone,
        offsetTs: t.at,
        closedTs: slot,
        peakPct: 100 * t.event.peakP,
        peakN: t.event.peakN,
        afterGap: t.event.gapped,
      });
    }
  }

  // adsb.lol refusing: pause it for an hour after 3 refused ticks. The tick notes carry the status codes.
  let lolAuthStreak = memory.lolAuthStreak;
  const pauses = { ...memory.pauses, ...obs.pauses };
  if (obs.lolOk) lolAuthStreak = 0;
  else if (obs.lolAuthFailed) lolAuthStreak += 1;
  let lolPaused = false;
  if (lolAuthStreak >= LOL_AUTH_STREAK) {
    lolAuthStreak = 0;
    pauses.lolUntil = now + LOL_AUTH_PAUSE_MS;
    lolPaused = true;
  }

  const daily = due.rollupDay ? rollupDay(due.rollupDay, ctx.daySamples, ZONES).filter((r) => r.samples > 0) : [];
  let gpsjamDay = memory.gpsjamDay;
  let gpsjam = [];
  if (obs.gpsjam) {
    const { day, ok, perZone } = obs.gpsjam;
    if (ok) {
      gpsjam = ZONES.map((z) => {
        const { gj_k = 0, gj_n = 0 } = perZone[z.id] ?? {};
        const gj_pct = gj_n ? (100 * gj_k) / gj_n : null;
        return { day, zone: z.id, gj_k, gj_n, gj_pct, gj_cat: category(gj_pct) };
      });
    }
    if (isFinalGpsjam(obs.gpsjam)) gpsjamDay = day; // done, or skipped
  }

  const okZones = obs.zones.filter((z) => z.ok).length;
  const notes = [obs.notes, controlsNoisy ? "controls_noisy" : null, lolPaused ? "lol_paused_1h" : null].filter(Boolean).join("; ");
  return {
    slot,
    samples,
    events,
    daily,
    gpsjam,
    alerts: newAlerts,
    controlsNoisy,
    tick: { slot, ok_zones: okZones, subreqs: obs.requests, ms, notes },
    prune: Boolean(due.rollupDay) && ctx.writesToday <= WRITES_GUARD,
    memory: {
      zones,
      swpcOkTs,
      gpsjamDay,
      rolledDay: due.rollupDay ?? memory.rolledDay,
      lolAuthStreak,
      pauses,
    },
  };
}
