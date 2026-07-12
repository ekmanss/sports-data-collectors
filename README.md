# Sports data collectors

Public TypeScript collectors for esports and sports data sources.

## Packages

- [`@ekmanss/hltv`](packages/hltv) — HLTV match-detail and live-match snapshots.

Each source lives in its own publishable workspace package. Shared infrastructure will only be extracted after another source demonstrates a real common boundary.

## Development

```bash
pnpm install
pnpm verify
```

Real HLTV validation is intentionally local-only:

```bash
HLTV_MATCH_URL='https://www.hltv.org/matches/<id>/<slug>' pnpm test:live
```

GitHub Actions runs deterministic type, fixture, build, and package checks. It does not access HLTV.

## Release

`pnpm release` runs all local verification, including the real-network test, computes the next `YYYYMMDD.REVISION.0` version, and creates a local release commit and tag. It never pushes.

The first `@ekmanss/hltv` release must be published manually so the npm package exists. Later releases use npm trusted publishing through `.github/workflows/publish.yml`.

## License

[MIT](LICENSE) © 2026 ekmanss
