# Data contracts

## Match Detail 1.0.0

`getFiveEPlayMatch()` returns `{ data, diagnostics }`. `data` has `schemaVersion: '1.0.0'`,
`sport: 'cs2'`, a canonical 5EPlay source URL, and the following stable sections.

### Identity and series state

- `match` contains the `csgo_mc_*` identity, numeric projection, live status, CS2 version,
  best-of, schedule, stage, and per-team series score.
- `tournament` contains the event identity, logo, grade, location, prize, dates, and source status.
- `teams` contains exactly the source teams with 5E/Valve ranks, logos, series scores, odds, and
  displayed odds percentages.
- `veto` preserves source order and normalizes `ban`, `pick`, and `left` actions.

When an in-progress API response temporarily omits an unplayed decider from `bouts_state`, the
collector reconstructs that `upcoming` map from the authoritative veto. It does not invent scores
or player data.

### Maps

Every map contains:

- status, pick ownership, winner, score, current sides, first/second-half and overtime results;
- live round number/stage, round start, timer, bomb state, player health, money, armor, kit, weapon;
- `playerStats[].overall`, `.ct`, and `.t`, covering Rating, K-D-A, K/D, KD difference, KAST, ADR,
  Round Swing, KPR, DPR, impact, multi-kill rating, headshots, first kills, flash assists, trades,
  clutches, MVPs, and multi-kills;
- `playerDuels`, the exact Player Comparison matrix represented as typed player/opponent kill rows;
- public highlights and milestones;
- `eventLog.events` in chronological order.

An HTTP log page with `not_more: '1'` is marked `complete: true`. Each event retains the provider's
monotonic `updateVersion` and typed round, kill, assist, flash, bomb, join/leave, suicide, restart,
weapon, special-kill flag, and coordinate fields. Unknown future event types remain present as
`kind: 'unknown'` instead of being discarded.

`current` is the same live map object projected at the top level, or `null` when no map is live.

### Analysis and community ratings

`analysis` covers the visible pre-match team metrics, player metrics, map history, player-power
records, recent matches, and head-to-head matches. Provider-specific power records remain JSON
objects so new metrics are preserved without a schema bump.

Each `analysis.recentMatches[]` group exposes typed, completed match references rather than raw
provider JSON. Every reference contains its canonical `csgo_mc_*` ID/URL, numeric ID, completion
status and timestamp, both teams and scores, and the winning team ID. `sourceCount` records how
many source rows were present; `invalidReferenceCount` makes malformed or incomplete source rows
explicit so consumers can fail closed instead of treating them as genuinely missing history.

`communityRatings` contains every public tab and returned card, including player, coach, and
big-event cards. Account-specific `my_*` voting state, write actions, and chat messages are not
returned.

### Missing values

Missing numeric/string scalars are `null`; collections are empty arrays. Source percentage strings
are returned as numbers without `%`. Provider IDs stay strings because team, player, tournament,
and match namespaces are distinct.

## Realtime updates

A `FiveEPlayMatchSession` is an async iterable of:

- `snapshot`: the initial complete HTTP result;
- `state`: a merged MQTT scoreboard/state update;
- `log`: one deduplicated MQTT event-log update.

Every update includes a complete immutable snapshot. MQTT messages can be partial: map states are
merged by `bout_num`, while match/tournament/global sections are shallow-merged over the verified
HTTP baseline. Log events are merged by `updateVersion` and remain chronological.

If an MQTT state regresses a started map's team score or status, the session withholds that state
and performs one authoritative HTTP resync. A rollback confirmed by HTTP becomes the new baseline;
otherwise the session keeps the trusted score and suppresses replay frames until MQTT catches up.
An unsuccessful resync terminates the async iterable with a retryable error instead of publishing
an unverified regressive snapshot.

The credential endpoint's `client_id`, `username`, and `password` are transport-only. They are not
part of either contract.

## Live Matches 1.0.0

`getFiveEPlayLiveMatches()` returns a lightweight `{ data, diagnostics }` result intended for
frequent polling. `data.hasLiveMatches` is exactly `data.matches.length > 0`. Every match contains
its canonical ID/URL, BO format, schedule/stage, tournament identity, two teams and series scores,
available map summaries, and `currentMap`.

The schedule endpoint groups both live and upcoming rows. A row is included only when its series
state is live or it contains a live map. A series remains live between maps even though
`currentMap` is then `null`. Normal polling uses the source's first 20 ordered rows and one HTTP
request; another page is requested only when all 20 rows are live. No detail, analysis, event-log,
community-rating, Markdown, or MQTT credential request is made.

## Diagnostics

Diagnostics include operation timing, canonical input where applicable, warnings, and one sanitized
entry per HTTP request with only request kind, HTTP status, duration, byte size, and optional
map/tab/page identity.
URLs with credentials, request/response bodies, MQTT credentials, cookies, and chat state are never
included.

## Markdown Report 1.0.0

`writeFiveEPlayMatchMarkdown(input, target)` fetches a snapshot, renders a reader-focused report,
creates missing parent directories, and atomically replaces the destination. A target ending in
`.md` is the exact file; any other target is treated as a directory and receives
`<match-id>.md`. `renderFiveEPlayMatchMarkdown(result)` returns the same content without writing.

The report includes:

- a compact match/team overview and the complete veto;
- completed/live map scores, half splits, readable round sequences, player overview/side tables,
  player duels, concise highlights/milestones, and readable event logs;
- a single-line placeholder for each upcoming map;
- compact team/player/map analysis, head-to-head scores, recent results, and seven player-power
  category scores;
- sanitized capture diagnostics.

The report intentionally omits community ratings, odds, logos, schedule/event metadata, transport
versions, coordinates, raw round/milestone/power JSON, and provider-only codes. Those values remain
available in the typed Match Detail contract. The Markdown writer also disables the community
rating HTTP requests, while all other report data is fetched normally.
