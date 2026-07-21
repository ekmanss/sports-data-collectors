import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_VERSION = /^(\d{8})\.(0|[1-9]\d*)\.0$/;

function releaseVersionParts(version: string): readonly [bigint, bigint] {
  const match = version.match(RELEASE_VERSION);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`release version ${version} must use YYYYMMDD.REVISION.0`);
  }
  return [BigInt(match[1]), BigInt(match[2])];
}

export function assertPublishVersionIsNewer(candidate: string, latest: string): void {
  const [candidateDate, candidateRevision] = releaseVersionParts(candidate);
  const [latestDate, latestRevision] = releaseVersionParts(latest);
  if (
    candidateDate < latestDate ||
    (candidateDate === latestDate && candidateRevision <= latestRevision)
  ) {
    throw new Error(
      `candidate ${candidate} must be newer than npm latest ${latest}; refusing to move latest backwards`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [candidate, latest, ...unexpected] = process.argv.slice(2);
  if (candidate === undefined || latest === undefined || unexpected.length > 0) {
    throw new Error('usage: publish-version-policy <candidate> <npm-latest>');
  }
  assertPublishVersionIsNewer(candidate, latest);
}
