# Manual recipes

Run these commands from the repository root after `pnpm build`.

## Fetch the first schedule page

```ts
import { getFiveEPlaySchedule } from '@ekmanss/5eplay';

const { data, diagnostics } = await getFiveEPlaySchedule({
  pageLimit: 1,
  timeoutMs: 15_000,
});
const live = data.matches.filter((match) => match.status === 'live');
const upcoming = data.matches.filter((match) => match.status === 'upcoming');

console.log({
  pages: diagnostics.requests.length,
  complete: data.complete,
  nextPage: data.nextPage,
  total: data.matches.length,
  live: live.length,
  upcoming: upcoming.length,
});
```

Omit `pageLimit` for a full refresh across every current schedule page. For frequent checks that
only need matches that have already started, use the lightweight live-only recipe below.

## Poll for newly started matches

```ts
import { setTimeout as delay } from 'node:timers/promises';
import { getFiveEPlayLiveMatches } from '@ekmanss/5eplay';

const known = new Set<string>();

while (true) {
  const { data } = await getFiveEPlayLiveMatches({ timeoutMs: 5_000 });
  for (const match of data.matches) {
    if (!known.has(match.id)) {
      console.log('started', match.id, match.url);
      known.add(match.id);
    }
  }
  for (const id of [...known]) {
    if (!data.matches.some((match) => match.id === id)) known.delete(id);
  }
  await delay(5_000);
}
```

Calls are serialized, so a slow request never overlaps the next poll. A normal call uses one list
request and performs no match-detail, log, analysis, community, Markdown, browser, or MQTT work.

## Generate the human-readable Markdown report

Pass an exact Markdown filename:

```bash
pnpm 5eplay:md -- \
  'https://event.5eplay.com/csgo/matches/csgo_mc_2395709' \
  './outputs/5eplay/csgo_mc_2395709.md'
```

Or pass a directory and let the writer use `<match-id>.md`:

```bash
pnpm 5eplay:md -- 'csgo_mc_2395709' './outputs/5eplay'
```

The writer creates missing parent directories and atomically replaces an existing destination.
Community ratings are not requested because they are not part of the Markdown report.

From another Node.js program:

```ts
import { writeFiveEPlayMatchMarkdown } from '@ekmanss/5eplay';

const written = await writeFiveEPlayMatchMarkdown(
  'csgo_mc_2395709',
  '/absolute/path/current-match.md',
);

console.log(written.outputPath, written.bytes);
```

## Save a complete snapshot

```bash
FIVEEPLAY_MATCH_URL='https://event.5eplay.com/csgo/matches/csgo_mc_2395709' \
node --input-type=module <<'EOF' > match.json
import { getFiveEPlayMatch } from './packages/5eplay/dist/index.js';

const result = await getFiveEPlayMatch(process.env.FIVEEPLAY_MATCH_URL);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
EOF
```

## Inspect maps and live players

```bash
jq '{
  match: .data.match,
  maps: [.data.maps[] | {number, name, status, teams}],
  livePlayers: [.data.current.playerStats[]?.overall[]? | {
    name,
    health: .equipment.health,
    money: .equipment.money,
    weapon: .equipment.weapon,
    kills: .metrics.kills,
    deaths: .metrics.deaths,
    assists: .metrics.assists,
    adr: .metrics.adr
  }]
}' match.json
```

## Stream realtime changes as NDJSON

```bash
FIVEEPLAY_MATCH_URL='csgo_mc_2395709' \
node --input-type=module <<'EOF'
import { createFiveEPlayMatchSession } from './packages/5eplay/dist/index.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

await using session = await createFiveEPlayMatchSession(
  process.env.FIVEEPLAY_MATCH_URL,
  { signal: controller.signal },
);

for await (const update of session) {
  const compact = update.type === 'log'
    ? { type: update.type, capturedAt: update.capturedAt, event: update.event }
    : { type: update.type, capturedAt: update.capturedAt, current: update.snapshot.current };
  process.stdout.write(JSON.stringify(compact) + '\n');
}
EOF
```

## Compact scoreboard-only snapshot

```js
const result = await getFiveEPlayMatch(match, {
  includeAnalysis: false,
  includeCommunityRatings: false,
  includeLogs: false,
});
```

This mode makes only the match-data request and is appropriate for high-frequency read-only
scoreboard refreshes when a persistent MQTT session is not desired.
