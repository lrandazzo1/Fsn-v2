/** Status and scoring rules shared by the matchup and team views. */
const INACTIVE = [
  { pattern: /(?:^|\b)(?:EXEMPT|COMMISSIONER(?:'S)? EXEMPT)(?:\b|$)/, badge: 'EX' },
  { pattern: /\bSUS(?:PENDED|PENSION)?\b/, badge: 'SUS' },
  { pattern: /\b(?:OUT|INACTIVE)\b/, badge: 'OUT' },
  { pattern: /\b(?:IR|INJURED RESERVE|RESERVE\/INJURED)\b/, badge: 'IR' }
];

/** Return a short label only for statuses that rule a player out. */
export function inactiveStatus(player) {
  const values = [
    player?.injuryStatus, player?.injury_status, player?.status,
    player?.newsStatus, player?.news_status,
    player?.injury?.designation, player?.injury?.injury_status,
    player?.injury?.news_status, player?.injury?.status
  ].filter((value) => typeof value === 'string');
  for (const { pattern, badge } of INACTIVE) {
    if (values.some((value) => pattern.test(value.toUpperCase().replace(/[_-]/g, ' ')))) return badge;
  }
  return null;
}

export function inactiveBadge(player) {
  const status = inactiveStatus(player);
  return status ? `<em class="inactive-badge" title="Inactive: ${status}">${status}</em>` : '';
}
