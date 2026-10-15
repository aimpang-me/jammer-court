# Jammer Court

A remote MCP server for Grok Bot and a public page that measure GPS jamming. Every 10 minutes it reads airliners' own GPS-integrity reports in 12 sentinel zones (Baltic, Levant, Persian Gulf and others) and 8 quiet control zones. Grok Bot asks it "is the Baltic worse than usual?" and, to keep a user updated inside the app, "what changed since I last told you?". Each day it grades itself against [gpsjam.org](https://gpsjam.org) and publishes the score, misses included.

It runs on a free Cloudflare Worker with one Durable Object, fed by a GitHub Actions job that takes the samples, and has no runtime dependencies. Every free aircraft feed refuses requests from Cloudflare's servers (adsb.lol answers 429; adsb.fi, airplanes.live, adsb.one and FlyItaly answer 403), while adsb.lol and adsb.fi answer GitHub's. So GitHub fetches, and the Worker judges, stores and answers. It contacts nothing but its four data sources, and it sends no notifications: updates reach the user through Grok Bot. The rules and their known error are in [docs/METHOD.md](docs/METHOD.md), detection power is in [docs/POWER.md](docs/POWER.md), and the full spec is in [SPEC.md](SPEC.md).

## Example

> Is GPS jamming worse than usual in the Baltic right now?

```
Baltic (Gotland to Kaliningrad): JAMMED since 06:20 UTC. 31% of 54 jets lost GPS integrity (usual 24%). Controls clean.
```

Later, in the same chat:

> Anything new since you last checked?

Grok Bot calls `recent_events` with `since` set to the `next_since` of its previous answer (also printed at the end of every answer), and gets only what was recorded after it:

```
1 event since 2026-10-15 06:40 UTC. Eastern Mediterranean and Levant: started 06:30 UTC, still open, peak 22%. Next check: since=2026-10-15T06:50:00Z.
```

## Tools

