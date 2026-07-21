# 5EPlay live validation — 2026-07-21

This log records production observations before any implementation change. Timestamps are UTC.

## Scope and stopping rule

- Package: `@ekmanss/5eplay@20260721.2.0`
- Commit: `c9e571c`
- Runtime: Node.js `v24.15.0`
- Provider schedule page: `https://event.5eplay.com/csgo/matches`, page 1
- Stop after five independent reproducible defects, or after every currently visible live match and
  the relevant live-state transitions have been exercised without finding another defect.

## Baseline

At `2026-07-21T08:07:03Z`, the first schedule page contained 20 source rows: three `live` and 17
`upcoming`. The normalized schedule returned the same three live match IDs in provider order:

- `csgo_mc_2395923`
- `csgo_mc_2395548`
- `csgo_mc_2396081`

Pages 1 through 5 each contained 20 source rows and all 100 rows decoded successfully. Later pages
contained future bracket slots whose team names were `TBD` and whose provider team IDs were empty;
the normalized schedule preserved those unknown identities as `null` rather than inventing IDs.
During live transitions, schedule map evidence could arrive before the corresponding detail
snapshot became coherent. This confirms that the list is suitable for discovery but is not an
atomic or authoritative detailed-phase observation.

Before a map started, all three core vectors were `[1,-1,-1,-1]`. Two consecutive `snapshot()`
calls for each match returned `confirmed / map1-unopened`; all five detail sections were either
`complete` or successfully `empty`.

## LIVE-001 — a newly live map is blocked as inconsistent

- First observed: `2026-07-21T08:07:50Z`
- Match: `csgo_mc_2395548`
- Severity: high
- Status: fixed in the current `fiveeplay-match/v3` tree; deterministic regression covered

The provider core vector changed from `[1,-1,-1,-1]` to `[1,1,-1,-1]`, which is the documented
`map1-live` vector. Immediately afterward, two consecutive public calls returned:

```json
{
  "kind": "blocked",
  "matchId": "csgo_mc_2395548",
  "reason": "inconsistent-state"
}
```

Expected: `confirmed` with `state.phase = { kind: "map-live", mapNumber: 1 }` and the available live
map data.

Observed impact: a consumer cannot obtain authoritative state or detailed data during this real
map-live transition and must freeze automated decisions.

Raw provider payloads used for diagnosis were stored temporarily outside the repository under
`/tmp`; no provider capture or generated debug artifact is committed here.

### Deterministic reproduction and diagnosis

The saved core response reproduced the public failure without network access or optional details
using the following transient diagnostic command:

```bash
pnpm --filter @ekmanss/5eplay exec tsx /tmp/repro-live-001.ts
```

The direct core decoder rejects it with `played map score breakdown is inconsistent`. During the
first live round, both teams had provider `quick_score="1"` while `all_score="0"` and
`fh_score="0"`. Changing only both quick scores to `0` made the exact captured response confirm as
`map1-live`; changing either team alone, the bomb fields, or the empty map start time did not.
Changing the formal and first-half scores to `1` also confirmed the response.

This establishes that the implementation incorrectly requires the provider's provisional quick
score to equal its settled map score. The provider legitimately advances quick score during an
unsettled live round, so snapshots can be blocked while a round is in progress.

A 90-second follow-up spanning provider rounds 4 and 5 never produced a readable interval: formal
scores advanced from `2:1` to `3:1`, while quick scores advanced from `3:1` to `4:1` and then
`5:1`. This is not a millisecond transition race; the defect can make the whole live map
unavailable.

At the regulation half switch, a brief exact-score window allowed `csgo_mc_2395548` to confirm. The
decoded second-half state was coherent: regulation round 13, score `10:3`, first-half score `9:3`,
second-half score `1:0`, and the expected side/role transition. This positive observation narrows
LIVE-001 to provisional quick-score handling rather than the half-switch normalization itself.

## Realtime baseline

For `csgo_mc_2396081` while its vector was `[1,-1,-1,-1]`, a real `watch()` produced the required
sequence `blocked / initializing` followed by `confirmed-state / map1-unopened`, then disposed
cleanly. No independent realtime defect was observed in that baseline.

## LIVE-002 — event history becomes unavailable during the pre-map live window

- First observed: `2026-07-21T08:10:53Z`
- Match: `csgo_mc_2395923`
- Severity: medium
- Status: fixed in the current `fiveeplay-match/v3` tree; deterministic regression covered

The same match previously returned a `confirmed / map1-unopened` snapshot with 17 complete event
rows. While its authoritative core vector remained `[1,-1,-1,-1]`, a later confirmed snapshot
reported:

