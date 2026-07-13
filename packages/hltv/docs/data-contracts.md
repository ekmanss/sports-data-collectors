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

## Match Detail 3.1.0

`getHltvMatch()` and `client.getMatch()` return the full match-page and Scorebot model:

```ts
interface HltvMatch {
  schemaVersion: '3.1.0';
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

### Match consistency

- `match.id`, `match.slug`, and `source.url` must describe the same canonical HLTV match.
- Exactly two unique primary teams are required.
- Every lineup player ID references a canonical player.
- Every Match stats team and player ID references a canonical team or player; substitutes found
  only in Match stats are added to `players` without being invented as lineup members.
- Completed and current map scores equal the number of completed Game log rounds.
- Overlapping Scorebot replay fragments are joined only when the older fragment supplies the missing prefix and agrees with the newer fragment at the splice boundary; the newer replay remains authoritative after that boundary.
- Knife rounds, scoreless draws, and replay fragments that cannot be safely reconciled are excluded rather than counted as official map rounds.
- Stored rounds start at one and increment without gaps.
- Completed maps contain no unfinished round.
- Scoreboards are included only when their score agrees with the canonical map score.
- `current` is `null` after the match ends.

Violations fail with `INCOMPLETE_CAPTURE`; they are not converted into a superficially successful partial match detail.

## Diagnostics

Match diagnostics use schema `3.0.0`; live diagnostics use schema `1.0.0`. Both include operation identity, start/end/duration, collector versions, capture attempts, and warnings. Match diagnostics additionally include reconciliation and per-map checks. Live diagnostics include card counts, skipped cards, and duplicate merges.
