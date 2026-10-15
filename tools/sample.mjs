// The sampler (SPEC.md 4.4). Every free aircraft feed refuses Cloudflare, so a GitHub job runs observe() and posts the
// result to the Worker's /ingest. Usage: JC_URL=https://... JC_KEY=... node tools/sample.mjs
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DEFAULT_REPO } from "../src/settings.js";
import { observe } from "../src/sources.js";
import { iso } from "../src/time.js";
import { SAMPLER_VERSION, VERSION } from "../src/version.js";
import { ZONE_CELLS } from "../src/zone_cells.js";
import { ZONES } from "../src/zones.js";

const WORKER_TIMEOUT_MS = 20_000;
const POST_RETRIES = 2;

/** A request to the Worker with a timeout; network errors say their cause (ECONNRESET, ENOTFOUND, timeout). */
async function workerFetch(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(WORKER_TIMEOUT_MS) });
  } catch (err) {
    const cause = err?.cause?.code ?? err?.cause?.message ?? err?.name;
    throw Object.assign(new Error(`network: ${err?.message ?? err}${cause ? ` (${cause})` : ""}`), { network: true });
  }
}

/**
 * One slot: ask the Worker what is due, fetch it, post it. Throws on any refused request. A post refused as stale
 * (the run crossed two slot boundaries) is planned and fetched again once.
 */
export async function sampleOnce({ url, key, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, repoUrl }) {
  const auth = { Authorization: `Bearer ${key}` };
  for (let attempt = 0; ; attempt++) {
    const planRes = await workerFetch(`${url}/ingest`, { headers: auth });
    if (!planRes.ok) throw new Error(`plan refused: ${planRes.status} ${(await planRes.text()).slice(0, 200)}`);
    const plan = await planRes.json();
    if (plan.skip) return { skipped: true, slot: iso(plan.slot) };
    if (plan.version !== SAMPLER_VERSION) {
      throw new Error(`version mismatch: the Worker is ${plan.version}, this sampler is ${SAMPLER_VERSION}. Deploy first.`);
    }

    const started = now();
    const obs = await observe(
      { zones: ZONES, due: plan.due, pauses: plan.pauses, zoneCells: ZONE_CELLS },
      { now, sleep, ua: `jammer-court/${VERSION} (+${repoUrl || DEFAULT_REPO})` },
    );
    const body = JSON.stringify({ slot: plan.slot, due: plan.due, obs, ms: now() - started });
    const res = await postWithRetry(`${url}/ingest`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body }, sleep);
    if (res.status === 409 && attempt === 0) continue;
    if (!res.ok) throw new Error(`ingest refused: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

/** The post is idempotent per slot, so a network error or a 5xx is safe to retry. */
async function postWithRetry(url, init, sleep) {
  for (let i = 0; ; i++) {
    try {
      const res = await workerFetch(url, init);
      if (res.status < 500 || i >= POST_RETRIES) return res;
    } catch (err) {
      if (!err.network || i >= POST_RETRIES) throw err;
    }
    await sleep(i === 0 ? 2000 : 5000);
  }
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const { JC_URL, JC_KEY, REPO_URL } = process.env;
  if (!JC_URL || !JC_KEY) {
    console.error("Set JC_URL and JC_KEY.");
    process.exit(2);
  }
  try {
    const out = await sampleOnce({ url: JC_URL.replace(/\/$/, ""), key: JC_KEY, repoUrl: REPO_URL });
    console.log(JSON.stringify(out));
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
}
