import assert from 'node:assert/strict';

import { createFiveEPlayMatchSource } from '../src/index.js';

const matchId = process.env.FIVEEPLAY_MATCH_ID;
assert.match(
  matchId ?? '',
  /^csgo_mc_[1-9]\d*$/,
  'FIVEEPLAY_MATCH_ID must be an explicit csgo_mc_<positive integer>',
);

const source = createFiveEPlayMatchSource();
const schedule = await source.schedule({ deadlineMs: 30_000 });
assert.equal(schedule.kind, 'available', JSON.stringify(schedule));

const result = await source.snapshot(matchId as string, {
  deadlineMs: 120_000,
});
assert.equal(result.kind, 'confirmed', JSON.stringify(result));
if (result.kind === 'confirmed') {
  process.stdout.write(
    `${JSON.stringify({
      detailsCompleteness: result.snapshot.detailsCompleteness,
      lifecycle: result.snapshot.state.lifecycle,
      matchId: result.snapshot.match.id,
      phase: result.snapshot.state.phase,
      revision: result.snapshot.revision,
      schedule: schedule.kind === 'available'
        ? {
            matches: schedule.schedule.matches.length,
            page: schedule.schedule.page,
            sourceCount: schedule.schedule.sourceCount,
          }
        : null,
    })}\n`,
  );
}
