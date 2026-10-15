import { DatabaseSync } from "node:sqlite";
import worker, { Court } from "../src/index.js";
import { SLOT } from "../src/time.js";
import { ZONES } from "../src/zones.js";
import { sampleOnce } from "../tools/sample.mjs";

export const KEY = "k".repeat(20);
export const BASE = "https://jc.example";

// Durable Object storage as Court uses it: sql.exec on real SQLite, transactionSync, and counters.
export class FakeStorage {
  constructor() {
    const db = new DatabaseSync(":memory:");
    this.db = db;
    this.transactions = 0;
    this.writes = 0;
    // Cursors carry rowsRead and rowsWritten like the real ones (approximated: rows returned, rows changed).
    this.sql = {
      exec: (query, ...args) => {
        const select = /^\s*SELECT/i.test(query);
        if (!select) this.writes += 1;
        const rows = db.prepare(query).all(...args).map((r) => ({ ...r }));
        const changed = select ? 0 : db.prepare("SELECT changes() AS c").get().c;
        return { toArray: () => rows, rowsRead: rows.length, rowsWritten: changed };
      },
    };
  }
  transactionSync(fn) {
    this.transactions += 1;
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

export class FakeKV {
  constructor() {
    this.map = new Map();
    this.puts = 0;
  }
  async get(k, type) {
    const v = this.map.get(k);
    return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
  }
  async put(k, v) {
    this.puts += 1;
    this.map.set(k, v);
  }
}

/**
 * A Worker env whose COURT binding reaches one in-memory Court on a clock the test moves. tick() is one run of the
 * GitHub sampler against it, exactly as in production: plan, fetch upstream (through whatever fakeNet is installed),
 * post. Its requests to the Worker itself bypass the fake network and aren't recorded in its calls.
 */
export function makeEnv(vars = {}, start = Date.parse("2026-10-15T00:00:20Z")) {
  const env = { API_KEY: KEY, ...vars };
  const storage = new FakeStorage();
  const court = new Court({ storage }, env);
  let now = start;
  court.now = () => now;
  env.COURT = { idFromName: (n) => n, get: () => ({ fetch: (url, init) => court.fetch(new Request(url, init)) }) };
  return {
    env,
    court,
    storage,
    async tick() {
      const upstream = globalThis.fetch;
      globalThis.fetch = (url, init) =>
        String(url).startsWith(BASE) ? worker.fetch(new Request(url, init), env) : upstream(url, init);
      try {
        return await sampleOnce({ url: BASE, key: KEY, sleep: async () => {}, now: () => now });
      } finally {
        globalThis.fetch = upstream;
      }
    },
    /** `count` sampler runs, one slot apart; `before(i)` may change the scripted network first. */
    async ticks(count, before = () => {}) {
      for (let i = 0; i < count; i++) {
        before(i);
        await this.tick();
        now += SLOT;
      }
    },
    rows: (q, ...a) => storage.sql.exec(q, ...a).toArray(),
    advance(ms) {
      now += ms;
    },
    get now() {
      return now;
    },
    set now(v) {
      now = v;
    },
  };
}

/**
 * Replaces global fetch with routes by host. A route is (url, init, n) => Response | status number | "throw".
 * Every request is recorded with the storage write count at that moment, to prove fetches happen before any write.
 */
export function fakeNet(routes, storage = null) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = { url: String(url), host: u.hostname, init, writes: storage?.writes ?? null };
    calls.push(call);
    const route = routes[u.hostname];
    const n = calls.filter((c) => c.host === u.hostname).length;
    let r = route ? route(u, init, n) : 404;
    if (r instanceof Promise) r = await r;
    if (r === "throw") throw new TypeError("network down");
    if (typeof r === "number") return new Response("{}", { status: r });
    return r;
  };
  return {
    calls,
    to: (host) => calls.filter((c) => c.host === host),
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

// ---- Synthetic, live-shaped adsb.lol / adsb.fi bodies ----
// Fields are exactly those verified live on 2026-10-15 (hex, t, version, nic, alt_baro, seen_pos, lat, lon); hex codes
// are synthetic. Real captures replace these after the first deploy.

const TYPES = ["B738", "A320", "B77W", "E190", "A21N", "B789"];

/** n aircraft placed at the zone centre, the first `bad` with nic 0. */
export function zoneBody(zoneId, n, bad, { key = "ac", extra = [] } = {}) {
  const z = ZONES.find((x) => x.id === zoneId);
  const list = Array.from({ length: n }, (_, i) => ({
    hex: `${zoneId}-${i}`,
    t: TYPES[i % TYPES.length],
    version: 2,
    nic: i < bad ? 0 : 8,
    nac_p: i < bad ? 0 : 9,
    alt_baro: 34000,
    seen_pos: 2.1,
    lat: z.lat + (i % 5) * 0.01,
    lon: z.lon + (i % 7) * 0.01,
  }));
  return { [key]: [...list, ...extra], now: 0, total: list.length + extra.length };
}

export const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Which zone a point-query URL asks for (both providers). */
export function zoneOfUrl(u) {
  const m = u.pathname.match(/point\/([-\d.]+)\/([-\d.]+)\//) ?? u.pathname.match(/lat\/([-\d.]+)\/lon\/([-\d.]+)\//);
  const [lat, lon] = [Number(m[1]), Number(m[2])];
  return ZONES.find((z) => z.lat === lat && z.lon === lon).id;
}

/** A routes table where every zone is clean except those in `bad` (zone id -> fraction bad). */
export function adsbRoutes(bad = {}, { n = 40, lol = null } = {}) {
  const body = (u, key) => {
    const id = zoneOfUrl(u);
    return jsonResponse(zoneBody(id, n, Math.round((bad[id] ?? 0) * n), { key }));
  };
  return {
    "api.adsb.lol": (u, init, k) => (lol ? lol(u, k) ?? body(u, "ac") : body(u, "ac")),
    "opendata.adsb.fi": (u) => body(u, "aircraft"),
    "services.swpc.noaa.gov": () => jsonResponse([]),
    "gpsjam.org": () => 404,
  };
}
