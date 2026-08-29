// The task of the day. Shared by the server, which counts progress, and the
// client, which draws the card — so the two can never disagree about what
// today's task even is.
//
// One task, the same for everyone, decided by the date alone. Nothing is
// stored to choose it: any machine that knows the date knows the task.
//
// Every task is finishable in a single sitting of a few matches, and none of
// them asks a player to win more than they normally would — a task nobody
// finishes is worse than no task at all, because it teaches people to ignore
// the card.
export const DAILY_TASKS = [
  { id: 'play4', target: 4, reward: 25 },        // just turn up and play
  { id: 'win2', target: 2, reward: 30 },
  { id: 'walls12', target: 12, reward: 30 },     // wall placement, not wins
  { id: 'win_human', target: 2, reward: 35 },    // against people, not bots
  { id: 'win_thrifty', target: 1, reward: 40 },  // win using at most 3 walls
  { id: 'win3', target: 3, reward: 40 },
  { id: 'win_strong', target: 1, reward: 45 },   // beat someone rated above you
];

// day is 'YYYY-MM-DD' — the player's own local day, the same one the streak
// counts by, so the task turns over at the player's midnight and not at ours.
export function taskForDay(day) {
  const n = Number(String(day || '').replace(/-/g, '')) || 0;
  return DAILY_TASKS[n % DAILY_TASKS.length];
}

/* How much a finished match adds. ctx:
     won        — did this player win
     walls      — walls this player placed in the match
     myPoints   — their rating before the match
     oppPoints  — the opponent's rating
     oppIsBot   — was the opponent one of ours                              */
export function matchProgress(task, ctx) {
  switch (task.id) {
    case 'play4': return 1;
    case 'win2':
    case 'win3': return ctx.won ? 1 : 0;
    case 'walls12': return ctx.walls || 0;
    case 'win_human': return ctx.won && !ctx.oppIsBot ? 1 : 0;
    case 'win_thrifty': return ctx.won && (ctx.walls || 0) <= 3 ? 1 : 0;
    case 'win_strong': return ctx.won && (ctx.oppPoints || 0) > (ctx.myPoints || 0) ? 1 : 0;
    default: return 0;
  }
}
