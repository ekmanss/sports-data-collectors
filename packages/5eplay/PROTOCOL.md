# 5EPlay match protocol invariants

This document records only invariants used by the current implementation. Deterministic evidence
provenance and hashes are in `tests/fixtures/manifest.json`.

Provider observations and unresolved counterexamples are maintained separately in the
[schedule-page facts](../../docs/provider/5eplay-schedule-page-facts.md),
[match-page facts](../../docs/provider/5eplay-match-page-facts.md), and
[live validation log](../../docs/live-validation-2026-07-21.md). This implementation contract must
not be treated as proof that the provider cannot emit a shape which the current package rejects.

## Authority and endpoints

`GET https://esports-data.5eplaycdn.com/v1/api/csgo/matches/{matchId}/data` is the sole confirmed
state authority. MQTT is provisional telemetry and invalidation. A snapshot reads `/data`, collects
details, then reads `/data` again; only an unchanged semantic confirmed revision crosses the
barrier. Terminal closure additionally requires an unchanged provider state version.

`GET https://app.5eplay.com/api/tournament/session_list?game_status=1&game_type=1&grades=&page={page}&limit=20`
is a discovery source only. It cannot confirm the detailed phase of a match.

Fixed detail sources are:

- `/matches/{matchId}/analysis_v1`;
- `/teams/{teamId}/matches?page={page}&limit=20`;
- `/team/matches_v1/{teamId}?page={page}&limit=30&status=past`;
- `/match/{matchId}/event/log?update_version={cursor}&limit={limit}`;
- `https://app.5eplay.com/api/score/match_score_tab` and its card endpoint.

The two team-history endpoints are different products and remain separate sections. Each is read
through the advertised `total_page`, subject to the configured page limit; page-count drift,
identity mismatch, row-count mismatch, timeout, or truncation is surfaced as an explicit gap.
Scores and results are always rebound to explicit team IDs; `home/opponent` and `t1/t2` coordinates
are never assumed interchangeable.

## Schedule discovery

One `schedule()` call reads exactly one positive safe-integer page with the fixed limit 20 and
preserves provider order. It never follows another page. `sourceCount` is the raw number of source
rows; a full source page sets `mayHaveNextPage: true`, which is not evidence that the next page has
rows.

Global match state `0` or `-1` maps to `upcoming`, `1` maps to `live`, and `2` is validated and then
excluded. A live map may promote a lagging upcoming global state to `live`. Map state `-1` or `0`
is unopened, `1` is live, and `2` is settled. More than one live map, a completed match with a live
map, an upcoming match with settled maps but no live map, duplicate match or map identities, or an
unknown required status blocks the entire page as `provider-schema-unsupported`; the package does
not guess around contradictory list data. HTTP failure blocks the page as `provider-unavailable`.

Schedule rows expose normalized identity, URL, plan time, BO number, team/rank and series-score
data, map summaries, current map number, tournament, and stage. Provider odds, video/stream flags,
engagement data, and unrelated additive fields are ignored. Consumers must call `snapshot()` with
the returned match ID for authoritative phase and complete detail collection.

## Evidence-derived BO3 classification

`global_state.status` and each bout's lifecycle fields determine phase. `bout_num` is preserved as
`providerBoutNumber`, a stable provider identity, but it is not chronological map order. Played
settlements are ordered by evidenced `start_time`; awarded no-play settlements follow them; the
current live bout follows all settlements; unopened slots come last. When the BP vector contains
three unique pick/pick/left map names and all three names join uniquely to the bout maps, that
explicit selected-map order takes precedence. This covers both the observed played → awarded → live
sequence with provider numbers 2 → 1 → 3 and a terminal award in map 1 followed by two played maps.
Provider bout number is only the deterministic tie-breaker inside equally unevidenced groups. The
resulting one-based position is `mapNumber`. Played, live, and awarded maps have
`orderFinality: 'confirmed'`; unopened and unused slots remain `provisional`.

`plan_ts`, `live_status`, page text, quick score, player counters, and logging text never promote the
authoritative phase. A complete, uniquely joined BP vector orders maps but never changes lifecycle
or result evidence.

