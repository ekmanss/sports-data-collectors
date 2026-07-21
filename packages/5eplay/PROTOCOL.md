# 5EPlay match protocol invariants

This document records only invariants used by the current implementation. Deterministic evidence
provenance and hashes are in `tests/fixtures/manifest.json`.

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

## BO3 classification

Only `global_state.status` followed by the three `bouts_state[].status` values determines phase.
`plan_ts`, BP, `live_status`, page text, and logging text never do.

| Vector | `stateCase` | Confirmed phase |
| --- | --- | --- |
| `0 / -1,-1,-1` | `prestart` | scheduled / prestart |
| `1 / -1,-1,-1` | `map1-unopened` | live / map 1 unopened |
| `1 / 1,-1,-1` | `map1-live` | map 1 live |
| `1 / 2,-1,-1` | `between-map1-map2` | between maps 1 and 2 |
| `1 / 2,1,-1` | `map2-live` | map 2 live |
| `1 / 2,2,-1` | `between-map2-map3` | between maps 2 and 3 |
| `1 / 2,2,1` | `map3-live` | map 3 live |
| `2 / 2,2,-1` | `series-ended-map2-normal` | normal terminal after map 2 |
| `2 / 2,2,2` | `series-ended-map3-normal` or `series-ended-map2-administrative` | normal terminal after map 3, or evidenced administrative terminal after map 2 |

Unknown vectors remain blocked. `global=2` with a live map is contradictory. A terminal series score
must agree with map winners and reach two wins. A settled map without a start time is never treated
as played. The only accepted administrative shape is an ordinarily played and settled map 1,
followed by an awarded map 2 with an exact `1:0` score and no gameplay data, followed by an unused
map 3 with no score, result, timing, rounds, or players. These maps expose
`closedWithoutPlay: true` and `technicalDisposition: 'awarded' | 'unused'`. Any other no-play or
technical-looking combination remains blocked until independent evidence supports it.

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

Deduplicate by `(matchId, boutId, updateVersion)`, compare the normalized full-event payload when
identities repeat, and return numeric versions in ascending order. Every row must match the core
match ID and tournament ID. Its map number, provider bout ID, and map name must also agree with the
corresponding core map slot; an identity mismatch makes the event section unavailable rather than
joining unrelated data.

Default safety bounds are 200 pages, 100,000 events, and 120 seconds. Unknown event types expose a
minimal envelope plus an evidence reference rather than leaking a provider DTO.

Known events retain provider map ID, map number/name, and tournament ID so consumers can join them
to normalized map slots without guessing. Numeric event player IDs are normalized to the same
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

## Schema and secrecy

Unknown additive fields are ignored. Missing or invalid core fields return
`provider-schema-unsupported`; optional-section schema failures make only that section unavailable.
Every HTTP and MQTT identity is checked. Public numeric fields are finite numbers or `null`; time is
Unix milliseconds; confirmed data is deeply frozen.

5EPlay odds, streams, chat, post-match content, discovery/list APIs beyond the normalized single-page
CS2 schedule, DOM, browser artifacts, cookies, and credentials are out of scope. Credentials are
memory-only and must never be logged or persisted.
