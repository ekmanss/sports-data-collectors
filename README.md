# 5EPlay data collector

Workspace for the public [`@ekmanss/5eplay`](packages/5eplay) TypeScript package. It provides
live-match discovery, complete 5EPlay CS2 match snapshots, MQTT live updates, and Markdown reports.

See the [package README](packages/5eplay/README.md) for the API, data coverage, and usage examples.

## Development

```bash
pnpm install
pnpm verify
```

Real-network validation is intentionally local-only:

```bash
FIVEEPLAY_MATCH_URL='https://event.5eplay.com/csgo/matches/<match-id>' \
pnpm test:live
pnpm test:live:list
```

Generate a complete formatted Markdown report from a 5EPlay match:

```bash
pnpm 5eplay:md -- \
  'https://event.5eplay.com/csgo/matches/csgo_mc_2395709' \
  './outputs/csgo_mc_2395709.md'
```

GitHub Actions runs deterministic type, fixture, build, and package checks. It does not access
5EPlay.

## Release

Releases use npm Trusted Publishing through GitHub Actions OIDC. Run the release command from a
clean, up-to-date `main`; it verifies locally, creates and pushes the release tag,
waits for the workflow, and confirms the published npm version:

```bash
FIVEEPLAY_MATCH_URL='https://event.5eplay.com/csgo/matches/<match-id>' \
pnpm release
```

Do not use local `npm login` / `npm publish` or a GitHub `NPM_TOKEN` for an existing package. See
the complete release standard and the one-time new-package bootstrap exception in
[`docs/releasing.md`](docs/releasing.md).

## License

[MIT](LICENSE) © 2026 ekmanss
