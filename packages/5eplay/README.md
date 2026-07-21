# @ekmanss/5eplay

Reliable, immutable 5EPlay CS2 match observations for Node.js 22+. The package is ESM-only and
talks directly to 5EPlay JSON and MQTT-over-WebSocket services; it does not launch a browser or
require an account.

The public API is intentionally small:

```ts
import { createFiveEPlayMatchSource } from '@ekmanss/5eplay';

const source = createFiveEPlayMatchSource();
const schedule = await source.schedule(); // first page, 20 source rows at most

if (schedule.kind === 'available') {
  console.log(schedule.schedule.matches);
}

const result = await source.snapshot('csgo_mc_2395547');

if (result.kind === 'confirmed') {
  console.log(result.snapshot.state.stateCase, result.snapshot.state.lifecycle);
  console.log(result.snapshot.teams, result.snapshot.maps);
  console.log(result.snapshot.details);
}
```

For production integration, exhaustive result handling, state mapping, retry policy, and realtime
ownership, see [INTEGRATION.md](INTEGRATION.md).

`snapshot()` returns one of `confirmed`, `blocked`, `not-found`, `unsupported`, or `superseded`.
A confirmed result certifies the core match state within an HTTP revision barrier. Optional detail
sections report their own `complete`, `empty`, `partial`, `unavailable`, or `not-applicable` status;
their failure never turns a valid core state into a guess.

`schedule()` fetches exactly one provider page of currently live and upcoming matches. It defaults
to page 1 and a fixed source page size of 20; pass `{ page: 2 }` explicitly for another page. Each
row includes the provider match ID and URL, scheduled time, BO number, both teams and ranks, series
score, available map summaries, current map number, tournament, and stage. `sourceCount` counts
provider rows before completed matches are excluded. `mayHaveNextPage` is true only when the source
page was full; it is permission to try the next page, not proof that one exists.

Schedule status is discovery data (`live` or `upcoming`), not a confirmed detailed match phase. Use
the row's `id` with `snapshot()` to distinguish map 1 unopened/live, between-map states, terminal
closing, and stable closed. A BO1 can appear in schedule results even though detailed BO1 snapshots
remain `unsupported / format-unverified` in this release.

Every snapshot contains fixed sections for:

- match identity, BO format, teams, ranks, tournament, stage, location, prize, and advisory plan time;
- lifecycle, exact phase, provider state vector, series score, veto, three map slots, round/side data,
  half/stage and map artwork metadata, economy/equipment, and live or final player statistics;
- bounded cursor-paginated event history, pre-match analysis, both distinct paginated team-history
  products, and community ratings; events retain map number/name and tournament identity, while
  analysis retains full pick/ban/left actions and player-stat sampling context;
- per-section observation time, attempts, completeness or explicit gap, and one opaque confirmed
  core revision.

For `complete` and `empty` sections, `data` is present and `gap` is `null`. A `partial` section keeps
the data obtained so far and names its gap. An `unavailable` section has `data: null`; consumers
never have to mistake an empty collection for a failed request. Page, row, event, and deadline
limits prevent unbounded collection.

5EPlay odds, streams, chat, post-match editorial content, general discovery/list APIs beyond the
single-page CS2 schedule, rendered Markdown, browser data, and account state are deliberately
excluded.

## Match states

BO3 observations distinguish:

- scheduled / prestart;
- live / map 1 unopened;
- map 1, 2, or 3 live;
- between maps 1–2 or 2–3;
- series ended / closing after the final played map;
- stable closed after two consistent terminal HTTP observations and the calibration interval.

Map slots independently expose `settled`, `played`, and `closedWithoutPlay`, so an administrative
1:0 map does not masquerade as a played map. A contradictory provider vector returns `blocked`
instead of being classified heuristically.

`state.stateCase` is the exhaustive public discriminator: `prestart`, `map1-unopened`,
`map1-live`, `between-map1-map2`, `map2-live`, `between-map2-map3`, `map3-live`,
`series-ended-map2-normal`, `series-ended-map3-normal`, or
`series-ended-map2-administrative`. TypeScript correlates each case with its exact provider vector,
phase, lifecycle, closure, and finality. Terminal cases first appear as `closing / provisional` and
are promoted to `closed / stable` only by the HTTP stability rule.

The schema stays fixed across phases; fields that the provider has not produced yet are `null` or
empty, never copied forward as if current:

| Phase | Core data that becomes meaningful |
| --- | --- |
| prestart / map 1 unopened | identities, schedule, tournament, ranks, veto and selected maps |
| map live | current round/half, sides, score, economy, equipment and live player state |
| between maps | settled map result and statistics plus the next unopened slot |
| series ended / closing | deciding map, series winner, final map scores and closure kind |
| closed | the same terminal result after strict HTTP-version stability and calibration |

Every phase still attempts all five detail sections. Their individual status says whether analysis,
events, both history products, and community data were complete at that observation.

Series and per-map player statistics expose each team's `overall`, `ct`, and `t` planes separately.
Every plane is `present`, `empty`, or `unavailable`; the package never fills a missing side split
from overall data or treats malformed data as a valid empty result. Comparison highlights, detailed
player metrics and duel rows, series MVP, and MVP chart references are retained when evidenced.
Duel rows have their own completeness status, so a provider list/map conflict or an unavailable
opponent roster cannot masquerade as a trustworthy empty array.

The public schema structurally reserves BO1, but this release returns
`unsupported / format-unverified` for BO1 because the retained evidence does not contain two
complete independent BO1 traces. Other formats return `format-not-supported`.

## Realtime watch

```ts
await using watch = source.watch('csgo_mc_2395547');

for await (const update of watch) {
  if (update.kind === 'confirmed-state') {
    console.log(update.observation.revision, update.observation.state);
  } else if (update.kind === 'blocked') {
    console.log(update.reason, update.lastConfirmed?.revision ?? null);
  }
}
```

`watch()` returns synchronously. `current()` is initially `null`; the first event is always
`blocked / initializing`. The watcher waits for the state topic's SUBACK before obtaining the HTTP
baseline and buffers state-topic messages during that baseline. The event topic starts concurrently,
but is not part of the confirmation barrier. Its messages are
best-effort provisional telemetry, including before the baseline; event-history completeness is
reported by the independently bounded `snapshot()` section. MQTT never confirms state: HTTP remains the
authority. Periodic HTTP checks continue while MQTT is connected, allowing silent provider
rollbacks to be observed.

The state-topic disconnects into `blocked / realtime-unavailable`; reconnect uses fresh credentials,
waits for SUBACK, then performs HTTP resynchronization. Event-topic failure does not invalidate core
state. Successful HTTP recovery always emits `confirmed-state`, even when the confirmed revision is
unchanged, so callers can leave their blocked state deterministically. Telemetry is coalesced for
slow consumers while phase and blocked transitions remain ordered.
Breaking the iterator or calling `Symbol.asyncDispose` closes both connections. A stable closed
observation is final and completes the iterator automatically.

## Consistent reads

Pass `expectedRevision` when a caller needs compare-and-read semantics:

```ts
const result = await source.snapshot('csgo_mc_2395547', {
  expectedRevision: priorRevision,
  deadlineMs: 120_000,
  eventLimits: { maxPages: 200, maxEvents: 100_000 },
  signal,
});
```

The revision is an equality token, not a sortable provider version. It changes when trading-relevant
state changes, including phase, lifecycle, series score, current round, per-half/map score,
map settlement/result, teams, closure, or finality. High-frequency player, economy, equipment, and
bomb telemetry reflects the final HTTP read but is deliberately not part of this semantic token. A mismatch before or after detail
collection returns `superseded`. Without an expected revision, one unstable barrier is retried once.

## Diagnostics and evidence

`onDiagnostic` receives structured, redacted diagnostics; there is no default console or file
output. `evidenceSink` receives best-effort event evidence records. Sink failure is reported as a
diagnostic and never blocks data collection. Realtime credentials stay in memory and are never
included in results, errors, diagnostics, fixtures, or evidence records.

See [INTEGRATION.md](INTEGRATION.md) for the consumer guide and [PROTOCOL.md](PROTOCOL.md) for the
current protocol invariants. The deterministic test evidence and provenance manifest live under
`tests/fixtures/` in the repository.

## Development

```bash
pnpm install
pnpm verify
```

TypeScript consumers need TypeScript 5.2+ with disposable-library types available when using
`await using`; callers may always dispose explicitly through `watch[Symbol.asyncDispose]()`.

An explicit live smoke test is never run by deterministic CI:

```bash
FIVEEPLAY_MATCH_ID=csgo_mc_2395547 pnpm test:live
```

The development-only recorder requires an explicit match ID and an absolute output directory
outside the repository:

```bash
pnpm record -- --match-id csgo_mc_2395547 --out-dir /absolute/evidence/path
```

This project is unofficial and is not affiliated with or endorsed by 5EPlay. Consumers are
responsible for applicable terms and reasonable request rates.

MIT © 2026 ekmanss
