// recent_events paging (SPEC.md 6.4). Pure. An event is placed by the slot of the tick that last recorded it (closed,
// else opened), never by its onset or offset, which are earlier run starts. The cursor is a slot too (last_slot), so a
// late tick can't slip an event behind it: everything in a snapshot was recorded at or before its last_slot, and
// everything later at least one slot after. So a caller that passes back each next cursor sees every event once.

/** @typedef {{opened:string, closed:string|null, open:boolean}} LogEvent */

/** @param {LogEvent} e @returns {number} */
export const recordedAt = (e) => Date.parse(e.closed ?? e.opened);

/** Newest first (the log's order): events still open or recorded at or after `fromMs`, at most `page`. */
export function eventsInWindow(log, fromMs, page) {
  return log.filter((e) => e.open || recordedAt(e) >= fromMs).slice(0, page);
}

/**
 * Oldest first: events recorded after `fromMs`, and the cursor for the next call.
 * The cursor never moves backwards, even when a stale snapshot answers (KV and the isolate cache can lag). A page is
 * cut between slots only, so the cursor can be the last slot kept; one slot holds at most 40 events (20 zones, each an
 * orphan close and an open), so a page of 50 always keeps at least one slot.
 * @returns {{events:LogEvent[], cursor:number, truncated:boolean}}
 */
export function eventsSince(log, fromMs, lastSlotMs, page) {
  const after = log
    .map((e) => ({ e, t: recordedAt(e) }))
    .filter((x) => x.t > fromMs)
    .sort((a, b) => a.t - b.t);
  if (after.length <= page) return { events: after.map((x) => x.e), cursor: Math.max(fromMs, lastSlotMs), truncated: false };
  const edge = after[page].t;
  const kept = after[0].t < edge ? after.filter((x) => x.t < edge) : after.filter((x) => x.t === edge);
  return { events: kept.map((x) => x.e), cursor: kept.at(-1).t, truncated: true };
}
