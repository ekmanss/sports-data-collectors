// Page-context code is intentionally self-contained and serialized with toString().
// @ts-nocheck
export function extractHltvLivePage() {
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const integer = (value) => {
    const normalized = clean(value);
    return /^\d+$/.test(normalized) ? Number(normalized) : null;
  };
  const positiveId = (value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  };
  const absolute = (value) => value ? new URL(value, location.origin).href : null;
  const preferredLogo = (root) => {
    const image = root?.querySelector('img.match-team-logo:not(.night-only), img.match-event-logo:not(.night-only)')
      || root?.querySelector('img.match-team-logo, img.match-event-logo');
    return absolute(image?.getAttribute('src'));
  };

  const liveRoot = document.querySelector('.liveMatches');
  const headings = [...document.querySelectorAll('h1,h2')].map((node) => clean(node.textContent));
  const recognized = Boolean(liveRoot) || headings.some((value) =>
    value === 'Live Counter-Strike matches' || value === 'Upcoming Counter-Strike matches');
  const wrappers = [...document.querySelectorAll('.liveMatches .live-match-container')];
  const cards = wrappers.map((card) => {
    const id = positiveId(card.getAttribute('data-match-id'));
    const matchLink = card.querySelector('a[href^="/matches/"]');
    const url = absolute(matchLink?.getAttribute('href'));
    const formatText = [...card.querySelectorAll('.match-meta')]
      .map((node) => clean(node.textContent).toLowerCase())
      .find((value) => /^bo\d+$/.test(value));
    const eventRoot = card.querySelector('.match-event');
    const eventId = positiveId(card.getAttribute('data-event-id') || eventRoot?.getAttribute('data-event-id'));
    const eventName = clean(eventRoot?.getAttribute('data-event-headline') || eventRoot?.textContent) || null;
    const teamIds = [positiveId(card.getAttribute('team1')), positiveId(card.getAttribute('team2'))];
    const teamNodes = [...card.querySelectorAll('.match-teams .match-team')].slice(0, 2);
    const teams = teamNodes.map((team, index) => {
      const teamId = teamIds[index] ?? null;
      const currentScore = teamId === null
        ? [...card.querySelectorAll('[data-livescore-current-map-score]')][index]
        : card.querySelector(`[data-livescore-current-map-score][data-livescore-team="${teamId}"]`);
      const mapsWon = teamId === null
        ? [...card.querySelectorAll('[data-livescore-maps-won-for]')][index]
        : card.querySelector(`[data-livescore-maps-won-for][data-livescore-team="${teamId}"]`);
      return {
        id: teamId,
        name: clean(team.querySelector('.match-teamname')?.textContent),
        logoUrl: preferredLogo(team),
        currentMap: integer(currentScore?.textContent),
        mapsWon: integer(mapsWon?.textContent),
      };
    });
    const lanValue = card.getAttribute('lan');
    return {
      id,
      url,
      bestOf: formatText ? Number(formatText.slice(2)) : null,
      region: clean(card.getAttribute('data-region')) || null,
      isLan: lanValue === 'true' ? true : lanValue === 'false' ? false : null,
      event: {
        id: eventId,
        name: eventName,
        type: clean(card.getAttribute('data-eventtype')) || null,
        logoUrl: preferredLogo(eventRoot),
      },
      teams,
    };
  });

  return {
    title: document.title,
    url: location.href,
    recognized,
    challenge: document.title.includes('Just a moment') || Boolean(document.querySelector('[id^="cf-chl"]')),
    cardsSeen: wrappers.length,
    cards,
  };
}
