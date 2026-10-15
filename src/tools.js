// The MCP tools, answered from the snapshot. One table: tools/list and dispatch both come from it.
// Zone names are data, never instructions. Answers never state a cause: "consistent with interference".
import { HISTORY_DAYS, STALE_MS, STALE_SNAPSHOT_MS } from "./config.js";
import { eventsInWindow, eventsSince } from "./cursor.js";
import { ToolError } from "./errors.js";
import { tally } from "./gpsjam.js";
import { CAVEATS, NOT_A_CAUSE, RULES } from "./method.js";
import { DAY, HOUR, iso } from "./time.js";
import { ZONES, ZONE_BY_ID } from "./zones.js";

const ZONE_IDS = ZONES.map((z) => z.id);
const zoneProp = { type: "string", enum: ZONE_IDS, description: "Zone id from list_zones, for example baltic." };
const readOnly = { readOnlyHint: true, openWorldHint: false };
const fmtTime = (isoStr) => (isoStr ? `${isoStr.slice(11, 16)} UTC` : "unknown");
const fmtDayTime = (isoStr) => `${isoStr.slice(0, 10)} ${isoStr.slice(11, 16)} UTC`;
/** The time, with the date too when it isn't on the same UTC day as `ref`. */
const fmtAt = (isoStr, ref) => (isoStr && isoStr.slice(0, 10) !== ref.slice(0, 10) ? fmtDayTime(isoStr) : fmtTime(isoStr));

export const TOOLS = [
  {
    name: "jamming_now",
    title: "GPS jamming now",
    description:
      "Which watched zones show GPS interference right now, measured from airliners' own GPS-integrity reports every 10 minutes. " +
      "Without a zone it lists only zones that aren't clear; with a zone it gives that zone's state, share of affected jets, usual level and data source.",
    inputSchema: { type: "object", properties: { zone: zoneProp }, additionalProperties: false },
    answer: jammingNow,
  },
  {
    name: "recent_events",
    title: "Recent jamming events",
    description:
      "Jamming onsets and offsets with peak share and the Sun check. Without `since`: newest first (at most 50). To keep a user " +
      "updated, pass `since` as the `next_since` of your previous answer (it is also at the end of the text): you get only what " +
      "was recorded after it, oldest first, with nothing repeated or missed. If `truncated` is true, call again with the new `next_since`.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "integer", minimum: 1, maximum: HISTORY_DAYS * 24, default: 48 },
        since: {
          type: "string",
          format: "date-time",
          description: "ISO time, normally the next_since of your previous answer. Don't combine with hours.",
        },
        zone: zoneProp,
      },
      additionalProperties: false,
    },
    answer: recentEvents,
    exclusive: ["hours", "since"],
  },
  {
    name: "court_record",
    title: "Accuracy record for a zone",
    description:
      "Daily share of affected jets for one zone next to gpsjam.org's figure for the same area, with agreement on red days and the mean difference.",
    inputSchema: {
      type: "object",
      properties: { zone: zoneProp, days: { type: "integer", minimum: 1, maximum: HISTORY_DAYS, default: 14 } },
      required: ["zone"],
      additionalProperties: false,
    },
    answer: courtRecord,
  },
  {
    name: "explain",
    title: "Explain a zone's reading",
    description: "The last 6 samples for a zone with their class, the rule thresholds, the usual level, the Sun check, controls and caveats.",
    inputSchema: { type: "object", properties: { zone: zoneProp }, required: ["zone"], additionalProperties: false },
    answer: explain,
  },
  {
    name: "list_zones",
    title: "List watched zones",
    description: "Every watched zone: id, name, role (sentinel or control), centre and radius in nautical miles.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    needsSnapshot: false,
    answer: () => {
      const zones = ZONES.map(({ id, name, role, lat, lon, r_nm }) => ({ id, name, role, lat, lon, r_nm }));
      const sentinels = zones.filter((z) => z.role === "sentinel").length;
      return result(`${zones.length} zones: ${sentinels} sentinels, ${zones.length - sentinels} controls.`, { zones });
    },
  },
].map((t) => Object.freeze({ needsSnapshot: true, ...t, annotations: readOnly }));

