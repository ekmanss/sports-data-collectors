# HLTV match data collector

A TypeScript library and CLI that accepts an exact HLTV match ID and slug, performs a fresh CloakBrowser capture, validates the result, and produces compact JSON plus English and Chinese Markdown reports.

The collector covers data exposed by the match page and its official Scorebot integration:

- match, event, team, lineup, player, map, score, half-score, and veto metadata;
- streams and embedded three-month player metrics;
- map statistics, recent matches, and head-to-head history;
- Normal and Advanced scoreboards;
- the full virtualized formal Game log, split into canonical maps and rounds.

It does not crawl linked player, team, event, or historical match detail pages.

## Requirements

- Node.js 22 or newer
- pnpm 11.11.0
- CloakBrowser binary

```bash
pnpm install
pnpm exec cloakbrowser install
pnpm check
```

## CLI

Both the ID and exact canonical slug are required:

```bash
pnpm match -- \
  --id 2395674 \
  --slug voca-vs-regain-circuit-x-blast-open-porto-2026-north-america-rising-event
```

The collector does not repair or replace a slug. If the final HLTV path contains a different ID or slug, the call stops with `SLUG_MISMATCH`.

Useful options:

```text
--output-root <path>         Default: outputs/matches
--headed                     Show the browser window
--page-wait-ms <number>      Default: 12000; allowed: 0-120000
--scorebot-wait-ms <number>  Default: 10000; allowed: 0-120000
--help
```

Progress is written to stderr. On success, stdout contains one JSON summary with the absolute output paths. On failure, the final stderr line is a structured JSON error and the process exits non-zero.

## TypeScript API

```ts
import { getHltvMatch, HltvMatchError } from './src/index.js';

try {
  const result = await getHltvMatch({
    id: 2395674,
    slug: 'voca-vs-regain-circuit-x-blast-open-porto-2026-north-america-rising-event',
  });

  console.log(result.data);
  console.log(result.markdown);
  console.log(result.chineseReport);
  console.log(result.files);
} catch (error) {
  if (error instanceof HltvMatchError) {
    console.error(error.code, error.stage, error.retryable);
  }
  throw error;
}
```

The function defaults to a fresh headless capture and file output. It never reads a previous run to build a new result.

```ts
const controller = new AbortController();

const result = await getHltvMatch({
  id: '2395674',
  slug: 'voca-vs-regain-circuit-x-blast-open-porto-2026-north-america-rising-event',
  writeFiles: false,
  headless: true,
  pageWaitMs: 12_000,
  scorebotWaitMs: 10_000,
  signal: controller.signal,
  onProgress: (event) => console.error(event.stage, event.message),
});
```

With `writeFiles: false`, the function returns the complete in-memory result and writes no files. `outputRoot` cannot be combined with this mode.

## Output layout

The default output directory combines the ID and input slug with an underscore:

```text
outputs/matches/
  2395674_voca-vs-regain-circuit-x-blast-open-porto-2026-north-america-rising-event/
    match.json
    match.md
    match-2395674-报告.md
    diagnostics.json
    artifacts/
      page.html
      page.json
      page-rich.json
      scorebot-current.json
      scorebot-latest.json
      live/
```

- `match.json` is compact consumer schema `2.1.0` data.
- `match.md` is a complete English business report, including the formal Game log.
- `match-<id>-报告.md` is a Chinese capture completeness and quality report.
- `diagnostics.json` contains attempt history, reconciliation evidence, warnings, and output audits.
- `artifacts/` contains only raw data captured during the current invocation.

Publishing is transactional. A failed refresh does not overwrite the previous successful output. The most recent failed run is summarized under `failed-attempt/`; a later success replaces it.

## Match states

- Upcoming matches may legitimately have no Scorebot, lineup, stream, veto, or historical sections.
- Live matches include the current score, combined scoreboard, completed rounds, and an optional in-progress round with `result: null`.
- Completed maps must have a canonical score whose sum equals the number of completed Game log rounds. Inconsistent completed data fails with `INCOMPLETE_CAPTURE`.

Non-fatal absence that reflects what HLTV actually published is recorded as a warning and does not change the successful exit status.

## Errors

`HltvMatchError` exposes stable `code`, `stage`, and `retryable` fields. Important codes include:

```text
INVALID_INPUT
BROWSER_NOT_INSTALLED
NAVIGATION_FAILED
ACCESS_BLOCKED
MATCH_NOT_FOUND
SLUG_MISMATCH
INCOMPLETE_CAPTURE
OUTPUT_ERROR
ABORTED
INTERNAL_ERROR
```

Navigation timeouts, HTTP 429, and HTTP 5xx are retried once after roughly two seconds. Input errors, slug mismatches, 404, access challenges, parsing failures, and consistency failures are not retried.

## Validation

Static checks do not access the network:

```bash
pnpm check
pnpm build
pnpm verify
```

The only test is an explicit real-network test. It writes to a temporary directory and cleans it afterward:

```bash
pnpm test -- \
  --id 2395674 \
  --slug voca-vs-regain-circuit-x-blast-open-porto-2026-north-america-rising-event
```

## Security boundary

Public JSON, Markdown, diagnostics, and error summaries are checked for credentials and local user paths. CloakBrowser uses a fresh, non-user Chrome context. Raw `artifacts/` and `failed-attempt/` are internal debugging material and should be reviewed or excluded before sharing.

The browser locale and timezone intentionally remain fixed at `en-US` and `Asia/Singapore` because Scorebot parsing relies on stable English text and the repository's established timezone behavior.
