# Consumer schema 2.1.0

`match.json` contains stable business facts only. Raw browser payloads stay under `artifacts/`; capture, reconciliation, warning, and validation evidence belongs in `diagnostics.json`.

Version 2.1.0 adds `match.slug` to the compatible 2.x contract. The input ID, input slug, source URL, output directory, and consumer identity must agree exactly.

## Canonical rules

- `teams` and `players` are entity lists. Other sections reference them by ID.
- `maps[].score` is the only canonical per-map score.
- A completed map uses the final match-card score; a current map uses the current Scorebot score.
- A map scoreboard is included only when its score matches the canonical score.
- The current scoreboard is stored once under `current`.
- Game log events exist only in `maps[].gameLog.rounds[].events`.
- Round start is implicit; round completion is represented by `round.result`.
- An in-progress live round may have `result: null`.
- The cumulative Scorebot log is split into maps before export and never embedded directly.
- Identical Team/Core recent-match views are stored once with both mode names.
- H2H is grouped as matches with nested maps.
- Missing scalar values are `null`; missing collections are empty arrays.
- The JSON is written compactly. Markdown is the human-readable artifact.
- `current` is `null` after the match ends.

## Required identity

```text
schemaVersion = 2.1.0
match.id       = requested ID
match.slug     = requested slug
source         = https://www.hltv.org/matches/<id>/<slug>
```

HLTV query parameters, fragments, and a trailing slash do not affect source-path validation. A different path ID or slug is fatal.

## Forbidden consumer keys

`currentSnapshot`, `liveMaps`, `chronological`, `mapRows`, `className`, `images`, `rowClasses`, `stats`, `sections`, `visibleGameLog`, `scrollHeight`, `httpStatus`, `rawCumulativeEvents`, `nonFormalEventsRemoved`, `cumulativePrefixEventsRemoved`, `adjacentFormalRoundDuplicatesRemoved`, and `validation`.

## Required consistency

- Exactly two unique primary teams exist.
- Every lineup player ID references a canonical player.
- For every completed or current map, the canonical score sum equals completed rounds.
- Every stored map round starts at round 1 and increments without gaps.
- Every completed-map round has exactly one result.
- A current or final scoreboard score must agree with its canonical score.
- No credential, session, local user path, or browser-private field appears in a public artifact.

Violations fail the capture with `INCOMPLETE_CAPTURE`; they are never downgraded into a superficially successful partial result.
