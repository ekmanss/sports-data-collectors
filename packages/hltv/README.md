# @ekmanss/hltv

Typed HLTV match-detail and live-match data collection for Node.js using CloakBrowser.

## Requirements

- Node.js 22 or newer
- ESM

```bash
npm install @ekmanss/hltv
```

CloakBrowser downloads and caches its Chromium binary on first launch. CI and container builds may pre-download it explicitly:

```bash
npx cloakbrowser install
```

## Discover live matches

`getHltvLiveMatches()` returns one passive snapshot of the Live section on `https://www.hltv.org/matches`.

```ts
import { getHltvLiveMatches } from '@ekmanss/hltv';

const { data, diagnostics } = await getHltvLiveMatches();

for (const match of data.matches) {
  console.log(match.id, match.teams, match.url);
}

console.log(data.capturedAt, diagnostics.warnings);
```

The collector reads the page's initial DOM and business attributes. It does not expand Scorebot, call undocumented internal endpoints, visit each match page, collect odds, or persist results. No live matches is a successful result with `matches: []`.

## Discover, then fetch detail

```ts
import { getHltvLiveMatches, getHltvMatch } from '@ekmanss/hltv';

const live = await getHltvLiveMatches();
const first = live.data.matches[0];

if (first) {
  const detail = await getHltvMatch(first.url);
  console.log(detail.data);
}
```

## Fetch completed Match stats

`getHltvCompletedMatchStats()` reads only the immutable stats section of an HLTV match marked
`Match over`. It returns every published `All maps / per-map × Both / CT / T` view with traditional
and Eco-adjusted values, without opening or waiting for Scorebot. This makes it suitable for a
persistent application cache keyed by completed HLTV match ID.

```ts
import { getHltvCompletedMatchStats } from '@ekmanss/hltv';

const result = await getHltvCompletedMatchStats(
  'https://www.hltv.org/matches/<id>/<slug>',
);

console.log(result.data.availability, result.data.matchStats.views);
```

`availability` is `available` when HLTV published the matrix and `not-published` when the completed
page has no Match stats. Both are successful, cacheable results. A live or upcoming match URL is
rejected instead of being cached as completed data.

## Reuse a browser

Frequent collection should reuse `HltvClient`:

```ts
import { createHltvClient } from '@ekmanss/hltv';

const client = await createHltvClient({
  headless: true,
  timezone: 'America/Los_Angeles',
  maxConcurrency: 1,
  minRequestIntervalMs: 5_000,
  livePageRefreshIntervalMs: 120_000,
  matchSessionIdleTimeoutMs: 1_800_000,
  maxMatchSessions: 10,
});

try {
  const live = await client.getLiveMatches({ timeoutMs: 60_000 });
  const match = live.data.matches[0];
  if (match) {
    const detail = await client.getMatch(match.url, { timeoutMs: 180_000 });
    console.log(detail.data.match);
  }
} finally {
  await client.close();
}
```

The client also implements `AsyncDisposable`. `close()` rejects queued cold-navigation work, allows
active per-match reads to finish, closes every persistent match page, and then closes the browser.

Consumers that already own an authenticated browser context can inject a narrow adapter instead of
launching CloakBrowser:

```ts
import { createHltvClientWithBrowser, type HltvBrowserAdapter } from '@ekmanss/hltv';

const browser: HltvBrowserAdapter = createYourBrowserAdapter();
const client = createHltvClientWithBrowser(browser, {
  maxConcurrency: 1,
  minRequestIntervalMs: 5_000,
  timezone: 'America/Los_Angeles',
  livePageRefreshIntervalMs: 120_000,
  matchSessionIdleTimeoutMs: 1_800_000,
  maxMatchSessions: 10,
});
```

The adapter owns only the pages or tabs it creates. `client.close()` calls `browser.close()`, so an
adapter attached to a user-owned browser must detach and close its managed HLTV pages without
terminating the surrounding browser or touching unrelated tabs. The exported adapter surface is
intentionally limited to the page operations used by this collector.

The reusable client separates cold navigation from live state collection. The first
`getLiveMatches()` opens one `/matches` page; later calls read its hydrated DOM directly while the
native WebSocket keeps scores current. The same page performs a bounded fallback navigation every
two minutes so newly started or completed cards cannot remain stale indefinitely. An invalid,
closed, challenged, or aborted list page is discarded and rebuilt on the bounded retry. Live
diagnostics expose `capture.session.reused`, `navigated`, and page `ageMs` so consumers can distinguish
millisecond warm reads from periodic navigation.

The first `getMatch()` for a match opens one page and lets that page establish HLTV's native
Scorebot connection. Later calls reuse the same page and never enter the global cold-navigation
queue. A semantically complete Scorebot state is accepted immediately; the collector does not wait
for a changing live scoreboard to produce two identical samples. If the lightweight Scorebot and
static-map signature is unchanged, the latest verified snapshot is reused without re-extracting the
virtual Game log. Inactive match pages are closed after thirty minutes. The client retains at most
ten match pages and evicts the least recently used inactive page before exceeding that bound; active
captures are never evicted. `client.close()` closes the live-list page and every remaining match page.

