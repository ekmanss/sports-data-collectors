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

## Reuse a browser

Frequent collection should reuse `HltvClient`:

```ts
import { createHltvClient } from '@ekmanss/hltv';

const client = await createHltvClient({
  headless: true,
  timezone: 'America/Los_Angeles',
  maxConcurrency: 1,
  minRequestIntervalMs: 5_000,
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

The client also implements `AsyncDisposable`. `close()` rejects queued work, allows active work to finish, and then closes the browser.

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
  maxConcurrency?: number;            // default: 1, maximum: 3
  minRequestIntervalMs?: number;      // default: 5000
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

HTTP 403 access challenges cool down for about 10–12.5 seconds before one retry. HTTP 429, HTTP 5xx, and transient navigation failures retry once after a shorter delay. All retries stay within the operation's total timeout budget. The library is silent by default.

## Manual recipes

See [docs/recipes.md](docs/recipes.md) for copy-paste commands that save live lists and match details to files, discover and capture live matches, reuse one browser, show progress, and configure timeouts or a proxy.

## Data contracts

See [docs/data-contracts.md](docs/data-contracts.md) for the Match Detail `3.0.0` and Live Matches `1.0.0` schemas and consistency rules.

## Verification

```bash
pnpm verify
HLTV_MATCH_URL='https://www.hltv.org/matches/<id>/<slug>' pnpm test:live
```

The normal test suite retains the tracked match-detail regression fixture. The live-list smoke test always uses the real HLTV page and is not run in GitHub Actions.

## Disclaimer

This is an unofficial project and is not affiliated with or endorsed by HLTV.org. Users are responsible for complying with applicable terms and using reasonable request rates.

## License

[MIT](LICENSE) © 2026 ekmanss
