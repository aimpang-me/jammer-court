// The public page: one HTML string from the snapshot. System fonts, light and dark, readable at 375 px. No scripts.
import { HISTORY_DAYS, WRITES_GUARD } from "./config.js";
import { LOWER_BOUND, NOT_A_CAUSE, RULES } from "./method.js";
import { ZONES } from "./zones.js";

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hhmm = (iso) => (iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)} UTC` : "–");
const pct = (v) => (v == null ? "–" : `${Math.round(v)}%`);
const cap = (t) => t[0].toUpperCase() + t.slice(1);
const CONTROLS = { noisy: "Controls noisy", thin: "Controls thin", clean: "Controls clean" };

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1f;--muted:#6b6b70;--card:#fff;--line:#e4e2dc;--jam:#c2410c;--mix:#b45309;--ok:#15803d;--none:#868b94}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececee;--muted:#9a9aa2;--card:#1d1d21;--line:#2e2e34;--jam:#fb923c;--mix:#fbbf24;--ok:#4ade80;--none:#71717a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 48px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}
.sub{color:var(--muted);margin:0 0 12px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.card b{display:block;font-size:14px}.row{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.st{font-size:12px;font-weight:600;letter-spacing:.02em}.JAMMED{color:var(--jam)}.CLEAR{color:var(--ok)}.ACQUIRING,.stale{color:var(--muted)}
.big{font-size:20px;font-weight:600}.m{color:var(--muted);font-size:13px}svg{display:block;width:100%;height:28px;margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}.pass{color:var(--ok)}.miss{color:var(--jam)}.wrap{overflow-x:auto}
a{color:inherit}footer{margin-top:32px;color:var(--muted);font-size:13px}.note{border-left:3px solid var(--mix);padding:6px 10px;margin:12px 0}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

function spark(points) {
  if (!points?.length) return "";
  const w = 144;
  const bars = points
    .map(([p, cls], i) => {
      if (p == null) return `<rect x="${i}" y="27" width="1" height="1" fill="var(--none)"/>`;
      const h = Math.max(1, Math.min(28, Math.round((p / 50) * 28)));
      const fill = cls === "DEGRADED" ? "var(--jam)" : cls === "MIXED" ? "var(--mix)" : "var(--ok)";
      return `<rect x="${i}" y="${28 - h}" width="1" height="${h}" fill="${fill}"/>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} 28" preserveAspectRatio="none" aria-hidden="true" focusable="false">${bars}</svg>`;
}

function card(z) {
  const state = z.stale ? "NO DATA" : z.quiet_sentinel ? `${z.state} · quiet sentinel` : z.state;
  const usual = z.usual_pct == null ? esc(z.usual_reason ?? "") : `usual ${pct(z.usual_pct)}`;
  return `<div class="card"><div class="row"><b>${esc(z.name)}</b><span class="st ${z.stale ? "stale" : esc(z.state)}">${esc(state)}</span></div>
<div class="row"><span class="big">${pct(z.pct)}</span><span class="m">${z.n == null ? "" : `of ${esc(z.n)} jets`} · ${usual}</span></div>${spark(z.spark)}</div>`;
}