| Core evidence | Confirmed phase |
| --- | --- |
| `global=0`, every map unopened | scheduled / `prestart` |
| `global=1`, no map started | live / `map-unopened` with the next `mapNumber` |
| `global=1`, exactly one live map and all earlier maps settled | `map-live` with its chronological `mapNumber` |
| `global=1`, no live map, settled prefix followed by unopened maps | `between-maps` with previous and next chronological numbers |
| `global=2`, no live map, winner counts and series score agree | `series-ended` with the final chronological map number |

Contradictory evidence remains blocked: this includes multiple live maps, a live match that already
has a series winner, chronological gaps, a terminal match with a live map, or series scores that do
not equal accepted map winners. A settled map without a start time is never treated as played. A
live series may contain an awarded `1:0` no-play map before the current live map; an unused no-play
slot or nonzero official gameplay fields in that position remains contradictory. A terminal
administrative series accepts any contiguous chronological prefix composed of played settlements
and evidenced `1:0` no-play awards; any later slot must be unopened or an unused no-play map with no
score, result, timing, rounds, or players. These maps expose `closedWithoutPlay: true` and
`technicalDisposition: 'awarded' | 'unused'`. Other technical-looking combinations remain blocked.

A no-play award may contain zero-valued half/overtime scores and fixed-length zero round arrays.
They are accepted only when every value is zero and all timing/current-round gameplay evidence is
absent, then normalized to empty public process fields. Present player planes on a no-play map are
isolated as `NON_OFFICIAL_ACTIVITY`; they never become official statistics for the award.
The provider can retain legacy bout `status=-1` after recording the winner and `1:0` award. That
shape is normalized to the same awarded no-play state only when its result, exact scores, absent
timings/stage, and zero official gameplay fields all agree; `providerState` still exposes the raw
`-1`. Any partial or contradictory legacy shape remains blocked.

Provider terminal state first becomes `closing`. It becomes `closed / stable` only after two
consistent HTTP observations at least one live polling interval apart and after the three-minute
default calibration window. A 2:0 terminal series does not pretend that map 3 ended. The live
polling and calibration intervals are configurable within safety bounds.

BO1 is schema-reserved but disabled as `format-unverified`. Enabling it requires two independent,
normal, complete traces covering prestart, map 1 unopened, map 1 live, terminal state, two
post-terminal HTTP observations, and realtime version/log behavior. No runtime feature flag exists.

## Realtime synchronization

Production topics are:

- `csgo/product/detail/{matchId}`;
- `csgo/product/event/log/{matchId}`.

Each topic obtains separate short-lived credentials from
`POST https://www.5eplay.com/api/restrict/matchscore`. Reconnect obtains new credentials. The broker
uses MQTT 3.1.1 over `wss://post-cn-7mz2e5hc90i.mqtt.aliyuncs.com/:443/mqtt`.

The state topic must reach SUBACK before the HTTP baseline and its messages buffer until that
baseline. The event topic starts concurrently but is not part of the confirmation barrier;
event-topic messages are best-effort provisional telemetry and are not an event-history completeness
channel. State messages validate `match.mc_info.id`; event messages validate `info.match_id`. Normal
non-zero state messages must form `next.from_ver === previous.this_ver`. All version values remain
opaque strings. All-zero
`from_ver` messages are independent baseline branches: they trigger HTTP reconciliation and never
advance the normal cursor. `csgo-detail-bp` is invalidation only. A gap, reconnect, zero branch,
identity mismatch, contradictory state, or decode failure triggers HTTP resynchronization.

MQTT may update provisional telemetry, but it cannot update `current()` or create a confirmed phase.
By default, HTTP polling continues at 60 seconds when far prestart, 10 seconds near start, and 5
seconds while live or closing; all three intervals are configurable within safety bounds.
State-topic disconnect blocks until reconnect, SUBACK, and HTTP reconciliation. Event-topic failure
only removes best-effort event telemetry; a later `snapshot()` determines event-history completeness
from HTTP pagination. Payloads buffered by an old state connection are discarded at the connection
epoch change. A successful reconciliation after any blocked update emits a fresh
`confirmed-state`, even when its revision and provider version equal the last confirmation, so the
stream never leaves consumers observably blocked after recovery.

## Event history

Start with cursor `0`. Pages are newest-to-oldest. Continue with the oldest row's
`update_version`; ignore `not_more`. Reaching an empty or short tail page proves only the old end of
the history. The implementation then rereads cursor `0`; it returns `complete` only when the head is
stable. If the head grew during the backfill, it follows the new prefix backwards until it overlaps
the already collected history, then verifies the head again. Head regression, a missing overlap,
conflicting payloads for one event identity, cursor non-progress, a repeated full page, page limit,
event limit, or deadline produces a partial section with an explicit gap. Every request, including
head verification and bridging, shares the same page, event, attempt, signal, and deadline budget.

