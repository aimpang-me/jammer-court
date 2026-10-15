// The one read model. Built once per tick from stored rows; MCP, the page, the JSON routes and KV all read this value.
// Public content: zone ids and names, counts, percentages and times only.
import { FREE_ROWS_READ, FREE_ROWS_WRITTEN, POOLED_SAMPLES, S7_WRITE_SHARE, UPTIME_MIN_ZONES, WORSE_BY, WRITES_GUARD } from "./config.js";
import { agreement, judgeDay } from "./gpsjam.js";
import { controlsNoisy as noisy, degradedControls, pooledP, usualPct } from "./metric.js";
import { POWER } from "./power.js";
import { isStale } from "./state.js";
import { sunVerdict } from "./sun.js";
import { DAY, HOUR, SLOT, iso } from "./time.js";
import { ZONES, ZONE_BY_ID } from "./zones.js";

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const pctOf = (s) => (s && s.n_elig && s.cls !== "UNKNOWN" ? r1((100 * s.n_bad) / s.n_elig) : null);

/**
 * @param {ReturnType<import("./store.js").Store["snapshotRows"]>} rows
 */
export function buildSnapshot(rows, now) {
  const { memory, lastSlot } = rows;
  const bySlotZone = new Map(rows.samples24h.map((s) => [`${s.zone}@${s.slot}`, s]));
  const lastTickSamples = lastSlot === null ? [] : ZONES.map((z) => bySlotZone.get(`${z.id}@${lastSlot}`)).filter(Boolean);
  const controlsNoisy = noisy(lastTickSamples);
  const controlCount = ZONES.filter((z) => z.role === "control").length;
  const controlsWithData = lastTickSamples.filter((s) => s.cls !== "UNKNOWN" && ZONE_BY_ID.get(s.zone).role === "control").length;
  // One level for every reader (MCP, page): noisy wins over thin, since a noisy tick did hear from its controls.
  const controlsThin = lastSlot !== null && controlsWithData < controlCount / 2;
  const controlsLevel = controlsNoisy ? "noisy" : controlsThin ? "thin" : "clean";
  // A sentinel with a week of daily rows and not one degraded sample is labelled, never silently dropped (spec 2).
  const quiet = new Set(
    ZONES.filter((z) => {
      const days = rows.daily.filter((d) => d.zone === z.id && d.samples > 0);
      return z.role === "sentinel" && days.length >= 7 && days.every((d) => !d.degraded);
    }).map((z) => z.id),
  );
  const hourUTC = Math.floor((now % DAY) / HOUR);

  const zones = ZONES.map((z) => {
    const st = memory.zones[z.id];
    const mine = rows.samples24h.filter((s) => s.zone === z.id);
    const last = lastSlot === null ? null : bySlotZone.get(`${z.id}@${lastSlot}`) ?? null;
    const withData = mine.filter((s) => s.cls !== "UNKNOWN");
    const pooled = pooledP(withData.slice(-POOLED_SAMPLES));
    const usual = usualPct(rows.usualRows.filter((r) => r.zone === z.id), hourUTC, now);
    const spark = [];
    if (lastSlot !== null) {
      for (let i = 143; i >= 0; i--) {
        const s = bySlotZone.get(`${z.id}@${lastSlot - i * SLOT}`);
        spark.push(s ? [pctOf(s), s.cls] : [null, "NONE"]);
      }
    }
    return {
      id: z.id,
      name: z.name,
      role: z.role,
      quiet_sentinel: quiet.has(z.id),
      state: st.mode,
      since: iso(st.since),
      stale: lastSlot !== null && isStale(st, lastSlot),
      cls: last?.cls ?? null,
      pct: pctOf(last),
      n: last?.n_elig ?? null,
      source: last?.src ?? null,
      usual_pct: r1(usual.pct == null ? null : 100 * usual.pct),
      usual_reason: usual.reason,
      pooled_pct: r1(pooled == null ? null : 100 * pooled),
      worse_than_usual: usual.pct != null && pooled != null && pooled - usual.pct >= WORSE_BY,
      event: st.event
        ? { opened: iso(st.event.openedTs), onset: iso(st.event.onsetTs), peak_pct: r1(100 * st.event.peakP), peak_n: st.event.peakN }
        : null,
      recent: mine.slice(-6).reverse().map((s) => ({ at: iso(s.slot), cls: s.cls, pct: pctOf(s), n: s.n_elig, n_bad: s.n_bad, types_bad: s.types_bad, src: s.src })),
      spark,
    };
  });

  const sun = sunVerdict({ alerts: rows.alerts, at: now, swpcOkTs: memory.swpcOkTs, now, controlsNoisy });
  const log = rows.events.map((e) => ({
    zone: e.zone,
    name: ZONE_BY_ID.get(e.zone)?.name ?? e.zone,
    opened: iso(e.opened_ts),
    onset: iso(e.onset_ts),
    offset: iso(e.offset_ts),
    closed: iso(e.closed_ts),
    end_unknown: Boolean(e.orphaned),
    open: e.offset_ts == null,
    peak_pct: e.offset_ts == null ? zones.find((z) => z.id === e.zone)?.event?.peak_pct ?? null : r1(e.peak_pct),
    peak_n: e.peak_n,
    sun: e.sun,
    after_gap: Boolean(e.after_gap),
  }));

  const daily = rows.daily.map((d) => ({ ...dayRow(d), ...judged(judgeDay(d)) }));
  const agree = agreement(daily); // the same judged, rounded rows court_record sums, so the two always agree

  return {
    as_of: iso(now),
    last_slot: iso(lastSlot),
    status: {
      zones,
      controls: { level: controlsLevel, degraded: degradedControls(lastTickSamples).map((s) => ZONE_BY_ID.get(s.zone).name) },
      sun,
      last_tick: rows.lastTick
        ? { at: iso(rows.lastTick.slot), ok_zones: rows.lastTick.ok_zones, subreqs: rows.lastTick.subreqs, ms: rows.lastTick.ms, notes: rows.lastTick.notes }
        : null,
      budget: {
        rows_written_today: rows.writesToday,
        rows_written_limit: FREE_ROWS_WRITTEN,
        rows_read_today: rows.readsToday,
        rows_read_limit: FREE_ROWS_READ,
        writes_guard: rows.writesToday > WRITES_GUARD,
      },
    },
    log,
    record: { daily, agreement: { overall: roundAgree(agree.overall), perZone: mapValues(agree.perZone, roundAgree) }, criteria: criteria(rows, lastSlot, agree) },
  };
}

