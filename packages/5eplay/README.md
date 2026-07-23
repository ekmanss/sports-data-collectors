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
  console.log(result.snapshot.state.phase, result.snapshot.state.lifecycle);
  console.log(result.snapshot.teams, result.snapshot.maps);
  console.log(result.snapshot.details);
}
```

To keep the complete confirmed JSON for debugging while also producing a filtered,
analysis-friendly Markdown file, write the snapshot as an artifact pair:

```ts
import {
  createFiveEPlayMatchSource,
  writeMatchSnapshotArtifacts,
} from '@ekmanss/5eplay';

const result = await createFiveEPlayMatchSource().snapshot('csgo_mc_2395547');
if (result.kind === 'confirmed') {
  const paths = await writeMatchSnapshotArtifacts(result.snapshot, {
    outputDirectory: './match-data',
  });
  console.log(paths.jsonPath, paths.markdownPath);
}
```

Both files use the same basename. The JSON is the complete `MatchSnapshot` without filtering. The
Markdown is organized by independent handlers following the 5E page terminology: `地图BP`,
`比赛数据` / `数据总览`, and the five `赛前分析` subsections. Beyond the visible page fields it
retains analysis-relevant API detail such as CT/T splits, advanced player metrics, round sequences,
duels, multi-kill distributions, comparison highlights, player-power metrics, and formal-round
match logs. It omits schema/revision tokens, provider state, artwork URLs, country
metadata, section transport metadata, community/player ratings, and player-power bar-rendering
guidelines/widths. It also suppresses provider UI-only MVP chart metadata, opaque map flags,
all-zero placeholder Impact columns, duplicate ADR/Damage-per-Round columns, empty side-split
multi-kill tables, and the duplicated `kills_per_round_win` row that 5E mislabels with the
player's HLTV rating. Those provider fields remain available in the complete JSON. Its headline
status uses the authoritative phase model, including unopened/live maps and both between-map
states. Map details are state-aware: live maps retain telemetry/economy fields, settled maps retain
final results, and unused decider maps render only their no-play reason.
To reduce AI context usage while improving comparisons, player-power metrics are transposed into
an indicator-by-player matrix, both teams' map-analysis values share one map row, duel details use
a lossless kill/opening-kill matrix, and round-score team order is declared once in the header.
Formal events remain in occurrence order by round. Event player aliases, side names, and common
weapon identifiers are normalized; event scores are explicitly labeled as CT:T side scores rather
than fixed-team scores. Stable provider event IDs are deduplicated across update versions, and
round-end score totals recover a formal round when its `round_start` marker is missing while
discarding warmup score resets. Partial or unavailable event sections show their exact `gap` but do
not render event detail into Markdown; the retained raw JSON remains available for diagnosis.
Comparison highlights identify one representative per provider category
instead of implying that every attached metric is independently team-leading. Pre-match output
also distinguishes current match teams from player-profile affiliations and 5E Rating from HLTV
Rating. Entirely unavailable columns are omitted; `—` consistently means unavailable or not
applicable, never an inferred zero.

Consumers that embed complete historical match Markdown beside a current match can request the
explicit historical evidence profile:

```ts
import { renderMatchMarkdown } from '@ekmanss/5eplay';

