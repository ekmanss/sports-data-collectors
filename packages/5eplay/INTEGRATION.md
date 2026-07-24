# Integrating @ekmanss/5eplay

This guide is for applications that consume 5EPlay match data in production. It explains which
result is authoritative, how to map the public state machine into an application state, and how to
handle incomplete provider data without guessing.

For the provider invariants behind these rules, see [PROTOCOL.md](PROTOCOL.md). For the package
overview, see [README.md](README.md).

## Runtime and installation

The package requires Node.js 22 or newer and is ESM-only. It has no runtime dependencies.

```bash
pnpm add @ekmanss/5eplay
```

Use the provider match ID, not the full page URL:

```text
https://event.5eplay.com/csgo/matches/csgo_mc_2395923
                                             └── csgo_mc_2395923
```

```ts
import { createFiveEPlayMatchSource } from '@ekmanss/5eplay';

const source = createFiveEPlayMatchSource();
const result = await source.snapshot('csgo_mc_2395923', {
  deadlineMs: 120_000,
});
```

Create one source per process or subsystem and reuse it. A source is immutable; each confirmed
snapshot and available schedule page is deeply frozen.

## Discover live and upcoming matches

Call `schedule()` without arguments for the first provider page. A call always fetches exactly one
page and never follows pagination automatically.

```ts
import {
  FiveEPlaySourceError,
  type SchedulePageResult,
} from '@ekmanss/5eplay';

function acceptSchedule(result: SchedulePageResult) {
  switch (result.kind) {
    case 'available':
      return result.schedule.matches;
    case 'blocked':
      // provider-unavailable is retryable; provider-schema-unsupported needs inspection.
      return null;
  }
}

try {
  const firstPage = await source.schedule({
    // page defaults to 1
    deadlineMs: 15_000,
    signal,
  });
  const matches = acceptSchedule(firstPage);

  if (firstPage.kind === 'available' && firstPage.schedule.mayHaveNextPage) {
    const secondPage = await source.schedule({ page: 2, deadlineMs: 15_000, signal });
    // Decide explicitly whether and when your application wants another page.
  }
} catch (error) {
  if (error instanceof FiveEPlaySourceError && error.code === 'ABORTED') {
    // The caller or operation deadline cancelled the request.
  } else {
    throw error;
  }
}
```

An available page has schema `fiveeplay-schedule/v1`, fixed `pageSize: 20`, `sourceCount`,
`providerStateVersion`, and matches in provider order. `sourceCount` is measured before completed
rows are excluded. `mayHaveNextPage` means only that the source page was full; it does not assert
that a following page exists. Invalid pages (zero, fractional, negative, or unsafe integers) throw
`FiveEPlaySourceError / INVALID_ARGUMENT`.

Each returned match includes `id`, canonical 5EPlay `url`, `scheduledAt`, `bestOf`, `status`, teams,
ranks, series scores, available map summaries, `currentMapNumber`, tournament, and stage. Empty or
not-yet-published provider fields are `null`; this includes team IDs while a future bracket slot is
still TBD. Odds and video fields are not exposed.

Treat schedule `live` and `upcoming` as discovery status only. For any decision that depends on the
exact match phase or complete data, pass the row's `id` to `snapshot()` and handle its authoritative
result. In particular, schedule does not return closed matches, and a BO1 schedule row does not
override the current `snapshot()` result `unsupported / format-unverified` for BO1.

## Handle every snapshot result

`snapshot()` returns a discriminated union. Do not treat every non-confirmed result as an empty
match, and do not manufacture a state from provider fields after the package blocks confirmation.

```ts
import {
  FiveEPlaySourceError,
  type MatchSnapshot,
  type MatchSnapshotResult,
} from '@ekmanss/5eplay';

function assertNever(value: never): never {
  throw new Error(`unhandled result: ${String(value)}`);
}

function acceptSnapshot(result: MatchSnapshotResult): MatchSnapshot | null {
  switch (result.kind) {
    case 'confirmed':
      return result.snapshot;

    case 'blocked':
      // Retry according to result.reason. Do not replace a last-known-good snapshot
      // with guessed or partially decoded core state.
      return null;

    case 'superseded':
      // A compare-and-read revision changed during collection. Discard and read again.
      return null;

    case 'not-found':
      // Terminal for this match ID unless the caller supplied the wrong ID.
      return null;

    case 'unsupported':
      // Do not infer a state. See result.reason and result.format.
      return null;

    default:
      return assertNever(result);
  }
}

try {
  const snapshot = acceptSnapshot(await source.snapshot('csgo_mc_2395923'));
  if (snapshot !== null) console.log(snapshot.state);
} catch (error) {
  if (error instanceof FiveEPlaySourceError && error.code === 'ABORTED') {
    // The caller or operation deadline cancelled the request.
  } else {
    throw error;
  }
}
```

