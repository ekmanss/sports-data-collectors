# HLTV match data

A small TypeScript library that captures one HLTV match page with CloakBrowser and returns complete structured match data.

The collector keeps the data exposed by the match page and Scorebot:

- match, event, teams, lineups, players, maps, scores, half-scores, and vetoes;
- streams and embedded three-month player metrics;
- map statistics, recent matches, and head-to-head history;
- Normal and Advanced scoreboards;
- the full virtualized formal Game log, reconciled into maps and rounds.

It does not crawl linked player, team, event, or historical match detail pages. It has no CLI and does not write files; persistence and presentation belong to the caller.

## Requirements

- Node.js 22 or newer
- pnpm 11.11.0
- CloakBrowser binary

```bash
pnpm install
pnpm exec cloakbrowser install
pnpm verify
```

## Usage

Pass one complete HLTV match URL:

```ts
import { getHltvMatch, HltvMatchError } from 'hltv-match-data';

try {
  const { data, diagnostics } = await getHltvMatch(
    'https://www.hltv.org/matches/2395674/voca-vs-regain-circuit-x-blast-open-porto-2026-north-america-rising-event',
  );

  console.log(data);
  console.log(diagnostics.warnings);
} catch (error) {
  if (error instanceof HltvMatchError) {
    console.error(error.code, error.stage, error.retryable);
  }
  throw error;
}
```

The URL path identifies the requested match. Redirected pages may correct the slug, but the final page must remain on `https://www.hltv.org` and contain the same match ID.

Long captures can be cancelled and observed without coupling the collector to a logger:

```ts
const controller = new AbortController();

const result = await getHltvMatch(matchUrl, {
  signal: controller.signal,
  onProgress: (event) => console.error(event.stage, event.message),
});
```

`headless`, `pageWaitMs`, and `scorebotWaitMs` remain optional escape hatches for debugging and slow pages. Their defaults are `true`, 12 seconds, and 10 seconds respectively.

## Match states

- Upcoming matches may legitimately omit Scorebot, lineup, stream, veto, or historical sections.
- Live matches include the current score, combined scoreboard, completed rounds, and optionally one in-progress round with `result: null`.
- Completed maps must have a canonical score whose sum equals the number of completed Game log rounds.
- Missing optional data is returned as `null` or an empty collection and may produce a diagnostic warning; inconsistent core data fails with `INCOMPLETE_CAPTURE`.

The complete data contract is documented in [docs/consumer-schema-v2.md](docs/consumer-schema-v2.md).

## Errors and recovery

`HltvMatchError` exposes stable `code`, `stage`, and `retryable` fields. Navigation timeouts, HTTP 429, and HTTP 5xx are retried once. Input errors, 404, access challenges, parsing failures, and consistency failures are not retried.

```text
INVALID_INPUT
BROWSER_NOT_INSTALLED
NAVIGATION_FAILED
ACCESS_BLOCKED
MATCH_NOT_FOUND
INCOMPLETE_CAPTURE
ABORTED
INTERNAL_ERROR
```

The browser locale and timezone remain fixed at `en-US` and `Asia/Singapore` because Scorebot parsing depends on stable English text and time behavior.

## Verification

Default verification is offline and checks the completed, upcoming, and live data contracts:

```bash
pnpm verify
```

The tracked completed-match JSON is a regression fixture, not generated output. A real-network smoke test is explicit:

```bash
HLTV_MATCH_URL='https://www.hltv.org/matches/<id>/<slug>' pnpm test:live
```
