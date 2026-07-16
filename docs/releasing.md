# Publishing packages

## Standard path: GitHub Actions OIDC

Existing packages are published only by `.github/workflows/publish.yml` using npm Trusted
Publishing and GitHub Actions OIDC. Do not run `npm login` or `npm publish` locally, do not create an
`NPM_TOKEN` GitHub secret, and do not pass a local npm credential into CI.

Run the package-specific release command from a clean, up-to-date `main` branch:

```bash
HLTV_MATCH_URL='https://www.hltv.org/matches/<live-id>/<slug>' \
HLTV_COMPLETED_MATCH_URL='https://www.hltv.org/matches/<completed-id>/<slug>' \
pnpm release:hltv

FIVEEPLAY_MATCH_URL='https://event.5eplay.com/csgo/matches/<match-id>' \
pnpm release:5eplay
```

Each command:

1. Requires a clean `main` exactly matching `origin/main` and an authenticated GitHub CLI.
2. Confirms that the package already exists on npm; a missing package stops with bootstrap guidance.
3. Runs deterministic verification and the package's real-network smoke tests.
4. Computes the next UTC `YYYYMMDD.REVISION.0` version and verifies the package tarball.
5. Creates the release commit and immutable `@ekmanss/<package>@<version>` tag.
6. Pushes `main` and the tag, waits for the GitHub Actions publish job, and verifies npm visibility.

The local command never authenticates to npm and never publishes directly. The workflow has only
`contents: read` and `id-token: write`; npm exchanges the job's OIDC identity for a short-lived,
workflow-specific publish credential and generates provenance for public packages.

## Required npm configuration

Every existing package must have exactly this Trusted Publisher relationship before a release:

- Provider: GitHub Actions
- Repository: `ekmanss/sports-data-collectors`
- Workflow file: `publish.yml`
- Allowed action: `npm publish`

The package manifest's `repository.url` must continue to identify this GitHub repository. The
workflow must run on a GitHub-hosted runner with npm 11.5.1 or newer and `id-token: write`.

## One-time bootstrap for a brand-new npm package

npm requires a package to exist before Trusted Publishing can be configured. This is the only case
where a local first publish is allowed:

1. Add the package to the workspace and to the tag routing in `publish.yml`.
2. Verify and manually publish its first public version with 2FA.
3. Immediately create the trust relationship:

   ```bash
   npx --yes npm@11.18.0 trust github '@ekmanss/<package>' \
     --file publish.yml \
     --repo ekmanss/sports-data-collectors \
     --allow-publish \
     --yes
   ```

4. Run `npm logout` after bootstrap. All subsequent releases must use the standard OIDC path.

## Failure handling

- Before a tag is pushed, fix the problem locally and rerun after returning to a clean `main`.
- After a tag is pushed, inspect the linked Actions run with `gh run view --log-failed`.
- Never move a remote release tag, overwrite a published version, or fall back to a long-lived npm
  token. Fix the cause and create a new version if registry publication already occurred.
- A failed registry check does not authorize a local publish. Confirm package visibility and the
  Trusted Publisher's repository/workflow fields first. The workflow publishes only after an
  explicit npm `E404`; other registry errors stop the job.
