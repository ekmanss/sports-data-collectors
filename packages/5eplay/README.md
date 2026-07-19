# @ekmanss/5eplay

Typed 5EPlay CS2 schedules, match details, and live updates for Node.js 22+. The collector uses
5EPlay's JSON endpoints and MQTT-over-WebSocket feed directly; it does not launch a browser,
execute page JavaScript, scrape rendered DOM, or require a logged-in account.

## Install

```bash
pnpm add @ekmanss/5eplay
```

## Complete match snapshot

```ts
import { getFiveEPlayMatch } from '@ekmanss/5eplay';

const result = await getFiveEPlayMatch(
  'https://event.5eplay.com/csgo/matches/csgo_mc_2395709',
);

console.log(result.data.match);
console.log(result.data.maps);
console.log(result.data.current);
```

The default snapshot includes every public match-data section used by the page:

- match, tournament, teams, ranks, odds, best-of, stage, and series score;
- complete map veto and every picked/decider map, including temporarily omitted upcoming maps;
- per-map scores, halves, round-result codes, live timer/bomb state, and player equipment;
- completed-map Data Overview metrics and the 5-by-5 Player Comparison kill matrix;
- complete historical logs and the current map's available log history;
- pre-match team/player/map analysis, recent matches, and head-to-head history;
- public player and big-event community rating cards.

Chat messages, login state, cookies, and account-specific actions are deliberately excluded.

`getFiveEPlayMatch()` accepts either the canonical URL or a `csgo_mc_<id>` identifier. It returns
`{ data, diagnostics }`. Independent HTTP sections are fetched concurrently; a normal capture does
not open the realtime credential endpoint.

## Complete current schedule

Use the schedule API when you need every currently listed CS2 match, including both live and
upcoming series:

```ts
import { getFiveEPlaySchedule } from '@ekmanss/5eplay';

const { data, diagnostics } = await getFiveEPlaySchedule();

for (const match of data.matches) {
  console.log(match.status, match.id, match.scheduledAtUnixSeconds, match.teams);
}

console.log(`Fetched ${data.matches.length} matches in ${diagnostics.requests.length} pages`);
```

The collector follows the same public JSON pagination used by the website, preserves provider
ordering, removes duplicate match IDs across page boundaries, and stops when the source returns a
short page. It uses an overall 15-second timeout by default and never opens match-detail, analysis,
log, community-rating, Markdown, browser, or realtime endpoints. Schedule rows use `live`,
`upcoming`, or `unknown` status; unknown provider states are retained rather than silently dropped.

## Currently live matches

Use the list API for frequent checks that only need to know whether a CS2 match has started:

```ts
import { getFiveEPlayLiveMatches } from '@ekmanss/5eplay';

const result = await getFiveEPlayLiveMatches();

if (result.data.hasLiveMatches) {
  for (const match of result.data.matches) {
    console.log(match.id, match.url, match.teams, match.currentMap);
  }
}
```

This method normally makes one small public list request and never fetches match details, analysis,
logs, community ratings, Markdown, or realtime credentials. The source list also contains upcoming
matches, so the collector strictly keeps series with live state (including the interval between two
maps, when `currentMap` is `null`). If the first 20 source rows are all live, it continues paging
until every live match is collected.

For serialized five-second polling without overlapping requests:

```ts
import { setTimeout as delay } from 'node:timers/promises';
import { getFiveEPlayLiveMatches } from '@ekmanss/5eplay';

while (true) {
  const { data } = await getFiveEPlayLiveMatches({ timeoutMs: 5_000 });
  console.log(data.hasLiveMatches, data.matches.map((match) => match.url));
  await delay(5_000);
}
```

## Generate a formatted Markdown report

From this repository, pass a match URL/ID and either an exact `.md` filename or a directory:

```bash
pnpm 5eplay:md -- \
  'https://event.5eplay.com/csgo/matches/csgo_mc_2395709' \
  './outputs/5eplay-report.md'
```

```bash
pnpm 5eplay:md -- 'csgo_mc_2395709' './outputs'
```

The directory form writes `./outputs/csgo_mc_2395709.md`. Parent directories are created
automatically, and the completed report atomically replaces the destination file. The report
contains match/map details, analysis, complete event logs, and sanitized request diagnostics.
Community ratings are intentionally omitted and are not requested by the Markdown writer.

The human-readable report is deliberately more compact than the typed snapshot:

- the overview keeps only match status/identity/version/format, capture time, and source URL;
- completed and live maps show scores, clear half/round results, player tables, duels, highlights,
  milestones, and readable logs; upcoming maps use one short placeholder;
- head-to-head and recent matches show only time, canonical match link, teams/opponent, score, and result;
- player power is reduced to Rating plus firepower, entry, opening, utility, sniping, clutch, and
  trading scores;
- transport versions, coordinates, raw round codes, provider JSON, odds, logos, and community
  ratings stay out of the Markdown report.

These presentation choices do not remove fields from `getFiveEPlayMatch()` or realtime snapshots.

Installed packages expose the same command as `5eplay-match-md` and a programmatic API:

```ts
import { writeFiveEPlayMatchMarkdown } from '@ekmanss/5eplay';

const written = await writeFiveEPlayMatchMarkdown(
  'csgo_mc_2395709',
  '/absolute/path/to/report.md',
);

console.log(written.outputPath, written.bytes);
```

Use `renderFiveEPlayMatchMarkdown(result)` instead when the match has already been fetched and the
caller wants the Markdown string without writing it.

## Realtime session

```ts
import { createFiveEPlayMatchSession } from '@ekmanss/5eplay';

await using session = await createFiveEPlayMatchSession('csgo_mc_2395709');

for await (const update of session) {
  if (update.type === 'state') {
    console.log(update.snapshot.current?.teams);
  } else if (update.type === 'log') {
    console.log(update.event.kind, update.event.kill);
  }
}
```

The first yielded item is the complete HTTP snapshot. Later `state` updates contain the latest
scoreboard snapshot and `log` updates contain one typed event. `session.snapshot()` returns the
latest merged state at any time. The session uses one authorized MQTT connection for match state
and one for event logs, sends keepalives, suppresses already-seen log `updateVersion` replays, and
reconnects with a bounded backoff after an unexpected disconnect. Distinct log versions remain
lossless even when their payloads match. Provider restart/replay frames that regress a started map
are withheld until an HTTP resync confirms the rollback or MQTT catches up.

Always close a session, either with `await using`, `await session.close()`, or a `finally` block.

## Options

```ts
const result = await getFiveEPlayMatch(match, {
  timeoutMs: 15_000,
  signal: abortController.signal,
  includeAnalysis: true,
  includeLogs: true,
  includeCommunityRatings: true,
  onProgress: (event) => console.error(event.stage, event.message),
});
```

The three `include*` flags default to `true`. Disable optional sections when only a compact live
scoreboard is required.

## Errors

Failures throw `FiveEPlayError` with stable `code`, `operation`, `stage`, and `retryable` fields.
Realtime credentials are kept inside the MQTT connection and never appear in data, diagnostics,
progress events, or errors.

## Documentation

- [Data contracts](docs/data-contracts.md)
- [Manual recipes](docs/recipes.md)

## Disclaimer

This is an unofficial project and is not affiliated with or endorsed by 5EPlay. Consumers are
responsible for complying with applicable terms and using reasonable request rates.

## License

[MIT](LICENSE) © 2026 ekmanss
