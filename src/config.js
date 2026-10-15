// Every threshold of the instrument, in one place. Changing a rule here is a dated entry in docs/METHOD.md.
// Types that report degraded GPS for up to 45 min with no jammer, by ICAO type code, with the family name the text uses.
export const ARTEFACTS = Object.freeze({ A359: "A350", A35K: "A350", A388: "A380" });
export const ARTEFACT_TYPES = Object.freeze(Object.keys(ARTEFACTS));
export const MIN_ALT_FT = 1000;
export const MAX_SEEN_POS_S = 60;
export const BAD_NIC = 7; // frozen from day one: an eligible aircraft is "bad" when nic < 7

export const DEGRADED_P = 0.1;
export const CLEAR_P = 0.05;
export const DEGRADED_MIN_BAD = 3;
export const DEGRADED_MIN_TYPES = 2;
export const WILSON_MIN = 0.02;

export const ACQUIRE_RUN = 2;
export const ONSET_RUN = 2;
export const OFFSET_RUN = 6;
export const STALE_MS = 2 * 3600_000;

export const USUAL_WINDOW_MS = 14 * 86400_000;
export const USUAL_MIN_DAYS = 7;
export const WORSE_BY = 0.1;
export const POOLED_SAMPLES = 3;

export const NOISY_CONTROLS = 2;
export const SUN_WINDOW_MS = 24 * 3600_000;
export const SWPC_STALE_MS = 3 * 3600_000;

export const COMPARABLE_N = 100;
export const COMPARABLE_GJ_N = 50;
export const RED_PCT = 10;
export const GREEN_PCT = 2;

export const FETCH_TIMEOUT_MS = 8000;
export const LOL_CONCURRENCY = 3;
export const LOL_GAP_MS = 250;
export const FI_GAP_MS = 1100;
export const LOL_AUTH_STREAK = 3;
export const LOL_AUTH_PAUSE_MS = 3600_000;
export const FI_PAUSE_MS = 30 * 60_000;
export const GPSJAM_MAX_BYTES = 20 * 1024 * 1024;
export const GPSJAM_TIMEOUT_MS = 25_000;

export const HISTORY_DAYS = 30; // the read model, the event log and every look-back answer cover this many days
export const RETAIN_SAMPLES_MS = HISTORY_DAYS * 86400_000;
export const RETAIN_ALERTS_MS = 7 * 86400_000;
// The Durable Object free plan's daily row limits, and the share of writes S7 allows.
export const FREE_ROWS_WRITTEN = 100_000;
export const FREE_ROWS_READ = 5_000_000;
export const S7_WRITE_SHARE = 0.3;
export const WRITES_GUARD = 60_000;
export const UPTIME_MIN_ZONES = 18; // S1: a tick counts as good when at least this many zones answered
export const STALE_SNAPSHOT_MS = 30 * 60_000; // answers warn when the newest sample is older than this

export const MIN_KEY = 20;