Use the result kinds as follows:

| Result | Meaning | Consumer action |
| --- | --- | --- |
| `confirmed` | Core state passed the HTTP revision barrier | Accept the snapshot |
| `blocked` | The package refused to guess | Retain the last confirmed state and retry |
| `superseded` | The requested revision changed during the read | Discard this read and retry immediately |
| `not-found` | The match ID does not exist | Stop or correct the ID |
| `unsupported` | Format or schema is not safely understood | Stop automatic processing and surface the reason |

`unsupported / format-unverified` is the expected result for BO1 until the package has sufficient
independent BO1 evidence. `unsupported / participants-unresolved` preserves `format: "3"` for a
known BO3 whose one or both team identities are still TBD; discovery may be retried after the
bracket advances. Neither result is equivalent to prestart or closed.

## Map the authoritative match state

Use `snapshot.state.phase.kind` as the exhaustive discriminator. Map numbers are carried as data,
so the same state machine can represent BO1 or BO3 without a separate case name for every map.
Use `lifecycle` to distinguish a terminal result that is still calibrating (`closing`) from one
that is stable (`closed`).

```ts
import type { MatchState } from '@ekmanss/5eplay';

type ConsumerPhase =
  | { kind: 'not-started' }
  | { kind: 'map-not-started'; mapNumber: number }
  | { kind: 'map-live'; mapNumber: number }
  | { kind: 'between-maps'; previousMapNumber: number; nextMapNumber: number }
  | { kind: 'series-closing'; finalMapNumber: number }
  | { kind: 'closed'; finalMapNumber: number };

function assertNever(value: never): never {
  throw new Error(`unhandled state: ${String(value)}`);
}

export function consumerPhase(state: MatchState): ConsumerPhase {
  switch (state.phase.kind) {
    case 'prestart':
      return { kind: 'not-started' };
    case 'map-unopened':
      return { kind: 'map-not-started', mapNumber: state.phase.mapNumber };
    case 'map-live':
      return { kind: 'map-live', mapNumber: state.phase.mapNumber };
    case 'between-maps':
      return {
        kind: 'between-maps',
        previousMapNumber: state.phase.previousMapNumber,
        nextMapNumber: state.phase.nextMapNumber,
      };
    case 'series-ended':
      return state.lifecycle === 'closed'
        ? { kind: 'closed', finalMapNumber: state.phase.finalMapNumber }
        : { kind: 'series-closing', finalMapNumber: state.phase.finalMapNumber };
    default:
      return assertNever(state.phase);
  }
}
```

The exact phases are:

| `phase.kind` | Additional field | Meaning |
| --- | --- | --- |
| `prestart` | — | The match has not started |
| `map-unopened` | `mapNumber` | The series is live, but this chronological map has not started |
| `map-live` | `mapNumber` | This chronological map is running |
| `between-maps` | `previousMapNumber`, `nextMapNumber` | The previous map settled and the next has not started |
| `series-ended` | `finalMapNumber` | The series ended after the indicated chronological map |

Terminal cases first arrive with `lifecycle: 'closing'` and `dataFinality: 'provisional'`. They
become `lifecycle: 'closed'` and `dataFinality: 'stable'` only after consistent terminal HTTP
observations and the closure calibration interval. Applications that settle irreversible actions
should wait for `closed` unless their own policy explicitly accepts provisional closure.

`snapshot.providerState` preserves raw `globalStatusCode` and each
`providerBoutNumber`/`statusCode` pair for audit. It is evidence, not a second state machine. Never
index it as chronological map order or use these fields as a replacement for `snapshot.state`:

- `tournament.status`: describes the tournament, not this match;
- `match.scheduledAt`: advisory schedule time, not proof that play started;
- map scores or player rows in isolation: may be stale or incomplete provider fields;
- MQTT telemetry: provisional invalidation or event information, never confirmation.

## Read map data without inventing play

Each currently supported BO3 snapshot has three evidence-ordered map slots. Interpret each slot by
`status`:

| Map status | `played` | Meaning |
| --- | --- | --- |
| `unopened` | `false` | The provider has not confirmed play for this slot |
| `live` | `true` | The map is running; round, side, score and live player fields may be present |
| `settled` | `true` | The map was played and has a final score and winner |
| `closed-without-play` | `false` | Administrative award or unused slot; do not count it as a played map |

