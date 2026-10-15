export const SLOT = 600_000;
export const SLOT_LAG = 20_000;
export const HOUR = 3600_000;
export const DAY = 86400_000;

/** The 10-minute grid point this moment belongs to; a slot is planned from 20 s after it. */
export const slotOf = (now) => Math.floor((now - SLOT_LAG) / SLOT) * SLOT;
/** "2026-10-15" in UTC. */
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(".000Z", "Z"));
