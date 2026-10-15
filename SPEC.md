# Jammer Court: build spec v1.4

Written spec-first: two candidate specs were drafted and judged, with the stronger as the base and grafts from the other, then two independent reviews and a final judgment. v1.1 folds in every "act on" and "consider" item from that judgment. The review notes are kept outside this repository.

**v1.2 (2026-10-15):** Jammer Court is only for Grok Bot. Updates should reach the user inside Grok Bot, with no phone pushes. So phone pushes and ntfy are removed: the onset, offset, instrument, stall, adsb.lol-refusing, hello and digest pushes, the caps, the flap guard (it only gated pushes), the `pushes` table, the `push_on`/`push_off` columns, and the `NTFY_TOPIC`, `NTFY_TOKEN`, `DISPLAY_TZ` and `PAGE_URL` settings. In their place, `recent_events` takes `since` so Grok Bot can ask "what changed since I last told the user?" without repeats or gaps (section 6.4). The page and the accuracy record stay; they are Grok Bot's evidence and the portfolio piece. The outside check is S6: in tests, a full scripted day contacts no host but the four data sources.

**v1.3 (2026-10-15, after the first deploy):** Risk 1 came true and is worse than feared. A probe from inside Cloudflare got 429 from adsb.lol and 403 from adsb.fi, airplanes.live, adsb.one and FlyItaly (all sit behind Cloudflare and refuse Workers; see adsblol/website#272). From a GitHub runner, adsb.lol and adsb.fi answered 200. So sampling moves out of the Worker (section 4.4): a scheduled GitHub Actions job in a public repo (public repositories get unlimited free Actions minutes) runs the same `observe()` code and posts the result to the Worker, which keeps everything else. The outside check: a real sample posted from GitHub to the live Worker shows at least 18 of 20 zones.

**v1.4 (2026-10-15, strict code review before going public):** The first GitHub samples got 20 of 20 zones, and every feed still refuses Cloudflare, so the Worker no longer samples at all. Removed: the alarm loop, the cron backstop and `/rearm`, the `SAMPLER` switch, and the per-invocation subrequest budget (the sampler runs on GitHub, where a slot makes at most 42 requests). `/ingest` is the only way a sample is recorded. The review also asked for each rule to live in one place: the rule text on the page, in `explain` and in `docs/POWER.md` is now built from `config.js` (`src/method.js`), the gpsjam judgement of a zone-day is one function (`judgeDay`), and the controls level is computed once in the read model. Section 7.5 now matches the code: the power check fails CI only when `docs/POWER.md` is out of date, never because S5 misses.

**v1.4.1 (2026-10-15, pre-ship review: three blind reviewers on spec and diff):** `jamming_now` with a zone now returns `next_since` like the summary does, and the summary lists a jammed control. `recent_events` refuses a `since` in the future, puts every event in the text when paging with `since`, and dates times that aren't on the snapshot's day. A KV read failure falls back to the Durable Object; a snapshot rebuild that fails after the commit answers `recorded` with a warning. Optional `INGEST_KEY` (4.4). The sample job may run 9 minutes, and the keepalive runs on any midnight-hour run. Page: the missing-slot mark meets 3:1 contrast, sparklines are hidden from screen readers (the card text carries the data), and the accuracy table's unlabelled columns have hidden labels.

Labels: **VERIFIED** = read or fetched live on 2026-10-15 (URL given). **INFERRED** = needs a spike or test. Since v1.3, the upstream blocks in section 10 are VERIFIED from inside a Worker.

Package: the repository root. Hand-rolled stateless JSON-RPC at `POST /mcp`, one SQLite Durable Object, a timing-safe bearer check, `node --test` with `node:sqlite` fakes, zero runtime deps, deployed by GitHub Actions (`.github/workflows/deploy.yml`).

## 1. Goal

A measurement instrument for GNSS interference, built on aircraft that already report how much they trust their GPS. Every 10 minutes it samples 12 sentinel zones and 8 control zones. It decides per zone whether GPS is degraded, logs when a zone starts or stops being jammed, answers Grok Bot's "is this worse than usual?" and "what changed since I last checked?", and publishes its own accuracy against gpsjam.org on a public page. The portfolio value is honest, measured accuracy plus a public log.

### Non-goals (v1)
No map, no ML, no spoofing flag, no "the Sun did it" confirmation, no archive backtest, no per-user zones, no phone pushes (Grok Bot keeps the user updated inside the app). No callsigns, registrations, tail numbers or hex codes in storage, the page or MCP output. Hex codes exist only in memory during a tick, for dedupe.

### Success criteria (published on the page, measured value shown even when it misses)
| # | Criterion | Target | Measured from |
|---|---|---|---|
| S1 | Loop uptime | at least 98% of expected ticks in 30 days stored at least 18 of 20 zones | `ticks` |
| S2 | Positive control | Baltic daily fraction at least 10% (red) on at least 90% of days | `daily` |
| S3 | Negative controls | at most 1 red day per control per 30 days; DEGRADED rate at most 0.5% of control samples | `daily`, `samples` |
| S4 | Agreement with gpsjam.org | per-zone category agreement (red vs not red) on comparable zone-days, plus mean absolute difference in percentage points; reported per zone and overall | `daily` |
| S5 | Detection power | table from synthetic injection; target at least 90% detection at 15% bad and n=30, at most 2% false DEGRADED at 2% bad | `docs/POWER.md` |
| S6 | Grok Bot only | a scripted day with onsets and offsets contacts no host but adsb.lol, adsb.fi, SWPC and gpsjam.org | tests |
| S7 | Cost | $0; rows written under 30% of 100k a day (DO requests, about 700 a day, are estimated in 4.3, not measured) | `meta` counters on the page |

## 2. Zones v1

`src/zones.js` exports an ordered array `{id, name, lat, lon, r_nm, role, min_n}`. Radius is at most 250 nm (adsb.lol point endpoint). Sentinel locations other than the Baltic are INFERRED from public interference reports. A sentinel that never degrades is labelled "quiet sentinel" on the page, never dropped silently. Adding a zone means one object here plus re-running the gen-cells workflow (section 5.4).

| id | name | lat | lon | r_nm | role | min_n |
|---|---|---|---|---|---|---|
| baltic | Baltic (Gotland to Kaliningrad) | 57.0 | 20.0 | 250 | sentinel | 8 |
| gulf_finland | Gulf of Finland | 60.0 | 25.5 | 110 | sentinel | 6 |
| vilnius | Vilnius and Belarus border | 54.7 | 25.3 | 100 | sentinel | 6 |
| finnmark | Finnmark and Kola border | 70.0 | 28.0 | 150 | sentinel | 4 |
| black_sea | Western Black Sea | 43.5 | 30.0 | 200 | sentinel | 5 |
| caucasus | South Caucasus | 41.5 | 44.5 | 200 | sentinel | 5 |
| levant | Eastern Mediterranean and Levant | 33.5 | 35.0 | 200 | sentinel | 6 |
| sinai | Sinai and northern Red Sea | 28.5 | 34.0 | 150 | sentinel | 5 |
| iraq | Baghdad and Kuwait corridor | 33.0 | 44.0 | 150 | sentinel | 5 |
| gulf | Persian Gulf and Hormuz | 26.5 | 54.5 | 200 | sentinel | 6 |
| punjab | Punjab border | 31.5 | 74.5 | 150 | sentinel | 5 |
| central_med | Central Mediterranean (Malta and Libya) | 34.0 | 15.0 | 200 | sentinel | 5 |
| ctl_london | London | 51.5 | -0.5 | 100 | control | 10 |
| ctl_frankfurt | Frankfurt | 50.0 | 8.6 | 100 | control | 10 |
| ctl_madrid | Madrid | 40.5 | -3.6 | 100 | control | 10 |
| ctl_atlanta | Atlanta | 33.6 | -84.4 | 100 | control | 10 |
| ctl_chicago | Chicago | 42.0 | -87.9 | 100 | control | 10 |
| ctl_dallas | Dallas | 32.9 | -97.0 | 100 | control | 10 |
| ctl_tokyo | Tokyo | 35.5 | 139.8 | 100 | control | 8 |
| ctl_sydney | Sydney | -33.9 | 151.2 | 100 | control | 8 |

Live checks during review: London 0 bad of 50 eligible, Atlanta 0 of 69, Tokyo 0 of 15, Levant 4 of 48 (VERIFIED).

## 3. Metric and state (all pure functions: `src/metric.js`, `src/state.js`, `src/sun.js`)

### 3.1 Eligibility
An aircraft from a zone response counts when all of these hold:
1. `version === 2`.
2. `nic` is a number.
3. `alt_baro` is a number of at least 1,000 ft. This excludes `"ground"`; ground aircraft often show low NIC with no jammer (VERIFIED tendency in the research round).
4. `seen_pos` is a number of at most 60 s.
5. `t` is not in `ARTEFACT_TYPES = ["A359","A35K","A388"]`. A350/A380 report degraded GPS for up to 45 min with no jammer (VERIFIED, ICAO APAC IP05). This is data in `src/config.js`.
6. **Dedupe:** within one tick, a `hex` counts once, in the zone whose centre is nearest to the position in the first response that contained it (zones are processed in table order). Positions from different responses are never mixed.

### 3.2 Counts and bad rule
For each zone sample: `n_all`, `n_elig`, `n_bad` (eligible with `nic < 7`), `n_nic0`, `types_bad` (distinct `t` among bad; a missing `t` is never counted as a type).
The bad rule is frozen at `nic < 7` from day one (VERIFIED basis: NIC >= 7 is normal and NIC 0 is severe, per the NAVI paper in the research notes; Baltic live 13 of 59). Any later change is dated in `docs/METHOD.md`, and the agreement history is split at that date.

### 3.3 Wilson lower bound
`wilsonLower(k, n, z=1.96)`. Known answers (recomputed): 13/59 gives 0.1335, 3/20 gives 0.0524, 5/20 gives 0.1119, 0/n gives 0, and n=0 gives 0.

### 3.4 Sample class
With `p = n_bad / n_elig`:
- **UNKNOWN**: request failed, or `n_elig < min_n`.
- **DEGRADED**: `p >= 0.10` AND `n_bad >= 3` AND `types_bad >= 2` AND `wilsonLower(n_bad, n_elig) >= 0.02`.
- **CLEAR**: `p < 0.05`.
- **MIXED**: anything else, which covers 5 to 10%, or 10% or more that isn't corroborated.
The 10% and 5% lines match gpsjam's red line and the middle of its yellow band (VERIFIED, https://gpsjam.org/faq/). Check: Levant at 4 of 48 (8.3%) is MIXED.

### 3.5 Zone state machine
States: `ACQUIRING` (after first deploy, or after a zone is added), `CLEAR`, `JAMMED`. A `stale` flag is set separately.
- A **run** is a sequence of samples in consecutive 10-minute slots with the same class. Any other class, or a missing slot, ends it. The run start is the slot time of its first sample.
- `ACQUIRING` becomes `CLEAR` after a CLEAR run of 2, or `JAMMED` after a DEGRADED run of 2. **This isn't an onset.** If it becomes JAMMED, an event is opened with `onset_ts = null` ("already jammed when watching began").
- `CLEAR` becomes `JAMMED` after a DEGRADED run of 2. Onset time is the run start. It emits `onset`.
- `JAMMED` becomes `CLEAR` after a CLEAR run of 6. Offset time is the run start. It emits `offset`.
- MIXED and UNKNOWN never change state; they only break runs. A zone holding at 5 to 10% keeps its state (hysteresis by design).
- **Stale:** if a zone has no non-UNKNOWN sample for 2 h, `stale = true`. The page and `jamming_now` show "no data". The state is kept. When data returns, `stale` clears and the normal run rules apply. An offset that follows a stale gap is flagged `after_gap`.

### 3.6 "Usual" for a zone
`usualPct(zone, hourUTC)` is the median sample fraction `p` over the last 14 days of that zone's samples whose slot hour equals `hourUTC` and whose class is not UNKNOWN. It needs at least 7 distinct days, otherwise `null` with the reason `"warming up (d of 7 days)"`. `worse_than_usual = p_now_pooled - usual >= 0.10`, where `p_now_pooled` pools the last 3 samples. It's computed on read, with no table.

### 3.7 Controls
- A control sample classed DEGRADED is logged in `samples` and counts against S3.
- If **2 or more** controls are DEGRADED in the same tick, the tick is flagged `controls_noisy`, and `jamming_now` and `explain` say "Controls noisy, treat with care." Nothing is held or queued.

### 3.8 Sun verdict (null control)
Source: SWPC `alerts.json` (section 5.3). On each onset:
- **ACTIVE** if, in the 24 h before onset, there's an alert of kind X-ray flux M5 or above, a 10 cm radio burst, a K-index of 5 or more, a geomagnetic storm watch or warning, or a proton event. Otherwise **QUIET**.
- Text: QUIET gives "Sun quiet." ACTIVE gives "Sun active (<kinds>), controls normal: not the Sun." If ACTIVE and the tick is `controls_noisy`, it gives "Sun active and controls noisy: possible space weather."
- If SWPC's last successful poll is older than 3 h, the verdict is `UNKNOWN` and the text is "Sun check unavailable."
- Never use `edited_events.json`, which lags about 6 days (VERIFIED).

### 3.9 Daily rollup
At the first tick after 00:10 UTC, for the previous UTC day and each zone: `k = sum(n_bad)`, `n = sum(n_elig)` over that day's non-UNKNOWN samples, `pct = 100*k/n`, and `cat` is green below 2, yellow from 2 to 10, red above 10. A zone-day counts as comparable when `n >= 100`. The figure is aircraft-sample weighted, which is stated on the page.

## 4. Durable Object, sampling, budget

### 4.1 Tables (DO class `Court`, instance `idFromName("main")`)
```sql
CREATE TABLE IF NOT EXISTS samples(zone TEXT NOT NULL, slot INTEGER NOT NULL, src TEXT NOT NULL,
  n_all INTEGER, n_elig INTEGER, n_bad INTEGER, n_nic0 INTEGER, types_bad INTEGER, cls TEXT NOT NULL,
  PRIMARY KEY(zone, slot)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ticks(slot INTEGER PRIMARY KEY, ok_zones INTEGER, subreqs INTEGER, ms INTEGER, notes TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, zone TEXT NOT NULL, opened_ts INTEGER NOT NULL,
  onset_ts INTEGER, offset_ts INTEGER, closed_ts INTEGER, peak_pct REAL, peak_n INTEGER, sun TEXT,
  after_gap INTEGER NOT NULL DEFAULT 0, orphaned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS daily(day TEXT NOT NULL, zone TEXT NOT NULL, k INTEGER, n INTEGER, pct REAL, cat TEXT,
  gj_k INTEGER, gj_n INTEGER, gj_pct REAL, gj_cat TEXT, PRIMARY KEY(day, zone)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS space_alerts(product_id TEXT NOT NULL, issued INTEGER NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY(product_id, issued)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
```
`meta` keys: `state` (one JSON object holding every zone's state, run and stale flags), `last_slot`, `swpc_ok_ts`, `gpsjam_day`, `lol_pause_until`, `fi_pause_until`, `writes:<yyyymmdd>`. `opened_ts` and `closed_ts` are the slots of the ticks that recorded the onset and the offset; `onset_ts` and `offset_ts` are run starts, which are earlier. `orphaned` marks an open event closed because the zone's state lost it (its end time is unknown). A store started on an older `events` table adds the missing columns. Retention: `samples` and `ticks` 30 days; `space_alerts` 7 days; `events` and `daily` forever (tiny). Pruning runs at the daily rollup, in batches.

### 4.2 Slots and idempotency
- Slots are every 10 minutes on the grid. `slot = floor((now - 20s) / 10min) * 10min`.
- A slot is recorded at most once. `GET /ingest` answers `skip` for a slot at or before `meta.last_slot`, and the commit re-checks `last_slot` inside its transaction, so a second post for the same slot writes nothing.
- Recording a slot: compute samples, state transitions and events with pure functions (`plan.js`), do one `transactionSync` that writes samples, events, `state`, `ticks` and `last_slot`, rebuild the snapshot (section 6.3), then copy it to KV if `SNAPSHOT` is bound. A commit that throws is logged to `ticks.notes`, answers 500 and leaves `last_slot` alone, so a retry can still land.
- The Worker never wakes itself: no alarm and no cron. Every sample comes from the sampler (4.4).
- **Stall:** every MCP answer starts with "Warning: no sample since HH:MM UTC." and carries `stale_snapshot: true` when the last sample is over 30 min old, so Grok Bot never presents an old picture as current.

### 4.3 Budget (free plan: 100k DO requests a day, 100k rows written a day, 13,000 GB-s a day; VERIFIED in the research notes and a review)
- **Upstream requests per slot** (made by the sampler on GitHub): 20 adsb.lol calls, plus up to 20 adsb.fi fallbacks, plus SWPC every third slot, plus gpsjam once a day. The worst case is 42; a typical slot uses 21 to 23. Each tick row records the count.
- **DO requests a day:** about 430 `/ingest` calls (two sampler runs per slot: a GET and a POST, then one GET) and MCP calls (budget 300). Public reads go to KV, not the DO, when `SNAPSHOT` is bound. That makes about 730 a day.
- **Rows written a day:** samples 2,880, ticks 144, meta (state, last_slot and counters) about 450, daily 20, events under 50, and pruning deletes about 3,000. The total is about 6,500, with headroom of 15x.
- **Writes guard:** if `writes:<day>` exceeds 60,000, pruning is skipped and the page shows a warning.

### 4.4 The sampler (v1.3, independently reviewed; the only sampler since v1.4)
- `GET /ingest` (bearer `API_KEY`) returns `{slot, due, pauses, version}` for the current slot, or `{slot, skip: true}` when it is already recorded. `version` fingerprints the release, the zones and their gpsjam cells; the sampler stops with "version mismatch" when its copy differs.
- `POST /ingest` (bearer `API_KEY`, body at most 2 MB, counted in bytes) takes `{slot, due, obs, ms}` and records it as in 4.2 when: `slot` is the current slot or the one before it (GitHub starts runs late) and newer than `last_slot`; `due` equals what the Durable Object computes for that slot; and `obs` passes a structural check of what `observe()` returns (20 zone results in zone order; aircraft `{hex, lat, lon, version, nic, alt, seenPos, type}`; swpc and gpsjam only when due; `requests`, the upstream request count). Posted `pauses` keep only `lolUntil` and `fiUntil`, clamped to now + 1 h and now + 30 min. A slot already recorded answers `200 {skipped: true}`, so retries are harmless. Older slots and a changed `due` answer 409; bad shapes answer 400; neither writes. A KV failure or a failed snapshot rebuild after the commit still answers `recorded`, with a `warning` (the rebuild failure is also noted on the tick row).
- `tools/sample.mjs` (Node 22, no dependencies): GET the plan, check the version, run `observe()` with the plan's `due` and `pauses`, POST with 20 s timeouts and up to two retries on network errors or 5xx, and re-plan once on a 409.
- Schedule: `.github/workflows/sample.yml` at `2-59/5 * * * *`, two runs per slot; the second costs one GET unless the first was dropped or late. It re-enables itself once a day through the API, since GitHub disables schedules after 60 days without repository activity. Forks never sample or deploy. The deploy workflow runs the sampler once after deploying and grades that sample's own answer.
- Key: `/ingest` takes `INGEST_KEY` when it is set, else `API_KEY`. With only `API_KEY`, whoever holds Grok Bot's key can post a well-formed fake sample, and its events stay in the public record; the clamp only limits pauses. So the repository secret `JAMMER_COURT_INGEST_KEY` is recommended: the deploy sets it on the Worker and the sampler uses it.
- Time: a sample taken 2 to 7 minutes into a slot is filed under the slot's start.

## 5. Upstreams (every request sends `User-Agent: jammer-court/<version> (+<REPO_URL>)`, with an 8 s timeout)

### 5.1 adsb.lol (primary)
`GET https://api.adsb.lol/v2/point/{lat}/{lon}/{r_nm}`. Keyless. The root key is `ac` (VERIFIED, with the fields in 3.1). Concurrency is 3, with a 250 ms gap between starts. A 429 or 5xx sends that zone to the fallback and pauses adsb.lol for the rest of the tick. A 401 or 403 on 3 consecutive ticks sets `lol_pause_until` for 1 h and notes it in the tick. ODbL attribution goes on the page. adsb.lol says rate limits are "dynamic" and that keys may be required "in the future" (VERIFIED, https://github.com/adsblol/api).

### 5.2 adsb.fi (fallback only)
`GET https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{nm}`. The root key is `aircraft`. Calls are serialised 1.1 s apart. After 2 or more 429s in one tick, `fi_pause_until` is set to 30 min ahead to avoid an IP ban. Use is personal and non-commercial, and the page carries attribution and a link (VERIFIED, https://github.com/adsbfi/opendata). The parser reads `body.ac ?? body.aircraft`.

### 5.3 SWPC alerts
`GET https://services.swpc.noaa.gov/products/alerts.json`, polled every third tick. The response is an array of `{product_id, issue_datetime, message}` (VERIFIED). `issue_datetime` is UTC `YYYY-MM-DD HH:MM:SS.mmm`.
Kinds are classified by `product_id` prefix, with the message as a fallback:
- `XM5`, `XMF` or "X-Ray Flux exceeded M5" give `xray_m5`.
- `BHI*` or "10cm Radio Burst" give `burst_10cm`.
- `K05`, `K06`, `K07`, `K08`, `K09` or "K-index of 5" through 9 give `kp5`.
- `A20`, `A30`, `A50` or "Geomagnetic ... Storm" in a Warning or Watch give `storm`.
- `SUM10P`, `ALTPX`, `WAR10P` or "Proton" give `proton`.
Exact prefixes are INFERRED; parse fixtures come from the live file. Unmatched items are ignored.

### 5.4 gpsjam.org daily CSV (accuracy witness)
- `GET https://gpsjam.org/data/{YYYY-MM-DD}-h3_4.csv` with header `hex,count_good_aircraft,count_bad_aircraft` (VERIFIED by three independent fetches). Data comes from airplanes.live and ADS-B Exchange, aggregated per day. Polling for the previous day starts at 00:30 UTC and runs once per tick until it succeeds or 12:00 UTC passes. A 404 means "not yet". If the header differs, the tick logs `FORMAT_CHANGED` and that day is skipped.
- Full size and coverage are UNVERIFIED (one review found the earlier "about 2,000 rows" was a truncated prefix; another measured a few hundred KB). The parser streams line by line and aborts above 20 MB.
- **Zone cells:** `src/zone_cells.json` maps zone id to the res-4 H3 cells whose centre is inside the zone circle. It's generated by `tools/gen-cells.mjs` using `h3-js` (a dev dependency for tools only), run in CI and committed. A cell inside two zones goes to the nearest centre.
- **Comparator:** `gj_k = sum(bad)`, `gj_n = sum(good + bad)` over the zone's cells, and `gj_pct = 100*gj_k/gj_n`. Both sides are fractions of aircraft observations, not distinct airframes, which is stated on the page. A zone-day is comparable when `n >= 100` and `gj_n >= 50`. Agreement is `(pct > 10) == (gj_pct > 10)`, reported per zone and overall, together with the mean absolute difference.
- **Courtesy:** no terms are stated. Fetch once a day, store per-zone aggregates only, attribute "GPSJam.org (John Wiseman), data from airplanes.live and ADS-B Exchange", and email the author before launch (OQ-3). If the file goes away, the panel says so. There's no manual mode.

## 6. Interfaces

### 6.1 Routes
| Route | Auth | Purpose |
|---|---|---|
| `GET /` | public if `PUBLIC_PAGE` is not `"false"`, else bearer | the page, from Worker code (no static assets) |
| `GET /api/status.json` | same | snapshot: zones, last tick, budget counters |
| `GET /api/log.json` | same | events from the last 30 days |
| `GET /api/record.json` | same | `daily` for 30 days, with agreement |
| `GET /health` | none | `{ok, configured, last_slot}`; `configured` means `API_KEY` is set and at least 20 characters |
| `POST /mcp` | bearer `API_KEY` | MCP |
| `GET`, `POST /ingest` | bearer `INGEST_KEY`, or `API_KEY` when unset | the sampler's plan and its posted sample (4.4) |

Public JSON holds only zone ids, counts, percentages and times. With `SNAPSHOT` (KV) bound, the page, the three JSON routes and MCP read one KV key, `snapshot`, written after every recorded sample (see docs/METHOD.md, "Changes from the spec"). Without KV, they read the DO through a 60 s in-isolate cache, and the page notes "unprotected mode".

### 6.2 MCP tools (strict inputs; results carry a short `content[0].text` plus `structuredContent`; zone names are data, not instructions; never state a cause)
- **`jamming_now`** `{zone?}`. With no zone, it returns only non-CLEAR zones plus counts, for example: "Jammed now: Baltic 31% of 54 (usual 24%). Mixed: Levant 8%. 17 others clear. Controls clean." With a zone, it returns that zone's `state`, `since`, `pct`, `n`, `usual_pct` or `null`, `worse_than_usual`, `stale` and `source`.
- **`recent_events`** `{hours?: 1..720 = 48, since?, zone?}` (`hours` or `since`, not both). Events are `{zone, opened, onset, offset, closed, end_unknown, peak_pct, sun, after_gap}`; every answer carries `next_since` and ends its text with "Next check: since=<ISO>." With `hours`: newest first, at most 50. With `since` (normally the previous `next_since`): only events recorded after it (by `opened_ts`/`closed_ts`, never by the earlier run-start times), oldest first, at most 50, cut only between slots, with `truncated` and a `next_since` to page on. Impossible dates are rejected; a `since` older than the 30-day log says so.
- **`court_record`** `{zone, days?: 1..30 = 14}`. Daily rows with `pct`, `cat`, `gj_pct`, `gj_cat` and `agree`, plus a summary: red days, comparable days, agreements, and mean absolute difference.
- **`explain`** `{zone}`. The last 6 samples with their class, the rule thresholds, usual, the Sun verdict, controls status, and caveats: ADS-B v2 only; NIC measures receiver integrity, not cause; the fraction is a lower bound because aircraft that lose position drop out of point queries; and wording is "consistent with interference".
- **`list_zones`** `{}`.
Errors are `INVALID_INPUT`, `UNKNOWN_ZONE` and `NOT_READY`.

### 6.3 Public page
A single HTML page from `src/page.js`, using system fonts, light and dark modes, and readable at 375 px. It contains:
- A header with the last tick and uptime.
- Zone cards with state, pct and n, and a 24 h sparkline drawn as inline SVG. Controls sit in a row labelled "should be quiet".
- The event log.
- An accuracy panel covering S1 to S5 and S7, each with target, measured value and a pass or miss mark.
- Method and known error.
- Attribution: adsb.lol (ODbL), adsb.fi, NOAA SWPC, GPSJam.org, and a repo link.

### 6.4 Keeping a user updated (Grok Bot only)
There are no pushes. A user who wants updates asks Grok Bot, and Grok Bot checks again whenever the conversation or a scheduled task brings it back. `recent_events` and `jamming_now` return `next_since`, which is the snapshot's `last_slot` (never the wall-clock `as_of`: a late tick can record events at a slot earlier than `as_of`), and print it as "Next check: since=<ISO>." for clients that pass only text. The next check calls `recent_events` with that `since`. Everything in a snapshot was recorded at or before its `last_slot` and everything later at least one slot after, so nothing is repeated or missed. `next_since` never moves backwards, even when a lagging KV or isolate cache answers with an older snapshot. Times are UTC. (Independently reviewed.)

## 7. Tests

### 7.1 Step 0 spike (the owner, any browser)
1. In Safari, open `https://api.adsb.lol/v2/point/57/20/250` and find `"nic":0`.
2. Open `https://gpsjam.org/data/<yesterday>-h3_4.csv` and note the size.
3. Open `https://services.swpc.noaa.gov/products/alerts.json`.
4. Deploy the Worker and open `/health`. (Done 2026-10-15: Cloudflare egress was refused, which led to the GitHub sampler in 4.4.) The page shows each source's status codes from `ticks.notes`.
The build doesn't wait on the spike. It ships with the fallback order and reports what it sees.

### 7.2 Unit tests (`node --test`, zero deps)
- Wilson known answers.
- Each eligibility rule.
- Dedupe across overlapping zones.
- Class boundaries: p exactly 0.10 and 0.05, `n_bad` of 2, a single type, a Wilson value just below 0.02.
- State machine:
  - silent acquisition;
  - a run broken by MIXED, UNKNOWN or a missing slot;
  - onset and offset times equal the run start;
  - stale after 2 h, then resume, plus the after-gap flag.
- `usualPct` warm-up and median.
- Sun classification from live-shaped fixtures, plus the 24 h window.
- gpsjam CSV parse with header check, comparator and categories.
- Rollup sums.
- `recent_events` `since`: an onset whose run started before `since` but was recorded after it is returned; one recorded at or before it is not; a late tick loses nothing; a stale snapshot never moves the cursor back; paging over 50; offsets in `since`; the orphan close.
- A scripted day contacts no host but the four data sources (S6).
- Every upstream request is counted on the tick row (at most 42).
- Tick idempotency: running the same slot twice writes once.

### 7.3 Replay
Upstream bodies in the tests are synthetic but shaped exactly like the live responses read on 2026-10-15 (`test/fakes.js`; the build sandbox can't reach adsb.lol). Swapping in trimmed live captures (no `flight` or `r`, `hex` hashed) is still open. A fake clock and fake fetch drive the real sampler against the Worker through scripted days; the tests assert the events, daily rows, Sun verdicts and snapshot.

### 7.4 MCP end to end
The SDK client is driven over the Worker. It covers `tools/list`, every tool, every error, every auth case, the 16 KB cap and batch refusal.

### 7.5 Power table
`npm run power` writes `docs/POWER.md`. It injects bad fractions of 0, 2, 5, 10, 15, 20 and 40% into clean control fixtures at n = 15, 30 and 60, using two or more types and 1,000 seeded draws each, and reports the DEGRADED probability. CI runs it with `--check` and fails only when `docs/POWER.md` or `src/power.js` is out of date. It never fails because S5 misses: the miss is reported in POWER.md and on the page rather than tuned away (section 1).

## 8. Build order (each step is one commit)
The original v1.1 order, kept as the record of how it was built. v1.3 added the sampler; v1.4 removed the alarm, the cron and `/rearm` from steps 1 and 4.
1. Scaffold the package, wrangler.toml (DO `COURT`, sqlite migration, cron, `keep_vars`, optional KV `SNAPSHOT` commented with instructions), rpc/auth copied, and `/health`.
2. `metric.js` and `state.js` with unit tests.
3. `sun.js`, `gpsjam.js` (parse and compare) with tests.
4. `court.js`: DO tables, `alarm()`, sources with fallback and budget, rollup, snapshot, `/rearm`.
5. MCP tools and the end-to-end test.
6. Page and public routes.
7. `tools/gen-cells.mjs` plus the committed `zone_cells.json`; `tools/power.mjs` plus `docs/POWER.md`; and `docs/METHOD.md`.
8. README with deploy steps (from a phone or any browser), the spike, and attribution.
9. v1.2: remove pushes and ntfy; add `since` and `closed_ts`.

## 9. Open questions (defaults apply)
- **OQ-1 Zones:** the table above.
- **OQ-2 Public page:** on by default; set `PUBLIC_PAGE=false` to hide it.
- **OQ-3 Email gpsjam's author:** yes, before sharing the page; the build doesn't wait.
- **OQ-4 Repo visibility:** public (decided 2026-10-15); nothing secret is committed.
- **OQ-5 KV snapshot:** bind it before sharing the page publicly. It's optional for private use.

## 10. Risks
1. adsb.lol blocks or limits Cloudflare egress. VERIFIED 2026-10-15 (429 on every request; adsb.fi 403). Mitigated by the external sampler (4.4). New risk: GitHub runners get limited too; the tick notes show it, and the fallback order is unchanged.
2. adsb.lol starts requiring a key. Mitigated by the source order in config.
3. The gpsjam path changes. The panel says "unavailable".
4. Thin over-water coverage. Mitigated by `min_n`, UNKNOWN and the "no data" label.
5. Other avionics artefacts in controls. Mitigated by the corroboration rule, the controls-noisy annotation and the artefact list.
6. A public page flood without KV. Mitigated by the KV snapshot.
7. Calling interference "jamming" as fact. The wording rule applies.
