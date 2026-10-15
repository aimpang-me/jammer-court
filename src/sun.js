// The null control: was the Sun active around an onset? Reads SWPC alerts.json (never edited_events.json, which lags days).
import { SUN_WINDOW_MS, SWPC_STALE_MS } from "./config.js";

const RULES = [
  ["xray_m5", /^(XM5|XMF|XX)/, /X-Ray Flux exceeded (M5|X)/i],
  ["burst_10cm", /^BHI/, /10cm Radio Burst/i],
  ["kp5", /^K0[5-9]/, /K-index of [5-9]/i],
  ["storm", /^A(20|30|50|99)/, /(WATCH|WARNING).*Geomagnetic Storm/is],
  ["proton", /^(PX|PC|SUM10P|ALTPX|WAR10P)/, /Proton Event/i],
];

/** @returns {"xray_m5"|"burst_10cm"|"kp5"|"storm"|"proton"|null} by product id prefix, with the message as a fallback */
export function classifyAlert(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.product_id ?? "").toUpperCase();
  const msg = String(item.message ?? "");
  for (const [kind, idRe] of RULES) if (idRe.test(id)) return kind;
  for (const [kind, , msgRe] of RULES) if (msgRe.test(msg)) return kind;
  return null;
}

export const KIND_LABELS = {
  xray_m5: "M5+ flare",
  burst_10cm: "10 cm radio burst",
  kp5: "K-index 5+",
  storm: "geomagnetic storm watch",
  proton: "proton event",
};

/** @returns {{productId:string, issued:number, kind:string}[]|null} null when the body isn't an alert list */
export function parseAlerts(json) {
  if (!Array.isArray(json)) return null;
  const out = [];
  for (const item of json) {
    const kind = classifyAlert(item);
    if (!kind) continue;
    const issued = Date.parse(`${String(item.issue_datetime).trim().replace(" ", "T")}Z`);
    if (Number.isNaN(issued)) continue;
    out.push({ productId: String(item.product_id), issued, kind });
  }
  return out;
}

/** @returns {{verdict:"QUIET"|"ACTIVE"|"UNKNOWN", kinds:string[], text:string}} */
export function sunVerdict({ alerts, at, swpcOkTs, now, controlsNoisy }) {
  if (swpcOkTs == null || now - swpcOkTs > SWPC_STALE_MS) {
    return { verdict: "UNKNOWN", kinds: [], text: "Sun check unavailable." };
  }
  const kinds = [...new Set(alerts.filter((a) => a.issued <= at && a.issued > at - SUN_WINDOW_MS).map((a) => a.kind))].sort();
  if (!kinds.length) return { verdict: "QUIET", kinds, text: "Sun quiet." };
  // A null control, not an explanation: the text names what happened and never claims a cause.
  const text = controlsNoisy
    ? "Sun active and controls noisy: possible space weather."
    : `Sun active (${kinds.map((k) => KIND_LABELS[k]).join(", ")}).`;
  return { verdict: "ACTIVE", kinds, text };
}
