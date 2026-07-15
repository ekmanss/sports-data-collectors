import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGE_NAME = '@ekmanss/hltv';
const PACKAGE_JSON = resolve(ROOT, 'packages/hltv/package.json');

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
    if (`${result.stdout ?? ''}${result.stderr ?? ''}`.includes('E404')) return [];
    throw new Error(`npm registry lookup failed: ${String(result.stderr ?? result.stdout).trim()}`);
  }
  const parsed: unknown = JSON.parse(String(result.stdout || '[]'));
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string')
    : typeof parsed === 'string' ? [parsed] : [];
}

function nextVersion(existing: string[]): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const pattern = new RegExp(`^${date}\\.(\\d+)\\.0$`);
  const revisions = existing.flatMap((version) => {
    const match = version.match(pattern);
    return match ? [Number(match[1])] : [];
  });
  return `${date}.${revisions.length ? Math.max(...revisions) + 1 : 0}.0`;
}

async function main(): Promise<void> {
  if (!process.env.HLTV_MATCH_URL) {
    throw new Error('HLTV_MATCH_URL is required for the real-network release test');
  }
  if (!process.env.HLTV_COMPLETED_MATCH_URL) {
    throw new Error('HLTV_COMPLETED_MATCH_URL is required for the real-network release test');
  }
  const dirty = run('git', ['status', '--porcelain'], true);
  if (dirty) throw new Error('working tree must be clean before release');

  run('pnpm', ['verify']);
  run('pnpm', ['test:live']);

  const tags = run('git', ['tag', '--list', `${PACKAGE_NAME}@*`], true)
    .split('\n')
    .filter(Boolean)
    .map((tag) => tag.slice(`${PACKAGE_NAME}@`.length));
  const version = nextVersion([...registryVersions(), ...tags]);
  const tag = `${PACKAGE_NAME}@${version}`;

  const original = await readFile(PACKAGE_JSON, 'utf8');
  const manifest = JSON.parse(original) as Record<string, unknown>;
  manifest.version = version;
  await writeFile(PACKAGE_JSON, `${JSON.stringify(manifest, null, 2)}\n`);

  try {
    run('pnpm', ['--filter', PACKAGE_NAME, 'build']);
    run('pnpm', ['--filter', PACKAGE_NAME, 'exec', 'npm', 'pack', '--dry-run']);
  } catch (error) {
    await writeFile(PACKAGE_JSON, original);
    throw error;
  }
  run('git', ['add', 'packages/hltv/package.json']);
  run('git', ['commit', '-m', `release(${PACKAGE_NAME}): ${version}`]);
  run('git', ['tag', tag]);

  process.stdout.write(`\nCreated local release ${tag}.\nReview it, then push the commit and tag manually.\n`);
}

await main();
