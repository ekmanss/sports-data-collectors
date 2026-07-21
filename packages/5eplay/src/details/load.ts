import type {
  CommunityData,
  DataSection,
  MatchDetails,
  TeamPastMatches,
  TeamRecentMatches,
} from '../domain/model.js';
import { unixMilliseconds } from '../internal/value.js';
import { COMMUNITY_BASE_URL, ESPORTS_DATA_BASE_URL } from '../transport/http.js';
import type { MatchTransport } from '../transport/port.js';
import { parseAnalysis } from './analysis.js';
import {
  EMPTY_COMMUNITY,
  parseCommunityCards,
  parseCommunityTabs,
} from './community.js';
import {
  loadEvents,
  type EventIdentityContext,
  type EventPageLimits,
} from './events.js';
import {
  mergeTeamPastMatches,
  mergeTeamRecentMatches,
  parseTeamPastMatches,
  parseTeamRecentMatches,
} from './history.js';
import { loadSection } from './section.js';

interface PagedTeamData {
  readonly teamId: string;
  readonly totalPages: number;
  readonly totalRows: number;
}

async function loadOneTeamHistory<T extends PagedTeamData>(
  transport: MatchTransport,
  teamId: string,
  url: (teamId: string, page: number) => string,
  parse: (payload: unknown, teamId: string) => T,
  merge: (pages: readonly T[], teamId: string) => T,
  rowCount: (data: T) => number,
  maximumPages: number,
  signal: AbortSignal,
): Promise<DataSection<T>> {
  const pages: T[] = [];
  let attempts = 0;
  let observedAt = unixMilliseconds();
  let expectedPages = 1;
  let gap: string | null = null;
  for (let page = 1; page <= Math.min(expectedPages, maximumPages); page += 1) {
    let response;
    try {
      response = await transport.fetchJsonWithRetry(url(teamId, page), signal);
    } catch {
      gap = signal.aborted ? 'DEADLINE' : 'PROVIDER_FAILURE';
      break;
    }
    attempts += response.attempts;
    observedAt = response.observedAt;
    if (response.kind !== 'ok') {
      gap = `HTTP_${response.status}`;
      break;
    }
    let parsed: T;
    try {
      parsed = parse(response.payload, teamId);
    } catch {
      gap = 'SCHEMA_OR_IDENTITY_MISMATCH';
      break;
    }
    if (parsed.teamId !== teamId) {
      gap = 'IDENTITY_MISMATCH';
      break;
    }
    if (page === 1) expectedPages = Math.max(1, parsed.totalPages);
    else if (Math.max(1, parsed.totalPages) !== expectedPages) {
      gap = 'PAGE_COUNT_CHANGED';
      break;
    }
    pages.push(parsed);
  }
  if (pages.length === 0) {
    return {
      attempts,
      data: null,
      gap: gap ?? 'NO_PAGE_DATA',
      observedAt,
      status: 'unavailable',
    };
  }
  const data = merge(pages, teamId);
  if (gap === null && expectedPages > maximumPages) gap = 'PAGE_LIMIT';
  if (gap === null && rowCount(data) < data.totalRows) gap = 'ROW_COUNT_MISMATCH';
  return gap === null
    ? { attempts, data, gap: null, observedAt, status: 'complete' }
    : { attempts, data, gap, observedAt, status: 'partial' };
}

async function loadTeamSection<T>(
  teamIds: readonly [string, string],
  load: (teamId: string) => Promise<DataSection<T>>,
): Promise<DataSection<readonly T[]>> {
  const loaded = await Promise.all(teamIds.map(load));
  const availableData = loaded.flatMap((section): T[] =>
    section.data === null ? [] : [section.data],
  );
  const statuses = loaded.map((section) => section.status);
  const status = statuses.every((value) => value === 'complete')
    ? 'complete'
    : availableData.length > 0
      ? 'partial'
      : 'unavailable';
  const metadata = {
    attempts: loaded.reduce((total, section) => total + section.attempts, 0),
    observedAt: unixMilliseconds(
      Math.max(0, ...loaded.map((section) => section.observedAt)),
    ),
  };
  if (status === 'complete') {
    return { ...metadata, data: availableData, gap: null, status };
  }
  if (availableData.length > 0) {
    return {
      ...metadata,
      data: availableData,
      gap: 'ONE_OR_MORE_TEAMS_INCOMPLETE',
      status: 'partial',
    };
  }
  return {
    ...metadata,
    data: null,
    gap: 'ONE_OR_MORE_TEAMS_INCOMPLETE',
    status: 'unavailable',
  };
}

