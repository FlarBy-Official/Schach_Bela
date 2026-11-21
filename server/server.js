const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const express = require('express');
const session = require('express-session');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // nur dieser Computer
const OWNER_NAME = 'Bela_Owner';
const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'schach.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    hash TEXT NOT NULL,
    is_owner INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS games (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    data TEXT NOT NULL,
    updated TEXT NOT NULL
  );
`);

// Passwort-Hash mit scrypt und eigenem Salz. Das Passwort selbst wird nie gespeichert.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
}
const DUMMY_HASH = hashPassword('nichts');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function ensureOwner() {
  if (db.prepare('SELECT 1 FROM users WHERE is_owner = 1').get()) return;
  let pw = process.env.OWNER_PASSWORD;
  if (!pw) {
    if (!process.stdin.isTTY) {
      console.error('Kein Besitzer-Konto da. Starte im Terminal mit "npm start" oder setze OWNER_PASSWORD.');
      process.exit(1);
    }
    console.log(`Willkommen Bela! Wir legen jetzt dein Konto "${OWNER_NAME}" an.`);
    for (;;) {
      pw = await askHidden('Wähle ein Passwort (mindestens 8 Zeichen): ');
      if (pw.length < 8) { console.log('Zu kurz, nochmal.'); continue; }
      const again = await askHidden('Gib es nochmal ein: ');
      if (pw === again) break;
      console.log('Die zwei Passwörter sind nicht gleich, nochmal.');
    }
  }
  if (pw.length < 8) { console.error('Passwort zu kurz (mindestens 8 Zeichen).'); process.exit(1); }
  db.prepare('INSERT INTO users (name, hash, is_owner) VALUES (?, ?, 1)').run(OWNER_NAME, hashPassword(pw));
  console.log(`Konto "${OWNER_NAME}" ist angelegt.`);
}

function sessionSecret() {
  const f = path.join(DATA, 'session-secret.txt');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8');
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'schach.sid',
  secret: sessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 14 },
}));

// Einfacher Schutz gegen Passwort-Raten
const fails = new Map();
function tooMany(key) {
  const f = fails.get(key);
  return f && f.count >= 5 && Date.now() - f.last < 60_000;
}
function noteFail(key) {
  const f = fails.get(key) || { count: 0, last: 0 };
  if (Date.now() - f.last > 60_000) f.count = 0;
  f.count++; f.last = Date.now();
  fails.set(key, f);
}

const publicUser = (u) => ({ name: u.name, isOwner: !!u.is_owner, settings: JSON.parse(u.settings) });
const userById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

// Eine Cookie-Sitzung kann mehrere Konten tragen: je eines pro Browser-Tab (Header X-Tab).
function tabOf(req) {
  const t = req.get('x-tab');
  return typeof t === 'string' && /^[A-Za-z0-9]{8,64}$/.test(t) ? t : 'default';
}
function uidOf(req) {
  const accounts = req.session.accounts;
  return accounts ? accounts[tabOf(req)] : undefined;
}
function loginTab(req, uid, done) {
  const tab = tabOf(req);
  const accounts = { ...(req.session.accounts || {}) };
  req.session.regenerate(() => {
    accounts[tab] = uid;
    req.session.accounts = accounts;
    done();
  });
}

function needLogin(req, res, next) {
  const uid = uidOf(req);
  if (!uid || !userById(uid)) return res.status(401).json({ error: 'Bitte zuerst einloggen.' });
  req.uid = uid;
  next();
}

app.post('/api/register', (req, res) => {
  const { name, password } = req.body || {};
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(name)) {
    return res.status(400).json({ error: 'Der Name darf 3 bis 20 Zeichen haben: Buchstaben, Zahlen und _.' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
    return res.status(400).json({ error: 'Das Passwort braucht mindestens 6 Zeichen.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) {
    return res.status(409).json({ error: 'Diesen Namen gibt es schon.' });
  }
  const r = db.prepare('INSERT INTO users (name, hash) VALUES (?, ?)').run(name, hashPassword(password));
  const uid = Number(r.lastInsertRowid);
  loginTab(req, uid, () => res.json(publicUser(userById(uid))));
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body || {};
  if (typeof name !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Name und Passwort fehlen.' });
  const key = `${req.ip}|${name.toLowerCase()}`;
  if (tooMany(key)) return res.status(429).json({ error: 'Zu viele Versuche. Warte eine Minute.' });
  const u = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  const ok = checkPassword(password, u ? u.hash : DUMMY_HASH) && !!u;
  if (!ok) { noteFail(key); return res.status(401).json({ error: 'Name oder Passwort stimmt nicht.' }); }
  fails.delete(key);
  loginTab(req, u.id, () => res.json(publicUser(u)));
});

app.post('/api/logout', (req, res) => {
  if (req.session.accounts) delete req.session.accounts[tabOf(req)];
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const uid = uidOf(req);
  const u = uid && userById(uid);
  res.json(u ? publicUser(u) : null);
});

const SETTING_KEYS = ['theme', 'letters', 'dots', 'lastMove', 'checkRed', 'sound'];
app.put('/api/settings', needLogin, (req, res) => {
  const body = req.body || {};
  const s = {};
  for (const k of SETTING_KEYS) if (k in body) s[k] = k === 'theme' ? (body[k] === 'marble' ? 'marble' : 'wood') : !!body[k];
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(s), req.session.uid);
  res.json(s);
});

app.get('/api/game', needLogin, (req, res) => {
  const g = db.prepare('SELECT data FROM games WHERE user_id = ?').get(req.session.uid);
  res.json(g ? JSON.parse(g.data) : null);
});
app.put('/api/game', needLogin, (req, res) => {
  const data = JSON.stringify(req.body || null);
  db.prepare(`INSERT INTO games (user_id, data, updated) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated = excluded.updated`)
    .run(req.session.uid, data, new Date().toISOString());
  res.json({ ok: true });
});
app.delete('/api/game', needLogin, (req, res) => {
  db.prepare('DELETE FROM games WHERE user_id = ?').run(req.session.uid);
  res.json({ ok: true });
});

// Computer-Gegner (Stockfish) läuft im Browser, die Dateien kommen von hier.
app.use('/engine', express.static(path.join(__dirname, '..', 'node_modules', 'stockfish', 'bin')));
app.use(express.static(path.join(__dirname, '..', 'docs')));

ensureOwner().then(() => {
  app.listen(PORT, HOST, () => console.log(`Schach läuft auf http://localhost:${PORT}`));
});
