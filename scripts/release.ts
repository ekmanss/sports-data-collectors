import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const REPOSITORY = 'ekmanss/sports-data-collectors';
const WORKFLOW = 'publish.yml';
const PACKAGE_NAME = '@ekmanss/5eplay';
const PACKAGE_DIRECTORY = 'packages/5eplay';
const REQUIRED_ENVIRONMENT = ['FIVEEPLAY_MATCH_URL'];
const LIVE_TEST_SCRIPTS = ['test:live', 'test:live:list'];

function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout ?? '').trim();
}

function registryVersions(): string[] {
  const result = spawnSync('npm', ['view', PACKAGE_NAME, 'versions', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (detail.includes('E404')) {
      throw new Error(
        `${PACKAGE_NAME} does not exist on npm. Bootstrap it once using docs/releasing.md, `
        + 'configure Trusted Publishing, then use this OIDC release command.',
      );
    }
    throw new Error(`npm registry lookup failed: ${detail.trim()}`);
  }
  const parsed: unknown = JSON.parse(String(result.stdout || '[]'));
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string')
    : typeof parsed === 'string' ? [parsed] : [];
}

export function nextVersion(existing: string[], now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const pattern = new RegExp(`^${date}\\.(\\d+)\\.0$`);
  const revisions = existing.flatMap((version) => {
    const match = version.match(pattern);
    return match ? [Number(match[1])] : [];
  });
  return `${date}.${revisions.length ? Math.max(...revisions) + 1 : 0}.0`;
}

const delay = async (milliseconds: number): Promise<void> => await new Promise(
  (resolveDelay) => setTimeout(resolveDelay, milliseconds),
);

async function workflowRunId(tag: string, headSha: string): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const output = run('gh', [
      'run', 'list', '--repo', REPOSITORY, '--workflow', WORKFLOW,
      '--branch', tag, '--event', 'push', '--limit', '5',
      '--json', 'databaseId,headSha',
    ], true);
    const runs = JSON.parse(output || '[]') as Array<{ databaseId?: unknown; headSha?: unknown }>;
    const match = runs.find((candidate) => candidate.headSha === headSha);
    if (typeof match?.databaseId === 'number') return match.databaseId;
    await delay(2_000);
  }
  throw new Error(`GitHub Actions run for ${tag} did not appear within 60 seconds`);
}

async function waitForRegistry(version: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync('npm', ['view', `${PACKAGE_NAME}@${version}`, 'version', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      env: process.env,
    });
    if (result.status === 0 && JSON.parse(String(result.stdout).trim()) === version) return;
    await delay(2_000);
  }
  throw new Error(`${PACKAGE_NAME}@${version} was not visible on npm within 60 seconds`);
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm release',
    '',
    'The command verifies locally, commits the version, pushes main and the release tag,',
    'then waits for GitHub Actions to publish with npm Trusted Publishing (OIDC).',
    'It never runs npm login or npm publish locally.',
  ].join('\n');
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  const arguments_ = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments;
  const input = arguments_[0];
  if (input === '--help' || input === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (arguments_.length !== 0) {
    throw new Error(`expected no arguments\n${usage()}`);
  }
  const missingEnvironment = REQUIRED_ENVIRONMENT.filter((name) => !process.env[name]);
  if (missingEnvironment.length) {
    throw new Error(`required real-network release variables are missing: ${missingEnvironment.join(', ')}`);
  }
  if (run('git', ['status', '--porcelain'], true)) {
    throw new Error('working tree must be clean before release');
  }
  if (run('git', ['branch', '--show-current'], true) !== 'main') {
    throw new Error('releases must be created from the main branch');
  }

  run('git', ['fetch', 'origin', 'main', '--tags']);
  const headBeforeRelease = run('git', ['rev-parse', 'HEAD'], true);
  const remoteMain = run('git', ['rev-parse', 'origin/main'], true);
  if (headBeforeRelease !== remoteMain) {
    throw new Error('local main must exactly match origin/main before release');
  }
  run('gh', ['auth', 'status']);
  run('gh', ['workflow', 'view', WORKFLOW, '--repo', REPOSITORY]);

  const versions = registryVersions();
  run('pnpm', ['verify']);
  for (const script of LIVE_TEST_SCRIPTS) run('pnpm', [script]);

  const tags = run('git', ['tag', '--list', `${PACKAGE_NAME}@*`], true)
    .split('\n')
    .filter(Boolean)
    .map((tag) => tag.slice(`${PACKAGE_NAME}@`.length));
  const version = nextVersion([...versions, ...tags]);
  const tag = `${PACKAGE_NAME}@${version}`;
  const packageJsonPath = resolve(ROOT, PACKAGE_DIRECTORY, 'package.json');
  const original = await readFile(packageJsonPath, 'utf8');
  const manifest = JSON.parse(original) as Record<string, unknown>;
  manifest.version = version;
  await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

  try {
    run('pnpm', ['--filter', PACKAGE_NAME, 'build']);
    run('pnpm', ['--filter', PACKAGE_NAME, 'exec', 'npm', 'pack', '--dry-run', '--ignore-scripts']);
  } catch (error) {
    await writeFile(packageJsonPath, original);
    throw error;
  }

  run('git', ['add', `${PACKAGE_DIRECTORY}/package.json`]);
  run('git', ['commit', '-m', `release(${PACKAGE_NAME}): ${version}`]);
  run('git', ['tag', tag]);
  const releaseSha = run('git', ['rev-parse', 'HEAD'], true);
  run('git', ['push', 'origin', 'main']);
  run('git', ['push', 'origin', tag]);

  const runId = await workflowRunId(tag, releaseSha);
  run('gh', ['run', 'watch', String(runId), '--repo', REPOSITORY, '--exit-status']);
  await waitForRegistry(version);

  process.stdout.write([
    '',
    `Published ${PACKAGE_NAME}@${version} through GitHub Actions OIDC.`,
    `Tag: ${tag}`,
    `Workflow: https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    `npm: https://www.npmjs.com/package/${PACKAGE_NAME}/v/${version}`,
    '',
  ].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
