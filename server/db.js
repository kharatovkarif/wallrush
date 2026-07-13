// Supabase clients. Everything degrades gracefully when env vars are absent:
// the game then runs in guest-only mode (no accounts, empty leaderboard).
import { createClient } from '@supabase/supabase-js';
import { WebSocket as WsImpl } from 'ws'; // realtime transport for Node < 22 (no native WebSocket)

// Values pasted from a phone often carry invisible junk (line breaks inside
// the key, surrounding quotes, zero-width chars) — scrub it all out.
export const cleanEnv = (v) => (v || '')
  .replace(/[\s\u200B-\u200D\uFEFF]+/g, '')
  .replace(/^["']+|["']+$/g, '');

const url = cleanEnv(process.env.SUPABASE_URL);
const serviceKey = cleanEnv(process.env.SUPABASE_SERVICE_KEY);

// Never crash the game because of bad credentials: fall back to guest mode.
// dbStatus tells the frontend WHY accounts are off, so it's debuggable from a phone.
let client = null;
let status = 'ok';
let detail = '';
if (!url && !serviceKey) status = 'no_env';
else if (!url) status = 'no_url';
else if (!serviceKey) status = 'no_service_key';
else if (!/^https:\/\/.+\.supabase\.co\/?$/i.test(url)) status = 'bad_url';
else if (!serviceKey.startsWith('eyJ') && !serviceKey.startsWith('sb_secret_')) status = 'bad_service_key';
else {
  try {
    client = createClient(url, serviceKey, {
      auth: { persistSession: false },
      realtime: { transport: WsImpl },
    });
  } catch (e) {
    console.error('Supabase init failed:', e.message);
    status = 'init_failed';
    detail = String(e.message || '').slice(0, 90);
  }
}
if (status !== 'ok') console.error(`Supabase disabled (${status}) — running in guest mode.`);

export const dbEnabled = Boolean(client);
export const dbStatus = status;
export const dbDetail = detail;
export const supa = client;

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
  const [{ data: people }, { data: bots }] = await Promise.all([
    supa.from('profiles').select('nick, wins, losses').limit(200),
    supa.from('bot_players').select('nick, wins, losses').limit(200),
  ]);
  const all = [...(people || []), ...(bots || [])];
  all.sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses));
  return all.slice(0, limit);
}

// ---- bot players (kept in their own table so real stats stay clean) ----

// One-time seed: insert missing bots with a believable starting record.
export async function seedBots(nicks) {
  if (!dbEnabled) return;
  try {
    const rows = nicks.map((nick) => {
      const games = 5 + Math.floor(Math.random() * 60);
      const wins = Math.floor(games * (0.25 + Math.random() * 0.5));
      return { nick, wins, losses: games - wins };
    });
    await supa.from('bot_players').upsert(rows, { onConflict: 'nick', ignoreDuplicates: true });
  } catch (e) {
    console.error('seedBots failed:', e.message);
  }
}

export async function recordBotResult(nick, won) {
  if (!dbEnabled) return;
  try {
    const { data } = await supa.from('bot_players').select('wins, losses').eq('nick', nick).maybeSingle();
    if (!data) return;
    await supa.from('bot_players').update(
      won ? { wins: data.wins + 1 } : { losses: data.losses + 1 }
    ).eq('nick', nick);
  } catch (e) {
    console.error('recordBotResult failed:', e.message);
  }
}

// Slow background growth so the leaderboard looks alive day to day:
// every call, a small random slice of bots "finishes a game".
export async function growBots(botWinChance) {
  if (!dbEnabled) return;
  try {
    const { data: bots } = await supa.from('bot_players').select('nick, wins, losses');
    if (!bots) return;
    for (const b of bots) {
      if (Math.random() > 0.12) continue; // ~12% of bots per tick
      const p = botWinChance.get(b.nick) ?? 0.5;
      const won = Math.random() < p;
      await supa.from('bot_players').update(
        won ? { wins: b.wins + 1 } : { losses: b.losses + 1 }
      ).eq('nick', b.nick);
    }
  } catch (e) {
    console.error('growBots failed:', e.message);
  }
}
