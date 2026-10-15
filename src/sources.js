// Every upstream read. Wire shapes (ac/aircraft keys, CSV text, SWPC items) end here and become domain values.
// Never throws, never writes storage. It runs in the GitHub sampler (tools/sample.mjs), never inside the Worker: every
// free aircraft feed refuses Cloudflare (SPEC.md 4.4). A slot makes at most 42 requests: 20 to adsb.lol, 20 to adsb.fi,
// SWPC and gpsjam.
import { FETCH_TIMEOUT_MS, FI_GAP_MS, FI_PAUSE_MS, GPSJAM_TIMEOUT_MS, LOL_CONCURRENCY, LOL_GAP_MS } from "./config.js";
import { createAggregator, gpsjamUrl } from "./gpsjam.js";
import { parseAlerts } from "./sun.js";

const SWPC_URL = "https://services.swpc.noaa.gov/products/alerts.json";
export const lolUrl = (z) => `https://api.adsb.lol/v2/point/${z.lat}/${z.lon}/${z.r_nm}`;
export const fiUrl = (z) => `https://opendata.adsb.fi/api/v3/lat/${z.lat}/lon/${z.lon}/dist/${z.r_nm}`;

/** One aircraft as the rules see it. Entries without a hex or a position are dropped (they can't be placed in a zone). */
export function parsePoint(body) {
  const list = body?.ac ?? body?.aircraft;
  if (!Array.isArray(list)) return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const out = [];
  for (const a of list) {
    if (!a || typeof a.hex !== "string" || num(a.lat) === null || num(a.lon) === null) continue;
    out.push({
      hex: a.hex,
      version: num(a.version),
      nic: num(a.nic),
      alt: num(a.alt_baro), // "ground" becomes null
      seenPos: num(a.seen_pos),
      type: typeof a.t === "string" && a.t ? a.t : null,
      lat: a.lat,
      lon: a.lon,
    });
  }
  return out;
}

/**
 * @param {{zones:object[], due:{swpc:boolean, gpsjamDay:string|null}, pauses:{lolUntil:number, fiUntil:number}, zoneCells:object}} what
 * @param {{now:()=>number, sleep:(ms:number)=>Promise<void>, ua:string}} how
 * @returns the observation posted to /ingest; `requests` counts every upstream request made
 */
export async function observe({ zones, due, pauses, zoneCells }, { now, sleep, ua }) {
  let requests = 0;
  const codes = { lol: {}, fi: {} };
  const count = (src, code) => (codes[src][code] = (codes[src][code] ?? 0) + 1);
  // Non-OK bodies are cancelled so they don't hold a connection open.
  const get = async (url, timeoutMs = FETCH_TIMEOUT_MS) => {
    requests += 1;
    try {
      const res = await fetch(url, { headers: { "User-Agent": ua, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { code: res.status };
      }
      return { code: res.status, res };
    } catch (err) {
      return { code: err?.name === "TimeoutError" ? "timeout" : "network" };
    }
  };
  const readZone = async (src, z) => {
    const { code, res } = await get(src === "lol" ? lolUrl(z) : fiUrl(z));
    if (!res?.ok) {
      count(src, code);
      return { ok: false, code };
    }
    let aircraft = null;
    try {
      aircraft = parsePoint(await res.json());
    } catch {}
    count(src, aircraft ? code : "bad_body");
    return aircraft ? { ok: true, aircraft } : { ok: false, code: "bad_body" };
  };

  const results = zones.map(() => null);
  const failures = zones.map(() => []);
  const newPauses = { ...pauses };
  let lolAuthFailed = false;
  let lolOk = false;

  // adsb.lol: 3 at a time, 250 ms between starts. A 429 or 5xx sends the rest of this tick to the fallback.
  if (pauses.lolUntil <= now()) {
    let stop = false;
    const inflight = new Set();
    for (let i = 0; i < zones.length && !stop; i++) {
      while (inflight.size >= LOL_CONCURRENCY) await Promise.race(inflight);
      if (stop) break;
      if (i > 0) await sleep(LOL_GAP_MS);
      const p = readZone("lol", zones[i]).then((r) => {
        if (r.ok) {
          lolOk = true;
          results[i] = { zone: zones[i].id, ok: true, src: "lol", aircraft: r.aircraft };
          return;
        }
        failures[i].push(`lol_${r.code}`);
        if (r.code === 401 || r.code === 403) lolAuthFailed = true;
        if (r.code === 429 || (typeof r.code === "number" && r.code >= 500)) stop = true;
      });
      const tracked = p.finally(() => inflight.delete(tracked));
      inflight.add(tracked);
    }
    await Promise.all(inflight);
  } else {
    failures.forEach((f) => f.push("lol_paused"));
  }

  // adsb.fi: only for zones adsb.lol didn't answer, one at a time, 1.1 s apart; two 429s pause it for 30 minutes.
  let fi429 = 0;
  let fiStarted = false;
  for (let i = 0; i < zones.length; i++) {
    if (results[i]) continue;
    if (newPauses.fiUntil > now() || fi429 >= 2) {
      failures[i].push("fi_paused");
      continue;
    }
    if (fiStarted) await sleep(FI_GAP_MS);
    fiStarted = true;
    const r = await readZone("fi", zones[i]);
    if (r.ok) {
      results[i] = { zone: zones[i].id, ok: true, src: "fi", aircraft: r.aircraft };
      continue;
    }
    failures[i].push(`fi_${r.code}`);
    if (r.code === 429 && ++fi429 >= 2) newPauses.fiUntil = now() + FI_PAUSE_MS;
  }
  const zoneFetches = zones.map((z, i) => results[i] ?? { zone: z.id, ok: false, src: "none", code: failures[i].join(",") });

  let swpc = null;
  if (due.swpc) {
    const { code, res } = await get(SWPC_URL);
    swpc = { ok: false, code };
    if (res?.ok) {
      let alerts = null;
      try {
        alerts = parseAlerts(await res.json());
      } catch {}
      swpc = alerts ? { ok: true, alerts } : { ok: false, code: "bad_body" };
    }
  }

  let gpsjam = null;
  if (due.gpsjamDay) gpsjam = { day: due.gpsjamDay, ...(await readGpsjam(get, due.gpsjamDay, zoneCells)) };

  const fmt = (m) => Object.entries(m).map(([c, n]) => `${c}x${n}`).join(" ");
  const notes = [
    `lol ${fmt(codes.lol) || "-"}`,
    `fi ${fmt(codes.fi) || "-"}`,
    swpc ? `swpc ${swpc.ok ? "ok" : swpc.code}` : null,
    gpsjam ? `gpsjam ${gpsjam.day} ${gpsjam.ok ? "ok" : gpsjam.code}` : null,
  ].filter(Boolean).join("; ");

  return { zones: zoneFetches, swpc, gpsjam, lolAuthFailed, lolOk, pauses: newPauses, notes, requests };
}

async function readGpsjam(get, day, zoneCells) {
  const { code, res } = await get(gpsjamUrl(day), GPSJAM_TIMEOUT_MS); // the timeout covers the whole download
  if (code === 404) return { ok: false, code: "not_yet" };
  if (!res?.ok || !res.body) return { ok: false, code: `http_${code}` };
  const agg = createAggregator(zoneCells);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (rest + value).split("\n");
      rest = lines.pop();
      if (!lines.every((l) => agg.line(l))) {
        await reader.cancel();
        return agg.result();
      }
    }
    if (rest) agg.line(rest);
  } catch {
    return { ok: false, code: "network" };
  }
  return agg.result();
}
