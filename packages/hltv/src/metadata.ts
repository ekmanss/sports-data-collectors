import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollectorVersions } from './types.js';

interface PackageMetadata { version: string }

let cached: Promise<CollectorVersions> | undefined;

async function packageVersionFromEntry(specifier: string): Promise<string> {
  const entry = fileURLToPath(import.meta.resolve(specifier));
  let directory = dirname(entry);
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const value = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) as PackageMetadata & { name?: string };
      if (value.name === specifier) return value.version;
    } catch {
      // Continue toward the package root.
    }
    directory = dirname(directory);
  }
  throw new Error(`could not resolve package metadata for ${specifier}`);
}

async function ownPackageVersion(): Promise<string> {
  const packagePath = resolve(import.meta.dirname, '..', 'package.json');
  const value = JSON.parse(await readFile(packagePath, 'utf8')) as PackageMetadata;
  return value.version;
}

export function collectorVersions(): Promise<CollectorVersions> {
  cached ??= Promise.all([
    ownPackageVersion(),
    packageVersionFromEntry('cloakbrowser'),
    packageVersionFromEntry('playwright-core'),
  ]).then(([packageVersion, cloakbrowserVersion, playwrightVersion]) => ({
    packageVersion,
    cloakbrowserVersion,
    playwrightVersion,
  }));
  return cached;
}