Deduplicate by stable provider `event_id` within `(matchId, providerBoutId, eventType)` when present,
falling back to `updateVersion`. When a stable identity repeats at different update versions, its
match, bout, map, round, event type, actor, target, team, sides, weapon, and head-shot identity must
remain equal; compatible revisions retain the highest `updateVersion`, even when mutable enrichment
such as assist data changes. A differing identity, or differing payloads at the same update version,
produces `EVENT_VERSION_CONFLICT`. Every row must match the core match ID and tournament ID. Its
provider bout number and ID must join the corresponding core map.
Map names are compared through one canonical identity form that accepts observed display/engine
aliases such as `Ancient` and `de_ancient`; the public event retains the core display name. A row
identity mismatch is isolated, retains the other verified rows, and makes the event section partial
with `EVENT_IDENTITY_OR_SCHEMA_MISMATCH`. A conflicting payload for one stable identity remains a
gap rather than being joined as a new event.

Transport pagination completeness is not semantic match-history completeness. Events belonging to
an `unopened` or `closed-without-play` core map are excluded, because real unopened bouts can carry
unmarked warmup kills, joins, and quits. Consequently, a stable provider history containing only
warmup rows is returned as an empty official event section, not as complete match activity.

Default safety bounds are 200 pages, 100,000 events, and 120 seconds. Unknown event types expose a
minimal envelope plus an evidence reference rather than leaking a provider DTO.

Known events retain `providerBoutId`, `providerBoutNumber`, chronological `mapNumber`, map name, and
tournament ID so consumers can join them to normalized map slots without guessing. Numeric event
player IDs are normalized to the same
`csgo_pl_*` namespace used by core player observations. Core map observations also retain evidenced stage,
regulation-round, display-name, artwork, and veto metadata. Tournament timestamps whose provider
timezone is not evidenced remain labeled provider-local strings rather than being converted to UTC.

## Player statistics

Series and per-map player statistics keep the provider's `overall`, `ct`, and `t` planes separate.
No plane is inferred from another: real terminal observations include maps with overall rows but no
side split, and administrative observations include side rows with an empty overall plane. Each
team/plane is explicitly `present`, `empty`, or `unavailable`; a missing or malformed plane is never
reported as a successful empty array. Per-map comparison highlights, series MVP data, and chart
references are preserved when valid; an unsupported subshape never invalidates another statistics
plane or the authoritative match phase. The observed provider sentinel `NaN%` means that one
percentage is undefined; it becomes field-level `null` and does not invalidate the surrounding
player row or statistics plane.

Player rows retain the evidenced aggregate metrics, opening and headshot measures, multi-kill
count, portraits, and opponent duel rows. Duel rows independently report `present`, `empty`,
`partial`, or `unavailable`; a series MVP whose provider map is populated while its paired list is
empty retains the known opponent counts as `partial` and leaves the missing provider marker `null`.
IDs must be unique within a team and plane, duel identities must belong to the opposing roster, and
ordinary duel maps must be set-equivalent to their paired arrays. Invalid statistics affect only
that statistics slice and never change the authoritative match phase.

For a played map, player kill/death counters must remain plausible for the confirmed current-round
budget, with one round of tolerance for provider update skew. An impossible plane becomes
`unavailable / TIMELINE_INCOHERENT`; other planes and the core phase remain available. `quickScore`
is separately preserved as provisional provider telemetry and may lead formal `score` during an
unsettled round. Formal score validation uses first-half, second-half, and overtime totals. Provider
stage `ot` is exposed as `overtime`.

## Schema and secrecy

Unknown additive fields are ignored. Missing or invalid core fields return
`provider-schema-unsupported`; optional-section schema failures make only that section unavailable.
Every HTTP and MQTT identity is checked. Public numeric fields are finite numbers or `null`; time is
Unix milliseconds; confirmed data is deeply frozen.

5EPlay odds, streams, chat, post-match content, discovery/list APIs beyond the normalized single-page
CS2 schedule, DOM, browser artifacts, cookies, and credentials are out of scope. Credentials are
memory-only and must never be logged or persisted.
