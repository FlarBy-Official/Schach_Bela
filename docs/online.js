window.Online = (function () {
  const $ = (id) => document.getElementById(id);
  const app = () => window.SchachApp;
  let channel = null;
  let timer = null;
  let lockUntil = null;
  let loadSeq = 0;
  let reloadTimer = null;
  let busy = false;

  function showError(msg) { $('online-error').textContent = msg || ''; }
  function errText(e) { return (e && e.message) || 'Das hat nicht geklappt. Bitte versuche es nochmal.'; }

  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }

  function fill(listId, emptyId, items) {
    const ul = $(listId);
    ul.replaceChildren(...items);
    $(emptyId).classList.toggle('hidden', items.length > 0);
  }

  // Sperre nur anzeigen, solange sie in der Zukunft liegt
  function updateLock() {
    const box = $('online-lock');
    if (lockUntil && lockUntil.getTime() > Date.now()) {
      const hm = lockUntil.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      box.textContent = 'Du kannst bis ' + hm + ' keine Einladungen annehmen.';
      box.classList.remove('hidden');
    } else {
      lockUntil = null;
      box.classList.add('hidden');
    }
  }

  async function run(fn) {
    if (busy) return;
    busy = true;
    showError('');
    try { await fn(); } catch (e) { showError(errText(e)); }
    busy = false;
  }

  function playerItem(p) {
    const li = el('li');
    const b = el('button', '✉ ' + p.name, 'wide');
    b.type = 'button';
    b.addEventListener('click', () => run(async () => {
      const { error } = await app().sb.rpc('send_invite', { p_to: p.id });
      if (error) throw error;
      await loadAll();
    }));
    li.append(b);
    return li;
  }

  function incomingItem(inv) {
    const li = el('li');
    const name = el('span', inv.from_name + ' lädt dich ein', 'name');
    const yes = el('button', 'Annehmen', 'primary');
    const no = el('button', 'Ablehnen');
    yes.type = no.type = 'button';
    yes.addEventListener('click', () => run(() => accept(inv)));
    no.addEventListener('click', () => run(async () => {
      const { error } = await app().sb.rpc('decline_invite', { p_id: inv.id });
      if (error) throw error;
      await loadAll();
    }));
    li.append(name, yes, no);
    return li;
  }

  function outgoingItem(inv) {
    const li = el('li');
    const name = el('span', 'Wartet auf ' + inv.to_name, 'name');
    const b = el('button', 'Zurückziehen');
    b.type = 'button';
    b.addEventListener('click', () => run(async () => {
      const { error } = await app().sb.rpc('cancel_invite', { p_id: inv.id });
      if (error) throw error;
      await loadAll();
    }));
    li.append(name, b);
    return li;
  }

  function gameItem(row, me) {
    const myColor = row.white_id === me ? 'w' : 'b';
    const opp = myColor === 'w' ? row.black_name : row.white_name;
    const li = el('li');
    const b = el('button', null, 'wide');
    b.type = 'button';
    b.append(el('span', 'Partie gegen ' + opp));
    let info;
    if (row.status === 'finished') info = 'Beendet – tippe zum Ansehen';
    else info = row.turn === myColor ? 'Du bist dran' : opp + ' ist dran';
    b.append(el('small', info));
    b.addEventListener('click', () => {
      close();
      app().openOnlineGame(row);
    });
    li.append(b);
    return li;
  }

  async function accept(inv) {
    const R = window.Rules;
    const state = R.newGame();
    const data = { mode: 'online', state, keys: [R.key(state)], moves: [], last: null, snaps: [], over: null };
    const sb = app().sb;
    const r = await sb.rpc('accept_invite', { p_id: inv.id, p_data: data });
    if (r.error) throw r.error;
    const g = await sb.from('online_games').select('*').eq('id', r.data).single();
    if (g.error) throw g.error;
    close();
    app().openOnlineGame(g.data);
  }

  async function loadAll() {
    const seq = ++loadSeq;
    const sb = app().sb;
    const me = app().getUser().id;
    const [pl, inv, gm, to] = await Promise.all([
      sb.rpc('list_players'),
      sb.from('invites').select('*').order('created_at', { ascending: true }),
      sb.from('online_games').select('*').order('updated_at', { ascending: false }),
      sb.rpc('my_timeout')
    ]);
    if (seq !== loadSeq) return;
    const err = pl.error || inv.error || gm.error;
    if (err) { showError(errText(err)); return; }

    const invites = inv.data || [];
    fill('online-players', 'online-players-empty', (pl.data || []).map(playerItem));
    fill('online-incoming', 'online-incoming-empty', invites.filter((i) => i.to_id === me).map(incomingItem));
    fill('online-outgoing', 'online-outgoing-empty', invites.filter((i) => i.from_id === me).map(outgoingItem));
    fill('online-games', 'online-games-empty', (gm.data || []).map((r) => gameItem(r, me)));

    lockUntil = !to.error && to.data ? new Date(to.data) : null;
    updateLock();
  }

  // Mehrere Änderungen kurz hintereinander nur einmal nachladen
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadAll().catch((e) => showError(errText(e))), 150);
  }

  function open() {
    close();
    const a = app();
    a.showScreen('screen-online');
    showError('');
    loadAll().catch((e) => showError(errText(e)));
    channel = a.sb.channel('online-lobby-' + a.getUser().id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invites' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'online_games' }, scheduleReload)
      .subscribe();
    timer = setInterval(updateLock, 1000);
  }

  function close() {
    clearInterval(timer);
    clearTimeout(reloadTimer);
    timer = reloadTimer = null;
    loadSeq++;
    if (channel) {
      const c = channel;
      channel = null;
      try { app().sb.removeChannel(c); } catch (e) { /* Verbindung schon weg */ }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('online-back').addEventListener('click', () => {
      close();
      app().showScreen('screen-menu');
    });
  });

  return { open, close };
})();
