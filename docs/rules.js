// Schach-Regeln. Brett: 64 Felder, Index 0 = a8, Index 63 = h1.
// Figur = Text wie "wP" (weiß Bauer) oder "bK" (schwarz König), leer = null.
(function (root) {
  const START = [
    'bR','bN','bB','bQ','bK','bB','bN','bR',
    'bP','bP','bP','bP','bP','bP','bP','bP',
    null,null,null,null,null,null,null,null,
    null,null,null,null,null,null,null,null,
    null,null,null,null,null,null,null,null,
    null,null,null,null,null,null,null,null,
    'wP','wP','wP','wP','wP','wP','wP','wP',
    'wR','wN','wB','wQ','wK','wB','wN','wR',
  ];

  const file = (i) => i % 8;
  const rank = (i) => Math.floor(i / 8);
  const onBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
  const other = (c) => (c === 'w' ? 'b' : 'w');
  const name = (i) => 'abcdefgh'[file(i)] + (8 - rank(i));

  function newGame() {
    return {
      board: START.slice(),
      turn: 'w',
      castling: { wK: true, wQ: true, bK: true, bQ: true },
      ep: null,
      half: 0,
      full: 1,
    };
  }

  function clone(s) {
    return { board: s.board.slice(), turn: s.turn, castling: { ...s.castling }, ep: s.ep, half: s.half, full: s.full };
  }

  function attacked(board, sq, by) {
    const f = file(sq), r = rank(sq);
    const pr = by === 'w' ? r + 1 : r - 1; // Bauern von "by" stehen hinter dem Feld
    for (const df of [-1, 1]) {
      if (onBoard(f + df, pr) && board[pr * 8 + f + df] === by + 'P') return true;
    }
    for (const [df, dr] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]) {
      if (onBoard(f + df, r + dr) && board[(r + dr) * 8 + f + df] === by + 'N') return true;
    }
    for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
      if ((df || dr) && onBoard(f + df, r + dr) && board[(r + dr) * 8 + f + df] === by + 'K') return true;
    }
    const dirs = [[1,0,'R'],[-1,0,'R'],[0,1,'R'],[0,-1,'R'],[1,1,'B'],[1,-1,'B'],[-1,1,'B'],[-1,-1,'B']];
    for (const [df, dr, t] of dirs) {
      let x = f + df, y = r + dr;
      while (onBoard(x, y)) {
        const p = board[y * 8 + x];
        if (p) {
          if (p[0] === by && (p[1] === t || p[1] === 'Q')) return true;
          break;
        }
        x += df; y += dr;
      }
    }
    return false;
  }

  function kingSquare(board, c) {
    return board.indexOf(c + 'K');
  }

  function inCheck(s, c = s.turn) {
    const k = kingSquare(s.board, c);
    return k >= 0 && attacked(s.board, k, other(c));
  }

  // Alle Züge ohne Prüfung, ob der eigene König danach im Schach steht.
  function pseudoMoves(s, from) {
    const p = s.board[from];
    if (!p || p[0] !== s.turn) return [];
    const c = p[0], t = p[1], f = file(from), r = rank(from);
    const out = [];
    const add = (to, extra) => out.push({ from, to, ...extra });

    if (t === 'P') {
      const dir = c === 'w' ? -1 : 1;
      const startRank = c === 'w' ? 6 : 1;
      const lastRank = c === 'w' ? 0 : 7;
      const push = (to) => {
        if (rank(to) === lastRank) for (const promo of ['Q','R','B','N']) add(to, { promo });
        else add(to);
      };
      const one = from + dir * 8;
      if (onBoard(f, r + dir) && !s.board[one]) {
        push(one);
        if (r === startRank && !s.board[one + dir * 8]) add(one + dir * 8);
      }
      for (const df of [-1, 1]) {
        if (!onBoard(f + df, r + dir)) continue;
        const to = (r + dir) * 8 + f + df;
        if (s.board[to] && s.board[to][0] !== c) push(to);
        else if (to === s.ep) add(to, { ep: true });
      }
    } else if (t === 'N' || t === 'K') {
      const steps = t === 'N'
        ? [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]
        : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [df, dr] of steps) {
        if (!onBoard(f + df, r + dr)) continue;
        const to = (r + dr) * 8 + f + df;
        if (!s.board[to] || s.board[to][0] !== c) add(to);
      }
      if (t === 'K') {
        const home = c === 'w' ? 60 : 4;
        if (from === home && !attacked(s.board, home, other(c))) {
          if (s.castling[c + 'K'] && s.board[home + 3] === c + 'R' && !s.board[home + 1] && !s.board[home + 2]
              && !attacked(s.board, home + 1, other(c)) && !attacked(s.board, home + 2, other(c))) {
            add(home + 2, { castle: 'K' });
          }
          if (s.castling[c + 'Q'] && s.board[home - 4] === c + 'R' && !s.board[home - 1] && !s.board[home - 2] && !s.board[home - 3]
              && !attacked(s.board, home - 1, other(c)) && !attacked(s.board, home - 2, other(c))) {
            add(home - 2, { castle: 'Q' });
          }
        }
      }
    } else {
      const dirs = [];
      if (t !== 'B') dirs.push([1,0],[-1,0],[0,1],[0,-1]);
      if (t !== 'R') dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
      for (const [df, dr] of dirs) {
        let x = f + df, y = r + dr;
        while (onBoard(x, y)) {
          const to = y * 8 + x;
          const q = s.board[to];
          if (!q) add(to);
          else { if (q[0] !== c) add(to); break; }
          x += df; y += dr;
        }
      }
    }
    return out;
  }

  // Führt einen Zug aus (ohne zu prüfen, ob er erlaubt ist).
  function apply(s, m) {
    const n = clone(s);
    const p = n.board[m.from];
    const c = p[0];
    const captured = n.board[m.to];
    n.board[m.to] = m.promo ? c + m.promo : p;
    n.board[m.from] = null;
    if (m.ep) n.board[m.to + (c === 'w' ? 8 : -8)] = null;
    if (m.castle === 'K') { n.board[m.to - 1] = n.board[m.to + 1]; n.board[m.to + 1] = null; }
    if (m.castle === 'Q') { n.board[m.to + 1] = n.board[m.to - 2]; n.board[m.to - 2] = null; }
    // Rochade-Rechte verlieren
    if (p[1] === 'K') { n.castling[c + 'K'] = false; n.castling[c + 'Q'] = false; }
    for (const sq of [m.from, m.to]) {
      if (sq === 63) n.castling.wK = false;
      if (sq === 56) n.castling.wQ = false;
      if (sq === 7) n.castling.bK = false;
      if (sq === 0) n.castling.bQ = false;
    }
    n.ep = p[1] === 'P' && Math.abs(m.to - m.from) === 16 ? (m.from + m.to) / 2 : null;
    n.half = p[1] === 'P' || captured || m.ep ? 0 : s.half + 1;
    if (c === 'b') n.full++;
    n.turn = other(c);
    return n;
  }

  function legalMovesFrom(s, from) {
    const c = s.turn;
    return pseudoMoves(s, from).filter((m) => !inCheck(apply(s, m), c));
  }

  function legalMoves(s) {
    const out = [];
    for (let i = 0; i < 64; i++) if (s.board[i] && s.board[i][0] === s.turn) out.push(...legalMovesFrom(s, i));
    return out;
  }

  function insufficient(board) {
    const rest = [];
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (p && p[1] !== 'K') rest.push({ t: p[1], c: p[0], sq: (file(i) + rank(i)) % 2 });
    }
    if (rest.length === 0) return true;
    if (rest.length === 1 && (rest[0].t === 'N' || rest[0].t === 'B')) return true;
    if (rest.every((x) => x.t === 'B') && rest.every((x) => x.sq === rest[0].sq)) return true;
    return false;
  }

  function key(s) {
    return s.board.map((p) => p || '-').join('') + s.turn + (s.castling.wK ? 'K' : '') + (s.castling.wQ ? 'Q' : '')
      + (s.castling.bK ? 'k' : '') + (s.castling.bQ ? 'q' : '') + (s.ep === null ? '' : s.ep);
  }

  // history = Liste der bisherigen Stellungs-Schlüssel (inkl. der aktuellen)
  function status(s, history = []) {
    const check = inCheck(s);
    const moves = legalMoves(s);
    if (!moves.length) {
      return check ? { over: true, check, result: s.turn === 'w' ? 'b' : 'w', reason: 'Schachmatt' }
        : { over: true, check, result: 'draw', reason: 'Patt' };
    }
    if (insufficient(s.board)) return { over: true, check, result: 'draw', reason: 'Zu wenig Figuren' };
    if (s.half >= 100) return { over: true, check, result: 'draw', reason: '50-Züge-Regel' };
    const k = key(s);
    if (history.filter((h) => h === k).length >= 3) return { over: true, check, result: 'draw', reason: 'Dreimal dieselbe Stellung' };
    return { over: false, check };
  }

  function toFEN(s) {
    const rows = [];
    for (let r = 0; r < 8; r++) {
      let row = '', empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = s.board[r * 8 + f];
        if (!p) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += p[0] === 'w' ? p[1] : p[1].toLowerCase();
      }
      if (empty) row += empty;
      rows.push(row);
    }
    const c = (s.castling.wK ? 'K' : '') + (s.castling.wQ ? 'Q' : '') + (s.castling.bK ? 'k' : '') + (s.castling.bQ ? 'q' : '');
    return `${rows.join('/')} ${s.turn} ${c || '-'} ${s.ep === null ? '-' : name(s.ep)} ${s.half} ${s.full}`;
  }

  // Zug als Text wie "e2e4" oder "e7e8q" (für Stockfish)
  const moveToUci = (m) => name(m.from) + name(m.to) + (m.promo ? m.promo.toLowerCase() : '');
  function uciToMove(s, uci) {
    const idx = (t) => 'abcdefgh'.indexOf(t[0]) + (8 - Number(t[1])) * 8;
    const from = idx(uci.slice(0, 2)), to = idx(uci.slice(2, 4));
    const promo = uci[4] ? uci[4].toUpperCase() : undefined;
    return legalMovesFrom(s, from).find((m) => m.to === to && m.promo === promo) || null;
  }

  const api = { START, newGame, clone, apply, legalMoves, legalMovesFrom, inCheck, status, key, toFEN, moveToUci, uciToMove, kingSquare, name, file, rank };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Rules = api;
})(typeof window !== 'undefined' ? window : globalThis);
