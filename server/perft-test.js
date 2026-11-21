const R = require('../public/rules.js');

function fromFEN(fen) {
  const [pos, turn, cast, ep] = fen.split(' ');
  const board = [];
  for (const ch of pos) {
    if (ch === '/') continue;
    if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) board.push(null);
    else board.push((ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase());
  }
  const epIdx = ep === '-' ? null : 'abcdefgh'.indexOf(ep[0]) + (8 - Number(ep[1])) * 8;
  return {
    board, turn, ep: epIdx, half: 0, full: 1,
    castling: { wK: cast.includes('K'), wQ: cast.includes('Q'), bK: cast.includes('k'), bQ: cast.includes('q') },
  };
}

function perft(s, d) {
  if (d === 0) return 1;
  let n = 0;
  for (const m of R.legalMoves(s)) n += perft(R.apply(s, m), d - 1);
  return n;
}

const tests = [
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', 4, 197281],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -', 3, 97862],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -', 4, 43238],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq -', 3, 9467],
];
let ok = true;
for (const [fen, d, expected] of tests) {
  const got = perft(fromFEN(fen), d);
  console.log(got === expected ? 'OK ' : 'FEHLER', got, expected);
  if (got !== expected) ok = false;
}
process.exit(ok ? 0 : 1);