```json
{
  "detailsCompleteness": "partial",
  "events": {
    "status": "unavailable",
    "gap": "EVENT_IDENTITY_OR_SCHEMA_MISMATCH"
  }
}
```

The other four detail sections remained complete or successfully empty. Expected: newly arriving
valid provider events either extend the event history or are represented by an explicit supported
partial condition; the entire event section should not regress from complete to unavailable solely
because the match is waiting for map 1 to start.

### Deterministic reproduction and diagnosis

The saved core and event responses reproduced the failure without network access using the
following transient diagnostic command:

```bash
pnpm --filter @ekmanss/5eplay exec tsx /tmp/repro-live-002.ts
```

One valid provider `type=10` match-started event used the engine map name `de_ancient`; the core and
all ordinary event rows used the display name `Ancient`. Normalizing only that outer event field to
`Ancient` changed the event section from unavailable to complete with 84 rows. Removing only the
type 10 row also confirmed 83 complete rows, while removing player-quit or kill rows did not.

The implementation therefore treats two provider-supported names for the same map as conflicting
identities. It needs an evidence-backed engine-name/display-name canonicalization before enforcing
the core/event map join.

## LIVE-003 — warmup player statistics leak into a confirmed live map

- First observed: `2026-07-21T08:22:15Z`
- Match: `csgo_mc_2395923`
- Severity: high
- Status: fixed in the current `fiveeplay-match/v3` tree; deterministic regression covered

The authoritative vector had just become `[1,1,-1,-1]`. Two consecutive snapshots confirmed
`map1-live` with map 1 at round 1 and score `0:0`, but exposed `overall / present` player rows with
impossible official-match totals accumulated before the map started. Examples included:

- one player with 25 kills at round 1;
- several players with 12 deaths at round 1;
- player money as high as 56,300;
- both teams' aggregate kills and deaths far beyond one CS2 round.

Expected: player rows that cannot belong to the confirmed official map timeline must not be exposed
as current match statistics. They should remain unavailable/empty with an explicit gap until the
provider data becomes coherent, or be separately labeled as warmup data if such a product is ever
supported.

Observed impact: consumers receive a confirmed match phase together with materially false player
statistics, which is more dangerous than an explicit unavailable slice.

### Deterministic reproduction and diagnosis

The captured core response reproduced the leak without network access using the following
transient diagnostic command:

```bash
pnpm --filter @ekmanss/5eplay exec tsx /tmp/repro-live-003.ts
```

The assertion observes 77 aggregate deaths at round 1. All ten player IDs exactly matched the two
analysis rosters, ruling out a simple roster identity mismatch. During a subsequent 37-second
observation, the provider state remained round 1, score `0:0`, and empty `start_time`, while the
aggregate deaths grew from 114 to 132 and kills from 107 to 123. This is a respawning warmup stream,
not an official CS2 round.

The implementation validates player identity and numeric shape but not temporal plausibility
against the confirmed map timeline. A live player plane needs a coherence bound derived from
`currentRound`, settled round arrays, score, and non-respawning CS2 semantics; incoherent rows must
be isolated behind an explicit gap rather than marked present.

## LIVE-004 — an apparently official map 2 starts while map 1 is unopened

- First observed: `2026-07-21T08:26:34Z`
- Match: `csgo_mc_2396081`
- Severity: high if confirmed as official play
- Status: fixed in the current `fiveeplay-match/v3` tree; deterministic regression covered

The provider core vector changed from `[1,-1,-1,-1]` to `[1,-1,1,-1]`: bout 1 (`Ancient`) stayed
unopened while bout 2 (`Mirage`) became live. Two public snapshots correctly refused the unknown
vector as `blocked / inconsistent-state` under the current protocol model.

The shape did not disappear as a brief server warmup artifact. Bout 2 subsequently advanced from
round 1 at `0:0` to round 2 at `0:1`, while bout 1 remained unopened. If round, player, event, and
veto evidence confirms this as official play, the implementation's assumption that provider bout
number is always chronological series order is invalid for a real match, leaving consumers without
an authoritative live state.

### Deterministic reproduction and diagnosis

The captured core response reproduced the block without network access using the following
transient diagnostic command:

```bash
pnpm --filter @ekmanss/5eplay exec tsx /tmp/repro-live-004.ts
```

The direct decoder reports `unsupported live provider state vector 1/-1/1/-1`. Bout 1 had only a
match-started event and no official round evidence. Bout 2 had coherent score/round arrays, exactly
ten aggregate deaths after its first settled round, and round-start/round-end events advancing into
round 3.

