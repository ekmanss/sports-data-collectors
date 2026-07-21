import type { CommunityCard, CommunityData, CommunityTab } from '../domain/model.js';
import {
  asArray,
  asRecord,
  asString,
  nullableNumber,
  nullableString,
} from '../internal/value.js';
import { arrayOrEmpty, providerData } from './shared.js';

export function parseCommunityTabs(payload: unknown): readonly CommunityTab[] {
  return asArray(providerData(payload, 'community tabs'), 'community tabs.data').map(
    (entry, index) => {
      const tab = asRecord(entry, `community tab[${index}]`);
      return {
        id: asString(tab.id, `community tab[${index}].id`),
        logoUrl: nullableString(tab.logo),
        name: asString(tab.name, `community tab[${index}].name`),
        tab: asString(tab.tab, `community tab[${index}].tab`),
      };
    },
  );
}

export function parseCommunityCards(payload: unknown, tabName: string): readonly CommunityCard[] {
  return asArray(providerData(payload, 'community cards'), 'community cards.data').map(
    (entry, index) => {
      const card = asRecord(entry, `community card[${index}]`);
      const score =
        card.score === null || card.score === undefined
          ? {}
          : asRecord(card.score, `community card[${index}].score`);
      return {
        averageScore: nullableNumber(score.avg_score),
        content: arrayOrEmpty(card.content, `community card[${index}].content`).map(String),
        countryLogoUrl: nullableString(card.country_logo),
        detail: nullableString(card.detail),
        id: asString(card.id, `community card[${index}].id`),
        logoUrl: nullableString(card.logo),
        name: asString(card.name, `community card[${index}].name`),
        positions: arrayOrEmpty(card.positions, `community card[${index}].positions`).map(String),
        scoreText: nullableString(score.score_text),
        tab: nullableString(card.tab) ?? tabName,
        teamLogoUrl: nullableString(card.team_logo),
        userCount: nullableNumber(score.user_cnt),
      };
    },
  );
}

export const EMPTY_COMMUNITY: CommunityData = { cards: [], tabs: [] };
