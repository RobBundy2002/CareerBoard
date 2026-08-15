const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const app = express();
const port = Number(process.env.PORT || 3000);
const db = new Database(process.env.DATABASE_PATH || path.join(__dirname, 'data.sqlite'));
const jwtSecret = process.env.JWT_SECRET || 'development-only-change-me';

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS team_members (team_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', PRIMARY KEY(team_id, user_id));
  CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, created_by TEXT NOT NULL, company TEXT NOT NULL, role TEXT NOT NULL, location TEXT DEFAULT '', url TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'Applied', salary TEXT DEFAULT '', next_step TEXT DEFAULT '', notes TEXT DEFAULT '', applied_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, properties TEXT DEFAULT '{}', created_at TEXT NOT NULL);
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const hash = (value, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(value, salt, 64).toString('hex')}`;
const verifyHash = (value, stored) => { const [salt, key] = stored.split(':'); return crypto.timingSafeEqual(Buffer.from(key, 'hex'), crypto.scryptSync(value, salt, 64)); };
const tokenFor = user => jwt.sign({ userId: user.id }, jwtSecret, { expiresIn: '7d' });
const publicUser = user => ({ id: user.id, name: user.name, email: user.email });

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  try { req.user = jwt.verify(header.replace('Bearer ', ''), jwtSecret); next(); }
  catch { res.status(401).json({ error: 'Please sign in to continue.' }); }
}

function teamFor(userId) {
  return db.prepare('SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? ORDER BY t.created_at LIMIT 1').get(userId);
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'careerboard', time: now() }));

app.post('/api/auth/register', (req, res) => {
  const { name, email, password, teamName = 'My job search' } = req.body;
  if (!name || !email || !password || password.length < 8) return res.status(400).json({ error: 'Name, email, and an 8+ character password are required.' });
  const cleanEmail = email.trim().toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE email=?').get(cleanEmail)) return res.status(409).json({ error: 'An account with that email already exists.' });
  const user = { id: id(), name: name.trim(), email: cleanEmail, password_hash: hash(password), created_at: now() };
  const team = { id: id(), name: teamName.trim() || 'My job search', created_at: now() };
  const transaction = db.transaction(() => { db.prepare('INSERT INTO users VALUES (@id,@name,@email,@password_hash,@created_at)').run(user); db.prepare('INSERT INTO teams VALUES (@id,@name,@created_at)').run(team); db.prepare('INSERT INTO team_members VALUES (?,?,?)').run(team.id, user.id, 'owner'); });
  transaction();
  res.status(201).json({ token: tokenFor(user), user: publicUser(user), team });
});

app.post('/api/auth/login', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email=?').get((req.body.email || '').trim().toLowerCase());
  if (!user || !req.body.password || !verifyHash(req.body.password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password.' });
  res.json({ token: tokenFor(user), user: publicUser(user), team: teamFor(user.id) });
});

app.get('/api/me', auth, (req, res) => { const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId); res.json({ user: publicUser(user), team: teamFor(user.id) }); });

app.get('/api/applications', auth, (req, res) => {
  const team = teamFor(req.user.userId); if (!team) return res.json([]);
  res.json(db.prepare('SELECT * FROM applications WHERE team_id=? ORDER BY updated_at DESC').all(team.id));
});

app.post('/api/applications', auth, (req, res) => {
  const team = teamFor(req.user.userId); const { company, role, location = '', url = '', status = 'Applied', salary = '', next_step = '', notes = '' } = req.body;
  if (!team || !company || !role) return res.status(400).json({ error: 'Company and role are required.' });
  const application = { id: id(), team_id: team.id, created_by: req.user.userId, company: company.trim(), role: role.trim(), location, url, status, salary, next_step, notes, applied_at: now(), updated_at: now() };
  db.prepare('INSERT INTO applications VALUES (@id,@team_id,@created_by,@company,@role,@location,@url,@status,@salary,@next_step,@notes,@applied_at,@updated_at)').run(application);
  res.status(201).json(application);
});

app.patch('/api/applications/:id', auth, (req, res) => {
  const team = teamFor(req.user.userId); const current = db.prepare('SELECT * FROM applications WHERE id=? AND team_id=?').get(req.params.id, team?.id);
  if (!current) return res.status(404).json({ error: 'Application not found.' });
  const fields = ['company', 'role', 'location', 'url', 'status', 'salary', 'next_step', 'notes'];
  const updates = Object.fromEntries(fields.map(field => [field, req.body[field] ?? current[field]]));
  db.prepare(`UPDATE applications SET ${fields.map(f => `${f}=@${f}`).join(', ')}, updated_at=@updated_at WHERE id=@id`).run({ ...updates, updated_at: now(), id: current.id });
  res.json(db.prepare('SELECT * FROM applications WHERE id=?').get(current.id));
});

app.delete('/api/applications/:id', auth, (req, res) => { const team = teamFor(req.user.userId); const result = db.prepare('DELETE FROM applications WHERE id=? AND team_id=?').run(req.params.id, team?.id); res.status(result.changes ? 204 : 404).end(); });

app.post('/api/events', auth, (req, res) => { db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(id(), req.user.userId, req.body.name || 'unknown', JSON.stringify(req.body.properties || {}), now()); res.status(204).end(); });

app.get('/api/analytics/summary', auth, (req, res) => {
  const team = teamFor(req.user.userId); const summary = db.prepare("SELECT status, COUNT(*) AS count FROM applications WHERE team_id=? GROUP BY status").all(team?.id);
  res.json({ pipeline: summary, total: summary.reduce((sum, item) => sum + item.count, 0) });
});

app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: 'Unexpected server error.' }); });
app.listen(port, () => console.log(`CareerBoard running on http://localhost:${port}`));
