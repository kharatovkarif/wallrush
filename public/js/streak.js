// Daily streak. Shared by the server, which counts the days, and the client,
// which draws the flame — so neither can disagree about which tier you are on.
//
// The flame itself changes rather than turning into a different object: same
// 🔥, recoloured and grown by CSS. A blue flame at 30 days reads as a level up;
// swapping to a diamond would read as a different thing entirely.
export const FLAMES = [
  { min: 1, cls: 'fl-1' },     // small, pale orange
  { min: 7, cls: 'fl-7' },     // full orange — one week
  { min: 30, cls: 'fl-30' },   // blue
  { min: 50, cls: 'fl-50' },   // violet
  { min: 100, cls: 'fl-100' }, // white hot
  { min: 200, cls: 'fl-200' }, // gold
  { min: 365, cls: 'fl-365' }, // rainbow — a full year
];

// Days that earn a celebration of their own.
export const MILESTONES = [7, 30, 50, 100, 200, 365];

export function flameClass(days) {
  let cls = FLAMES[0].cls;
  for (const f of FLAMES) if (days >= f.min) cls = f.cls;
  return cls;
}

export function isMilestone(days) { return MILESTONES.includes(days); }

// A streak stays alive through yesterday, and through the day before that
// while this month's one free save is still unused.
export function streakAlive(lastDay, today, freezeMonth) {
  if (!lastDay) return false;
  const gap = Math.round((Date.parse(today) - Date.parse(lastDay)) / 86400000);
  if (gap <= 1) return true;
  return gap === 2 && freezeMonth !== today.slice(0, 7);
}

// The player's own calendar day, from the offset their browser reports.
// Using their local midnight is the whole point: a streak that rolls over at
// Moscow midnight makes no sense to someone in Tehran or São Paulo.
export function localDay(tzOffsetMinutes) {
  const off = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0;
  return new Date(Date.now() - off * 60000).toISOString().slice(0, 10);
}