Changing only the provider bout numbers so that live Mirage becomes chronological map 1 made the
same core response confirm as `map1-live` with score `0:1`; merely changing provider array order did
not. This confirms that provider bout number is not a safe chronological series-map number. The
domain model needs a separate provider bout identity and evidence-derived play order, with event
joins translated through that mapping.

## LIVE-005 — warmup events are exposed as complete match history

- First observed: `2026-07-21T08:10:53Z` in the LIVE-002 capture
- Match: `csgo_mc_2395923`
- Severity: high
- Status: fixed in the current `fiveeplay-match/v3` tree; deterministic regression covered

The captured authoritative core still said `map1-unopened`, but the event endpoint already
contained many respawning warmup kills and player join/quit events. Isolating LIVE-002 by changing
only `de_ancient` to `Ancient` made the current implementation report all 84 rows as
`events / complete`.

The public event model does not label these rows as warmup or otherwise distinguish them from
official match history. Expected: events that precede an evidence-backed official map timeline must
either be excluded, explicitly labeled as warmup/provisional, or held behind an honest gap. They
must not be presented as complete official event history.

Observed impact: consumers can compute kills, participation, or audit history from events that did
not occur in the official match, even if LIVE-003 player-stat validation is fixed separately.

### Deterministic reproduction and diagnosis

The same captured core and event responses reproduced this independently of LIVE-002 using the
following transient diagnostic command:

```bash
pnpm --filter @ekmanss/5eplay exec tsx /tmp/repro-live-005.ts
```

The reproducer changed only the single engine-name alias `de_ancient` to `Ancient` to remove
LIVE-002 from the experiment. The resulting public snapshot was `confirmed / map1-unopened`, while
the event section was `complete` with 84 rows: 56 kills (`type=8`), 26 player-quit rows (`type=4`),
one player-join row (`type=3`), and one match-started row (`type=10`). The red assertion expected no
official kills for an unopened map and observed 56. A decoded kill included concrete killer and
victim IDs, sides, weapon, coordinates, and an evidence reference, so consumers cannot distinguish
it from an official kill by shape.

The captured provider rows contained no explicit warmup flag, timestamp, or round number, and no
official round-start or round-end events (`type=1` or `type=2`). The current event decoder validates
schema and match/map/tournament identity, then classifies the section as complete from stable
pagination alone; it never reconciles the rows with the confirmed core phase or an official-round
boundary. Thus the provider's pre-round respawning stream is exposed as complete match history.

This needs a cross-source timeline gate: event rows before evidence-backed official play must stay
provisional/unavailable, be excluded, or be explicitly modeled as warmup. Transport completeness
must not imply semantic completeness.

## LIVE-006 — a no-play award can occur while the series is still live

- First observed: `2026-07-21T10:12:46Z` during the post-implementation live smoke
- Match: `csgo_mc_2396081`
- Severity: high
- Status: fixed in the current `fiveeplay-match/v3` tree; deterministic regression covered

The follow-up core response was still `global_state.status="1"` with series score `1:1`, but its
provider bouts were:

| Provider bout | Map | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Ancient | settled/no-play | result `t1`, formal `1:0`, no start/end/round/stage |
| 2 | Mirage | settled/played | `13:16`, overtime, start/end present |
| 3 | Dust2 | live | second half, round 20, `10:9` |

The evidence-backed chronological state is therefore Mirage as map 1, the awarded Ancient as map 2,
and live Dust2 as map 3. This disproves the previous implementation rule that any
`closedWithoutPlay` map before `global=2` is inconsistent.

The awarded bout also contained zero-valued placeholder data: both teams had 12-entry first- and
second-half arrays, 24-entry overtime arrays, and zero half/overtime scores despite having no play
time. Both `t*_pr_stats` lists had five rows. These values cannot be interpreted as official rounds
or official player statistics for the no-play map.

### Deterministic reproduction and diagnosis

The live `snapshot()` smoke returned `blocked / inconsistent-state`. A tight direct-core loop first
failed with `unplayed map contains gameplay team data`. Changing only the zero placeholder half and
overtime fields to empty values advanced the same payload to
`technical map closure appeared before terminal state`. This isolated two independent obsolete
assumptions: no-play placeholders had to be empty, and an award was allowed only after terminal
global status.

The regression test constructs the minimal public `snapshot()` shape from retained real fixtures;
it is explicitly synthetic because the LIVE-006 raw response was not persisted. The current
implementation accepts only zero/empty no-play placeholders, isolates present no-play player planes
as `NON_OFFICIAL_ACTIVITY`, orders played settlements before awards and awards before the current
live map, and still rejects unused no-play slots or nonzero gameplay evidence during a live series.

## Result and remaining risk

