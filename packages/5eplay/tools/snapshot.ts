import { resolve } from 'node:path';

import {
  createFiveEPlayMatchSource,
  describeMatchState,
  writeMatchSnapshotArtifacts,
} from '../src/index.js';

interface Arguments {
  readonly matchId: string;
  readonly outputDirectory: string;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm --filter @ekmanss/5eplay snapshot -- --match-id csgo_mc_123 --out-dir ./output',
    '',
    'Writes one complete .json file and one filtered, human-readable .md file with the same name.',
  ].join('\n');
}

function argumentsFromCommandLine(values: readonly string[]): Arguments {
  const valueFor = (flag: string): string | null => {
    const index = values.indexOf(flag);
    return index < 0 ? null : values[index + 1] ?? null;
  };
  const matchId = valueFor('--match-id') ?? '';
  const outputDirectory = valueFor('--out-dir') ?? '';
  if (!/^csgo_mc_[1-9]\d*$/.test(matchId)) {
    throw new Error(`invalid --match-id\n${usage()}`);
  }
  if (outputDirectory.trim() === '') throw new Error(`--out-dir is required\n${usage()}`);
  return { matchId, outputDirectory: resolve(outputDirectory) };
}

const arguments_ = argumentsFromCommandLine(process.argv.slice(2));
const source = createFiveEPlayMatchSource();
const result = await source.snapshot(arguments_.matchId);
if (result.kind !== 'confirmed') {
  const exitCodes = {
    blocked: 2,
    'not-found': 3,
    superseded: 4,
    unsupported: 5,
  } as const;
  process.stderr.write(`snapshot not written: ${JSON.stringify(result)}\n`);
  process.exitCode = exitCodes[result.kind];
} else {
  const paths = await writeMatchSnapshotArtifacts(result.snapshot, {
    outputDirectory: arguments_.outputDirectory,
  });
  process.stdout.write(`${JSON.stringify({
    jsonPath: paths.jsonPath,
    markdownPath: paths.markdownPath,
    status: describeMatchState(result.snapshot.state),
  })}\n`);
}