HLTV updates the current Scorebot over its native connection, but the static map cards on an already
open document can remain at their pre-match values after the series advances to another map. When a
reused session observes a different semantic Scorebot map, the collector navigates that same page to
the canonical match URL exactly once for the boundary. The refreshed map cards then provide the
authoritative completed-map score while the new Scorebot remains the authoritative current-map
source. Ordinary warm reads still do not navigate.

The collector does not inject a synthetic Scorebot configuration or reload a page when native
Scorebot is temporarily absent. The first cold page gets a bounded twelve-second readiness window;
an established session uses a six-second inter-map window. A visible scoreboard is not accepted
until the extracted formal Game log contains enough completed rounds to account for its score.
The collector keeps reading within the same bounded window while HLTV replays that history;
exhausting the window returns a fail-closed partial snapshot with `SCOREBOT_UNAVAILABLE` instead of
an inconsistent current map. The complete Game log is read directly from the rendered Scorebot
component state; virtual-list traversal remains a compatibility fallback when that internal
representation is unavailable. Normal/Advanced mode changes use the page's native toggle event and
verify the resulting active mode without foreground-window actionability checks, so a minimized
caller-owned browser does not add multi-second click waits. Cold navigation intentionally stops at
`DOMContentLoaded`: waiting for the browser toolbar's loading indicator, full `load`, or
`networkidle` can add unrelated image/advertising time and does not prove that Scorebot's live Game
log is reconciled. Inspect
`diagnostics.capture.timings`, `diagnostics.capture.session`, and
`diagnostics.capture.scorebot.positionsVisited` when profiling a capture; `navigationSeconds` is the
pure `page.goto()` duration.

When the browser joins a live series after an earlier map has finished, HLTV can expose that map's
canonical final score without exposing its historical virtual Game log. The result keeps the usable
current Scorebot and marks only the affected completed map with `INCOMPLETE_GAME_LOG`; current-map
score/Game-log disagreement still fails closed.

## Options

Client options:

```ts
interface HltvClientOptions {
  headless?: boolean;                 // default: true
  proxy?: {
    server: string;
    username?: string;
    password?: string;
  };
  timezone?: string;                  // default: runtime system timezone
  maxConcurrency?: number;            // default: 1, maximum: 3; cold navigations only
  minRequestIntervalMs?: number;      // default: 5000; cold navigation start interval
}
```

Request options:

```ts
interface HltvRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: HltvProgressEvent) => void;
}
```

The one-shot functions accept both groups in one options object. Locale is fixed to `en-US`; returned timestamps use Unix milliseconds or UTC ISO strings. Proxy credentials never appear in data, diagnostics, errors, or logs.

The browser timezone is part of its network fingerprint. The default follows the runtime system timezone. When a VPN, transparent proxy, or remote network changes the public egress location, pass the matching IANA timezone explicitly. For example, a US West Coast egress should use `America/Los_Angeles`. A timezone that disagrees with the public egress can increase the chance of an access challenge.

## Errors

All operational failures use `HltvError` with stable `code`, `operation`, `stage`, and `retryable` fields.

```text
INVALID_INPUT
BROWSER_LAUNCH_FAILED
NAVIGATION_FAILED
TIMEOUT
ACCESS_BLOCKED
MATCH_NOT_FOUND
INCOMPLETE_CAPTURE
ABORTED
CLIENT_CLOSED
INTERNAL_ERROR
```

The one-shot functions handle HTTP 403 access challenges by closing the challenged browser and launching a fresh browser for at most two retries, with bounded exponential cooldowns of about 10–12.5 seconds and 20–25 seconds. A reusable `HltvClient` does not replace its browser and returns `ACCESS_BLOCKED` immediately so its owner can decide when to rebuild the client. HTTP 429, HTTP 5xx, and transient navigation failures retry once in the current browser after a shorter delay. All retries stay within the operation's total timeout budget. The library is silent by default.

## Manual recipes

See [docs/recipes.md](docs/recipes.md) for copy-paste commands that save live lists and match details to files, discover and capture live matches, reuse one browser, show progress, and configure timeouts or a proxy.

## Data contracts

See [docs/data-contracts.md](docs/data-contracts.md) for the Match Detail `3.2.0` and Live Matches `1.0.0` schemas and consistency rules.

## Verification

```bash
pnpm verify
HLTV_MATCH_URL='https://www.hltv.org/matches/<live-id>/<slug>' \
HLTV_COMPLETED_MATCH_URL='https://www.hltv.org/matches/<completed-id>/<slug>' \
pnpm test:live
```

The normal test suite retains the tracked match-detail regression fixture. The live-list smoke test always uses the real HLTV page and is not run in GitHub Actions.

## Disclaimer

This is an unofficial project and is not affiliated with or endorsed by HLTV.org. Users are responsible for complying with applicable terms and using reasonable request rates.

## License

[MIT](LICENSE) © 2026 ekmanss