Join provider-side data through `providerBoutNumber`, not through array position. `mapNumber` is the
chronological series position derived from start/end evidence. `orderFinality: 'confirmed'` means
the map was played, is live, or is an evidenced award whose position is constrained by surrounding
settlements. Unopened and unused slots remain `provisional` and can move when later evidence arrives.
Use `quickScore` only as unsettled provider telemetry; `score` plus half/overtime fields are the
formal score model. A no-play map can carry upstream zero-filled round placeholders and player rows;
the package normalizes the former away and reports the latter as `NON_OFFICIAL_ACTIVITY`.
Some awarded no-play maps retain raw provider `statusCode: -1`; when the result, exact `1:0` score,
absent gameplay timing/stage, and zero official gameplay fields all agree, the normalized map is
still `closed-without-play` with `technicalDisposition: 'awarded'`. Inspect `providerState` when the
raw lifecycle code matters, and treat blocked near-matches as contradictory evidence.
If the provider later erases the map-level award, a terminal `2:1` can still yield the same
normalized award only when one empty settled no-play slot and two played settlements leave exactly
one winner missing from the final series score. This inference is not applied to `2:0`, live,
multi-gap, or contradictory snapshots.

Use `settled`, `played`, `closedWithoutPlay`, `technicalDisposition`, and `winnerTeamId` rather than
deriving map semantics from a score. An administrative 1:0 result is deliberately different from a
played 1:0 map.

Before the provider produces a field, it is `null` or empty. Do not carry a value forward from an
older snapshot and present it as current without separately labeling it last-known-good.

## Handle detail completeness explicitly

The five fixed detail sections are `analysis`, `events`, `teamRecentMatches`, `teamPastMatches`, and
`community`. Each has its own status even when core match state is confirmed.

Within `events`, a repeated stable provider event ID can revise mutable enrichment such as assist
data. The source retains the highest compatible update version and still reports
`EVENT_VERSION_CONFLICT` when the event's core identity changes.

```ts
import type { DataSection } from '@ekmanss/5eplay';

export function availableRows<Row>(
  section: DataSection<readonly Row[]>,
): readonly Row[] | null {
  switch (section.status) {
    case 'complete':
    case 'empty':
    case 'partial':
      return section.data;
    case 'unavailable':
    case 'not-applicable':
      return null;
  }
}
```

| Status | `data` | Meaning |
| --- | --- | --- |
| `complete` | Present | Fully collected within configured limits |
| `empty` | Present and empty | The provider successfully returned no items |
| `partial` | Present | Useful data exists, but `gap` identifies what is missing |
| `unavailable` | `null` | Collection or decoding failed; `gap` identifies why |
| `not-applicable` | `null` | The section does not apply to this observation |

`empty` is a successful result. Do not display it as a provider outage. Conversely, do not replace
`unavailable` with an empty array. `snapshot.detailsCompleteness` is only a convenient aggregate;
section-level status remains authoritative for each detail product.

Series and per-map player statistics independently expose `overall`, `ct`, and `t` planes. Each
plane is `present`, `empty`, or `unavailable`; never synthesize a missing side split from overall
statistics. `TIMELINE_INCOHERENT` means its counters cannot fit the confirmed round budget;
`NON_OFFICIAL_ACTIVITY` means rows were attached to a no-play map. Opponent duel rows have their own
completeness status.

Event rows expose `providerBoutId`/`providerBoutNumber` for upstream identity and `mapNumber` for
chronological series order. Activity attached to an unopened or no-play map is excluded even when
the provider's pagination is stable; do not reconstruct those warmup rows from raw provider slots.

## Consistent compare-and-read

Use the opaque revision token when an operation must verify that trading-relevant state did not
change while details were collected:

```ts
const first = await source.snapshot(matchId);

if (first.kind === 'confirmed') {
  const second = await source.snapshot(matchId, {
    expectedRevision: first.snapshot.revision,
    deadlineMs: 120_000,
  });

  if (second.kind === 'superseded') {
    // Discard the decision based on `first` and restart from a fresh snapshot.
  }
}
```

Revisions are equality tokens, not sortable provider versions. They cover phase, lifecycle, series
and map score, settlement, current round, teams, closure and finality. High-frequency player,
economy, equipment and bomb telemetry is deliberately excluded. Therefore:

- use revision equality for decisions tied to match progression;
- do not deduplicate every player/economy update solely by revision;
- store `observedAt` and `freshness.coreObservedAt` alongside cached observations.

## Historical Markdown evidence

Use the default `renderMatchMarkdown(snapshot)` for the current match. When a complete historical
match is embedded as supporting evidence, use
`renderMatchMarkdown(snapshot, { profile: 'historical-evidence' })`. The profile keeps the
historical match's own competitive facts and analysis but removes its nested `近期战绩` and
`交手战绩` subsections, including summaries and rows. Its explicit omission note distinguishes
consumer-requested de-nesting from provider missing data. Do not mutate a `MatchSnapshot` to empty
those arrays before rendering; that would preserve a `complete` section status while changing its
meaning.

## Realtime watch

Use `watch()` when a process owns a match for more than one read. HTTP remains authoritative; MQTT
only triggers resynchronization and carries best-effort provisional telemetry.