const dayRow = (d) => ({ day: d.day, zone: d.zone, pct: r1(d.pct), cat: d.cat, n: d.n, gj_pct: r1(d.gj_pct), gj_cat: d.gj_cat, gj_n: d.gj_n });
const judged = ({ comparable, agree, diff }) => ({ comparable, agree, diff: r1(diff) });
const roundAgree = (a) => ({ ...a, mad: r1(a.mad) });
const mapValues = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

// Spec section 1's pass lines. Each criterion's target text below is written from these numbers.
const TARGETS = { uptimePct: 98, balticRedShare: 0.9, controlRedDays: 1, controlDegradedPct: 0.5 };

/** Success criteria S1 to S5 and S7 (spec section 1), each with target, measured value and pass (null while collecting). */
function criteria(rows, lastSlot, agree) {
  const out = [];
  const { n, good, first } = rows.ticks;
  let s1 = { measured: null, pass: null };
  if (n && lastSlot !== null) {
    const expected = Math.floor((lastSlot - first) / SLOT) + 1;
    const share = (100 * (good ?? 0)) / expected;
    s1 = { measured: `${r1(share)}% of ${expected} ticks`, pass: share >= TARGETS.uptimePct };
  }
  out.push({ id: "S1", name: "Loop uptime", target: `${TARGETS.uptimePct}% of ticks store ${UPTIME_MIN_ZONES} of ${ZONES.length} zones`, ...s1 });

  const baltic = rows.daily.filter((d) => d.zone === "baltic" && d.n > 0);
  const red = baltic.filter((d) => d.cat === "red").length;
  out.push({
    id: "S2",
    name: "Positive control (Baltic red)",
    target: `red on ${100 * TARGETS.balticRedShare}% of days`,
    measured: baltic.length ? `${red} of ${baltic.length} days` : null,
    pass: baltic.length ? red / baltic.length >= TARGETS.balticRedShare : null,
  });

  const controls = ZONES.filter((z) => z.role === "control").map((z) => z.id);
  const ctlRows = rows.daily.filter((d) => controls.includes(d.zone) && d.n > 0);
  const worst = Math.max(0, ...controls.map((c) => ctlRows.filter((d) => d.zone === c && d.cat === "red").length));
  const samples = ctlRows.reduce((t, d) => t + d.samples, 0);
  const degraded = ctlRows.reduce((t, d) => t + d.degraded, 0);
  const rate = samples ? (100 * degraded) / samples : null;
  out.push({
    id: "S3",
    name: "Negative controls quiet",
    target: `at most ${TARGETS.controlRedDays} red day per control; at most ${TARGETS.controlDegradedPct}% of control samples degraded`,
    measured: ctlRows.length ? `worst control ${worst} red days; ${r1(rate)}% of ${samples} samples degraded` : null,
    pass: ctlRows.length ? worst <= TARGETS.controlRedDays && rate <= TARGETS.controlDegradedPct : null,
  });

  const o = agree.overall;
  out.push({
    id: "S4",
    name: "Agreement with gpsjam.org",
    target: "reported: red vs not red on comparable zone-days, and mean difference",
    measured: o.comparable ? `${o.agree} of ${o.comparable} agree; mean difference ${r1(o.mad)} points` : null,
    pass: null,
  });

  out.push({
    id: "S5",
    name: "Detection power (synthetic)",
    target: POWER.target,
    measured: `${r1(100 * POWER.detect15n30)}% detection; ${r1(100 * POWER.false2n30)}% false`,
    pass: POWER.pass,
  });

  out.push({
    id: "S7",
    name: "Cost",
    target: `$0; rows written under ${100 * S7_WRITE_SHARE}% of ${FREE_ROWS_WRITTEN.toLocaleString("en-US")} a day`,
    measured: `${rows.writesToday} rows written and ${rows.readsToday} read today`,
    pass: rows.writesToday < S7_WRITE_SHARE * FREE_ROWS_WRITTEN,
  });
  return out;
}
