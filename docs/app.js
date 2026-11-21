(function () {
  const R = window.Rules, P = window.Pieces;
  const $ = (id) => document.getElementById(id);
  const DEFAULTS = { theme: 'wood', letters: false, dots: true, lastMove: true, checkRed: true, sound: true };

  let user = null;
  let settings = { ...DEFAULTS };
  let game = null;        // laufendes Spiel
  let selected = null;    // gewähltes Feld
  let flipped = false;
  let tool = 'free', addPiece = 'wQ';
  let magicOn = false;
  let engine = null, engineBusy = false, engineToken = 0;

  const SUPABASE_URL = 'https://bqpeitdgqmsbnfklgwas.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_U_eZLVd9Mf8-aNLV9j5pPQ_UqUtPpzI'; // öffentlicher Key, die Rechte regelt Row-Level-Security
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  const emailOf = (name) => `schach.${name.toLowerCase()}@gmail.com`;

  async function profile() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const { data, error } = await sb.from('profiles').select('name,is_owner,settings').eq('id', session.user.id).single();
    if (error) return null;
    return { id: session.user.id, name: data.name, isOwner: !!data.is_owner, settings: data.settings || {} };
  }
  const must = ({ data, error }) => { if (error) throw new Error('Etwas ist schiefgegangen.'); return data; };
  const uid = async () => (await sb.auth.getSession()).data.session.user.id;

  // Gleiche Schnittstelle wie vorher der Server, jetzt mit Supabase.
  async function api(method, url, body) {
    if (url === '/api/register') {
      const { name, password } = body;
      if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw new Error('Der Name darf 3 bis 20 Zeichen haben: Buchstaben, Zahlen und _.');
      if (password.length < 6 || password.length > 72) throw new Error('Das Passwort braucht mindestens 6 Zeichen.');
      const { data, error } = await sb.auth.signUp({ email: emailOf(name), password, options: { data: { name } } });
      if (error) throw new Error(/already|registered/i.test(error.message) ? 'Diesen Namen gibt es schon.' : 'Anmelden hat nicht geklappt: ' + error.message);
      if (!data.session) throw new Error('Supabase verlangt noch eine E-Mail-Bestätigung (im Dashboard abschalten).');
      return profile();
    }
    if (url === '/api/login') {
      const { error } = await sb.auth.signInWithPassword({ email: emailOf(body.name), password: body.password });
      if (error) throw new Error('Name oder Passwort stimmt nicht.');
      return profile();
    }
    if (url === '/api/logout') { await sb.auth.signOut(); return { ok: true }; }
    if (url === '/api/me') return profile();
    if (url === '/api/settings') {
      must(await sb.from('profiles').update({ settings: body }).eq('id', await uid()));
      return body;
    }
    if (url === '/api/game') {
      const id = await uid();
      if (method === 'GET') {
        const d = must(await sb.from('games').select('data').eq('user_id', id).maybeSingle());
        return d ? d.data : null;
      }
      if (method === 'PUT') {
        must(await sb.from('games').upsert({ user_id: id, data: body, updated: new Date().toISOString() }));
        return { ok: true };
      }
      if (method === 'DELETE') { must(await sb.from('games').delete().eq('user_id', id)); return { ok: true }; }
    }
    throw new Error('Unbekannte Anfrage.');
  }

  function show(id) {
    for (const s of ['screen-auth', 'screen-menu', 'screen-online', 'screen-game']) $(s).classList.toggle('hidden', s !== id);
  }

  // ---------- Töne ----------
  let actx = null;
  function beep(freq, dur = 0.08, delay = 0, type = 'triangle', vol = 0.15) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = actx.currentTime + delay;
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
    } catch { /* Ton geht nicht, egal */ }
  }
  const sounds = {
    move: () => beep(330, 0.07),
    capture: () => { beep(200, 0.12, 0, 'square', 0.12); beep(140, 0.12, 0.05, 'square', 0.1); },
    check: () => { beep(660, 0.1); beep(880, 0.14, 0.1); },
    end: () => { beep(523, 0.18); beep(392, 0.18, 0.18); beep(262, 0.35, 0.36); },
  };

  // ---------- Anmelden ----------
  let registerMode = false;
  function setAuthMode(reg) {
    registerMode = reg;
    $('tab-login').classList.toggle('active', !reg);
    $('tab-register').classList.toggle('active', reg);
    $('auth-submit').textContent = reg ? 'Konto erstellen' : 'Einloggen';
    $('auth-hint').classList.toggle('hidden', !reg);
    $('auth-pass').autocomplete = reg ? 'new-password' : 'current-password';
    $('auth-error').textContent = '';
  }
  $('tab-login').onclick = () => setAuthMode(false);
  $('tab-register').onclick = () => setAuthMode(true);
  $('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const u = await api('POST', registerMode ? '/api/register' : '/api/login', { name: $('auth-name').value.trim(), password: $('auth-pass').value });
      $('auth-pass').value = '';
      await onLogin(u);
    } catch (err) { $('auth-error').textContent = err.message; }
  };

  async function onLogin(u) {
    user = u;
    settings = { ...DEFAULTS, ...u.settings };
    applySettings();
    $('menu-user').textContent = u.name;
    $('magic').classList.toggle('hidden', !u.isOwner);
    const saved = await api('GET', '/api/game');
    $('btn-resume').classList.toggle('hidden', !saved);
    $('menu-note').textContent = '';
    show('screen-menu');
  }

  $('menu-logout').onclick = async () => { await api('POST', '/api/logout'); stopEngine(); if (window.OnlineGame.leave) window.OnlineGame.leave(); user = null; game = null; show('screen-auth'); };

  // ---------- Einstellungen ----------
  function applySettings() {
    document.body.classList.toggle('theme-wood', settings.theme === 'wood');
    document.body.classList.toggle('theme-marble', settings.theme === 'marble');
    if (game) render();
  }
  function openSettings() {
    $('set-theme').value = settings.theme;
    for (const k of ['letters', 'dots', 'lastMove', 'checkRed', 'sound']) $('set-' + k).checked = settings[k];
    $('dlg-settings').showModal();
  }
  function saveSettings() {
    settings.theme = $('set-theme').value;
    for (const k of ['letters', 'dots', 'lastMove', 'checkRed', 'sound']) settings[k] = $('set-' + k).checked;
    applySettings();
    api('PUT', '/api/settings', settings).catch(() => {});
  }
  $('dlg-settings').addEventListener('change', saveSettings);
  $('menu-settings').onclick = openSettings;
  $('g-settings').onclick = openSettings;

  // ---------- Menü ----------
  function newGame(mode, level, player) {
    game = {
      mode, level, player,
      state: R.newGame(), keys: [], moves: [], last: null, snaps: [], over: null,
    };
    game.keys.push(R.key(game.state));
    flipped = mode === 'cpu' && player === 'b';
    startGame();
  }
  function startGame() {
    selected = null; magicOn = false; $('magic-on').checked = false; $('magic-tools').classList.add('hidden');
    document.body.classList.remove('magic-active');
    $('g-new').classList.toggle('hidden', game.mode === 'online');
    show('screen-game');
    render();
    if (game.mode !== 'online') save();
    maybeEngineMove();
  }
  $('btn-local').onclick = () => newGame('local');
  $('btn-cpu').onclick = () => {
    let c = $('cpu-color').value;
    if (c === 'r') c = Math.random() < 0.5 ? 'w' : 'b';
    newGame('cpu', $('cpu-level').value, c);
  };
  $('btn-online').onclick = () => window.Online.open();
  $('btn-resume').onclick = async () => {
    try {
      const g = await api('GET', '/api/game');
      if (!g) return;
      game = g; flipped = g.mode === 'cpu' && g.player === 'b';
      startGame();
    } catch (err) { $('menu-note').textContent = err.message; }
  };
  $('g-menu').onclick = async () => {
    stopEngine();
    if (game && game.mode === 'online') {
      window.OnlineGame.leave();
      game = null;
      return window.Online.open();
    }
    const saved = await api('GET', '/api/game').catch(() => null);
    $('btn-resume').classList.toggle('hidden', !saved);
    show('screen-menu');
  };
  $('g-new').onclick = () => {
    if (!confirm('Neues Spiel anfangen? Das jetzige Spiel ist dann weg.')) return;
    stopEngine();
    newGame(game.mode, game.level, game.player);
  };
  $('g-flip').onclick = () => { flipped = !flipped; render(); };

  function save() {
    if (!game) return;
    if (game.mode === 'online') {
      const { onlineId, player, ...data } = game;
      window.OnlineGame.push({ ...data, snaps: [], onlineId, player });
      return;
    }
    if (game.over) { api('DELETE', '/api/game').catch(() => {}); return; }
    const copy = { ...game, snaps: game.snaps.slice(-40) };
    api('PUT', '/api/game', copy).catch(() => {});
  }

  // ---------- Brett zeichnen ----------
  function legalFrom(sq) {
    return R.legalMovesFrom(game.state, sq);
  }

  function render() {
    if (!game) return;
    const s = game.state;
    const st = game.over || R.status(s, game.keys);
    const board = $('board');
    board.innerHTML = '';
    const checkSq = settings.checkRed && st.check ? R.kingSquare(s.board, s.turn) : -1;
    const targets = new Map();
    if (selected !== null && settings.dots && !(magicOn && tool === 'free')) {
      for (const m of legalFrom(selected)) targets.set(m.to, m);
    }
    const order = [...Array(64).keys()];
    if (flipped) order.reverse();
    for (const i of order) {
      const f = R.file(i), r = R.rank(i);
      const d = document.createElement('div');
      d.className = 'sq' + ((f + r) % 2 ? ' dark' : '');
      d.dataset.sq = i;
      if (i === selected) d.classList.add('selected');
      if (settings.lastMove && game.last && (i === game.last.from || i === game.last.to)) d.classList.add('last');
      if (i === checkSq) d.classList.add('check');
      const p = s.board[i];
      if (p) {
        const el = document.createElement('div');
        el.className = 'piece ' + p[0];
        el.innerHTML = P.svg(p) + (settings.letters ? `<span class="letter">${P.LETTER[p[1]]}</span>` : '');
        el.title = (p[0] === 'w' ? 'Weißer ' : 'Schwarzer ') + P.NAMES[p[1]];
        el.draggable = true;
        el.addEventListener('dragstart', (ev) => {
          const ok = magicOn ? tool === 'free' : humanCanMove() && p[0] === game.state.turn;
          if (!ok) return ev.preventDefault();
          selected = i; // kein neu Zeichnen, sonst bricht das Ziehen ab
          ev.dataTransfer.setData('text/plain', String(i));
          ev.dataTransfer.effectAllowed = 'move';
        });
        d.appendChild(el);
      }
      if (targets.has(i)) {
        const dot = document.createElement('div');
        dot.className = 'dot' + (p || targets.get(i).ep ? ' cap' : '');
        d.appendChild(dot);
      }
      const visualCol = flipped ? 7 - f : f, visualRow = flipped ? 7 - r : r;
      if (visualRow === 7) { const c = document.createElement('span'); c.className = 'coord f'; c.textContent = 'abcdefgh'[f]; d.appendChild(c); }
      if (visualCol === 0) { const c = document.createElement('span'); c.className = 'coord r'; c.textContent = 8 - r; d.appendChild(c); }
      d.addEventListener('click', () => onSquare(i, false));
      d.addEventListener('dragover', (ev) => ev.preventDefault());
      d.addEventListener('drop', (ev) => { ev.preventDefault(); if (selected !== null && selected !== i) onSquare(i, false, true); else { selected = null; render(); } });
      board.appendChild(d);
    }
    renderStatus(st);
    renderMoves();
  }

  function renderStatus(st) {
    const el = $('status');
    el.classList.toggle('over', !!st.over);
    const who = (c) => (c === 'w' ? 'Weiß' : 'Schwarz');
    if (st.over) {
      el.textContent = st.result === 'draw' ? `Unentschieden (${st.reason})` : `${who(st.result)} gewinnt! (${st.reason})`;
    } else {
      let t = `${who(game.state.turn)} ist dran`;
      if (game.mode === 'online') t += game.state.turn === game.player ? ' (du)' : ` (${game.opponent || 'Gegner'})`;
      if (game.mode === 'cpu') t += game.state.turn === game.player ? ' (du)' : ' (Computer denkt…)';
      if (st.check) t += ' – Schach!';
      el.textContent = t;
    }
  }

  function renderMoves() {
    const ol = $('moves');
    ol.innerHTML = '';
    for (let i = 0; i < game.moves.length; i += 2) {
      const li = document.createElement('li');
      li.textContent = game.moves[i] + (game.moves[i + 1] ? '   ' + game.moves[i + 1] : '');
      ol.appendChild(li);
    }
    ol.scrollTop = ol.scrollHeight;
  }

  // ---------- Klicken & Ziehen ----------
  function humanCanMove() {
    if (!game || game.over) return false;
    if (magicOn) return true;
    if (game.mode === 'online') return game.state.turn === game.player;
    if (game.mode === 'cpu' && game.state.turn !== game.player) return false;
    return !engineBusy;
  }

  function onSquare(i, _unused, fromDrop) {
    if (!game) return;
    const s = game.state;
    if (magicOn) return magicClick(i);
    if (!humanCanMove()) return;
    const p = s.board[i];
    if (selected !== null) {
      const moves = legalFrom(selected).filter((m) => m.to === i);
      if (moves.length) return playMove(moves, selected, i);
    }
    if (p && p[0] === s.turn) { selected = i; render(); }
    else { selected = null; render(); }
  }

  async function playMove(moves, from, to) {
    let m = moves[0];
    if (moves.length > 1) {
      const promo = await askPromotion(game.state.turn);
      m = moves.find((x) => x.promo === promo) || moves[0];
    }
    commitMove(m);
  }

  function askPromotion(color) {
    return new Promise((resolve) => {
      const box = $('promo-choices');
      box.innerHTML = '';
      for (const t of ['Q', 'R', 'B', 'N']) {
        const b = document.createElement('button');
        b.type = 'button'; b.title = P.NAMES[t]; b.innerHTML = P.svg(color + t);
        b.onclick = () => { $('dlg-promo').close(); resolve(t); };
        box.appendChild(b);
      }
      $('dlg-promo').addEventListener('cancel', (e) => e.preventDefault(), { once: true });
      $('dlg-promo').showModal();
    });
  }

  function notation(s, m) {
    if (m.castle) return m.castle === 'K' ? '0-0' : '0-0-0';
    const p = s.board[m.from];
    const cap = s.board[m.to] || m.ep;
    return (p[1] === 'P' ? '' : P.LETTER[p[1]]) + R.name(m.from) + (cap ? 'x' : '-') + R.name(m.to) + (m.promo ? '=' + P.LETTER[m.promo] : '');
  }

  function snapshot() {
    game.snaps.push({ state: R.clone(game.state), keys: game.keys.slice(), moves: game.moves.slice(), last: game.last });
    if (game.snaps.length > 60) game.snaps.shift();
  }

  function afterChange(capture) {
    selected = null;
    game.keys.push(R.key(game.state));
    const st = R.status(game.state, game.keys);
    if (st.over) game.over = st;
    render();
    save();
    if (st.over) { sounds.end(); showEnd(st); }
    else if (st.check) sounds.check();
    else if (capture) sounds.capture();
    else sounds.move();
    maybeEngineMove();
  }

  function commitMove(m) {
    snapshot();
    const s = game.state;
    const cap = !!(s.board[m.to] || m.ep);
    game.moves.push(notation(s, m));
    game.state = R.apply(s, m);
    game.last = { from: m.from, to: m.to };
    afterChange(cap);
  }

  function showEnd(st) {
    $('end-title').textContent = st.result === 'draw' ? 'Unentschieden' : (st.result === 'w' ? 'Weiß' : 'Schwarz') + ' hat gewonnen!';
    $('end-text').textContent = st.reason;
    $('dlg-end').showModal();
  }

  // ---------- Zauber-Modus (nur Besitzer) ----------
  function buildPalette() {
    const box = $('palette');
    box.innerHTML = '';
    for (const c of ['w', 'b']) for (const t of ['K', 'Q', 'R', 'B', 'N', 'P']) {
      const b = document.createElement('button');
      b.type = 'button'; b.innerHTML = P.svg(c + t); b.dataset.p = c + t; b.title = P.NAMES[t];
      b.classList.toggle('on', c + t === addPiece);
      b.onclick = () => { addPiece = c + t; buildPalette(); };
      box.appendChild(b);
    }
  }
  $('magic-on').onchange = (e) => {
    if (!user || !user.isOwner) { e.target.checked = false; return; }
    stopEngine();
    magicOn = e.target.checked;
    $('magic-tools').classList.toggle('hidden', !magicOn);
    document.body.classList.toggle('magic-active', magicOn);
    selected = null; render();
    if (!magicOn) maybeEngineMove();
  };
  document.querySelectorAll('input[name=tool]').forEach((r) => {
    r.onchange = () => { tool = r.value; $('palette').classList.toggle('hidden', tool !== 'add'); if (tool === 'add') buildPalette(); selected = null; render(); };
  });

  function magicClick(i) {
    if (!user.isOwner) return;
    const s = game.state;
    if (tool === 'remove') {
      if (!s.board[i]) return;
      snapshot(); s.board[i] = null; s.ep = null;
      return afterMagic(false);
    }
    if (tool === 'add') {
      snapshot(); s.board[i] = addPiece; s.ep = null;
      return afterMagic(false);
    }
    // frei ziehen
    if (selected === null) {
      if (s.board[i]) { selected = i; render(); }
      return;
    }
    if (i === selected) { selected = null; render(); return; }
    const from = selected, p = s.board[from], cap = !!s.board[i];
    if (!p) { selected = null; render(); return; }
    snapshot();
    const lastRank = p[0] === 'w' ? 0 : 7;
    s.board[i] = p[1] === 'P' && R.rank(i) === lastRank ? p[0] + 'Q' : p;
    s.board[from] = null;
    for (const sq of [from, i]) {
      if (sq === 63) s.castling.wK = false; if (sq === 56) s.castling.wQ = false;
      if (sq === 7) s.castling.bK = false; if (sq === 0) s.castling.bQ = false;
      if (sq === 60) { s.castling.wK = false; s.castling.wQ = false; }
      if (sq === 4) { s.castling.bK = false; s.castling.bQ = false; }
    }
    s.ep = null;
    game.moves.push('✨' + R.name(from) + '-' + R.name(i));
    game.last = { from, to: i };
    if (!$('magic-double').checked) { s.turn = s.turn === 'w' ? 'b' : 'w'; if (s.turn === 'w') s.full++; }
    afterMagic(cap);
  }

  function afterMagic(cap) {
    // Nach Zauber ist das Spiel nicht mehr "vorbei"
    game.over = null;
    game.state.castling = fixCastling(game.state);
    afterChange(cap);
  }
  // Rochade nur erlauben, wenn König und Turm noch am Platz stehen
  function fixCastling(s) {
    const c = { ...s.castling }, b = s.board;
    if (b[60] !== 'wK') { c.wK = false; c.wQ = false; }
    if (b[4] !== 'bK') { c.bK = false; c.bQ = false; }
    if (b[63] !== 'wR') c.wK = false;
    if (b[56] !== 'wR') c.wQ = false;
    if (b[7] !== 'bR') c.bK = false;
    if (b[0] !== 'bR') c.bQ = false;
    return c;
  }

  $('magic-undo').onclick = () => {
    stopEngine();
    const prev = game.snaps.pop();
    if (!prev) return;
    game.state = prev.state; game.keys = prev.keys; game.moves = prev.moves; game.last = prev.last; game.over = null;
    selected = null; render(); save();
  };
  $('magic-turn').onclick = () => {
    stopEngine();
    snapshot();
    game.state.turn = game.state.turn === 'w' ? 'b' : 'w';
    game.state.ep = null;
    game.keys.push(R.key(game.state));
    render(); save();
    maybeEngineMove();
  };

  // ---------- Computer-Gegner (Stockfish im Browser) ----------
  const LEVELS = {
    easy: { elo: 1320, time: 150 },
    medium: { elo: 1800, time: 400 },
    hard: { elo: null, time: 1200 },
  };

  function stopEngine() {
    engineToken++;
    engineBusy = false;
    if (engine) { engine.terminate(); engine = null; }
  }

  function getEngine() {
    if (engine) return engine;
    engine = new Worker('engine/stockfish-19-lite-single.js');
    engine.postMessage('uci');
    engine.postMessage('isready');
    return engine;
  }

  function maybeEngineMove() {
    if (!game || game.mode !== 'cpu' || game.over || magicOn) return;
    if (game.state.turn === game.player) return;
    if (engineBusy) return;
    engineBusy = true;
    render();
    const token = ++engineToken;
    const lv = LEVELS[game.level] || LEVELS.medium;
    const w = getEngine();
    const fen = R.toFEN(game.state);
    const onMsg = (ev) => {
      const line = typeof ev.data === 'string' ? ev.data : '';
      if (!line.startsWith('bestmove')) return;
      w.removeEventListener('message', onMsg);
      if (token !== engineToken) return;
      engineBusy = false;
      const uci = line.split(' ')[1];
      const m = uci && R.uciToMove(game.state, uci);
      if (m) setTimeout(() => token === engineToken && commitMove(m), 250);
      else render();
    };
    w.addEventListener('message', onMsg);
    w.postMessage('ucinewgame');
    w.postMessage(`setoption name UCI_LimitStrength value ${lv.elo ? 'true' : 'false'}`);
    if (lv.elo) w.postMessage(`setoption name UCI_Elo value ${lv.elo}`);
    w.postMessage(`position fen ${fen}`);
    w.postMessage(`go movetime ${lv.time}`);
  }

  // ---------- Online (Teile in online.js und online-game.js) ----------
  function openOnlineGame(row) {
    selected = null;
    game = { ...row.data, mode: 'online', onlineId: row.id, snaps: [] };
    const me = user.id === row.white_id ? 'w' : 'b';
    game.player = me;
    game.opponent = me === 'w' ? row.black_name : row.white_name;
    flipped = me === 'b';
    startGame();
    window.OnlineGame.enter(row);
  }
  function applyRemote(row) {
    if (!game || game.onlineId !== row.id) return;
    const d = row.data;
    const same = JSON.stringify(d.state) === JSON.stringify(game.state) && JSON.stringify(d.over || null) === JSON.stringify(game.over || null);
    if (same) return;
    const opponentMoved = d.moves.length > game.moves.length && d.state.turn === game.player;
    snapshot();
    selected = null;
    const wasOver = !!game.over;
    const { snaps, opponent, player, onlineId } = game;
    game = { ...d, mode: 'online', snaps, opponent, player, onlineId, over: d.over || null };
    render();
    if (opponentMoved) {
      const st = game.over;
      if (st) sounds.end(); else sounds.move();
    }
    if (game.over && !wasOver) showEnd(game.over);
  }
  window.SchachApp = {
    sb, sounds, beep: () => sounds.move(),
    getUser: () => user,
    getGame: () => game,
    showScreen: show,
    openOnlineGame, applyRemote, showEnd,
  };

  // ---------- Start ----------
  (async function init() {
    setAuthMode(false);
    try {
      const u = await api('GET', '/api/me');
      if (u) await onLogin(u); else show('screen-auth');
    } catch { show('screen-auth'); }
  })();
})();
