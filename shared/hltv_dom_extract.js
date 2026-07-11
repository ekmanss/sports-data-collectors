() => {
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const text = (root, selector) => clean(root?.querySelector(selector)?.textContent);
  const absolute = (href) => href ? new URL(href, location.origin).href : null;
  const idFromHref = (href, kind) => {
    const match = href?.match(new RegExp(`/${kind}/(\\d+)`));
    return match ? Number(match[1]) : null;
  };
  const rows = (table) => [...(table?.querySelectorAll('tr') || [])].map((row) =>
    [...row.querySelectorAll('th,td')].map((cell) => clean(cell.textContent))
  );

  const matchPage = document.querySelector('.match-page');
  const eventLink = matchPage?.querySelector('.timeAndEvent .event a');
  const timeNode = matchPage?.querySelector('.timeAndEvent .time');
  const teams = [...(matchPage?.querySelectorAll('.teamsBox:not(.Dropdown) > .team') || [])].map((team) => {
    const link = team.querySelector('a[href*="/team/"]');
    const href = link?.getAttribute('href');
    return {
      id: idFromHref(href, 'team'),
      name: text(team, '.teamName'),
      url: absolute(href),
      country: team.querySelector('img.team1, img.team2')?.getAttribute('title') || null,
      logo: team.querySelector('img.logo')?.getAttribute('src') || null,
    };
  });

  const mapSection = [...(matchPage?.querySelectorAll('.maps') || [])]
    .find((node) => [...node.querySelectorAll('span')].some((span) => clean(span.textContent) === 'Maps'));
  const formatRaw = text(mapSection, '.preformatted-text');
  const [format = '', stage = ''] = formatRaw.split('*').map(clean);
  const veto = [...(mapSection?.querySelectorAll('.veto-box .padding > div') || [])]
    .map((node) => clean(node.textContent)).filter((value) => /^\d+\./.test(value));
  const maps = [...(mapSection?.querySelectorAll('.mapholder') || [])].map((holder) => ({
    name: text(holder, '.mapname'),
    optional: Boolean(holder.querySelector(':scope > .optional')),
    teams: [...holder.querySelectorAll('.results-left, .results-right')].map((side) => ({
      name: text(side, '.results-teamname:not(.results-teamname-container)'),
      score: text(side, '.results-team-score'),
      picked: side.classList.contains('pick'),
    })),
    halfScores: text(holder, '.results-center'),
  }));

  const streams = [...(matchPage?.querySelectorAll('.streams .stream-box') || [])].map((box) => {
    const link = box.querySelector('a[href]');
    const embed = box.querySelector('[data-stream-embed]');
    return {
      name: clean(box.querySelector('.stream-box-embed, .hltv-live-logo')?.textContent),
      viewers: text(box, '.viewers'),
      url: absolute(link?.getAttribute('href')),
      embedUrl: embed?.getAttribute('data-stream-embed') || null,
    };
  }).filter((stream) => stream.name || stream.viewers || stream.url || stream.embedUrl);

  const compare = document.querySelector('#lineups .lineups-compare-container');
  const rawStats = [compare?.getAttribute('data-team1-players-data'), compare?.getAttribute('data-team2-players-data')];
  const statsByTeam = rawStats.map((value) => {
    try { return value ? JSON.parse(value) : {}; } catch { return {}; }
  });
  const lineups = [...document.querySelectorAll('#lineups .lineup.standard-box')].map((box, teamIndex) => {
    const teamLink = box.querySelector('.box-headline a[href*="/team/"]');
    const teamHref = teamLink?.getAttribute('href');
    const imageCells = [...box.querySelectorAll('table tr:nth-child(1) td')];
    const nameCells = [...box.querySelectorAll('table tr:nth-child(2) td')];
    return {
      id: idFromHref(teamHref, 'team'),
      name: clean(teamLink?.textContent),
      worldRank: Number(text(box, '.teamRanking').match(/#(\d+)/)?.[1] || 0) || null,
      players: nameCells.map((cell, playerIndex) => {
        const dataNode = cell.querySelector('[data-player-id]');
        const id = Number(dataNode?.getAttribute('data-player-id') || 0) || null;
        const image = imageCells[playerIndex]?.querySelector('img');
        const stats = id ? (statsByTeam[teamIndex]?.[String(id)] || {}) : {};
        return {
          id,
          nickname: text(cell, '.text-ellipsis:last-child'),
          fullName: image?.getAttribute('title') || null,
          country: cell.querySelector('img.flag')?.getAttribute('title') || null,
          image: image?.getAttribute('src') || null,
          profileUrl: absolute(stats.profileLinkUrl),
          statsUrl: absolute(stats.statsLinkUrl),
          rating: stats.rating ?? null,
          kpr: stats.kpr ?? null,
          dpr: stats.dpr ?? null,
          kast: stats.kast ?? null,
          adr: stats.adr ?? null,
          stats,
        };
      }),
    };
  });

  const mapStatsRoot = document.querySelector('#map-stats + .map-stats-infobox');
  const mapStats = mapStatsRoot ? (() => {
    const mapTeamNames = [...mapStatsRoot.querySelectorAll('.map-stats-infobox-header .team')].map((node) => clean(node.textContent));
    const teamDetails = [...mapStatsRoot.querySelectorAll('.map-stats-infobox-header .team')].map((node, teamIndex) => {
      const link = node.querySelector('a[href*="/team/"]');
      const href = link?.getAttribute('href');
      const matchTeam = teams[teamIndex];
      return {
        id: idFromHref(href, 'team') ?? matchTeam?.id ?? null,
        name: clean(node.textContent),
        url: absolute(href) ?? matchTeam?.url ?? null,
        logo: absolute(node.querySelector('img')?.getAttribute('src')),
      };
    });
    const tabs = [...mapStatsRoot.querySelectorAll('.map-stats-infobox-tab')].map((node) => clean(node.textContent));
    const right = mapStatsRoot.querySelector('.map-stats-infobox-right');
    const groups = [...(right?.children || [])].map((child) =>
      [...child.querySelectorAll(':scope > .map-stats-infobox-maps')]
    ).filter((group) => group.length);
    const metrics = {};
    groups.forEach((group, index) => {
      const label = (tabs[index] || `metric_${index + 1}`).replace(/\s*%$/, '').toLowerCase();
      metrics[label] = group.map((row) => {
        const cells = [...row.children];
        const detail = (cell) => ({
          action: clean(cell?.querySelector('.map-stats-infobox-pick,.map-stats-infobox-ban')?.textContent) || null,
          percentage: clean(cell?.querySelector('.map-stats-infobox-winpercentage')?.textContent) || null,
          sample: clean(cell?.querySelector('.map-stats-infobox-maps-played')?.textContent) || null,
          statsUrl: absolute(cell?.querySelector('a[href]')?.getAttribute('href')),
        });
        return {
          map: clean(cells[1]?.textContent),
          mapCode: row.getAttribute('data-mapname') || null,
          team1: clean(cells[0]?.textContent),
          team2: clean(cells[2]?.textContent),
          team1Details: detail(cells[0]),
          team2Details: detail(cells[2]),
          notPicked: row.classList.contains('not-picked'),
        };
      });
    });
    return { teams: mapTeamNames, teamDetails, tabs, metrics };
  })() : null;

  const recentMatches = [...document.querySelectorAll('#past-matches')]
    .flatMap((anchor) => [...(anchor.parentElement?.querySelectorAll('.past-matches-grid') || [])])
    .map((grid) => ({
      mode: grid.hasAttribute('data-past-matches-core') ? 'core' : 'team',
      teams: [...grid.querySelectorAll('.past-matches-box')].map((box) => ({
        team: text(box, '.past-matches-teamname') || clean(box.querySelector('.past-matches-headline a[href*="/team/"]')?.textContent),
        teamId: idFromHref(box.querySelector('.past-matches-headline a[href*="/team/"]')?.getAttribute('href'), 'team'),
        teamUrl: absolute(box.querySelector('.past-matches-headline a[href*="/team/"]')?.getAttribute('href')),
        teamCountry: box.querySelector('.past-matches-headline img')?.getAttribute('title') || null,
        matches: [...box.querySelectorAll('.past-matches-table tr')].map((row) => ({
          opponent: clean(row.querySelector('.past-matches-team a[href*="/team/"]')?.textContent),
          opponentId: idFromHref(row.querySelector('.past-matches-team a[href*="/team/"]')?.getAttribute('href'), 'team'),
          opponentUrl: absolute(row.querySelector('.past-matches-team a[href*="/team/"]')?.getAttribute('href')),
          opponentCountry: row.querySelector('.past-matches-team img')?.getAttribute('title') || null,
          timeAgo: text(row, '.past-matches-time-ago'),
          format: clean(row.querySelector('a[href*="/matches/"]')?.textContent),
          score: clean(row.querySelector('.past-matches-score a')?.textContent),
          result: row.querySelector('.past-matches-score a')?.classList.contains('won') ? 'won' :
            row.querySelector('.past-matches-score a')?.classList.contains('lost') ? 'lost' : null,
          matchId: idFromHref(row.querySelector('a[href*="/matches/"]')?.getAttribute('href'), 'matches'),
          matchUrl: absolute(row.querySelector('a[href*="/matches/"]')?.getAttribute('href')),
          rowClasses: [...row.classList],
        })),
      })),
    }));

  const h2hRoot = document.querySelector('.head-to-head');
  const h2hValues = [...(h2hRoot?.querySelectorAll('.bold') || [])].map((node) => clean(node.textContent));
  const headToHead = h2hRoot ? (() => {
    const summaryTeam = (selector) => {
      const root = h2hRoot.querySelector(selector);
      const link = root?.querySelector('a[href*="/team/"]');
      const href = link?.getAttribute('href');
      return {
        id: idFromHref(href, 'team'),
        name: clean(link?.textContent),
        url: absolute(href),
        logo: absolute(root?.querySelector('img')?.getAttribute('src')),
      };
    };
    const mapRows = [...document.querySelectorAll('.head-to-head-listing tr.row')].map((row) => {
      const matchLink = row.querySelector('.date a[href*="/matches/"]');
      const matchHref = matchLink?.getAttribute('href');
      const time = row.querySelector('.date [data-unix]');
      const eventLink = row.querySelector('.event a[href*="/events/"]');
      const eventHref = eventLink?.getAttribute('href');
      const result = [...row.querySelectorAll('.result span')];
      const parseTeam = (selector, scoreNode) => {
        const cell = row.querySelector(selector);
        const link = cell?.querySelector('a[href*="/team/"]');
        const href = link?.getAttribute('href');
        return {
          id: idFromHref(href, 'team'),
          name: clean(link?.textContent),
          url: absolute(href),
          country: cell?.querySelector('img.flag')?.getAttribute('title') || null,
          lineup: (cell?.getAttribute('title') || '').split(',').map(clean).filter(Boolean),
          winner: Boolean(cell?.classList.contains('winner')),
          score: Number(clean(scoreNode?.textContent)) || 0,
        };
      };
      return {
        matchId: idFromHref(matchHref, 'matches'),
        matchUrl: absolute(matchHref),
        date: clean(time?.textContent),
        unixMs: Number(time?.getAttribute('data-unix') || 0) || null,
        newMatch: row.classList.contains('new-match-begin'),
        teams: [parseTeam('td.team1', result[0]), parseTeam('td.team2', result[1])],
        event: {
          id: idFromHref(eventHref, 'events'),
          name: clean(eventLink?.textContent),
          url: absolute(eventHref),
        },
        map: clean(row.querySelector('.dynamic-map-name-full')?.textContent),
        mapCode: clean(row.querySelector('.dynamic-map-name-short')?.textContent),
        picked: Boolean(row.querySelector('.map')?.classList.contains('bold')),
      };
    });
    const matches = [];
    for (const row of mapRows) {
      let match = matches.find((item) => item.id === row.matchId);
      if (!match) {
        match = {
          id: row.matchId,
          url: row.matchUrl,
          date: row.date,
          unixMs: row.unixMs,
          teams: row.teams.map(({ score, ...team }) => team),
          event: row.event,
          maps: [],
        };
        matches.push(match);
      }
      match.maps.push({
        name: row.map,
        code: row.mapCode,
        picked: row.picked,
        scores: row.teams.map((team) => ({ teamId: team.id, team: team.name, score: team.score })),
      });
    }
    return JSON.parse(JSON.stringify({
      team1: text(h2hRoot, '.team1 .teamName'),
      team1Wins: h2hValues[0] ?? null,
      overtimes: h2hValues[1] ?? null,
      team2Wins: h2hValues[2] ?? null,
      team2: text(h2hRoot, '.team2 .teamName'),
      teams: [summaryTeam('.team1'), summaryTeam('.team2')],
      mapRows,
      matches,
    }));
  })() : null;

  const scoreboard = document.querySelector('#scoreboardElement .scoreboard');
  const scoreboardData = scoreboard ? {
    mode: text(scoreboard, '.pro-toggle.active'),
    round: text(scoreboard, '.currentRoundText'),
    score: text(scoreboard, '.scoreText'),
    fact: text(scoreboard, '.facts'),
    tables: [...scoreboard.querySelectorAll('table.team')].map((table) => rows(table)),
  } : null;
  const visibleGameLog = [...document.querySelectorAll('#scoreboardElement .gamelog .gamelogBox')]
    .map((node) => clean(node.textContent));

  return {
    title: document.title,
    url: location.href,
    match: {
      id: idFromHref(location.pathname, 'matches'),
      status: text(matchPage, '.countdown'),
      scheduledUnixMs: Number(timeNode?.getAttribute('data-unix') || 0) || null,
      event: {
        id: idFromHref(eventLink?.getAttribute('href'), 'events'),
        name: clean(eventLink?.textContent),
        url: absolute(eventLink?.getAttribute('href')),
      },
    },
    teams,
    maps: { format, stage, veto, maps },
    streams,
    lineups,
    mapStats,
    recentMatches,
    headToHead,
    scoreboard: scoreboardData,
    visibleGameLog,
    sections: {
      matchPage: Boolean(matchPage),
      maps: Boolean(mapSection),
      streams: streams.length > 0,
      lineups: Boolean(document.querySelector('#lineups')),
      mapStats: Boolean(mapStatsRoot),
      recentMatches: Boolean(document.querySelector('#past-matches')),
      headToHead: Boolean(h2hRoot),
      scoreboard: Boolean(scoreboard),
      gameLog: Boolean(document.querySelector('#scoreboardElement .gamelog')),
      cloudflareChallenge: document.title.includes('Just a moment') || Boolean(document.querySelector('[id^="cf-chl"]')),
    },
  };
}
