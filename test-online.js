// Test der Online-Funktionen. Start: node test-online.js
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const src = fs.readFileSync(path.join(__dirname, 'docs', 'app.js'), 'utf8');
const URL_ = src.match(/SUPABASE_URL\s*=\s*'([^']+)'/)[1];
const KEY = src.match(/SUPABASE_KEY\s*=\s*'([^']+)'/)[1];
const PASSWORD = 'testpass123';

let failed = 0;
const ok = (name, cond, extra) => {
  if (!cond) failed++;
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${!cond && extra ? ' -> ' + extra : ''}`);
};
const fails = async (name, p, text) => {
  const r = await p;
  const msg = r.error ? r.error.message : '';
  ok(name, !!r.error && (!text || msg.includes(text)), r.error ? msg : 'kein Fehler');
};
const succeeds = async (name, p) => {
  const r = await p;
  ok(name, !r.error, r.error && r.error.message);
  return r.data;
};
const newClient = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function login(name) {
  const sb = newClient();
  const email = `schach.${name}@gmail.com`;
  let r = await sb.auth.signInWithPassword({ email, password: PASSWORD });
  if (r.error) {
    const s = await sb.auth.signUp({ email, password: PASSWORD, options: { data: { name } } });
    if (s.error) throw new Error(`Registrierung ${name}: ${s.error.message}`);
    r = await sb.auth.signInWithPassword({ email, password: PASSWORD });
    if (r.error) throw new Error(`Anmeldung ${name}: ${r.error.message}`);
  }
  return { sb, id: r.data.user.id, name };
}

const startData = () => ({ mode: 'online', state: { turn: 'w' }, keys: ['k0'], moves: [], last: null, snaps: [], over: null });
const myGames = async (u) => (await u.sb.from('online_games').select('*')).data || [];
const one = async (u, table, id) => ((await u.sb.from(table).select('*').eq('id', id)).data || [])[0];
const submit = (u, id, data, turn, status = 'active', result = null, reason = null) =>
  u.sb.rpc('submit_state', { p_id: id, p_data: data, p_turn: turn, p_status: status, p_result: result, p_reason: reason });

async function cleanup(users) {
  for (const u of users) {
    const inv = (await u.sb.from('invites').select('*')).data || [];
    for (const i of inv) {
      await u.sb.rpc(i.from_id === u.id ? 'cancel_invite' : 'decline_invite', { p_id: i.id });
    }
  }
  for (const u of users) {
    for (const g of await myGames(u)) {
      if (g.status === 'active') await u.sb.rpc('resign', { p_id: g.id });
    }
  }
  for (const u of users) {
    for (const g of await myGames(u)) await u.sb.rpc('ack_game', { p_id: g.id });
  }
}

async function main() {
  const a = await login('zz_a');
  const b = await login('zz_b');
  const c = await login('zz_c');
  const users = [a, b, c];
  await cleanup(users);

  const anon = newClient();
  await fails('anonym: list_players verboten', anon.rpc('list_players'));
  await fails('anonym: send_invite verboten', anon.rpc('send_invite', { p_to: b.id }));
  const anonInv = await anon.from('invites').select('*');
  ok('anonym: invites nicht lesbar', !!anonInv.error || (anonInv.data || []).length === 0);

  const pl = await succeeds('list_players', a.sb.rpc('list_players'));
  const names = (pl || []).map((p) => p.name.toLowerCase());
  ok('list_players enthält zz_b, nicht zz_a', names.includes('zz_b') && !names.includes('zz_a'));
  ok('list_players sortiert', JSON.stringify(names) === JSON.stringify(names.slice().sort()));

  ok('Direkt-INSERT invites verboten', !!(await a.sb.from('invites').insert({ from_id: a.id, to_id: b.id, from_name: 'zz_a', to_name: 'zz_b' })).error);
  ok('Direkter Zugriff timeouts verboten', !!(await a.sb.from('timeouts').select('*')).error);
  ok('Direkt-INSERT timeouts verboten', !!(await a.sb.from('timeouts').insert({ user_id: a.id, until: new Date().toISOString() })).error);
  ok('Direkt-INSERT online_games verboten', !!(await a.sb.from('online_games').insert({
    white_id: a.id, black_id: b.id, white_name: 'x', black_name: 'y', data: {},
  })).error);

  await fails('send_invite an sich selbst', a.sb.rpc('send_invite', { p_to: a.id }), 'selbst');
  await fails('send_invite an Unbekannten', a.sb.rpc('send_invite', { p_to: '00000000-0000-0000-0000-000000000000' }), 'nicht gefunden');
  const inv1 = await succeeds('send_invite a->b', a.sb.rpc('send_invite', { p_to: b.id }));
  await fails('send_invite doppelt', a.sb.rpc('send_invite', { p_to: b.id }), 'offene Einladung');
  await fails('send_invite Gegenrichtung', b.sb.rpc('send_invite', { p_to: a.id }), 'offene Einladung');
  const rowA = await one(a, 'invites', inv1);
  ok('Einladung sichtbar für Absender mit Namen', !!rowA && rowA.from_name === 'zz_a' && rowA.to_name === 'zz_b');
  ok('Einladung sichtbar für Empfänger', !!(await one(b, 'invites', inv1)));
  ok('Einladung unsichtbar für Dritte', !(await one(c, 'invites', inv1)));
  await fails('cancel durch Empfänger verboten', b.sb.rpc('cancel_invite', { p_id: inv1 }));
  await fails('decline durch Absender verboten', a.sb.rpc('decline_invite', { p_id: inv1 }));
  await fails('accept durch Absender verboten', a.sb.rpc('accept_invite', { p_id: inv1, p_data: startData() }));
  await fails('accept durch Dritte verboten', c.sb.rpc('accept_invite', { p_id: inv1, p_data: startData() }));
  await succeeds('cancel durch Absender', a.sb.rpc('cancel_invite', { p_id: inv1 }));
  ok('Einladung nach cancel weg', !(await one(b, 'invites', inv1)));
  const inv2 = await succeeds('send_invite erneut', a.sb.rpc('send_invite', { p_to: b.id }));
  await succeeds('decline durch Empfänger', b.sb.rpc('decline_invite', { p_id: inv2 }));
  ok('Einladung nach decline weg', !(await one(a, 'invites', inv2)));

  const inv3 = await succeeds('send_invite für accept', a.sb.rpc('send_invite', { p_to: b.id }));
  await fails('accept mit ungültigen Daten', b.sb.rpc('accept_invite', { p_id: inv3, p_data: null }));
  const gid = await succeeds('accept_invite', b.sb.rpc('accept_invite', { p_id: inv3, p_data: startData() }));
  ok('Einladung nach accept gelöscht', !(await one(a, 'invites', inv3)));
  const gA = await one(a, 'online_games', gid);
  const gB = await one(b, 'online_games', gid);
  ok('Partie sichtbar für beide', !!gA && !!gB);
  ok('Partie unsichtbar für Dritte', !(await one(c, 'online_games', gid)));
  ok('Farben vergeben', !!gA && [gA.white_id, gA.black_id].sort().join() === [a.id, b.id].sort().join());
  ok('Startwerte', !!gA && gA.turn === 'w' && gA.status === 'active' && gA.data.mode === 'online');
  ok('Namen passen', !!gA && gA.white_name === (gA.white_id === a.id ? 'zz_a' : 'zz_b'));

  const white = gA.white_id === a.id ? a : b;
  const black = white === a ? b : a;

  const d1 = { ...startData(), moves: ['e4'] };
  await fails('submit: Schwarz bei Weiß am Zug verboten', submit(black, gid, d1, 'b'));
  await fails('submit: Fremder verboten', submit(c, gid, d1, 'b'));
  await fails('submit: ungültiger Status', submit(white, gid, d1, 'b', 'foo'));
  await fails('submit: ungültiger Zug-Wert', submit(white, gid, d1, 'x'));
  await succeeds('submit: Weiß am Zug ok', submit(white, gid, d1, 'b'));
  const g2 = await one(black, 'online_games', gid);
  ok('Stellung gespeichert, Zug wechselt', !!g2 && g2.turn === 'b' && g2.data.moves[0] === 'e4');
  await fails('submit: Weiß nicht mehr am Zug', submit(white, gid, d1, 'w'));
  await succeeds('submit: Schwarz ok', submit(black, gid, { ...d1, moves: ['e4', 'e5'] }, 'w'));

  const upd = await white.sb.from('online_games').update({ turn: 'b' }).eq('id', gid);
  const del = await white.sb.from('online_games').delete().eq('id', gid);
  const g3 = await one(white, 'online_games', gid);
  ok('Direkt-UPDATE/DELETE verboten', !!upd.error && !!del.error && !!g3 && g3.turn === 'w');

  await fails('offer_draw durch Fremden verboten', c.sb.rpc('offer_draw', { p_id: gid }));
  await fails('answer_draw ohne Angebot', black.sb.rpc('answer_draw', { p_id: gid, p_accept: true }));
  await succeeds('offer_draw', white.sb.rpc('offer_draw', { p_id: gid }));
  const g4 = await one(black, 'online_games', gid);
  ok('draw_offer_by gesetzt', !!g4 && g4.draw_offer_by === white.id);
  await fails('answer_draw durch Anbieter verboten', white.sb.rpc('answer_draw', { p_id: gid, p_accept: true }));
  await fails('answer_draw durch Fremden verboten', c.sb.rpc('answer_draw', { p_id: gid, p_accept: true }));
  await succeeds('answer_draw ablehnen', black.sb.rpc('answer_draw', { p_id: gid, p_accept: false }));
  const g5 = await one(black, 'online_games', gid);
  ok('Angebot nach Ablehnen weg', !!g5 && g5.draw_offer_by === null && g5.status === 'active');
  await succeeds('offer_draw erneut', black.sb.rpc('offer_draw', { p_id: gid }));
  await succeeds('answer_draw annehmen', white.sb.rpc('answer_draw', { p_id: gid, p_accept: true }));
  const g6 = await one(white, 'online_games', gid);
  ok('Remis beendet Partie', !!g6 && g6.status === 'finished' && g6.result === 'draw' && g6.reason === 'Remis vereinbart');
  await fails('submit nach Ende verboten', submit(white, gid, d1, 'b'));
  await fails('claim_win nach Ende verboten', white.sb.rpc('claim_win', { p_id: gid }));

  await fails('ack durch Fremden verboten', c.sb.rpc('ack_game', { p_id: gid }));
  await succeeds('ack durch a', a.sb.rpc('ack_game', { p_id: gid }));
  ok('Partie nach einem ack noch da', !!(await one(b, 'online_games', gid)));
  await succeeds('ack durch b', b.sb.rpc('ack_game', { p_id: gid }));
  ok('Partie nach beiden ack gelöscht', !(await one(a, 'online_games', gid)) && !(await one(b, 'online_games', gid)));

  // Zweite Partie: claim_win zu früh, Aufgeben
  const inv4 = await succeeds('send_invite b->a', b.sb.rpc('send_invite', { p_to: a.id }));
  const gid2 = await succeeds('accept durch a', a.sb.rpc('accept_invite', { p_id: inv4, p_data: startData() }));
  const g7 = await one(a, 'online_games', gid2);
  const w2 = g7.white_id === a.id ? a : b;
  const b2 = w2 === a ? b : a;
  await fails('ack bei laufender Partie verboten', a.sb.rpc('ack_game', { p_id: gid2 }), 'läuft noch');
  await fails('claim_win durch Spieler am Zug', w2.sb.rpc('claim_win', { p_id: gid2 }));
  await fails('claim_win zu früh', b2.sb.rpc('claim_win', { p_id: gid2 }), 'zu früh');
  await fails('claim_win durch Fremden', c.sb.rpc('claim_win', { p_id: gid2 }));
  const ta = await succeeds('my_timeout a', a.sb.rpc('my_timeout'));
  const tb = await succeeds('my_timeout b', b.sb.rpc('my_timeout'));
  ok('keine Sperre', ta === null && tb === null);
  await fails('resign durch Fremden verboten', c.sb.rpc('resign', { p_id: gid2 }));
  await succeeds('resign durch Weiß', w2.sb.rpc('resign', { p_id: gid2 }));
  const g8 = await one(b2, 'online_games', gid2);
  ok('Aufgabe: Schwarz gewinnt', !!g8 && g8.status === 'finished' && g8.result === 'b' && g8.reason === 'Aufgegeben');
  await succeeds('ack a', a.sb.rpc('ack_game', { p_id: gid2 }));
  await succeeds('ack b', b.sb.rpc('ack_game', { p_id: gid2 }));
  ok('Partie 2 gelöscht', !(await one(a, 'online_games', gid2)));

  await cleanup(users);
  ok('Aufgeräumt', (await myGames(a)).length === 0 && (await myGames(b)).length === 0
    && ((await a.sb.from('invites').select('*')).data || []).length === 0);
}

main()
  .catch((e) => { failed++; console.log('FAIL Abbruch ->', e.message); })
  .finally(() => {
    console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
    process.exit(failed ? 1 : 0);
  });
