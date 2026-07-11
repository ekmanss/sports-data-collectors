# Consumer schema 2.1.0

`getHltvMatch()` returns `{ data, diagnostics }`. `data` uses schema `2.1.0` and contains stable business facts. `diagnostics` uses schema `2.0.0` and contains capture attempts, reconciliation evidence, warnings, and timing.

## Canonical rules

- `teams` and `players` are entity lists. Other sections reference them by ID.
- `maps[].score` is the canonical per-map score.
- A completed map uses the final match-card score; a current map uses the current Scorebot score.
- A map scoreboard is included only when its score matches the canonical score.
- The current scoreboard is stored once under `current`.
- Game log events exist only in `maps[].gameLog.rounds[].events`.
- Round start is implicit; round completion is represented by `round.result`.
- An in-progress live round may have `result: null`.
- The cumulative Scorebot log is split into maps before returning.
- Identical Team/Core recent-match views are stored once with both mode names.
- H2H is grouped as matches with nested maps.
- Missing scalar values are `null`; missing collections are empty arrays.
- `current` is `null` after the match ends.

## Required identity

```text
schemaVersion = 2.1.0
match.id       = final HLTV page match ID
match.slug     = final canonical URL slug
source         = https://www.hltv.org/matches/<id>/<slug>
```

Query parameters, fragments, and a trailing slash are removed during input normalization. A redirect may correct the slug, but a different host or match ID is fatal.

## Required consistency

- Exactly two unique primary teams exist.
- Every lineup player ID references a canonical player.
- For every completed or current map, the canonical score sum equals completed rounds.
- Every stored map round starts at round 1 and increments without gaps.
- Every completed-map round has exactly one result.
- A current or final scoreboard score agrees with its canonical score before it is included.

Violations fail with `INCOMPLETE_CAPTURE`; they are never downgraded into a superficially successful partial result.

## Data coverage

The schema preserves match-page and Scorebot business data for match identity, event, teams, players, lineups, streams, vetoes, maps, scores, halves, map statistics, recent matches, head-to-head history, Normal/Advanced scoreboards, and formal round events.

Browser-private state, DOM class names, duplicate visible log fragments, and raw HTML are implementation details rather than match data and are not returned.
