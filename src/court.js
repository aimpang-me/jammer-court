// The Durable Object: one instance ("main") that records one sample per 10-minute slot. Every free aircraft feed
// refuses Cloudflare, so a GitHub job takes each sample and posts it to /ingest (SPEC.md 4.4). This file only fixes
// the order of steps; rules live in plan.js, the body check in ingest.js and SQL in store.js.
import { checkEnvelope, checkIngest, clampPauses, sameDue, slotOpen } from "./ingest.js";
import { dueThisTick, planTick } from "./plan.js";
import { json, text } from "./rpc.js";
import { Store } from "./store.js";
import { iso, slotOf } from "./time.js";
import { SAMPLER_VERSION } from "./version.js";
import { buildSnapshot } from "./views.js";

export class Court {
  constructor(ctx, env) {
    this.env = env;
    this.store = new Store(ctx.storage);
    this.now = () => Date.now();
  }

  /** GET /ingest: what the sampler should fetch for a slot, or that the slot is done. */
  slotPlan(slot) {
    if (this.store.recorded(slot)) return { slot, skip: true };
    const memory = this.store.memory();
    return { slot, due: dueThisTick(memory, slot), pauses: memory.pauses, version: SAMPLER_VERSION };
  }

  /** POST /ingest. Everything up to the commit is synchronous, so no other request can change the slot or memory in between. */
  async ingest(raw) {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "bad_json" }, 400);
    }
    const envelope = checkEnvelope(body);
    if (envelope) return json({ error: "bad_shape", message: envelope }, 400);
    const now = this.now();
    const current = slotOf(now);
    const { slot } = body;
    if (!slotOpen(slot, current)) return json({ error: "stale_slot", slot: iso(current) }, 409);
    const plan = this.slotPlan(slot);
    if (plan.skip) return json({ skipped: true, slot: iso(slot) });
    if (!sameDue(body.due, plan.due)) return json({ error: "due_changed" }, 409);
    const problem = checkIngest(body, plan.due);
    if (problem) return json({ error: "bad_shape", message: problem }, 400);
    let tick;
    try {
      tick = this.record({ slot, due: plan.due, obs: { ...body.obs, pauses: clampPauses(body.obs.pauses, now) }, ms: body.ms });
    } catch (err) {
      this.noteFailure(slot, err);
      return json({ error: "record_failed" }, 500);
    }
    const warning = await this.publish(slot);
    return json({ recorded: true, slot: iso(slot), ok_zones: tick.ok_zones, notes: tick.notes, ...(warning && { warning }) });
  }

  /** Plans and commits one slot in one transaction. */
  record({ slot, due, obs, ms }) {
    const now = this.now();
    const plan = planTick({ slot, now, due, memory: this.store.memory(), obs, ctx: this.store.context(now, due), ms });
    // ingest() checked the slot with no await since, so this only fails if that invariant breaks; say so loudly.
    if (!this.store.commit(plan, now)) throw new Error(`slot ${iso(slot)} was already recorded`);
    return plan.tick;
  }

  refreshSnapshot() {
    const now = this.now();
    const snap = buildSnapshot(this.store.snapshotRows(now), now);
    this.store.saveSnapshot(snap);
    return snap;
  }

  /**
   * Rebuilds the read model and copies it to KV, when bound. The sample is already committed, so a failure is a warning
   * on the answer (and, for the rebuild, a note on the tick), never "not recorded".
   */
  async publish(slot) {
    const why = (err) => String(err?.message ?? err).slice(0, 120);
    let snap;
    try {
      snap = this.refreshSnapshot();
    } catch (err) {
      this.noteFailure(slot, err);
      return `recorded, but the snapshot was not rebuilt: ${why(err)}`;
    }
    if (!this.env.SNAPSHOT) return null;
    try {
      await this.env.SNAPSHOT.put("snapshot", JSON.stringify(snap));
      return null;
    } catch (err) {
      return `recorded, but the KV snapshot was not updated: ${why(err)}`;
    }
  }

  /** A failed record is logged on the slot's tick row, never rethrown; last_slot is untouched so a retry can still land. */
  noteFailure(slot, err) {
    try {
      this.store.noteFailure(slot, err);
    } catch {}
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/snapshot") return json(this.store.loadSnapshot());
    // The Worker has already checked the key, the method (GET or POST) and the body size.
    if (pathname === "/ingest") {
      return request.method === "GET" ? json(this.slotPlan(slotOf(this.now()))) : this.ingest(await request.text());
    }
    return text("Not found", 404);
  }
}
