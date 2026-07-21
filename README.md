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

See the [package README](packages/5eplay/README.md) for API usage and
[protocol invariants](packages/5eplay/PROTOCOL.md) for classification and synchronization rules.

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
