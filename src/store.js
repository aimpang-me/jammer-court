// The only module that knows the schema. Everything a tick writes goes through commit(), in one transactionSync.
import { HISTORY_DAYS, RETAIN_ALERTS_MS, RETAIN_SAMPLES_MS, UPTIME_MIN_ZONES, USUAL_WINDOW_MS } from "./config.js";
import { initialMemory } from "./plan.js";
import { initialZoneState } from "./state.js";
import { DAY, HOUR, SLOT, dayOf } from "./time.js";
import { ZONES } from "./zones.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS samples(zone TEXT NOT NULL, slot INTEGER NOT NULL, src TEXT NOT NULL,
    n_all INTEGER, n_elig INTEGER, n_bad INTEGER, n_nic0 INTEGER, types_bad INTEGER, cls TEXT NOT NULL,
    PRIMARY KEY(zone, slot)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS samples_slot ON samples(slot)`,
  `CREATE TABLE IF NOT EXISTS ticks(slot INTEGER PRIMARY KEY, ok_zones INTEGER, subreqs INTEGER, ms INTEGER, notes TEXT)`,
  `CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, zone TEXT NOT NULL, opened_ts INTEGER NOT NULL,
    onset_ts INTEGER, offset_ts INTEGER, closed_ts INTEGER, peak_pct REAL, peak_n INTEGER, sun TEXT,
    after_gap INTEGER NOT NULL DEFAULT 0, orphaned INTEGER NOT NULL DEFAULT 0)`,
  // At most one open event per zone, enforced by the database rather than by care.
  `CREATE UNIQUE INDEX IF NOT EXISTS events_one_open ON events(zone) WHERE offset_ts IS NULL`,
  `CREATE TABLE IF NOT EXISTS daily(day TEXT NOT NULL, zone TEXT NOT NULL, k INTEGER, n INTEGER, pct REAL, cat TEXT,
    samples INTEGER, degraded INTEGER, gj_k INTEGER, gj_n INTEGER, gj_pct REAL, gj_cat TEXT,
    PRIMARY KEY(day, zone)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS space_alerts(product_id TEXT NOT NULL, issued INTEGER NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY(product_id, issued)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`,
];

const ADDED_EVENT_COLUMNS = [["closed_ts", "INTEGER"], ["orphaned", "INTEGER NOT NULL DEFAULT 0"]];

export class Store {
  /** @param {{sql:{exec:Function}, transactionSync:Function}} storage */
  constructor(storage) {
    this.storage = storage;
    this.pending = { reads: 0, writes: 0 }; // counted from the cursors, flushed into meta by commit()
    for (const q of SCHEMA) this.exec(q);
    // A Durable Object created before spec v1.2 has an older events table; add what it lacks rather than fail every tick.
    const cols = new Set(this.exec("PRAGMA table_info(events)").map((c) => c.name));
    for (const [col, type] of ADDED_EVENT_COLUMNS) if (!cols.has(col)) this.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`);
  }

  exec(q, ...args) {
    const cursor = this.storage.sql.exec(q, ...args);
    const rows = cursor.toArray();
    this.pending.reads += cursor.rowsRead ?? rows.length;
    this.pending.writes += cursor.rowsWritten ?? 0;
    return rows;
  }

  meta(k) {
    return this.exec("SELECT v FROM meta WHERE k = ?", k)[0]?.v ?? null;
  }

  setMeta(k, v) {
    this.exec("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
  }

  lastSlot() {
    const v = this.meta("last_slot");
    return v === null ? null : Number(v);
  }

  /** A slot at or before the last one committed is done; a second sample for it is skipped. */
  recorded(slot) {
    const last = this.lastSlot();
    return last !== null && last >= slot;
  }

  /** Today's running count of rows written or read. */
  counter(kind, now) {
    return Number(this.meta(`${kind}:${dayOf(now)}`) ?? 0);
  }

  alertsSince(t) {
    return this.exec("SELECT product_id, issued, kind FROM space_alerts WHERE issued >= ?", t).map((r) => ({
      productId: r.product_id,
      issued: r.issued,
      kind: r.kind,
    }));
  }

  /** @returns {import("./plan.js").Memory} Zones added since the last tick start in ACQUIRING; removed zones are dropped. */
  memory() {
    const raw = this.meta("state");
    const base = initialMemory();
    if (!raw) return base;
    const m = { ...base, ...JSON.parse(raw) };
    m.zones = Object.fromEntries(ZONES.map((z) => [z.id, m.zones?.[z.id] ?? initialZoneState()]));
    m.pauses = { ...base.pauses, ...m.pauses };
    return m;
  }

  /** Synchronous reads the planner needs, taken after every fetch is done. */
  context(now, due) {
    const ctx = {
      alerts: this.alertsSince(now - 2 * DAY),
      writesToday: this.counter("writes", now),
      daySamples: [],
    };
    if (due.rollupDay) {
      const from = Date.parse(`${due.rollupDay}T00:00:00Z`);
      ctx.daySamples = this.exec("SELECT zone, slot, n_elig, n_bad, cls FROM samples WHERE slot >= ? AND slot < ?", from, from + DAY);
    }
    return ctx;
  }

  /**
   * The one transactionSync of a tick. Re-checks last_slot inside it, so a second run of the same slot writes nothing.
   * @returns {boolean} false when this slot was already committed
   */
  commit(plan, now) {
    return this.storage.transactionSync(() => {
      if (this.recorded(plan.slot)) return false;

      for (const s of plan.samples) {
        this.exec(
          "INSERT OR REPLACE INTO samples(zone, slot, src, n_all, n_elig, n_bad, n_nic0, types_bad, cls) VALUES(?,?,?,?,?,?,?,?,?)",
          s.zone, s.slot, s.src, s.n_all, s.n_elig, s.n_bad, s.n_nic0, s.types_bad, s.cls,
        );
      }

      for (const e of plan.events) {
        if (e.op === "open") {
          // A zone's state and its open event row can disagree (zone removed and re-added, state reset). Close the
          // orphan rather than let the unique index roll back every tick.
          this.exec("UPDATE events SET offset_ts = ?, closed_ts = ?, orphaned = 1 WHERE zone = ? AND offset_ts IS NULL", e.openedTs, e.openedTs, e.zone);
          this.exec("INSERT INTO events(zone, opened_ts, onset_ts, sun) VALUES(?,?,?,?)", e.zone, e.openedTs, e.onsetTs, e.sun);
        } else {
          this.exec(
            `UPDATE events SET offset_ts = ?, closed_ts = ?, peak_pct = ?, peak_n = ?, after_gap = ?
             WHERE zone = ? AND offset_ts IS NULL`,
            e.offsetTs, e.closedTs, e.peakPct, e.peakN, e.afterGap ? 1 : 0, e.zone,
          );
        }
      }

      for (const d of plan.daily) {
        this.exec(
          `INSERT INTO daily(day, zone, k, n, pct, cat, samples, degraded) VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(day, zone) DO UPDATE SET k = excluded.k, n = excluded.n, pct = excluded.pct, cat = excluded.cat,
             samples = excluded.samples, degraded = excluded.degraded`,
          d.day, d.zone, d.k, d.n, d.pct, d.cat, d.samples, d.degraded,
        );
      }
      for (const g of plan.gpsjam) {
        this.exec(
          `INSERT INTO daily(day, zone, gj_k, gj_n, gj_pct, gj_cat) VALUES(?,?,?,?,?,?)
           ON CONFLICT(day, zone) DO UPDATE SET gj_k = excluded.gj_k, gj_n = excluded.gj_n, gj_pct = excluded.gj_pct,
             gj_cat = excluded.gj_cat`,
          g.day, g.zone, g.gj_k, g.gj_n, g.gj_pct, g.gj_cat,
        );
      }
      for (const a of plan.alerts) {
        this.exec("INSERT OR IGNORE INTO space_alerts(product_id, issued, kind) VALUES(?,?,?)", a.productId, a.issued, a.kind);
      }

      const t = plan.tick;
      this.exec(
        "INSERT OR REPLACE INTO ticks(slot, ok_zones, subreqs, ms, notes) VALUES(?,?,?,?,?)",
        t.slot, t.ok_zones, t.subreqs, t.ms, t.notes,
      );

      if (plan.prune) {
        for (const [q, cutoff] of [
          ["DELETE FROM samples WHERE slot < ?", now - RETAIN_SAMPLES_MS],
          ["DELETE FROM ticks WHERE slot < ?", now - RETAIN_SAMPLES_MS],
          ["DELETE FROM space_alerts WHERE issued < ?", now - RETAIN_ALERTS_MS],
        ]) {
          this.exec(q, cutoff);
        }
        for (const k of ["writes", "reads"]) {
          this.exec(`DELETE FROM meta WHERE k LIKE '${k}:%' AND k < ?`, `${k}:${dayOf(now - 7 * DAY)}`);
        }
      }

      this.setMeta("state", JSON.stringify(plan.memory));
      this.setMeta("last_slot", plan.slot);
      this.flushCounters(now);
      return true;
    });
  }

  /** Adds the rows read and written since the last flush (this tick, and the previous tick's later writes) to today's. */
  flushCounters(now) {
    const { reads, writes } = this.pending;
    this.pending = { reads: 0, writes: 0 };
    for (const [kind, n] of [["writes", writes + 2], ["reads", reads + 2]]) {
      this.setMeta(`${kind}:${dayOf(now)}`, this.counter(kind, now) + n);
    }
  }

  /** A tick that threw is logged, never rethrown; last_slot is untouched so the next slot runs normally. */
  noteFailure(slot, err) {
    const note = `error: ${String(err?.message ?? err).slice(0, 200)}`;
    this.exec(
      `INSERT INTO ticks(slot, ok_zones, notes) VALUES(?, 0, ?)
       ON CONFLICT(slot) DO UPDATE SET notes = COALESCE(ticks.notes || '; ', '') || excluded.notes`,
      slot,
      note,
    );
  }

  /**
   * The same-hour samples of the last 14 days, read by exact slot so the index is used: about 1,700 rows instead of a
   * 40,000-row range scan (the free plan allows 5 million rows read a day).
   */
  usualRows(at, now) {
    const hourStart = Math.floor(at / HOUR) * HOUR;
    const slots = [];
    for (let d = 0; d <= 14; d++) {
      for (let k = 0; k < HOUR / SLOT; k++) {
        const s = hourStart - d * DAY + k * SLOT;
        if (s <= now && s >= now - USUAL_WINDOW_MS) slots.push(s);
      }
    }
    return this.exec(
      `SELECT zone, slot, n_elig, n_bad, cls FROM samples WHERE slot IN (${slots.map(() => "?").join(",")}) AND cls != 'UNKNOWN'`,
      ...slots,
    );
  }

  /** The read model is stored as one row after each tick, so a public read costs one row, not thousands. */
  saveSnapshot(snap) {
    this.setMeta("snapshot", JSON.stringify(snap));
  }

  loadSnapshot() {
    const v = this.meta("snapshot");
    return v === null ? null : JSON.parse(v);
  }

  /** Everything views.buildSnapshot needs, read in one go. */
  snapshotRows(now) {
    const since = now - HISTORY_DAYS * DAY;
    return {
      lastSlot: this.lastSlot(),
      memory: this.memory(),
      samples24h: this.exec("SELECT * FROM samples WHERE slot > ? ORDER BY slot", now - DAY),
      usualRows: this.usualRows(now, now),
      events: this.exec("SELECT * FROM events WHERE offset_ts IS NULL OR closed_ts >= ? ORDER BY opened_ts DESC, id DESC", since),
      daily: this.exec("SELECT * FROM daily WHERE day >= ? ORDER BY day, zone", dayOf(since)),
      ticks: this.exec(
        "SELECT COUNT(*) AS n, SUM(ok_zones >= ?) AS good, MIN(slot) AS first FROM ticks WHERE slot >= ? AND subreqs IS NOT NULL",
        UPTIME_MIN_ZONES,
        since,
      )[0],
      lastTick: this.exec("SELECT * FROM ticks ORDER BY slot DESC LIMIT 1")[0] ?? null,
      alerts: this.alertsSince(now - DAY),
      writesToday: this.counter("writes", now),
      readsToday: this.counter("reads", now),
    };
  }
}