| Tool | Arguments | Answers |
|---|---|---|
| `jamming_now` | `zone` (optional) | Without a zone, only zones that aren't clear, plus counts. With a zone: its state, since when, share, usual level, data source. |
| `recent_events` | `hours` (1 to 720, default 48), `since`, `zone` | Onsets and offsets, newest first, with peak and Sun check. `since` (an ISO time, normally the previous answer's `next_since`) returns only events recorded after it, oldest first, paged at 50 with `truncated` |
| `court_record` | `zone`, `days` (1 to 30, default 14) | Our daily share next to gpsjam.org's, with agreement and mean difference |
| `explain` | `zone` | The last 6 samples, the thresholds, usual level, Sun, controls and caveats |
| `list_zones` | none | Every zone with its centre and radius |

Answers come from the latest 10-minute sample and carry `as_of`. Before the first sample, tools return `NOT_READY`.

## Set up (free, from any browser, a phone included)

Live instance: [jammer-court.aimpang.workers.dev](https://jammer-court.aimpang.workers.dev). To run your own, fork this repo (forks don't deploy or sample until you change the `github.repository` checks in `.github/workflows/`), then:

1. **Make a key.** Save a generated password of at least 20 characters with no spaces. Grok Bot sends it to reach the server.
2. **Make a Cloudflare token.** In the Cloudflare dashboard, go to My Profile, then API Tokens, then Create Token, and use the "Edit Cloudflare Workers" template.
3. **Add two repository secrets** under Settings, then Secrets and variables, then Actions: `CLOUDFLARE_API_TOKEN` (the token) and `JAMMER_COURT_API_KEY` (the key). Recommended: also add `JAMMER_COURT_INGEST_KEY`, a second key of 20+ characters, so the key you give Grok Bot can't post samples; the next deploy sets it on the Worker. If your Worker's address isn't `jammer-court.aimpang.workers.dev`, also add a repository variable `JAMMER_COURT_URL`.
4. **Deploy.** Run the "Deploy Jammer Court" workflow, or push to `main`. It runs the tests, deploys, sets the key on the Worker, checks that `/health` is configured and that MCP refuses requests without the key, then takes a real sample and reports how many of the 20 zones answered.
5. **Sample.** The Sample workflow runs by itself, twice per 10-minute slot. Each run's summary line says how many zones answered and what each source returned, like `lol 200x20`.

`wrangler.toml` binds a KV namespace, so public visitors never reach the Durable Object. For your own copy, create one under Storage & Databases, then KV, and paste its id there, or delete that block.

### Add it to Grok Bot

> Add a custom MCP server called Jammer Court at https://jammer-court.aimpang.workers.dev/mcp with header Authorization: Bearer &lt;your key&gt;

Then try "What's jammed right now?", "Explain the Levant reading." and, later, "Anything new since you last checked?"

## How it works

```
GitHub Actions, every 10 min: tools/sample.mjs ─► GET /ingest (what's due) ─► sources.js (adsb.lol, adsb.fi fallback, SWPC, gpsjam)
                                              ─► POST /ingest ─► Durable Object: plan.js (pure rules) ─► store.js (one transaction)
                                                                                                    └► snapshot ─► KV
Worker: /mcp, /, /api/*.json ─► snapshot (KV, or the Durable Object behind a 60 s cache)
```

- `tools/sample.mjs` runs on GitHub. It asks the Worker what is due for the current slot, runs `observe()` from `src/sources.js`, and posts the result. The Worker itself never calls an aircraft feed.
- `src/court.js` is the Durable Object. `/ingest` checks the slot, recomputes what is due, checks the body's shape (`src/ingest.js`), then plans and commits in one transaction. A slot already recorded is skipped, so a retried post is harmless.
- `src/plan.js` is the pure tick brain. It uses the rules in `metric.js` (counting and classing), `state.js` (onset and offset), `sun.js` and `gpsjam.js`.
- `src/sources.js` holds every upstream call:
  - adsb.lol, 3 at a time, 250 ms apart;
  - adsb.fi for the zones adsb.lol missed, 1.1 s apart, paused 30 minutes after two 429s;
  - SWPC every third tick;
  - gpsjam once a day.
- A slot makes at most 42 upstream requests, and each tick row records how many it made.
- `src/method.js` writes the rules in words from `src/config.js`, so the page, `explain` and `docs/POWER.md` always describe the thresholds in force.
- Each event keeps the tick that recorded its onset (`opened_ts`) and its end (`closed_ts`). `recent_events` with `since` filters on those, not on the onset and offset times, which are earlier run starts. Its cursor `next_since` is the last sample's slot, not the wall clock, and never moves backwards, so a follow-up never misses or repeats an event even after a late tick or a lagging cache.
- `src/views.js` builds the one read model that the MCP tools, the page and the JSON routes all read.
- `src/store.js` is the only file with SQL.
- `test/boundaries.test.js` fails the build when a pure module imports an I/O module.

Aircraft hex codes exist only in memory during a tick, for deduplication. Storage, the page and MCP answers hold zone ids, counts, percentages and times only.

## Develop

```
npm install
npm test            # unit, tick-replay and MCP end-to-end tests, plus the power and zone-cell checks
npm run power       # regenerate docs/POWER.md and src/power.js
npm run gen-cells   # regenerate src/zone_cells.js after changing src/zones.js
npm run dev         # local Worker; put the settings in .dev.vars
```

## Limits

Everything fits the Workers free plan and GitHub's free minutes for public repos. A typical day:
- 288 sample runs on GitHub: 144 take a sample (about 30 seconds, 21 to 23 upstream requests), and the rest find their slot already done;
- about 430 Worker requests to `/ingest`;
- about 6,500 rows written (the page shows the live count against the 100,000 limit);
- 144 KV writes out of 1,000, when KV is bound.

GitHub can start a scheduled run late or skip one when it's busy. Each slot gets two runs, and the Worker accepts a sample for the slot that just ended, so a late run still counts; a slot no run reaches is a gap, which the rules treat like any missing sample. GitHub turns off schedules after 60 days without repository activity, so the Sample workflow re-enables itself once a day.

Samples and ticks are kept 30 days, space alerts 7. Events and daily scores are kept forever.

## Attribution

Aircraft data from [adsb.lol](https://adsb.lol) (ODbL) and [adsb.fi](https://adsb.fi) (personal, non-commercial use). Space weather from [NOAA SWPC](https://www.swpc.noaa.gov). Daily witness: [GPSJam.org](https://gpsjam.org) by John Wiseman, with data from airplanes.live and ADS-B Exchange.

## License

MIT