async function loadCommunity(
  transport: MatchTransport,
  matchId: string,
  signal: AbortSignal,
): Promise<DataSection<CommunityData>> {
  const tabsUrl = new URL(`${COMMUNITY_BASE_URL}/match_score_tab`);
  tabsUrl.searchParams.set('match_id', matchId);
  tabsUrl.searchParams.set('game_type', '1');
  let tabsResponse;
  try {
    tabsResponse = await transport.fetchJsonWithRetry(tabsUrl.toString(), signal);
  } catch {
    return {
      attempts: 0,
      data: null,
      gap: signal.aborted ? 'DEADLINE' : 'PROVIDER_FAILURE',
      observedAt: unixMilliseconds(),
      status: 'unavailable',
    };
  }
  if (tabsResponse.kind !== 'ok') {
    return {
      attempts: tabsResponse.attempts,
      data: null,
      gap: `HTTP_${tabsResponse.status}`,
      observedAt: tabsResponse.observedAt,
      status: 'unavailable',
    };
  }
  let tabs;
  try {
    tabs = parseCommunityTabs(tabsResponse.payload);
  } catch {
    return {
      attempts: tabsResponse.attempts,
      data: null,
      gap: 'SCHEMA_UNSUPPORTED',
      observedAt: tabsResponse.observedAt,
      status: 'unavailable',
    };
  }
  if (tabs.length === 0) {
    return {
      attempts: tabsResponse.attempts,
      data: EMPTY_COMMUNITY,
      gap: null,
      observedAt: tabsResponse.observedAt,
      status: 'empty',
    };
  }
  const cards = await Promise.all(
    tabs.map(async (tab) => {
      const url = new URL(`${COMMUNITY_BASE_URL}/match_score_list`);
      url.searchParams.set('match_id', matchId);
      url.searchParams.set('tab', tab.tab);
      url.searchParams.set('game_type', '1');
      url.searchParams.set('team_id', tab.id);
      try {
        return await transport.fetchJsonWithRetry(url.toString(), signal);
      } catch {
        return null;
      }
    }),
  );
  const parsedCards = [];
  let partial = false;
  for (const [index, response] of cards.entries()) {
    if (response === null || response.kind !== 'ok') {
      partial = true;
      continue;
    }
    try {
      parsedCards.push(...parseCommunityCards(response.payload, tabs[index]?.tab ?? ''));
    } catch {
      partial = true;
    }
  }
  const result = {
    attempts: tabsResponse.attempts + cards.reduce(
      (total, response) => total + (response?.attempts ?? 0),
      0,
    ),
    data: { cards: parsedCards, tabs },
    observedAt: unixMilliseconds(
      Math.max(
        tabsResponse.observedAt,
        ...cards.map((response) => response?.observedAt ?? 0),
      ),
    ),
  };
  return partial
    ? {
        ...result,
        gap: 'ONE_OR_MORE_CARD_GROUPS_UNAVAILABLE',
        status: 'partial',
      }
    : { ...result, gap: null, status: 'complete' };
}

export async function loadMatchDetails(
  transport: MatchTransport,
  matchId: string,
  teamIds: readonly [string, string],
  tournamentId: string,
  maps: EventIdentityContext['maps'],
  eventLimits: EventPageLimits,
  teamHistoryPageLimit: number,
  signals: {
    readonly detail: AbortSignal;
    readonly events: AbortSignal;
  },
): Promise<MatchDetails> {
  const analysisUrl = `${ESPORTS_DATA_BASE_URL}/matches/${encodeURIComponent(matchId)}/analysis_v1`;
  const [analysis, teamRecentMatches, teamPastMatches, events, community] = await Promise.all([
    loadSection(
      transport,
      analysisUrl,
      signals.detail,
      (payload) => parseAnalysis(payload, matchId, teamIds, tournamentId),
      () => false,
    ),
    loadTeamSection<TeamRecentMatches>(
      teamIds,
      (teamId) =>
        loadOneTeamHistory(
          transport,
          teamId,
          (id, page) =>
            `${ESPORTS_DATA_BASE_URL}/teams/${encodeURIComponent(id)}/matches?page=${page}&limit=20`,
          parseTeamRecentMatches,
          mergeTeamRecentMatches,
          (data) => data.tournaments.reduce(
            (total, group) => total + group.matches.length,
            0,
          ),
          teamHistoryPageLimit,
          signals.detail,
        ),
    ),
    loadTeamSection<TeamPastMatches>(
      teamIds,
      (teamId) =>
        loadOneTeamHistory(
          transport,
          teamId,
          (id, page) =>
            `${ESPORTS_DATA_BASE_URL}/team/matches_v1/${encodeURIComponent(id)}?page=${page}&limit=30&status=past`,
          parseTeamPastMatches,
          mergeTeamPastMatches,
          (data) => data.matches.length,
          teamHistoryPageLimit,
          signals.detail,
        ),
    ),
    loadEvents(
      transport,
      { maps, matchId, tournamentId },
      eventLimits,
      signals.events,
    ),
    loadCommunity(transport, matchId, signals.detail),
  ]);
  return { analysis, community, events, teamPastMatches, teamRecentMatches };
}
