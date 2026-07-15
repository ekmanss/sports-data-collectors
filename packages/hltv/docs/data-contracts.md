# Data contracts

`@ekmanss/hltv` returns `{ data, diagnostics }`. Business data is isolated from collector evidence and browser implementation details.

## Shared rules

- `capturedAt`, `startedAt`, and `completedAt` are UTC ISO strings.
- `sport` is `cs2` and `source.provider` is `hltv`.
- Missing scalar source data is `null`; missing collections are empty arrays.
- Raw HTML, selectors, CSS classes, proxy configuration, and credentials are never returned.
- Collector package versions live in diagnostics, not business data.

## Live Matches 1.0.0

`getHltvLiveMatches()` and `client.getLiveMatches()` return one snapshot:

```ts
interface HltvLiveMatchesData {
  schemaVersion: '1.0.0';
  capturedAt: string;
  sport: 'cs2';
  source: {
    provider: 'hltv';
    url: 'https://www.hltv.org/matches';
  };
  matches: HltvLiveMatch[];
}
```

Each match contains a positive HLTV ID, canonical URL, literal `live` status, nullable best-of/region/LAN metadata, nullable event metadata, and exactly two named teams. Each team carries nullable ID and Logo URL plus separate nullable `currentMap` and `mapsWon` scores.

The collector deliberately excludes odds, stars, map pools, Scorebot, raw DOM, and URL slugs.

### Live consistency

- Source order is preserved.
- Duplicate match IDs merge deterministically at the first position.
- A card without a reconcilable ID/URL or two named teams is skipped with a warning.
- Optional missing fields do not fail the batch.
- Zero live matches is valid.
- If values do not stabilize within five seconds, the latest complete snapshot is returned with `LIVE_STATE_UNSTABLE`.
- A page that cannot be recognized as the HLTV matches page fails with `INCOMPLETE_CAPTURE`.

## Match Detail 3.2.0

`getHltvMatch()` and `client.getMatch()` return the full match-page and Scorebot model:

```ts
interface HltvMatch {
  schemaVersion: '3.2.0';
  capturedAt: string;
  sport: 'cs2';
  source: { provider: 'hltv'; url: string };
  // match, teams, players, lineups, veto, streams,
  // maps, current, matchStats, mapStats, recentMatches, headToHead
}
```

`matchStats.views` contains every published Match stats combination without depending on the
currently selected page controls. A view identifies `All maps` with `map: null` or one completed
map with its HLTV `mapStatsId`, then separates `both`, `ct`, and `t` sides. Each player keeps
traditional and Eco-adjusted kills, deaths, ADR, and KAST together with the view's Round Swing
and Rating 3.0. When HLTV has not published Match stats yet, `views` is empty.

Each Scoreboard team exposes the current semantic `side` from HLTV's `ctTeamHeaderBg` or
`tTeamHeaderBg` class. This is the team side at the captured Scoreboard state, never a permanent team
identity and never evidence for earlier rounds.

Each completed Game log round exposes `winnerTeamId`, cumulative `teamScore`, `winnerSide`, and
cumulative `sideScore`. `winnerTeamId` is resolved from the winning side's event participants and
the canonical lineups; `teamScore` is keyed by stable primary team IDs, so the same team continues
accruing wins after halftime or overtime side changes. If any round cannot be mapped uniquely,
`winnerTeamId` is `null` for that round and cumulative `teamScore` is `null` from that point onward.
Every Game log participant also exposes its canonical nullable `teamId` separately from its
per-event `side`, so consumers never need to repeat lineup joins or infer team identity from color.
`lineups[].players` is the complete roster identity source: every entry has a nickname and a
nullable `playerId`. HLTV occasionally lists a stand-in before creating or linking a canonical
player profile; in that case the participant remains safely assigned to the explicit lineup team,
`playerId` is `null`, and diagnostics include `UNIDENTIFIED_LINEUP_PLAYER`. The legacy
`lineups[].playerIds` field remains the projection of only the identified profile IDs.

`sideScore.ct` and `sideScore.t` remain diagnostic side aggregates: they count rounds won while
playing the corresponding side on that map and must not be interpreted as team scores. They are
derived from the round winners because the two numeric values rendered in HLTV's `Round over` text
follow team ordering, not stable CT/T ordering.

`recentMatches` excludes HLTV's fully empty table row used to represent a team with no matches in
the period. A partially populated source row remains present with nullable identity fields so a
consumer can distinguish incomplete source data from a genuine empty history.

### Match consistency

- `match.id`, `match.slug`, and `source.url` must describe the same canonical HLTV match.
- Exactly two unique primary teams are required.
- Every non-null lineup player ID references a canonical player. A participant without an HLTV
  profile ID is represented by its nickname and explicit lineup team instead of receiving an
  invented ID or making the otherwise complete live match unusable.
- A normalized lineup nickname belongs to at most one primary team, so anonymous Game log
  participants can be assigned only when the team relationship is unambiguous.
- Every Match stats team and player ID references a canonical team or player; substitutes found
  only in Match stats are added to `players` without being invented as lineup members.
