# 5EPlay match source

Workspace for the public [`@ekmanss/5eplay`](packages/5eplay) TypeScript package. It provides
single-page live/upcoming schedule discovery, reliable 5EPlay CS2 match-state observations, fixed
detail sections with explicit completeness, and provisional MQTT updates confirmed by periodic
HTTP reconciliation.

```bash
pnpm install
pnpm verify
```

Deterministic CI never contacts 5EPlay. Run the explicit live smoke test locally when needed:

```bash
FIVEEPLAY_MATCH_ID=csgo_mc_2395547 pnpm test:live
```

Save a complete confirmed snapshot as JSON plus a filtered, human-readable Markdown file with the
same basename:

```bash
pnpm snapshot:5eplay -- --match-id csgo_mc_2395547 --out-dir ./match-data
```

See the [package README](packages/5eplay/README.md) for API usage and
[protocol invariants](packages/5eplay/PROTOCOL.md) for classification and synchronization rules.

Provider reality is recorded separately from implementation contracts:

- [schedule-page facts](docs/provider/5eplay-schedule-page-facts.md);
- [match-page facts](docs/provider/5eplay-match-page-facts.md);
- [2026-07-21 live validation and defects](docs/live-validation-2026-07-21.md).

The fact documents preserve direct observations, historical evidence and explicit unknowns. The
protocol document describes what the current package accepts; it must not be used as evidence that
the provider always behaves that way.

## Release

Releases use npm Trusted Publishing through GitHub Actions OIDC. From a clean, current `main`:

```bash
FIVEEPLAY_MATCH_ID=csgo_mc_2395547 pnpm release
```

The release command verifies deterministic and live tests, computes the next UTC
`YYYYMMDD.REVISION.0` version, atomically pushes `main` and the immutable tag, waits for OIDC
publication, and confirms npm visibility. It never runs a local publish. See
[docs/releasing.md](docs/releasing.md).

MIT © 2026 ekmanss
