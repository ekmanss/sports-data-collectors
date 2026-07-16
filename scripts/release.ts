import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const REPOSITORY = 'ekmanss/sports-data-collectors';
const WORKFLOW = 'publish.yml';

interface ReleaseTarget {
  name: '@ekmanss/hltv' | '@ekmanss/5eplay';
  directory: 'packages/hltv' | 'packages/5eplay';
  requiredEnvironment: string[];
  liveTestScripts: string[];
}

const TARGETS: Record<string, ReleaseTarget> = {
  hltv: {
    name: '@ekmanss/hltv',
    directory: 'packages/hltv',
    requiredEnvironment: ['HLTV_MATCH_URL', 'HLTV_COMPLETED_MATCH_URL'],
    liveTestScripts: ['test:live'],
  },
  '5eplay': {
    name: '@ekmanss/5eplay',
    directory: 'packages/5eplay',
    requiredEnvironment: ['FIVEEPLAY_MATCH_URL'],
    liveTestScripts: ['test:live:5eplay', 'test:live:5eplay:list'],
  },
};

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

export function resolveTarget(input: string): ReleaseTarget {
  const normalized = input.trim().replace(/^@ekmanss\//, '');
  const target = TARGETS[normalized];
  if (!target) {
    throw new Error(`unsupported package ${JSON.stringify(input)}; expected hltv or 5eplay`);
  }
  return target;
}

function registryVersions(target: ReleaseTarget): string[] {
  const result = spawnSync('npm', ['view', target.name, 'versions', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (detail.includes('E404')) {
      throw new Error(
        `${target.name} does not exist on npm. Bootstrap it once using docs/releasing.md, `
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

async function waitForRegistry(target: ReleaseTarget, version: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync('npm', ['view', `${target.name}@${version}`, 'version', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      env: process.env,
    });
    if (result.status === 0 && JSON.parse(String(result.stdout).trim()) === version) return;
    await delay(2_000);
  }
  throw new Error(`${target.name}@${version} was not visible on npm within 60 seconds`);
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm release:hltv',
    '  pnpm release:5eplay',
    '  pnpm release -- <hltv|5eplay>',
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
  if (!input || input === '--help' || input === '-h') {
    process.stdout.write(`${usage()}\n`);
    if (!input) process.exitCode = 2;
    return;
  }
  if (arguments_.length !== 1) {
    throw new Error(`expected exactly one package argument\n${usage()}`);
  }
  const target = resolveTarget(input);
  const missingEnvironment = target.requiredEnvironment.filter((name) => !process.env[name]);
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

  const versions = registryVersions(target);
  run('pnpm', ['verify']);
  for (const script of target.liveTestScripts) run('pnpm', [script]);

  const tags = run('git', ['tag', '--list', `${target.name}@*`], true)
    .split('\n')
    .filter(Boolean)
    .map((tag) => tag.slice(`${target.name}@`.length));
  const version = nextVersion([...versions, ...tags]);
  const tag = `${target.name}@${version}`;
  const packageJsonPath = resolve(ROOT, target.directory, 'package.json');
  const original = await readFile(packageJsonPath, 'utf8');
  const manifest = JSON.parse(original) as Record<string, unknown>;
  manifest.version = version;
  await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

  try {
    run('pnpm', ['--filter', target.name, 'build']);
    run('pnpm', ['--filter', target.name, 'exec', 'npm', 'pack', '--dry-run', '--ignore-scripts']);
  } catch (error) {
    await writeFile(packageJsonPath, original);
    throw error;
  }

  run('git', ['add', `${target.directory}/package.json`]);
  run('git', ['commit', '-m', `release(${target.name}): ${version}`]);
  run('git', ['tag', tag]);
  const releaseSha = run('git', ['rev-parse', 'HEAD'], true);
  run('git', ['push', 'origin', 'main']);
  run('git', ['push', 'origin', tag]);

  const runId = await workflowRunId(tag, releaseSha);
  run('gh', ['run', 'watch', String(runId), '--repo', REPOSITORY, '--exit-status']);
  await waitForRegistry(target, version);

  process.stdout.write([
    '',
    `Published ${target.name}@${version} through GitHub Actions OIDC.`,
    `Tag: ${tag}`,
    `Workflow: https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    `npm: https://www.npmjs.com/package/${target.name}/v/${version}`,
    '',
  ].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
