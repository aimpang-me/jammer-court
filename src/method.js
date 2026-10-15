// The rules in words, built from config.js alone, so the page, Grok Bot's answers and docs/POWER.md can't describe an
// old rule after a threshold changes. Changing a rule is still a dated entry in docs/METHOD.md.
import {
  ARTEFACTS,
  ARTEFACT_TYPES,
  BAD_NIC,
  CLEAR_P,
  DEGRADED_MIN_BAD,
  DEGRADED_MIN_TYPES,
  DEGRADED_P,
  MAX_SEEN_POS_S,
  MIN_ALT_FT,
  OFFSET_RUN,
  ONSET_RUN,
  WILSON_MIN,
} from "./config.js";

const pct = (p) => `${Math.round(p * 1000) / 10}%`;
const families = [...new Set(Object.values(ARTEFACTS))].join(" and ");

export const RULES = Object.freeze({
  eligible:
    `ADS-B version 2, a NIC value, at or above ${MIN_ALT_FT.toLocaleString("en-US")} ft, a position under ` +
    `${MAX_SEEN_POS_S} s old, and a type other than ${ARTEFACT_TYPES.join(", ")} (${families})`,
  bad: `NIC under ${BAD_NIC}`,
  degraded:
    `at least ${pct(DEGRADED_P)} bad, at least ${DEGRADED_MIN_BAD} bad aircraft of at least ${DEGRADED_MIN_TYPES} types, ` +
    `and a Wilson lower bound of at least ${WILSON_MIN}`,
  clear: `under ${pct(CLEAR_P)} bad`,
  onset: `${ONSET_RUN} degraded samples in a row`,
  offset: `${OFFSET_RUN} clear samples in a row`,
});

export const NOT_A_CAUSE =
  "NIC measures how much an aircraft trusts its own position, not why; readings are consistent with interference, not proof of a cause.";

export const LOWER_BOUND = "The share is a lower bound: aircraft that lose their position entirely drop out of the query.";

export const CAVEATS = Object.freeze([
  "Only ADS-B version 2 aircraft count.",
  NOT_A_CAUSE,
  LOWER_BOUND,
  `${families} are excluded because they report degraded GPS without any jammer.`,
]);
