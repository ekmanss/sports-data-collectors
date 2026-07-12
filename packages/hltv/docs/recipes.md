# Recipes

Copy-paste commands for manual, one-off HLTV collection. Commands in this document run from the repository root and write disposable results to `outputs/`, which is already ignored by Git.

Build the local package once before running a recipe:

```bash
pnpm --filter @ekmanss/hltv build
mkdir -p outputs
```

In another project, install `@ekmanss/hltv` and replace `./packages/hltv/dist/index.js` in the examples with `@ekmanss/hltv`.

## Capture the live-match list

Save the complete result, including diagnostics:

```bash
node --input-type=module -e "
import { getHltvLiveMatches } from './packages/hltv/dist/index.js';

const result = await getHltvLiveMatches();
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
" > outputs/live-matches.json
```

Inspect a compact view with `jq`:

```bash
jq '.data.matches[] | {
  id,
  url,
  event: .event.name,
  teams: [.teams[].name],
  scores: [.teams[].score]
}' outputs/live-matches.json
```

`matches: []` is a successful result when HLTV has no live matches.

## Capture one match by URL

```bash
MATCH_URL='https://www.hltv.org/matches/<id>/<slug>' \
node --input-type=module -e "
import { getHltvMatch } from './packages/hltv/dist/index.js';

const result = await getHltvMatch(process.env.MATCH_URL);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
" > outputs/match-detail.json
```

The URL must be the canonical `https://www.hltv.org/matches/<id>/<slug>` URL.

## Discover and capture the first live match

This writes the list first and exits successfully without a detail file when no match is live.

```bash
node --input-type=module <<'EOF'
import { mkdir, writeFile } from 'node:fs/promises';
import {
  getHltvLiveMatches,
  getHltvMatch,
} from './packages/hltv/dist/index.js';

await mkdir('outputs', { recursive: true });

const live = await getHltvLiveMatches();
await writeFile('outputs/live-matches.json', JSON.stringify(live, null, 2) + '\n');

const first = live.data.matches[0];
if (!first) {
  console.log('No live matches.');
  process.exit(0);
}

const detail = await getHltvMatch(first.url);
await writeFile('outputs/match-detail.json', JSON.stringify(detail, null, 2) + '\n');
console.log(`Saved match ${first.id}.`);
EOF
```

## Capture every live match detail

Reuse one browser and keep requests serial. The client enforces the configured interval between operations.

```bash
node --input-type=module <<'EOF'
import { mkdir, writeFile } from 'node:fs/promises';
import { createHltvClient } from './packages/hltv/dist/index.js';

await mkdir('outputs', { recursive: true });

const client = await createHltvClient({
  maxConcurrency: 1,
  minRequestIntervalMs: 5_000,
});

try {
  const live = await client.getLiveMatches({ timeoutMs: 60_000 });
  await writeFile('outputs/live-matches.json', JSON.stringify(live, null, 2) + '\n');

  for (const match of live.data.matches) {
    const detail = await client.getMatch(match.url, { timeoutMs: 180_000 });
    await writeFile(
      `outputs/match-${match.id}.json`,
      JSON.stringify(detail, null, 2) + '\n',
    );
    console.log(`Saved match ${match.id}.`);
  }
} finally {
  await client.close();
}
EOF
```

## Keep JSON output clean while showing progress

Progress belongs on standard error, so redirecting standard output still produces valid JSON:

```js
const onProgress = (event) => {
  console.error(`[${event.operation}:${event.stage}] ${event.message}`);
};

const result = await getHltvLiveMatches({ onProgress });
```

## Save only business data

Every operation returns `{ data, diagnostics }`. Use `result.data` instead of `result` when diagnostics are not needed:

```js
JSON.stringify(result.data, null, 2)
```

Keep diagnostics while developing or investigating missing fields. A live score may be `null` when HLTV displays `-`; warnings explain other partial fields.

## Timeouts and proxy

One-shot functions accept browser and request options together:

```js
const result = await getHltvLiveMatches({
  timeoutMs: 60_000,
  timezone: 'UTC',
  proxy: {
    server: 'http://127.0.0.1:8080',
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
  },
});
```

Match-detail requests normally need a larger timeout such as `180_000`. Proxy credentials are never included in returned data, diagnostics, errors, or progress events.

## Fail visibly in shell scripts

```js
try {
  const result = await getHltvLiveMatches();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
```

Operational failures are `HltvError` instances with stable `code`, `operation`, `stage`, and `retryable` fields.