export const TOOL_LIST = TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
  name,
  title,
  description,
  inputSchema,
  annotations,
}));

/** Whether answering this tool reads the snapshot; the router loads it only then. */
export const needsSnapshot = (name) => TOOLS.find((t) => t.name === name)?.needsSnapshot !== false;

/** @returns {{content:object[], structuredContent:object}} or an error result */
export function answerTool(name, args, snap, now = Date.now()) {
  const tool = TOOLS.find((t) => t.name === name);
  try {
    const clean = validate(tool, args);
    if (tool.needsSnapshot && !snap?.last_slot) {
      throw new ToolError("NOT_READY", "Jammer Court hasn't finished its first sample yet. Try again in about 10 minutes.", {
        retryable: true,
        retryAfter: 600,
      });
    }
    const res = tool.answer(clean, snap, now);
    // If the loop has stopped, say so instead of serving an old picture as current.
    if (snap?.last_slot && now - Date.parse(snap.last_slot) > STALE_SNAPSHOT_MS) {
      res.content[0].text = `Warning: no sample since ${fmtDayTime(snap.last_slot)}. ${res.content[0].text}`;
      res.structuredContent.stale_snapshot = true;
    }
    return res;
  } catch (err) {
    if (err instanceof ToolError) return err.toResult();
    throw err;
  }
}

function validate({ inputSchema: schema, exclusive }, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new ToolError("INVALID_INPUT", "Arguments must be an object.");
  const out = Object.create(null);
  for (const [k, v] of Object.entries(args)) {
    const p = Object.hasOwn(schema.properties, k) ? schema.properties[k] : null;
    if (!p) throw new ToolError("INVALID_INPUT", `Unknown argument "${k.slice(0, 40)}".`);
    if (p.enum) {
      if (typeof v !== "string") throw new ToolError("INVALID_INPUT", `"${k}" must be a string.`);
      if (!p.enum.includes(v)) throw new ToolError("UNKNOWN_ZONE", `No zone "${v.slice(0, 40)}". Call list_zones for the ids.`);
    } else if (p.type === "integer" && (!Number.isInteger(v) || v < p.minimum || v > p.maximum)) {
      throw new ToolError("INVALID_INPUT", `"${k}" must be a whole number from ${p.minimum} to ${p.maximum}.`);
    } else if (p.format === "date-time" && !isIsoTime(v)) {
      throw new ToolError("INVALID_INPUT", `"${k}" must be an ISO time like 2026-10-15T14:20:00Z.`);
    }
    out[k] = v;
  }
  for (const k of schema.required ?? []) if (!(k in out)) throw new ToolError("INVALID_INPUT", `"${k}" is required.`);
  if (exclusive && exclusive.every((k) => k in out)) throw new ToolError("INVALID_INPUT", `Pass ${exclusive.join(" or ")}, not both.`);
  for (const [k, p] of Object.entries(schema.properties)) if (!(k in out) && "default" in p) out[k] = p.default;
  return out;
}

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** A real ISO time: Date.parse alone rolls 2026-02-30 over to 2 March and T24:00 to the next day. */
function isIsoTime(v) {
  const m = typeof v === "string" ? v.match(ISO_TIME) : null;
  if (!m || !Number.isFinite(Date.parse(v))) return false;
  const [y, mo, d, h, mi, s = "0"] = m.slice(1).map((x) => (x === undefined ? undefined : Number(x)));
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, Number(s)));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === Number(s);
}
const nextCheck = (cursor) => `Next check: since=${cursor}.`;
const result = (text, structuredContent) => ({ content: [{ type: "text", text }], structuredContent });
/** A zone the snapshot doesn't have yet (just added, before its first sample) is not ready, not a crash. */
function zoneOf(snap, id) {
  const z = snap.status.zones.find((x) => x.id === id);
  if (!z) throw new ToolError("NOT_READY", "That zone has no sample yet. Try again in about 10 minutes.", { retryable: true, retryAfter: 600 });
  return z;
}
const share = (z) => (z.pct == null ? "last sample missing" : `${Math.round(z.pct)}% of ${z.n}`);
const CONTROLS_TEXT = {
  noisy: "Controls noisy, treat with care.",
  thin: "Controls thin: most have no data.",
  clean: "Controls clean.",
};
const controlsText = (c) => CONTROLS_TEXT[c.level];

