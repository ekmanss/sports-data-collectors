# Sports data collectors

Public TypeScript collectors for esports and sports data sources.

## Packages

- [`@ekmanss/hltv`](packages/hltv) — HLTV match-detail and live-match snapshots.
- [`@ekmanss/5eplay`](packages/5eplay) — live-match discovery, complete 5EPlay CS2 match snapshots, and MQTT live updates.

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
pnpm test:live:5eplay:list
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

Package releases use npm Trusted Publishing through GitHub Actions OIDC. Run the package-specific
command from a clean, up-to-date `main`; it verifies locally, creates and pushes the release tag,
waits for the workflow, and confirms the published npm version:

```bash
pnpm release:hltv
pnpm release:5eplay
```

Do not use local `npm login` / `npm publish` or a GitHub `NPM_TOKEN` for an existing package. See
the complete release standard and the one-time new-package bootstrap exception in
[`docs/releasing.md`](docs/releasing.md).

## License

[MIT](LICENSE) © 2026 ekmanss