```ts
const controller = new AbortController();
const watch = source.watch(matchId, { signal: controller.signal });

try {
  for await (const update of watch) {
    switch (update.kind) {
      case 'confirmed-state':
        // Safe to replace the current authoritative core observation.
        persistConfirmed(update.observation);
        break;

      case 'provisional-telemetry':
        // Suitable for transient UI/metrics only. Never advance match state from it.
        observeTelemetry(update.telemetry);
        break;

      case 'blocked':
        // Freeze automatic decisions. update.lastConfirmed may be displayed as stale data.
        markBlocked(update.reason, update.lastConfirmed);
        break;

      case 'not-found':
      case 'unsupported':
        // Terminal for this watch.
        break;
    }
  }
} finally {
  await watch[Symbol.asyncDispose]();
}
```

`watch()` returns synchronously and `current()` is initially `null`. Its first update is always
`blocked / initializing`. After MQTT subscription, the initial HTTP baseline produces the first
`confirmed-state`. A state-topic disconnect produces `blocked / realtime-unavailable`; the watcher
requires fresh credentials, SUBACK, and an HTTP resync before it confirms again. A stable closed
state completes the iterator automatically.

Breaking out of the iterator does not replace explicit ownership cleanup. Always dispose in a
`finally` block, use `await using`, or abort the supplied signal.

## Retry and safety policy

A reasonable consumer policy is:

| Condition | Recommended action |
| --- | --- |
| schedule `blocked / provider-unavailable` | Retry the same page with exponential backoff and jitter |
| schedule `blocked / provider-schema-unsupported` | Stop consuming that page and surface the provider change |
| `blocked / initializing` or `resyncing` | Wait for the watcher; do not start a second watcher |
| `blocked / provider-unavailable` | Exponential backoff with jitter; retain last confirmed data as stale |
| `blocked / stale-http` or `version-gap` | Freeze decisions until a confirmed resync |
| `blocked / inconsistent-state` | Freeze decisions and surface its machine-readable `diagnosticCode` |
| `unsupported / participants-unresolved` | Keep the known BO3 discovery row and retry after bracket participants resolve |
| `blocked / realtime-unavailable` | Let the existing watcher reconnect; HTTP resync is mandatory |
| `superseded` | Retry immediately from a fresh snapshot |
| `FiveEPlaySourceError / ABORTED` | Stop if caller-initiated; otherwise apply the operation timeout policy |
| `FiveEPlaySourceError / INVALID_ARGUMENT` | Fix configuration; do not retry unchanged input |

Prefer one watcher per match per process. If multiple components need the same match, fan out one
confirmed stream internally instead of opening duplicate MQTT sessions. Configure bounded event and
history limits rather than removing safety caps.

## Time and persistence

- Numeric timestamps are Unix milliseconds in UTC.
- `tournament.providerLocalStartTime` and `providerLocalEndTime` remain provider-local strings
  because the provider timezone is not evidenced; do not append `Z` or convert them as UTC.
- `match.scheduledAt` is advisory. Match progression comes only from confirmed state.
- Persist `schema`, `revision`, `observedAt`, `state`, `providerState`, `maps`, `details`, and section
  statuses when an
  audit trail is needed.
- Keep the complete discriminated unions in stored JSON. Flattening them too early can erase the
  difference between unavailable, empty, unplayed, played, and administratively closed data.

## Deliberate exclusions

The package does not return 5EPlay odds, streams, chat, post-match editorial content, general
discovery/list products beyond the single-page CS2 schedule, rendered Markdown, browser state, or
account state. Schedule rows are deliberately separate from confirmed match observations.

## Production checklist

Before enabling automated decisions:

- [ ] Run Node.js 22 or newer in ESM mode.
- [ ] Validate and store the `csgo_mc_*` match ID separately from the page URL.
- [ ] Treat schedule status as discovery data and call `snapshot()` for authoritative match state.
- [ ] Fetch additional schedule pages explicitly; never read `mayHaveNextPage` as proof of data.
- [ ] Exhaustively handle every snapshot result and watch update kind.
- [ ] Derive application phase from `state.phase` plus `lifecycle`.
- [ ] Require `closed / stable` for irreversible settlement unless policy says otherwise.
- [ ] Treat MQTT telemetry as provisional and HTTP observations as authoritative.
- [ ] Preserve `empty`, `partial`, `unavailable`, and `not-applicable` as distinct values.
- [ ] Keep automated BO1 handling disabled while it is `format-unverified`.
- [ ] Dispose every watcher and bound retries, deadlines, pages, and events.
- [ ] Emit diagnostics for prolonged blocks and retain the last confirmed observation as stale,
      never as current confirmation.
- [ ] Pin or deliberately upgrade the package version and run a real-match smoke test before rollout.