function jammingNow({ zone }, snap) {
  const controls = controlsText(snap.status.controls);
  if (zone) {
    const z = zoneOf(snap, zone);
    const usual = z.usual_pct == null ? `usual: ${z.usual_reason}` : `usual ${Math.round(z.usual_pct)}%`;
    const since = z.since ? ` since ${fmtAt(z.since, snap.last_slot)}` : "";
    const state = `${z.state}${since}${z.stale ? `, but no data for ${STALE_MS / HOUR} h or more` : ""}`;
    const reading = z.pct == null ? `Last sample missing; ${usual}` : `${share(z)} jets lost GPS integrity; ${usual}`;
    const text = `${z.name}: ${state}. ${reading}${z.worse_than_usual ? ", worse than usual" : ""}. ${controls} ${nextCheck(snap.last_slot)}`;
    return result(text, {
      as_of: snap.as_of,
      next_since: snap.last_slot,
      zone: z.id,
      name: z.name,
      role: z.role,
      state: z.state,
      since: z.since,
      pct: z.pct,
      n: z.n,
      usual_pct: z.usual_pct,
      usual_reason: z.usual_reason,
      worse_than_usual: z.worse_than_usual,
      stale: z.stale,
      source: z.source,
    });
  }
  const sentinels = snap.status.zones.filter((z) => z.role === "sentinel");
  // Exclusive buckets: a jammed zone stays jammed through one failed fetch; only stale makes it "no data".
  // A jammed control is listed too: it should never happen, so hiding it would hide the one thing worth saying.
  const jammed = snap.status.zones.filter((z) => z.state === "JAMMED" && !z.stale);
  const rest = sentinels.filter((z) => !jammed.includes(z));
  const noData = rest.filter((z) => z.stale || z.cls === "UNKNOWN" || z.cls === null);
  const mixed = rest.filter((z) => !noData.includes(z) && (z.cls === "MIXED" || z.cls === "DEGRADED"));
  const clear = rest.length - noData.length - mixed.length;
  const brief = (z) => ({ zone: z.id, name: z.name, pct: z.pct, n: z.n, usual_pct: z.usual_pct, since: z.since });
  const parts = [];
  parts.push(
    jammed.length
      ? `Jammed now: ${jammed.map((z) => `${z.name} ${share(z)}${z.usual_pct == null ? "" : ` (usual ${Math.round(z.usual_pct)}%)`}`).join("; ")}.`
      : "Nothing jammed now.",
  );
  if (mixed.length) parts.push(`Mixed: ${mixed.map((z) => `${z.name} ${Math.round(z.pct)}%`).join("; ")}.`);
  if (noData.length) parts.push(`No data: ${noData.map((z) => z.name).join("; ")}.`);
  parts.push(`${clear} other ${clear === 1 ? "sentinel" : "sentinels"} clear.`, controls, `As of ${fmtTime(snap.last_slot)}.`, nextCheck(snap.last_slot));
  return result(parts.join(" "), {
    as_of: snap.as_of,
    sampled_at: snap.last_slot,
    next_since: snap.last_slot,
    jammed: jammed.map(brief),
    mixed: mixed.map(brief),
    no_data: noData.map((z) => z.id),
    clear_count: clear,
    controls: snap.status.controls.level,
  });
}

const PAGE = 50;