const markdown = renderMatchMarkdown(historicalSnapshot, {
  profile: 'historical-evidence',
});
```

This profile preserves the match, maps, scores, player statistics, formal-round logs, and
pre-match player/map/team analysis, but omits that historical snapshot's own `近期战绩` and
`交手战绩` sections, including their aggregate win rates and match rows. The Markdown explicitly
labels the omission as a consumer-requested de-nesting operation; it never claims that the
provider omitted those rows. The default `standard` profile and artifact writer output are
unchanged.

For production integration, exhaustive result handling, state mapping, retry policy, and realtime
ownership, see [INTEGRATION.md](INTEGRATION.md).

`snapshot()` returns one of `confirmed`, `blocked`, `not-found`, `unsupported`, or `superseded`.
A confirmed result certifies the core match state within an HTTP revision barrier. Optional detail
sections report their own `complete`, `empty`, `partial`, `unavailable`, or `not-applicable` status;
their failure never turns a valid core state into a guess.
An `inconsistent-state` block includes a stable `diagnosticCode` derived from the failed invariant.
An unresolved BO3 roster returns `unsupported / participants-unresolved` with `format: "3"` instead
of losing the known format. The snapshot CLI prints expected non-confirmed results as one compact
JSON line on stderr and uses distinct nonzero exit codes without a Node stack trace.

Confirmed observations use schema `fiveeplay-match/v3`.

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
- lifecycle, exact phase, raw provider state, series score, veto, evidence-ordered map slots, round/side data,
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
single-page CS2 schedule, browser data, and account state are deliberately excluded.

## Match states

BO3 observations distinguish:

- scheduled / prestart;
- live / map 1 unopened;
- map 1, 2, or 3 live;
- between maps 1–2 or 2–3;
- series ended / closing after the final played map;
- stable closed after two consistent terminal HTTP observations and the calibration interval.

Map slots independently expose `settled`, `played`, and `closedWithoutPlay`, so an administrative
1:0 map does not masquerade as a played map. `mapNumber` is the evidence-derived chronological
series position; `providerBoutNumber` is the stable upstream slot identity. They are deliberately
separate because a provider bout numbered 2 has been observed as the actual first played map.
`orderFinality` is `confirmed` for played, live, and awarded maps; unopened and unused slots are
`provisional`. A `1:0` no-play award has also been observed between a played map and the current live
map, so administrative settlement is not assumed to be terminal-only. When BP provides three
unique selected map names matching the three bout maps, that explicit selection order determines
`mapNumber`; otherwise the lifecycle/start-time evidence ordering remains the fallback. Terminal
administrative series may contain an evidenced `1:0` award at any chronological position, followed
or preceded by normally played maps, while unused slots are allowed only after the final deciding
map.

`state.phase.kind` is the exhaustive public discriminator: `prestart`, `map-unopened`, `map-live`,
`between-maps`, or `series-ended`. The phase carries `mapNumber`,
`previousMapNumber`/`nextMapNumber`, or `finalMapNumber` as appropriate. Terminal phases first
appear as `closing / provisional` and are promoted to `closed / stable` only by the HTTP stability
rule. Raw upstream status codes remain separately available in `providerState`; consumers must not
derive chronological order by indexing those bouts.

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

Event rows carry both provider bout identity and chronological map number. Engine/display aliases
are canonicalized for identity, and activity attached to an unopened or no-play map is excluded as
non-official warmup data even when provider pagination itself is stable. Repeated stable provider
event IDs retain the highest compatible update version when mutable enrichment changes; changes to
the event's core identity remain an explicit conflict. An invalid event row is
isolated from otherwise valid rows and marks the section partial. Markdown never treats a partial
event collection as an analysis-safe subset.

Series and per-map player statistics expose each team's `overall`, `ct`, and `t` planes separately.
Every plane is `present`, `empty`, or `unavailable`; the package never fills a missing side split
from overall data or treats malformed data as a valid empty result. Comparison highlights, detailed
player metrics and duel rows, series MVP, and MVP chart references are retained when evidenced.
Duel rows have their own completeness status, so a provider list/map conflict or an unavailable
opponent roster cannot masquerade as a trustworthy empty array. Per-map counters that are
impossible for the confirmed round timeline are isolated as `TIMELINE_INCOHERENT` without blocking
the authoritative core phase. `quickScore` remains provider telemetry and may lead the formal score
during an unsettled round; formal score consistency uses the half and overtime totals.

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

For a one-off confirmed snapshot artifact pair, run:

```bash
pnpm snapshot -- --match-id csgo_mc_2395547 --out-dir ./match-data
```

This project is unofficial and is not affiliated with or endorsed by 5EPlay. Consumers are
responsible for applicable terms and reasonable request rates.

MIT © 2026 ekmanss
