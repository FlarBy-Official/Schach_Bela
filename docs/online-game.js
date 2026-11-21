// Live-Teil einer Online-Partie: Realtime, Presence, Aufgeben/Remis, Sende-Warteschlange.
(function () {
  'use strict';

  const AWAY_MS = 3 * 60 * 1000;
  const MAX_BACKOFF = 30000;

  let cur = null;
  let ctl = null;
  let origTitle = null;

  // Warteschlange bleibt auch nach leave() aktiv, damit kein Zug verloren geht
  const q = { pending: null, inflight: false, timer: null, attempt: 0 };
  let sentSigs = [];

  function app() { return window.SchachApp; }
  function sb() { return app().sb; }

  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  function sigOf(data, turn, status, result, reason) {
    return canon(data) + '|' + turn + '|' + status + '|' + (result || '') + '|' + (reason || '');
  }

  function cleanData(game) {
    const d = JSON.parse(JSON.stringify(game));
    delete d.onlineId;
    delete d.player;
    delete d.opponent;
    return d;
  }

  // ---------- Senden ----------
  function showErr(msg) {
    if (ctl) { ctl.err.textContent = msg || ''; ctl.err.classList.toggle('hidden', !msg); }
  }

  function push(game) {
    if (!game || !game.onlineId) return;
    const over = game.over;
    const p = {
      id: game.onlineId,
      data: cleanData(game),
      turn: game.state.turn,
      status: over ? 'finished' : 'active',
      result: over ? over.result : null,
      reason: over ? over.reason : null,
    };
    p.sig = sigOf(p.data, p.turn, p.status, p.result, p.reason);
    q.pending = p;
    sentSigs.push(p.sig);
    if (sentSigs.length > 10) sentSigs.shift();
    clearTimeout(q.timer);
    q.timer = null;
    flush();
  }

  async function flush() {
    if (q.inflight || !q.pending) return;
    const p = q.pending;
    q.pending = null;
    q.inflight = true;
    let error = null;
    try {
      const res = await sb().rpc('submit_state', {
        p_id: p.id, p_data: p.data, p_turn: p.turn, p_status: p.status, p_result: p.result, p_reason: p.reason,
      });
      error = res && res.error;
    } catch (e) {
      error = e || new Error('Keine Verbindung');
    }
    q.inflight = false;
    if (!error) {
      q.attempt = 0;
      if (!q.pending) showErr('');
      flush();
      return;
    }
    if (error.code) {
      // Server hat abgelehnt: erneut senden hilft nicht, Stand vom Server holen
      q.attempt = 0;
      showErr(error.message || 'Zug wurde nicht angenommen.');
      if (!q.pending && cur && cur.id === p.id) fetchRow();
      flush();
      return;
    }
    if (!q.pending) q.pending = p;
    q.attempt++;
    showErr('Zug noch nicht gesendet – ich versuche es gleich nochmal …');
    const delay = Math.min(MAX_BACKOFF, 1000 * Math.pow(2, q.attempt - 1));
    clearTimeout(q.timer);
    q.timer = setTimeout(() => { q.timer = null; flush(); }, delay);
  }

  // ---------- Zeilen vom Server ----------
  async function fetchRow() {
    if (!cur) return;
    const id = cur.id;
    try {
      const { data, error } = await sb().from('online_games').select('*').eq('id', id).maybeSingle();
      if (error || !data || !cur || cur.id !== id) return;
      onRow(data);
    } catch (e) { /* Realtime liefert später */ }
  }

  function onRow(row) {
    if (!cur || !row || row.id !== cur.id) return;
    const ts = Date.parse(row.updated_at) || 0;
    if (ts < cur.ts) return;
    cur.ts = ts;
    cur.row = row;

    const sig = sigOf(row.data, row.turn, row.status, row.result, row.reason);
    const echo = sig === cur.sig || sentSigs.includes(sig);
    if (!echo && !q.pending && !q.inflight) {
      sentSigs = [];
      cur.sig = sig;
      const g = app().getGame && app().getGame();
      if (g && g.onlineId === cur.id) {
        app().applyRemote(row);
        if (row.status === 'active' && row.turn === cur.myColor && document.hidden) setTitleAlert(true);
      }
    }

    if (row.status === 'finished') finish(row);
    renderControls();
  }

  function finish(row) {
    if (cur.ended) return;
    cur.ended = true;
    // bei data.over zeigt app.js den Dialog selbst
    if (!row.data || !row.data.over) app().showEnd({ result: row.result, reason: row.reason });
    Promise.resolve(sb().rpc('ack_game', { p_id: row.id })).catch(() => {});
  }

  function onDelete() {
    if (!cur || cur.ended) return;
    cur.ended = true;
    showErr('Diese Partie ist nicht mehr da.');
    renderControls();
  }

  // ---------- Titel ----------
  function setTitleAlert(on) {
    if (origTitle === null) return;
    document.title = on ? '♟ Du bist dran' : origTitle;
  }

  function onVisibility() {
    if (!document.hidden) setTitleAlert(false);
  }

  // ---------- Presence ----------
  function onPresence() {
    if (!cur || !cur.pch) return;
    const state = cur.pch.presenceState();
    const here = Object.keys(state).some((k) => k === cur.oppId ||
      (state[k] || []).some((m) => m && m.uid === cur.oppId));
    if (here) cur.offlineSince = null;
    else if (cur.offlineSince === null) cur.offlineSince = Date.now();
    renderControls();
  }

  function awayLong() {
    return cur.offlineSince !== null && Date.now() - cur.offlineSince >= AWAY_MS;
  }

  // ---------- Bedienelemente ----------
  function mk(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    if (tag === 'button') el.type = 'button';
    return el;
  }

  function buildControls() {
    const status = document.getElementById('status');
    const box = mk('div', 'og-box');
    box.id = 'online-controls';
    const presence = mk('div', 'og-presence');
    const buttons = mk('div', 'og-buttons');
    const resign = mk('button', 'og-resign', 'Aufgeben');
    const draw = mk('button', 'og-draw', 'Remis anbieten');
    buttons.append(resign, draw);
    const offer = mk('div', 'og-offer hidden');
    const offerText = mk('span', 'og-offer-text', 'Remis angeboten');
    const accept = mk('button', 'primary og-accept', 'Annehmen');
    const decline = mk('button', 'og-decline', 'Ablehnen');
    offer.append(offerText, accept, decline);
    const claim = mk('button', 'primary og-claim hidden', 'Gegner ist weg – als gewonnen werten');
    const err = mk('div', 'og-err hidden');
    box.append(presence, buttons, offer, claim, err);
    if (status && status.parentNode) status.parentNode.insertBefore(box, status.nextSibling);
    ctl = { box, presence, buttons, resign, draw, offer, offerText, accept, decline, claim, err };

    resign.onclick = () => {
      if (!confirm('Wirklich aufgeben?')) return;
      call('resign', {});
    };
    draw.onclick = () => call('offer_draw', {});
    accept.onclick = () => call('answer_draw', { p_accept: true });
    decline.onclick = () => call('answer_draw', { p_accept: false });
    claim.onclick = () => call('claim_win', {});
  }

  async function call(fn, args) {
    if (!cur) return;
    const id = cur.id;
    showErr('');
    try {
      const { error } = await sb().rpc(fn, { p_id: id, ...args });
      if (error) { showErr(error.message || 'Das hat nicht geklappt.'); return; }
    } catch (e) {
      showErr('Keine Verbindung – bitte nochmal versuchen.');
      return;
    }
    if (cur && cur.id === id) fetchRow();
  }

  function renderControls() {
    if (!ctl || !cur) return;
    const row = cur.row;
    const done = cur.ended || row.status === 'finished';
    ctl.buttons.classList.toggle('hidden', done);
    ctl.presence.classList.toggle('hidden', done);
    ctl.presence.textContent = '';
    if (!done) {
      const online = cur.offlineSince === null;
      ctl.presence.append(mk('span', 'og-dot ' + (online ? 'on' : 'off')),
        document.createTextNode(' ' + (cur.oppName || 'Gegner') + (online ? ' ist online' : ' ist offline')));
    }
    const mine = row.draw_offer_by === cur.me;
    const theirs = !!row.draw_offer_by && !mine;
    ctl.draw.disabled = mine;
    ctl.draw.textContent = mine ? 'Remis angeboten …' : 'Remis anbieten';
    ctl.offer.classList.toggle('hidden', done || !theirs);
    ctl.claim.classList.toggle('hidden', done || !(row.turn === cur.oppColor && awayLong()));
  }

  // ---------- Betreten / Verlassen ----------
  function enter(row) {
    leave();
    const me = app().getUser().id;
    const myColor = row.white_id === me ? 'w' : 'b';
    cur = {
      id: row.id,
      me,
      myColor,
      oppColor: myColor === 'w' ? 'b' : 'w',
      oppId: myColor === 'w' ? row.black_id : row.white_id,
      oppName: myColor === 'w' ? row.black_name : row.white_name,
      row,
      ts: Date.parse(row.updated_at) || 0,
      sig: sigOf(row.data, row.turn, row.status, row.result, row.reason),
      offlineSince: Date.now(),
      ended: false,
      ch: null,
      pch: null,
      tick: null,
    };
    sentSigs = [];
    origTitle = document.title;
    document.addEventListener('visibilitychange', onVisibility);
    buildControls();

    const client = sb();
    let subscribedBefore = false;
    cur.ch = client.channel('og-' + row.id + '-' + Date.now())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'online_games', filter: 'id=eq.' + row.id },
        (p) => onRow(p.new))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'online_games', filter: 'id=eq.' + row.id },
        () => onDelete())
      .subscribe((st) => {
        if (st === 'SUBSCRIBED') {
          if (subscribedBefore) fetchRow();
          subscribedBefore = true;
        }
      });

    const pch = client.channel('game:' + row.id, { config: { presence: { key: me } } });
    cur.pch = pch;
    pch.on('presence', { event: 'sync' }, onPresence)
      .subscribe((st) => {
        if (st === 'SUBSCRIBED') pch.track({ uid: me });
      });

    cur.tick = setInterval(renderControls, 1000);
    renderControls();
    if (row.status === 'finished') finish(row);
  }

  function leave() {
    if (!cur) return;
    clearInterval(cur.tick);
    const client = app() && app().sb;
    [cur.ch, cur.pch].forEach((c) => {
      if (c && client) { try { client.removeChannel(c); } catch (e) { /* egal */ } }
    });
    document.removeEventListener('visibilitychange', onVisibility);
    if (origTitle !== null) document.title = origTitle;
    origTitle = null;
    if (ctl && ctl.box.parentNode) ctl.box.parentNode.removeChild(ctl.box);
    ctl = null;
    cur = null;
  }

  window.OnlineGame = { enter, leave, push };
})();