function recentEvents({ hours, since, zone }, snap, now) {
  const mine = snap.log.filter((e) => !zone || e.zone === zone);
  const where = zone ? ` for ${ZONE_BY_ID.get(zone).name}` : "";
  const windowed = since === undefined;
  const from = windowed ? Date.parse(snap.as_of) - hours * HOUR : Date.parse(since);
  const last = Date.parse(snap.last_slot);
  // A cursor in the future would skip everything recorded before it; a real next_since is never ahead of the clock.
  if (!windowed && from > now) throw new ToolError("INVALID_INPUT", '"since" is in the future. Pass the next_since of your previous answer.');
  const { events, cursor, truncated } = windowed
    ? { events: eventsInWindow(mine, from, PAGE), cursor: last, truncated: false }
    : eventsSince(mine, from, last, PAGE);
  const window = windowed ? `in the last ${hours} h` : `since ${fmtDayTime(iso(from))}`;
  const notes = [];
  if (!windowed && from < Date.parse(snap.as_of) - HISTORY_DAYS * DAY) notes.push(`History only goes back ${HISTORY_DAYS} days.`);
  const out = events.map(({ zone: id, name, opened, onset, offset, closed, end_unknown, peak_pct, sun, after_gap }) => ({
    zone: id,
    name,
    opened,
    onset,
    offset,
    closed,
    end_unknown,
    peak_pct,
    sun,
    after_gap,
  }));
  const ref = snap.last_slot;
  const ended = (e) => (e.end_unknown ? ", ended (time unknown)" : e.offset ? `, ended ${fmtAt(e.offset, ref)}` : ", still open");
  // With since, every event is in the text too: clients that pass only text move on to next_since after reading it.
  const lines = out.slice(0, windowed ? 5 : PAGE).map((e) =>
    `${e.name}: ${e.onset ? `started ${fmtAt(e.onset, ref)}` : "already jammed when watching began"}` +
    `${ended(e)}${e.peak_pct == null ? "" : `, peak ${Math.round(e.peak_pct)}%`}.`,
  );
  if (out.length > lines.length) lines.push(`${out.length - lines.length} more in the list.`);
  if (truncated) notes.push("There are more to fetch: call again with the next check below.");
  const next_since = iso(cursor);
  const head = out.length ? `${out.length} ${out.length === 1 ? "event" : "events"} ${window}${where}.` : `No events ${window}${where}.`;
  const text = [head, ...lines, ...notes, nextCheck(next_since)].join(" ");
  return result(text, {
    as_of: snap.as_of,
    ...(windowed ? { hours } : { since: iso(from) }),
    events: out,
    truncated,
    next_since,
  });
}

function courtRecord({ zone, days }, snap) {
  const from = iso(Date.parse(snap.as_of) - days * DAY).slice(0, 10);
  const rows = snap.record.daily.filter((d) => d.zone === zone && d.day >= from);
  const a = tally(rows);
  const red = rows.filter((d) => d.cat === "red").length;
  const summary = {
    days: rows.length,
    red_days: red,
    comparable_days: a.comparable,
    agreements: a.agree,
    mean_abs_diff_pp: a.mad == null ? null : Math.round(a.mad * 10) / 10,
  };
  const name = ZONE_BY_ID.get(zone).name;
  const text = rows.length
    ? `${name}, last ${rows.length} days: red on ${red}. gpsjam.org comparable on ${a.comparable} days, agreeing on ${a.agree}` +
      `${a.mad == null ? "" : `, mean difference ${summary.mean_abs_diff_pp} points`}.`
    : `${name}: no daily rows yet. The first appears after midnight UTC.`;
  return result(text, { as_of: snap.as_of, zone, rows, summary });
}

function explain({ zone }, snap) {
  const z = zoneOf(snap, zone);
  const thresholds = { ...RULES, min_aircraft: ZONE_BY_ID.get(zone).min_n };
  const recent = z.recent.map((s) => `${fmtTime(s.at)} ${s.cls}${s.pct == null ? "" : ` ${Math.round(s.pct)}% of ${s.n}`}`).join(", ");
  const text =
    `${z.name} is ${z.state}. Last samples: ${recent || "none yet"}. ` +
    `Usual at this hour: ${z.usual_pct == null ? z.usual_reason : `${Math.round(z.usual_pct)}%`}. ` +
    `${snap.status.sun.text} ${controlsText(snap.status.controls)} ${NOT_A_CAUSE}`;
  return result(text, {
    as_of: snap.as_of,
    zone: z.id,
    state: z.state,
    since: z.since,
    stale: z.stale,
    recent: z.recent,
    thresholds,
    usual_pct: z.usual_pct,
    usual_reason: z.usual_reason,
    sun: snap.status.sun,
    controls: snap.status.controls,
    caveats: CAVEATS,
  });
}