export function renderPage(snap, { unprotected, repoUrl }) {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jammer Court</title><meta name="description" content="GPS interference measured from airliners, graded against gpsjam.org."><style>${CSS}</style></head><body><main>
<h1>Jammer Court</h1><p class="sub">GPS interference measured from airliners' own GPS-integrity reports, every 10 minutes, and graded daily against gpsjam.org.</p>`;
  const foot = `<footer>Aircraft data: <a href="https://adsb.lol">adsb.lol</a> (ODbL) and <a href="https://adsb.fi">adsb.fi</a> (personal, non-commercial use).
Space weather: <a href="https://www.swpc.noaa.gov">NOAA SWPC</a>. Witness: <a href="https://gpsjam.org">GPSJam.org</a> (John Wiseman), data from airplanes.live and ADS-B Exchange.
<a href="${esc(repoUrl)}">Source and method</a>.</footer></main></body></html>`;
  if (!snap) return `${head}<p class="note">No sample yet. The first one lands within 10 minutes of deploy.</p>${foot}`;

  const s = snap.status;
  const sentinels = s.zones.filter((z) => z.role === "sentinel");
  const controls = s.zones.filter((z) => z.role === "control");
  const tick = s.last_tick;
  const events = snap.log.slice(0, 40).map((e) => `<tr><td>${esc(e.name)}</td><td>${e.onset ? hhmm(e.onset) : `before watching (${hhmm(e.opened)})`}</td>
<td>${e.open ? "open" : e.end_unknown ? "unknown" : hhmm(e.offset)}</td><td>${pct(e.peak_pct)}</td><td>${esc(e.sun ?? "–")}</td><td>${e.after_gap ? "after a data gap" : ""}</td></tr>`).join("");
  const crit = snap.record.criteria.map((c) => `<tr><td>${esc(c.id)}</td><td>${esc(c.name)}<div class="m">${esc(c.target)}</div></td>
<td>${esc(c.measured ?? "collecting")}</td><td class="${c.pass === true ? "pass" : c.pass === false ? "miss" : ""}">${c.pass === true ? "pass" : c.pass === false ? "miss" : "–"}</td></tr>`).join("");
  const a = snap.record.agreement.overall;

  return `${head}
<p class="m">Last sample ${hhmm(snap.last_slot)}${tick ? ` · ${esc(tick.ok_zones)} of ${ZONES.length} zones answered${tick.subreqs == null ? "" : ` · ${esc(tick.subreqs)} requests`}` : ""} · ${esc(s.sun.text.replace(/\.$/, ""))} · ${CONTROLS[s.controls.level]}</p>
${s.budget.writes_guard ? `<p class="note">Over ${WRITES_GUARD.toLocaleString("en-US")} rows written today: pruning is paused to protect the free plan's daily limit.</p>` : ""}
${s.controls.level === "thin" ? `<p class="note">Fewer than half the control zones answered this tick, so "controls clean" can't be checked.</p>` : ""}
${unprotected ? `<p class="note">Unprotected mode: no KV snapshot is bound, so page views reach the Durable Object (cached for 60 s).</p>` : ""}
<h2>Sentinels</h2><div class="grid">${sentinels.map(card).join("")}</div>
<h2>Controls (should be quiet)</h2><div class="grid">${controls.map(card).join("")}</div>
<h2>Event log (${HISTORY_DAYS} days)</h2><div class="wrap"><table><tr><th>Zone</th><th>Started</th><th>Ended</th><th>Peak</th><th>Sun</th><th>Note</th></tr>${events || `<tr><td colspan="6" class="m">No events yet.</td></tr>`}</table></div>
<h2>Accuracy</h2><p class="m">${a.comparable ? `gpsjam.org agreement: ${a.agree} of ${a.comparable} comparable zone-days.` : "gpsjam.org comparison starts after the first full day."} Both sides are shares of aircraft observations (aircraft-sample weighted), not counts of distinct airframes.</p>
<div class="wrap"><table><tr><th><span class="vh">ID</span></th><th>Criterion</th><th>Measured</th><th><span class="vh">Result</span></th></tr>${crit}</table></div>
<h2>Method and known error</h2>
<p>An aircraft counts when it has ${RULES.eligible}; those types report degraded GPS without any jammer. It is "bad" with ${RULES.bad}. A zone sample is <b>degraded</b> with ${RULES.degraded}, and <b>clear</b> ${RULES.clear}. ${cap(RULES.onset)} start an event; ${RULES.offset} end it.</p>
<p class="m">${NOT_A_CAUSE} ${LOWER_BOUND} Over-water zones can run thin and show no data. Bars show the last 24 hours (height up to 50%).</p>
${foot}`;
}
