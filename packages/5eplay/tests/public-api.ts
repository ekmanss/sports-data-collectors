import {
  createFiveEPlayMatchSource,
  FiveEPlaySourceError,
  type FiveEPlayMatchSource,
  type FiveEPlaySourceErrorCode,
  type ConfirmedMatchObservation,
  type MatchFreshness,
  type MatchMap,
  type MatchSnapshotResult,
  type MatchState,
  type MatchUpdate,
  type ProvisionalTelemetry,
} from '../src/index.js';

function assertNever(value: never): never {
  throw new Error(`unexpected public union member: ${String(value)}`);
}

export function consumeSnapshot(result: MatchSnapshotResult): string {
  switch (result.kind) {
    case 'confirmed':
      return result.snapshot.revision;
    case 'blocked':
      return result.reason;
    case 'not-found':
      return result.matchId;
    case 'unsupported':
      return result.reason;
    case 'superseded':
      return result.observedRevision;
    default:
      return assertNever(result);
  }
}

export function consumeUpdate(update: MatchUpdate): ProvisionalTelemetry | null {
  switch (update.kind) {
    case 'confirmed-state':
    case 'blocked':
    case 'not-found':
    case 'unsupported':
      return null;
    case 'provisional-telemetry':
      return update.telemetry;
    default:
      return assertNever(update);
  }
}

export async function consumeWatch(source: FiveEPlayMatchSource): Promise<void> {
  await using watch = source.watch('csgo_mc_1');
  for await (const update of watch) consumeUpdate(update);
}

export function constructPublicError(code: FiveEPlaySourceErrorCode): FiveEPlaySourceError {
  return new FiveEPlaySourceError(code, 'consumer-visible failure');
}

export const publicSource: FiveEPlayMatchSource = createFiveEPlayMatchSource();

// @ts-expect-error scheduled observations cannot claim a terminal phase or live vector
const impossibleScheduledState: MatchState = { certainty: 'confirmed', closure: null, dataFinality: 'stable', lifecycle: 'scheduled', phase: { finalMap: 3, kind: 'series-ended' }, providerVector: [1, 2, 2, 1], stateCase: 'prestart' };
void impossibleScheduledState;

declare const publicMap: MatchMap;
// @ts-expect-error a confirmed BO3 observation always has exactly three ordered map slots
const incompleteMapTuple: ConfirmedMatchObservation['maps'] = [publicMap, publicMap];
void incompleteMapTuple;

type Equal<First, Second> =
  (<Value>() => Value extends First ? 1 : 2) extends
  (<Value>() => Value extends Second ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;
export type UnopenedMapStartIsAlwaysNull = Expect<
  Equal<Extract<MatchMap, { readonly status: 'unopened' }>['startedAt'], null>
>;
export type TechnicalMapsDoNotExposeFlattenedPlayers = Expect<
  Equal<
    'players' extends keyof Extract<MatchMap, { readonly status: 'closed-without-play' }>
      ? true
      : false,
    false
  >
>;
export type UnopenedMapsCannotExposePresentPlayerRows = Expect<
  Equal<
    Extract<MatchMap, { readonly status: 'unopened' }>['playerStatistics']['teams'][0]['overall']['status'],
    'empty' | 'unavailable'
  >
>;
export type AwardedMapsAlwaysHaveAWinner = Expect<
  Equal<
    Extract<MatchMap, { readonly technicalDisposition: 'awarded' }>['winnerTeamId'],
    string
  >
>;
type ScorePair<Teams> = Teams extends readonly [
  { readonly score: infer First; readonly quickScore: infer FirstQuick },
  { readonly score: infer Second; readonly quickScore: infer SecondQuick },
]
  ? readonly [First, Second, FirstQuick, SecondQuick]
  : never;
export type AwardedMapsHaveExactlyOneToZero = Expect<
  Equal<
    ScorePair<Extract<MatchMap, { readonly technicalDisposition: 'awarded' }>['teams']>,
    | readonly [1, 0, 1, 0]
    | readonly [0, 1, 0, 1]
  >
>;
export type UnusedMapsNeverHaveAWinner = Expect<
  Equal<
    Extract<MatchMap, { readonly technicalDisposition: 'unused' }>['winnerTeamId'],
    null
  >
>;
export type FreshnessKeysStayMinimal = Expect<
  Equal<keyof MatchFreshness, 'coreObservedAt' | 'stateVersion' | 'localVersion'>
>;
