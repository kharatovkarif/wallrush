// Supabase clients. Everything degrades gracefully when env vars are absent:
// the game then runs in guest-only mode (no accounts, empty leaderboard).
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || '';
const serviceKey = process.env.SUPABASE_SERVICE_KEY || '';

export const dbEnabled = Boolean(url && serviceKey);

export const supa = dbEnabled
  ? createClient(url, serviceKey, { auth: { persistSession: false } })
  : null;

// Verify a Supabase Auth JWT; returns { id } or null.
export async function verifyUser(jwt) {
  if (!dbEnabled || !jwt) return null;
  try {
    const { data, error } = await supa.auth.getUser(jwt);
    if (error || !data?.user) return null;
    return { id: data.user.id };
  } catch {
    return null;
  }
}

export async function getProfile(userId) {
  if (!dbEnabled) return null;
  const { data } = await supa.from('profiles').select('id, nick, wins, losses').eq('id', userId).maybeSingle();
  return data || null;
}

export async function createProfile(userId, nick) {
  const { error } = await supa.from('profiles').insert({ id: userId, nick });
  if (error) {
    if (error.code === '23505') return { error: 'nick_taken' };
    return { error: 'generic' };
  }
  return { ok: true };
}

export async function recordResult(winnerUserId, loserUserId) {
  if (!dbEnabled) return;
  try {
    if (winnerUserId) await supa.rpc('add_result', { uid: winnerUserId, is_win: true });
    if (loserUserId) await supa.rpc('add_result', { uid: loserUserId, is_win: false });
  } catch (e) {
    console.error('recordResult failed:', e.message);
  }
}

export async function leaderboard(limit = 50) {
  if (!dbEnabled) return [];
  const { data } = await supa
    .from('profiles')
    .select('nick, wins, losses')
    .order('wins', { ascending: false })
    .order('losses', { ascending: true })
    .limit(limit);
  return data || [];
}
