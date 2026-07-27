// WallRush ladder. Shared by the server, which awards the points, and by the
// client, which draws the badge — so the two can never disagree about a rank.
//
// The thresholds are set against real play: the average player finishes about
// 13 games, ~400 people have passed 100 games, 4 have passed 500 and exactly
// one has passed 3000. That one player is the only GOAT in the world, and the
// top of the ladder stays worth chasing.
export const RANKS = [
  { key: 'rank_rookie', icon: '🟢', min: 0 },
  { key: 'rank_student', icon: '🔵', min: 100 },
  { key: 'rank_strategist', icon: '🟣', min: 500 },
  { key: 'rank_master', icon: '🟠', min: 1500 },
  { key: 'rank_pro', icon: '🔴', min: 4000 },
  { key: 'rank_legend', icon: '💎', min: 10000 },
  { key: 'rank_goat', icon: '🐐', min: 20000 },
];

export function rankIndex(points) {
  const p = Math.max(0, points | 0);
  let i = 0;
  for (let k = 0; k < RANKS.length; k++) if (p >= RANKS[k].min) i = k;
  return i;
}

export function rankOf(points) { return RANKS[rankIndex(points)]; }

export function nextRank(points) { return RANKS[rankIndex(points) + 1] || null; }

// Beating someone ranked above you pays more; losing to someone below costs
// more. Wins outweigh losses on purpose — a casual player who wins half their
// games still needs to climb, or they stop playing.
export function pointsDelta(myPoints, oppPoints, won) {
  const me = rankIndex(myPoints);
  const opp = rankIndex(oppPoints);
  if (won) return opp > me ? 40 : 25;
  return opp < me ? -20 : -10;
}