The original stopping threshold was reached with five independent reproducible defects, so the
initial monitoring pass stopped as specified. A later post-implementation smoke exposed LIVE-006.
At initial capture time no product code, fixture, API contract, or package version was changed. The
current tree now covers all six defects through deterministic public-seam regressions and uses the
clean-break `fiveeplay-match/v3` model.

| ID | Failure mode | Consumer risk |
| --- | --- | --- |
| LIVE-001 | Provisional quick score blocks a live round | No authoritative state or data during live play |
| LIVE-002 | Engine/display map aliases invalidate event identity | Event history becomes unavailable |
| LIVE-003 | Warmup player counters are marked present | Confirmed snapshots contain false player statistics |
| LIVE-004 | Provider bout number is assumed to be chronological | Real map play is rejected as an impossible vector |
| LIVE-005 | Warmup events are marked complete | False kills and participation enter official history |
| LIVE-006 | Mid-series no-play award is treated as terminal-only | A real live map 3 is blocked |

Current implementation mapping:

- LIVE-001: quick score is preserved as provisional telemetry and excluded from formal score equality;
- LIVE-002: event/core map names use canonical engine/display identity;
- LIVE-003: temporally impossible player planes are isolated as `TIMELINE_INCOHERENT`;
- LIVE-004: provider bout identity and chronological map number are separate fields;
- LIVE-005: unopened and no-play map activity is excluded from the official event section.
- LIVE-006: zero no-play placeholders are normalized, non-official player rows are isolated, and a
  mid-series award can precede the current live map.

The observations cover one real schedule page, all three live matches visible at the start, the
map-1 unopened-to-live transition, first-half live rounds, a half switch, realtime initialization,
and a non-chronological provider bout through a played/awarded/live three-map state. They do not
prove correctness for BO1 closing, match cancellation, repeated awards, multiple unused slots, or
all final-closure revisions. Those paths remain unverified rather than known-good.

## Clean-break follow-up verification

- Window: `2026-07-21T10:24:22Z` through `2026-07-21T10:39:25Z`
- Commit under test: `b241f3e`
- Runtime: Node.js `v24.15.0`
- Method: visible Chrome DOM, Chrome-observed `/data` responses, and independent public
  `schedule()` / `snapshot()` calls
- Result: no new collector defect found in the exercised states

The first schedule page initially showed three live matches and later showed four when
`csgo_mc_2395549` crossed its planned start boundary. In both observations `schedule()` returned
20 source rows in the same provider order. Its live/upcoming labels, series scores, visible map
scores, and current-map summaries agreed with the page. As designed, the list remained discovery
data: the between-map row had no current map, while the newly live unopened row identified map 1
without inventing a map result.

The following detail observations were cross-checked:

| Match | Visible/raw evidence | Confirmed result | Detail outcome |
| --- | --- | --- | --- |
| `csgo_mc_2395923` | page `1:1`; Ancient `13:8`; Dust2 `13:16`; raw vector `[1,2,2,-1]` | `live / between-maps`, previous 2, next 3 | all five sections complete or validly empty; 820 official events |
| `csgo_mc_2395996` | map 1 Inferno live; page advanced to `4:6` while formal score was `2:6` and quick score `4:6` | `live / map-live(1)` | complete snapshot; ten current-map player rows; quick score stayed provisional |
| `csgo_mc_2396057` | map 1 Ancient live at round 6 and `2:3` | `live / map-live(1)` | complete snapshot; ten current-map player rows and 332 official events |
| `csgo_mc_2395549` | raw vector changed from `[0,-1,-1,-1]` to `[1,-1,-1,-1]`; page changed from countdown to LIVE with unnamed, scoreless maps | `scheduled / prestart` through `10:30:42Z`, then `live / map-unopened(1)` at `10:30:48Z` | analysis and both history planes complete; community/events validly empty; no official player rows |

Chrome also observed the page requesting the same public core, analysis, event-log, recent-match,
and past-match endpoints documented by the provider facts. The raw unopened response contained
`global_state.status="1"`, three `bout status="-1"` values, no BP entries, and no map names. This
directly corroborates that the planned time and page LIVE label are insufficient to call map 1
live; the public state machine correctly required bout evidence.

Twelve additional paired snapshots from `10:36:29Z` through `10:39:25Z` consistently returned
`between-maps(2,3)` and `map-unopened(1)` for the two transition candidates. None returned a
transient wrong phase, an inconsistent-state block, or a regressed detail section.

This follow-up did not reach the next transition for `csgo_mc_2395923` or `csgo_mc_2395549` during
the window, and no live BO1 was present on the first schedule page. BO1 closing, the map-3 start,
and stable terminal closure therefore remain unverified rather than implicitly accepted.
