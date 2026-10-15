# Method

How Jammer Court turns aircraft reports into a verdict, and what it can get wrong. Any change to a rule here is dated
below, and the agreement history is split at that date.

## The instrument

Airliners broadcast ADS-B messages that include how much they trust their own GPS position. The **NIC** (Navigation
Integrity Category) runs from 0 (no integrity) to 11. Normal flight reports 7 or more; GNSS jamming drives it toward 0.
Jammer Court reads those reports for 20 circles every 10 minutes:

- 12 **sentinels** where interference has been reported (only the Baltic is verified live; the others are placed from
  public reports), and
- 8 **controls** (big quiet hubs) that should stay clear. A control that degrades points at the instrument, not a jammer.

## Rules (frozen 2026-10-15)

1. **Eligible aircraft**: ADS-B version 2, a numeric NIC, barometric altitude at or above 1,000 ft (ground traffic
   often reports low NIC), position under 60 s old, and type not A359, A35K or A388 (these report degraded GPS for up
   to 45 minutes with no jammer). Each aircraft counts once per tick: its position comes from the first response
   that contained it, and it goes to the nearest zone among those whose responses contained it.
2. **Bad**: an eligible aircraft with NIC under 7.
3. **Sample class** with p = bad / eligible:
   - UNKNOWN if the request failed or fewer than the zone's minimum aircraft were eligible;
   - DEGRADED if p is at least 10%, at least 3 aircraft are bad, they are at least 2 different types, and the Wilson
     95% lower bound is at least 2%;
   - CLEAR if p is under 5%;
   - MIXED otherwise.
   The Wilson gate is a backstop: once 3 or more are bad at 10% or more, its lower bound is always at least 2%
   (`test/metric.test.js` pins this). The 2-types rule is what stops one airline's avionics from raising an alarm.
4. **Events**: two DEGRADED samples in consecutive 10-minute slots start one, dated at the first. Six CLEAR in a row
   end it, dated at the first. MIXED, UNKNOWN or a missing slot breaks a run. A zone sitting at 5 to 10% keeps its state.
5. **First watch**: a new zone acquires its state silently. If it is already jammed, the event has no onset time.
6. **Stale**: no data for 2 hours shows "no data"; the state is kept. An event that ends after such a gap is marked
   "after a data gap".
7. **Controls**: two or more controls DEGRADED in one tick marks it "controls noisy", and Grok Bot's answers say
   "Controls noisy, treat with care." A control's own events are logged like any other.
8. **Sun**: NOAA SWPC alerts in the 24 hours before an onset (M5+ X-ray flux, 10 cm radio burst, K-index 5+,
   geomagnetic storm watch or warning, proton event) mark the Sun "active". GPS effects from the Sun need extreme
   storms, so this is a null control, not an explanation: the answer names what happened ("Sun active (K-index 5+).")
   and claims no cause. A SWPC answer that isn't an alert list counts as a failed check ("Sun check unavailable").
9. **Usual**: the median fraction for the same zone and UTC hour over the last 14 days, once 7 days exist.
    "Worse than usual" means the last 3 samples pooled are at least 10 points above it.

## Daily score and the witness

After 00:10 UTC each zone gets yesterday's row: bad and eligible summed over that day's samples (so busy hours weigh
more), and a category: green under 2%, yellow 2 to 10%, red over 10%.

From 00:30 UTC the sampler reads gpsjam.org's daily file for yesterday. It sums each zone's H3 cells (resolution 4,
`src/zone_cells.js`, generated from `src/zones.js` by `npm run gen-cells`). A zone-day is comparable when we saw at
least 100 aircraft samples and gpsjam at least 50 cell-aircraft. Agreement is red vs not red on both sides, reported
per zone and overall with the mean absolute difference in percentage points.

## Known error

- **Lower bound.** Aircraft that lose their position entirely drop out of a point query, so heavy jamming can shrink
  the denominator and the share reads low.
- **Not a cause.** NIC says how much an aircraft trusts its position, not why. Readings are "consistent with
  interference".
- **Different counting.** gpsjam counts aircraft per cell per day, so one flight crossing a zone appears in many
  cells; we count aircraft per 10-minute sample. Both are shares of observations, never airframe counts, and the
  absolute numbers are not compared.
- **Feeder coverage.** adsb.lol and gpsjam (airplanes.live and ADS-B Exchange) use different volunteer receivers.
  Over-water zones can run thin and show no data.
- **Detection power** is in [POWER.md](POWER.md). At 15% bad with 30 aircraft the rule misses the 90% target; it is
  reported, not tuned.

## Changes from the spec (v1.1)

Decided in the architecture review, before the build:

1. One KV key `snapshot` instead of three, matching the spec's "1 KV put" budget.
2. MCP is answered by the Worker from the snapshot, so with KV bound Grok Bot's calls cost no Durable Object
   requests. Answers can be up to 10 minutes old and carry `as_of`.
3. Most meta keys fold into the single `meta.state` value (one writer). `last_slot`, `snapshot`, `writes:<day>` and
   `reads:<day>` stay separate.
4. The subrequest budget is 47 with 1 reserved for the KV put, so upstream reads stop at 46. (Removed in v1.4: sampling
   runs on GitHub, where no such limit applies and a slot makes at most 42 requests.)
5. `events.opened_ts` is added, so an event that was already jammed when watching began has a time.
6. `daily.samples` and `daily.degraded` are added, so S3 reads 30 rows instead of tens of thousands.
7. Zone cells and power data are JS modules (`src/zone_cells.js`, `src/power.js`) so Node and Wrangler import them
   the same way.
8. The power check in CI fails only when POWER.md is out of date, never because S5 misses (spec section 1: the
   measured value is shown even when it misses).
9. Test fixtures are synthetic but shaped exactly like the live responses read on 2026-10-15; the build sandbox
    cannot reach adsb.lol. Real captures replace them after the first deploy.
10. The Sun text drops spec 3.8's "controls normal: not the Sun", which repeated the controls clause and claimed a
    cause; it now lists the alert kinds in plain words.

## Spec v1.2: Grok Bot only (2026-10-15)

Jammer Court talks only to Grok Bot, which keeps the user updated inside the app. There are no phone pushes, no ntfy,
no caps and no flap guard (it only held back pushes). `recent_events` takes `since`, normally the `next_since` of Grok Bot's
previous answer, and returns only events recorded after it. It filters on the tick that recorded an onset or an offset
(`events.opened_ts`, and the new `events.closed_ts`), not on the onset and offset times themselves: those are run
starts, 10 minutes before an onset is recorded and 50 minutes before an offset is, so filtering on them would miss
events. The cursor Grok Bot passes back, `next_since`, is the last sample's slot rather than the wall-clock `as_of`,
because a late tick can record an event at a slot earlier than `as_of`. An open event closed only because the zone's
state lost it is marked "end unknown". The rules above are unchanged, so the agreement history is not split.

## Rule changes log

- 2026-10-15: rules frozen as above.