- Current map scores equal the number of completed Game log rounds. Completed maps do too when
  their historical Scorebot sequence is available; a collector that joins after a map finished
  keeps the canonical map-card score, leaves the unavailable rounds empty, and emits a matching
  `INCOMPLETE_GAME_LOG` warning instead of discarding the usable current-map snapshot.
- Overlapping Scorebot replay fragments are joined only when the older fragment supplies the missing prefix and agrees with the newer fragment at the splice boundary; the newer replay remains authoritative after that boundary.
- Knife rounds, scoreless draws, and replay fragments that cannot be safely reconciled are excluded rather than counted as official map rounds.
- Stored rounds start at one and increment without gaps.
- A uniquely resolvable round winner references a canonical primary team, and its cumulative
  `teamScore` increments that team regardless of CT/T side changes.
- The latest reliable Game log `teamScore` agrees with the canonical map score.
- When Scoreboard semantic sides are present, exactly one team is CT and the other is T.
- Completed maps contain no unfinished round.
- Scoreboards are included only when their score agrees with the canonical map score.
- `current` is `null` after the match ends.

Undocumented violations fail with `INCOMPLETE_CAPTURE`; a partial historical Game log is accepted
only when its `INCOMPLETE_GAME_LOG` warning exactly matches that completed map's score and captured
round count. A current-map mismatch still fails closed. A Scorebot whose visible score has advanced
before its formal Game log replay catches up is not considered semantically ready: collection keeps
polling inside the bounded window, then falls back to `SCOREBOT_UNAVAILABLE` rather than exposing the
inconsistent current map.

## Diagnostics

Match diagnostics use schema `3.0.0`; live diagnostics use schema `1.0.0`. Both include operation identity, start/end/duration, collector versions, capture attempts, and warnings. Match diagnostics additionally include reconciliation and per-map checks. The first cold match page gets a bounded twelve-second Scorebot readiness window. During a later live inter-map window, HLTV can temporarily omit Scorebot while still exposing canonical map-card scores; the established session waits for at most six seconds and returns a bounded partial snapshot with `SCOREBOT_UNAVAILABLE`, `current: null`, and any incomplete Game log checks preserved as inconsistent. Consumers must abstain from decisions that require current-round evidence. A non-null Scorebot DOM skeleton is also treated as unavailable unless its score, round/map, teams, player rows, and required Game log are semantically usable. Live diagnostics include card counts, skipped cards, duplicate merges, and additive `capture.session` evidence showing whether the persistent `/matches` page was reused, whether this call navigated, and the page age.

The reusable client keeps one `/matches` page open. Warm live-list calls read one semantically hydrated
DOM snapshot without refreshing; the page's native WebSocket continues updating current scores. A
two-minute fallback navigation bounds lifecycle staleness for newly started and completed cards.
Page closure, abort, access challenge, or unrecognized structure discards that session so the next
bounded attempt starts with a fresh page. This behavior changes collection cost, not the
`HltvLiveMatchesData` business schema.

The browser toolbar's transition from stop to reload is not a Match Detail readiness contract. Full
document `load` may wait on unrelated images, advertising, or frames, while the native Scorebot
connection can still be replaying Game log history afterward. The collector therefore begins its
semantic page/Scorebot checks after `DOMContentLoaded` and never uses `networkidle` as live-data
evidence.

HLTV's rendered Scorebot may begin at the current map when a browser joins an already-running
series; the page does not expose a control for recovering the prior map's virtual Game log. In that
case `INCOMPLETE_GAME_LOG` identifies only the affected completed map, while current-map scores,
rounds, and Scorebot remain strictly reconciled.

`match-detail` diagnostics expose pure navigation time separately from capture work. The additive
`capture.timings` object reports milliseconds spent in metadata lookup, page creation, navigation,
page readiness, Scorebot reload/readiness, final page extraction, scoreboards, Game log extraction,
and page close. `capture.scorebot.positionsVisited` reports how many virtual Game log positions were
read by the compatibility fallback; it is zero when the complete rendered component state was
available directly. `capture.session` reports whether the match page was reused, whether the verified snapshot
cache was hit, and the age of the persistent page. A reused match read does not enter the global
cold-navigation queue; unchanged warm reads normally report zero navigation time. These fields are
diagnostic evidence and do not change the `HltvMatch` business schema.
If Match Detail exhausts its capture attempts, the thrown `HltvError.details.attempts` preserves the
bounded attempt timeline instead of discarding the earlier failure evidence.

## Completed Match Stats 1.0.0

`getHltvCompletedMatchStats()` and `client.getCompletedMatchStats()` accept only a canonical match
URL whose page is marked over. They return match identity, teams, players, final map scores and the
complete published `matchStats.views` matrix. `availability` is `available` or `not-published`; an
empty matrix is therefore an explicit immutable result rather than an ambiguous collection error.

The collector stops after the static match page stabilizes. It does not initialize, wait for, read,
or validate Scorebot, so diagnostics keep `scorebotReadyMs`, `scoreboardsMs`, and `gameLogMs` at
zero. Each call uses a short-lived page and is still governed by the reusable client's cold
navigation queue and minimum request interval. Applications may safely persist successful results
by HLTV match ID because the endpoint accepts only completed matches.
