# Sports data collectors

Public TypeScript collectors for esports and sports data sources.

## Packages

- [`@ekmanss/hltv`](packages/hltv) — HLTV match-detail and live-match snapshots.
- [`@ekmanss/5eplay`](packages/5eplay) — complete 5EPlay CS2 match snapshots and MQTT live updates.

Each source lives in its own publishable workspace package. Shared infrastructure will only be extracted after another source demonstrates a real common boundary.

## Development

```bash
pnpm install
pnpm verify
```

Real HLTV validation is intentionally local-only:

```bash
HLTV_MATCH_URL='https://www.hltv.org/matches/<live-id>/<slug>' \
HLTV_COMPLETED_MATCH_URL='https://www.hltv.org/matches/<completed-id>/<slug>' \
pnpm test:live
```

Real 5EPlay validation is also local-only:

```bash
FIVEEPLAY_MATCH_URL='https://event.5eplay.com/csgo/matches/<match-id>' \
pnpm test:live:5eplay
```

Generate a complete formatted Markdown report from a 5EPlay match:

```bash
pnpm 5eplay:md -- \
  'https://event.5eplay.com/csgo/matches/csgo_mc_2395709' \
  './outputs/csgo_mc_2395709.md'
```

GitHub Actions runs deterministic type, fixture, build, and package checks. It does not access
HLTV or 5EPlay.

## Release

`pnpm release` runs all local verification, including the real-network test, computes the next `YYYYMMDD.REVISION.0` version, and creates a local release commit and tag. It never pushes.

The first `@ekmanss/hltv` release must be published manually so the npm package exists. Later releases use npm trusted publishing through `.github/workflows/publish.yml`.

## License

[MIT](LICENSE) © 2026 ekmanss
