const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const app = express();
const port = Number(process.env.PORT || 3000);
const startedAt = Date.now();
const db = new Database(process.env.DATABASE_PATH || path.join(__dirname, 'data.sqlite'));
const jwtSecret = process.env.JWT_SECRET || 'development-only-change-me';
const roles = ['owner', 'admin', 'member'];
const statuses = ['Saved', 'Applied', 'Interview', 'Offer', 'Rejected'];

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS team_members (team_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), joined_at TEXT NOT NULL, PRIMARY KEY(team_id,user_id));
  CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, accepted_at TEXT);
  CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, website TEXT DEFAULT '', UNIQUE(name));
  CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT DEFAULT '', location TEXT DEFAULT '');
  CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, job_id TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Applied', salary TEXT DEFAULT '', next_step TEXT DEFAULT '', notes TEXT DEFAULT '', applied_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, application_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS interviews (id TEXT PRIMARY KEY, application_id TEXT NOT NULL, scheduled_at TEXT NOT NULL, kind TEXT DEFAULT 'Interview', notes TEXT DEFAULT '', created_by TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, application_id TEXT, user_id TEXT NOT NULL, action TEXT NOT NULL, metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, team_id TEXT, user_id TEXT, name TEXT NOT NULL, properties TEXT DEFAULT '{}', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS revoked_tokens (jti TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs_queue (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, run_after TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, team_id TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, read_at TEXT, created_at TEXT NOT NULL);
`);

// Existing installations may have been created before joined_at was added.
// CREATE TABLE IF NOT EXISTS does not update an existing table's schema.
const teamMemberColumns = db.prepare('PRAGMA table_info(team_members)').all();
if (!teamMemberColumns.some(column => column.name === 'joined_at')) {
  db.exec("ALTER TABLE team_members ADD COLUMN joined_at TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE team_members SET joined_at = COALESCE((SELECT created_at FROM teams WHERE teams.id = team_members.team_id), datetime('now')) WHERE joined_at = ''");
}

// Migrate the original denormalized applications table to the current model.
// Older databases stored company, role, and created_by directly on applications.
const applicationColumns = db.prepare('PRAGMA table_info(applications)').all();
if (!applicationColumns.some(column => column.name === 'job_id')) {
  db.transaction(() => {
    db.exec('ALTER TABLE applications RENAME TO applications_legacy');
    db.exec("CREATE TABLE applications (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, job_id TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Applied', salary TEXT DEFAULT '', next_step TEXT DEFAULT '', notes TEXT DEFAULT '', applied_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const legacyApplications = db.prepare('SELECT * FROM applications_legacy').all();
    const companyIds = new Map();
    for (const application of legacyApplications) {
      let companyId = companyIds.get(application.company);
      if (!companyId) {
        const existingCompany = db.prepare('SELECT id FROM companies WHERE name=?').get(application.company);
        companyId = existingCompany?.id || crypto.randomUUID();
        if (!existingCompany) db.prepare('INSERT INTO companies (id,name,website) VALUES (?,?,?)').run(companyId, application.company, '');
        companyIds.set(application.company, companyId);
      }
      const jobId = crypto.randomUUID();
      db.prepare('INSERT INTO jobs (id,company_id,title,url,location) VALUES (?,?,?,?,?)').run(jobId, companyId, application.role, application.url || '', application.location || '');
      db.prepare('INSERT INTO applications (id,team_id,job_id,owner_id,status,salary,next_step,notes,applied_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(application.id, application.team_id, jobId, application.created_by, application.status, application.salary || '', application.next_step || '', application.notes || '', application.applied_at, application.updated_at);
    }
    db.exec('DROP TABLE applications_legacy');
  })();
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const hash = (value, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(value, salt, 64).toString('hex')}`;
const verifyHash = (value, stored) => { const [salt, key] = stored.split(':'); const actual = crypto.scryptSync(value, salt, 64); return key && crypto.timingSafeEqual(Buffer.from(key, 'hex'), actual); };
const publicUser = user => ({ id: user.id, name: user.name, email: user.email });
const tokenFor = user => jwt.sign({ userId: user.id, jti: id() }, jwtSecret, { expiresIn: '7d' });
const bodyText = value => typeof value === 'string' ? value.trim() : '';

function seedDemoData() {
  const demoTeam = { id: 'demo-team', name: 'The Next Chapter', created_at: '2026-01-05T09:00:00.000Z' };
  const names = ['Maya Chen', 'Jordan Lee', 'Avery Brooks', 'Sam Rivera', 'Priya Shah', 'Noah Williams', 'Elena Rossi', 'Theo Martin', 'Grace Kim', 'Marcus Johnson', 'Sofia Alvarez', 'Ben Carter'];
  const companies = ['Linear', 'Notion', 'Stripe', 'Vercel', 'Figma', 'Loom', 'Arc', 'Ramp', 'Airbnb', 'Dropbox', 'Webflow', 'Plaid', 'OpenAI', 'GitLab', 'Mercury', 'Anthropic', 'Brex', 'Asana'];
  const roles = ['Product Designer', 'Frontend Engineer', 'Growth Lead', 'Product Manager', 'Researcher', 'Operations Manager', 'Content Strategist', 'Data Analyst'];
  const statusesForDemo = ['Offer', 'Offer', ...Array(9).fill('Interview'), ...Array(20).fill('Applied'), ...Array(10).fill('Saved'), ...Array(6).fill('Rejected')];
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO teams (id,name,created_at) VALUES (?,?,?)').run(demoTeam.id, demoTeam.name, demoTeam.created_at);
    names.forEach((name, index) => {
      const user = { id: `demo-user-${String(index + 1).padStart(2, '0')}`, name, email: `demo${index + 1}@careerboard.local`, password_hash: hash('demo-password-2026'), created_at: '2026-01-05T09:00:00.000Z' };
      db.prepare('INSERT OR IGNORE INTO users (id,name,email,password_hash,created_at) VALUES (@id,@name,@email,@password_hash,@created_at)').run(user);
      db.prepare('INSERT OR IGNORE INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,?,?)').run(demoTeam.id, user.id, index === 0 ? 'owner' : index < 3 ? 'admin' : 'member', `2026-01-${String(5 + index).padStart(2, '0')}T09:00:00.000Z`);
    });
    companies.forEach((name, index) => db.prepare('INSERT OR IGNORE INTO companies (id,name,website) VALUES (?,?,?)').run(`demo-company-${String(index + 1).padStart(2, '0')}`, name, `https://${name.toLowerCase().replace(/[^a-z]+/g, '')}.com`));
    for (let index = 0; index < 47; index += 1) {
      const appId = `demo-application-${String(index + 1).padStart(2, '0')}`;
      const companyId = `demo-company-${String((index % companies.length) + 1).padStart(2, '0')}`;
      const jobId = `demo-job-${String(index + 1).padStart(2, '0')}`;
      const ownerId = `demo-user-${String((index % names.length) + 1).padStart(2, '0')}`;
      const appliedAt = `2026-02-${String((index % 26) + 1).padStart(2, '0')}T10:00:00.000Z`;
      db.prepare('INSERT OR IGNORE INTO jobs (id,company_id,title,url,location) VALUES (?,?,?,?,?)').run(jobId, companyId, roles[index % roles.length], `https://example.com/demo/${index + 1}`, ['Remote', 'New York', 'San Francisco', 'London'][index % 4]);
      db.prepare('INSERT OR IGNORE INTO applications (id,team_id,job_id,owner_id,status,salary,next_step,notes,applied_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(appId, demoTeam.id, jobId, ownerId, statusesForDemo[index], index % 3 === 0 ? '$120k–$165k' : '', statusesForDemo[index] === 'Interview' ? 'Prepare story bank' : statusesForDemo[index] === 'Offer' ? 'Review the offer' : '', index % 4 === 0 ? 'A strong mission fit and a thoughtful team.' : '', appliedAt, appliedAt);
      if (index < 9) db.prepare('INSERT OR IGNORE INTO interviews (id,application_id,scheduled_at,kind,notes,created_by) VALUES (?,?,?,?,?,?)').run(`demo-interview-${String(index + 1).padStart(2, '0')}`, appId, `2026-03-${String(index + 10).padStart(2, '0')}T16:00:00.000Z`, index % 2 ? 'Panel' : 'Hiring manager', 'Bring portfolio and questions.', ownerId);
      if (index < 12) db.prepare('INSERT OR IGNORE INTO comments (id,application_id,user_id,body,created_at) VALUES (?,?,?,?,?)').run(`demo-comment-${String(index + 1).padStart(2, '0')}`, appId, `demo-user-${String((index + 2) % names.length + 1).padStart(2, '0')}`, index < 2 ? 'This one feels like a real fit. Let us know how we can help.' : 'Shared the role with the group — good luck!', `2026-03-${String((index % 9) + 1).padStart(2, '0')}T12:00:00.000Z`);
      db.prepare('INSERT OR IGNORE INTO activity (id,team_id,application_id,user_id,action,metadata,created_at) VALUES (?,?,?,?,?,?,?)').run(`demo-activity-${String(index + 1).padStart(2, '0')}`, demoTeam.id, appId, ownerId, index < 2 ? 'received an offer' : statusesForDemo[index] === 'Interview' ? 'moved an application to Interview' : 'added an application', '{}', appliedAt);
    }
  })();
  return db.prepare('SELECT * FROM users WHERE id=?').get('demo-user-01');
}

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    req.user = jwt.verify(token, jwtSecret);
    if (db.prepare('SELECT jti FROM revoked_tokens WHERE jti=?').get(req.user.jti)) throw new Error('revoked');
    next();
  } catch { res.status(401).json({ error: 'Please sign in to continue.' }); }
}
function membership(userId, teamId) { return db.prepare('SELECT tm.*, t.name FROM team_members tm JOIN teams t ON t.id=tm.team_id WHERE tm.user_id=? AND tm.team_id=?').get(userId, teamId); }
function teamFor(userId) { return db.prepare('SELECT t.*, tm.role FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? ORDER BY t.created_at LIMIT 1').get(userId); }
function requireRole(...allowed) { return (req, res, next) => { const teamId = req.params.teamId || req.body.teamId || teamFor(req.user.userId)?.id; const member = membership(req.user.userId, teamId); if (!member) return res.status(403).json({ error: 'You are not a member of this team.' }); if (!allowed.includes(member.role)) return res.status(403).json({ error: 'Your team role cannot perform this action.' }); req.team = { id: teamId, name: member.name, role: member.role }; next(); }; }
function recordActivity(teamId, userId, action, applicationId = null, metadata = {}) { db.prepare('INSERT INTO activity VALUES (?,?,?,?,?,?,?)').run(id(), teamId, applicationId, userId, action, JSON.stringify(metadata), now()); }
function recordEvent(teamId, userId, name, properties = {}) { db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(id(), teamId, userId, name, JSON.stringify(properties), now()); }
function enqueueJob(type, payload) { db.prepare('INSERT INTO jobs_queue VALUES (?,?,?,?,?,?,?)').run(id(), type, JSON.stringify(payload), 'pending', 0, now(), now()); }
function enqueueNotification(userId, teamId, type, message) { if (userId) enqueueJob('notification.created', { userId, teamId, type, message }); }
function applicationView(row) { return { ...row, company: row.company_name, role: row.job_title }; }
const applicationQuery = `SELECT a.*, c.name company_name, c.website, j.title job_title, j.url job_url, j.location, u.name owner_name FROM applications a JOIN jobs j ON j.id=a.job_id JOIN companies c ON c.id=j.company_id JOIN users u ON u.id=a.owner_id`;

app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: 'ok', version: process.env.APP_VERSION || '1.0.0', uptime: Math.floor((Date.now() - startedAt) / 1000) }));
app.get('/api/ready', (_req, res) => { try { db.prepare('SELECT 1').get(); res.json({ status: 'ready', database: 'ok' }); } catch { res.status(503).json({ status: 'not_ready', database: 'error' }); } });

app.post('/api/auth/demo', (_req, res) => { const user = seedDemoData(); res.json({ token: tokenFor(user), user: publicUser(user), team: { id: 'demo-team', name: 'The Next Chapter', role: 'owner' } }); });

app.post('/api/auth/register', (req, res) => {
  const name = bodyText(req.body.name); const email = bodyText(req.body.email).toLowerCase(); const password = req.body.password; const teamName = bodyText(req.body.teamName) || 'My job search';
  if (!name || !email.includes('@') || typeof password !== 'string' || password.length < 10) return res.status(400).json({ error: 'Name, valid email, and a 10+ character password are required.' });
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'An account with that email already exists.' });
  const user = { id: id(), name, email, password_hash: hash(password), created_at: now() }; const team = { id: id(), name: teamName, created_at: now() };
  db.transaction(() => { db.prepare('INSERT INTO users VALUES (@id,@name,@email,@password_hash,@created_at)').run(user); db.prepare('INSERT INTO teams VALUES (@id,@name,@created_at)').run(team); db.prepare('INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,?,?)').run(team.id, user.id, 'owner', now()); })();
  res.status(201).json({ token: tokenFor(user), user: publicUser(user), team: { ...team, role: 'owner' } });
});
app.post('/api/auth/login', (req, res) => { const user = db.prepare('SELECT * FROM users WHERE email=?').get(bodyText(req.body.email).toLowerCase()); if (!user || !req.body.password || !verifyHash(req.body.password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password.' }); res.json({ token: tokenFor(user), user: publicUser(user), team: teamFor(user.id) }); });
app.post('/api/auth/logout', auth, (req, res) => { db.prepare('INSERT OR REPLACE INTO revoked_tokens VALUES (?,?)').run(req.user.jti, new Date(req.user.exp * 1000).toISOString()); res.status(204).end(); });
app.get('/api/me', auth, (req, res) => { const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId); res.json({ user: publicUser(user), teams: db.prepare('SELECT t.*,tm.role FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=?').all(user.id) }); });
app.get('/api/notifications', auth, (req, res) => res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.userId)));
app.post('/api/notifications/:id/read', auth, (req, res) => { db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(now(), req.params.id, req.user.userId); res.status(204).end(); });

app.get('/api/teams/:teamId/members', auth, requireRole('owner', 'admin', 'member'), (req, res) => res.json(db.prepare('SELECT u.id,u.name,u.email,tm.role,tm.joined_at FROM users u JOIN team_members tm ON tm.user_id=u.id WHERE tm.team_id=? ORDER BY tm.joined_at').all(req.team.id)));
app.post('/api/teams/:teamId/invitations', auth, requireRole('owner', 'admin'), (req, res) => { const email = bodyText(req.body.email).toLowerCase(); const role = roles.includes(req.body.role) && req.body.role !== 'owner' ? req.body.role : 'member'; if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required.' }); const rawToken = crypto.randomBytes(32).toString('hex'); db.prepare('INSERT INTO invitations VALUES (?,?,?,?,?,?,?,?)').run(id(), req.team.id, email, role, req.user.userId, hash(rawToken), new Date(Date.now() + 7 * 864e5).toISOString(), null); recordActivity(req.team.id, req.user.userId, 'invited a member', null, { email, role }); recordEvent(req.team.id, req.user.userId, 'user_invited', { role }); res.status(201).json({ email, role, inviteToken: rawToken, message: 'Share this one-time invite token with the teammate.' }); });
app.post('/api/invitations/accept', auth, (req, res) => { const user = db.prepare('SELECT email FROM users WHERE id=?').get(req.user.userId); const invitation = db.prepare('SELECT * FROM invitations WHERE email=? AND accepted_at IS NULL AND expires_at>? ORDER BY expires_at DESC').get(user.email, now()); const match = invitation && verifyHash(bodyText(req.body.inviteToken), invitation.token_hash) ? invitation : null; if (!match) return res.status(400).json({ error: 'Invite token is invalid, expired, or not for this account.' }); db.transaction(() => { db.prepare('INSERT OR IGNORE INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,?,?)').run(match.team_id, req.user.userId, match.role, now()); db.prepare('UPDATE invitations SET accepted_at=? WHERE id=?').run(now(), match.id); })(); recordActivity(match.team_id, req.user.userId, 'joined the team'); res.json({ ok: true, team: db.prepare('SELECT * FROM teams WHERE id=?').get(match.team_id) }); });
app.post('/api/teams/:teamId/members/:userId/role', auth, requireRole('owner', 'admin'), (req, res) => { const role = req.body.role; if (!roles.includes(role) || role === 'owner' && req.team.role !== 'owner') return res.status(400).json({ error: 'Invalid role change.' }); const target = membership(req.params.userId, req.team.id); if (!target || target.role === 'owner') return res.status(400).json({ error: 'That member cannot be changed.' }); db.prepare('UPDATE team_members SET role=? WHERE team_id=? AND user_id=?').run(role, req.team.id, req.params.userId); recordActivity(req.team.id, req.user.userId, `changed ${req.params.userId} role to ${role}`); res.json({ ok: true }); });
app.delete('/api/teams/:teamId/members/:userId', auth, requireRole('owner', 'admin'), (req, res) => { const result = db.prepare("DELETE FROM team_members WHERE team_id=? AND user_id=? AND role!='owner'").run(req.team.id, req.params.userId); if (!result.changes) return res.status(404).json({ error: 'Member not found or protected.' }); recordActivity(req.team.id, req.user.userId, 'removed a member'); res.status(204).end(); });

app.get('/api/applications', auth, requireRole('owner', 'admin', 'member'), (req, res) => res.json(db.prepare(`${applicationQuery} WHERE a.team_id=? ORDER BY a.updated_at DESC`).all(req.team.id).map(applicationView)));
app.post('/api/applications', auth, requireRole('owner', 'admin', 'member'), (req, res) => {
  const company = bodyText(req.body.company); const role = bodyText(req.body.role); const status = statuses.includes(req.body.status) ? req.body.status : 'Applied'; if (!company || !role) return res.status(400).json({ error: 'Company and role are required.' });
  let companyRow = db.prepare('SELECT * FROM companies WHERE name=?').get(company); if (!companyRow) { companyRow = { id: id(), name: company, website: bodyText(req.body.website) }; db.prepare('INSERT INTO companies VALUES (?,?,?)').run(companyRow.id, companyRow.name, companyRow.website); }
  const job = { id: id(), company_id: companyRow.id, title: role, url: bodyText(req.body.url), location: bodyText(req.body.location) }; db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run(job.id, job.company_id, job.title, job.url, job.location);
  const application = { id: id(), team_id: req.team.id, job_id: job.id, owner_id: req.body.ownerId && membership(req.body.ownerId, req.team.id) ? req.body.ownerId : req.user.userId, status, salary: bodyText(req.body.salary), next_step: bodyText(req.body.next_step), notes: bodyText(req.body.notes), applied_at: now(), updated_at: now() };
  db.prepare('INSERT INTO applications VALUES (?,?,?,?,?,?,?,?,?,?)').run(Object.values(application)); recordActivity(req.team.id, req.user.userId, 'created an application', application.id, { company, role }); recordEvent(req.team.id, req.user.userId, 'application_created', { status }); res.status(201).json(applicationView(db.prepare(`${applicationQuery} WHERE a.id=?`).get(application.id)));
});
app.patch('/api/applications/:id', auth, requireRole('owner', 'admin', 'member'), (req, res) => {
  const current = db.prepare(`${applicationQuery} WHERE a.id=? AND a.team_id=?`).get(req.params.id, req.team.id); if (!current) return res.status(404).json({ error: 'Application not found in this team.' }); if (req.team.role === 'member' && current.owner_id !== req.user.userId) return res.status(403).json({ error: 'Members can only update their own applications.' });
  const status = req.body.status && statuses.includes(req.body.status) ? req.body.status : current.status; const fields = { status, salary: bodyText(req.body.salary ?? current.salary), next_step: bodyText(req.body.next_step ?? current.next_step), notes: bodyText(req.body.notes ?? current.notes), updated_at: now(), id: current.id };
  db.prepare('UPDATE applications SET status=@status,salary=@salary,next_step=@next_step,notes=@notes,updated_at=@updated_at WHERE id=@id').run(fields); if (status !== current.status) { recordActivity(req.team.id, req.user.userId, `changed status ${current.status} → ${status}`, current.id); recordEvent(req.team.id, req.user.userId, 'application_status_changed', { from: current.status, to: status }); } else recordActivity(req.team.id, req.user.userId, 'updated an application', current.id); res.json(applicationView(db.prepare(`${applicationQuery} WHERE a.id=?`).get(current.id)));
});
app.delete('/api/applications/:id', auth, requireRole('owner', 'admin'), (req, res) => { const result = db.prepare('DELETE FROM applications WHERE id=? AND team_id=?').run(req.params.id, req.team.id); if (!result.changes) return res.status(404).json({ error: 'Application not found.' }); recordActivity(req.team.id, req.user.userId, 'deleted an application', req.params.id); res.status(204).end(); });

app.get('/api/applications/:id/activity', auth, requireRole('owner', 'admin', 'member'), (req, res) => { const appRow = db.prepare('SELECT id FROM applications WHERE id=? AND team_id=?').get(req.params.id, req.team.id); if (!appRow) return res.status(404).json({ error: 'Application not found.' }); res.json(db.prepare('SELECT a.*,u.name user_name FROM activity a JOIN users u ON u.id=a.user_id WHERE a.application_id=? ORDER BY a.created_at DESC').all(req.params.id)); });
app.get('/api/applications/:id/comments', auth, requireRole('owner', 'admin', 'member'), (req, res) => { res.json(db.prepare('SELECT c.*,u.name user_name FROM comments c JOIN users u ON u.id=c.user_id JOIN applications a ON a.id=c.application_id WHERE c.application_id=? AND a.team_id=? ORDER BY c.created_at').all(req.params.id, req.team.id)); });
app.post('/api/applications/:id/comments', auth, requireRole('owner', 'admin', 'member'), (req, res) => { const body = bodyText(req.body.body); const appRow = db.prepare('SELECT id,owner_id FROM applications WHERE id=? AND team_id=?').get(req.params.id, req.team.id); if (!appRow || !body) return res.status(400).json({ error: 'Application and comment text are required.' }); db.prepare('INSERT INTO comments VALUES (?,?,?,?,?)').run(id(), req.params.id, req.user.userId, body, now()); recordActivity(req.team.id, req.user.userId, 'added a comment', req.params.id); enqueueNotification(appRow.owner_id === req.user.userId ? null : appRow.owner_id, req.team.id, 'comment', 'A teammate commented on your application.'); res.status(201).json({ ok: true }); });
app.post('/api/applications/:id/interviews', auth, requireRole('owner', 'admin', 'member'), (req, res) => { const scheduledAt = new Date(req.body.scheduledAt); if (Number.isNaN(scheduledAt.valueOf())) return res.status(400).json({ error: 'A valid interview date is required.' }); const appRow = db.prepare('SELECT id,owner_id FROM applications WHERE id=? AND team_id=?').get(req.params.id, req.team.id); if (!appRow) return res.status(404).json({ error: 'Application not found.' }); db.prepare('INSERT INTO interviews VALUES (?,?,?,?,?,?)').run(id(), req.params.id, scheduledAt.toISOString(), bodyText(req.body.kind) || 'Interview', bodyText(req.body.notes), req.user.userId); recordActivity(req.team.id, req.user.userId, 'scheduled an interview', req.params.id, { scheduledAt: scheduledAt.toISOString() }); enqueueNotification(appRow.owner_id === req.user.userId ? null : appRow.owner_id, req.team.id, 'interview', `Interview scheduled for ${scheduledAt.toLocaleString()}.`); recordEvent(req.team.id, req.user.userId, 'interview_scheduled'); res.status(201).json({ ok: true }); });

app.post('/api/events', auth, requireRole('owner', 'admin', 'member'), (req, res) => { recordEvent(req.team.id, req.user.userId, bodyText(req.body.name) || 'unknown', req.body.properties || {}); res.status(204).end(); });
app.get('/api/analytics/summary', auth, requireRole('owner', 'admin', 'member'), (req, res) => { const pipeline = db.prepare('SELECT status,COUNT(*) count FROM applications WHERE team_id=? GROUP BY status').all(req.team.id); const total = pipeline.reduce((n, item) => n + item.count, 0); const interviews = db.prepare("SELECT COUNT(*) count FROM applications WHERE team_id=? AND status='Interview'").get(req.team.id).count; const offers = db.prepare("SELECT COUNT(*) count FROM applications WHERE team_id=? AND status='Offer'").get(req.team.id).count; const month = db.prepare("SELECT COUNT(*) count FROM applications WHERE team_id=? AND applied_at >= date('now','start of month')").get(req.team.id).count; res.json({ total, interviews, offers, responseRate: total ? Math.round((interviews + offers) / total * 100) : 0, thisMonth: month, pipeline }); });
app.get('/api/activity', auth, requireRole('owner', 'admin', 'member'), (req, res) => res.json(db.prepare('SELECT a.*,u.name user_name FROM activity a JOIN users u ON u.id=a.user_id WHERE a.team_id=? ORDER BY a.created_at DESC LIMIT 50').all(req.team.id)));

setInterval(() => { const jobs = db.prepare("SELECT * FROM jobs_queue WHERE status='pending' AND run_after<=? ORDER BY created_at LIMIT 20").all(now()); for (const job of jobs) { try { const payload = JSON.parse(job.payload); if (job.type === 'notification.created') db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,?)').run(id(), payload.userId, payload.teamId, payload.type, payload.message, null, now()); db.prepare("UPDATE jobs_queue SET status='complete',attempts=attempts+1 WHERE id=?").run(job.id); } catch (error) { console.error(JSON.stringify({ job: job.id, error: error.message })); db.prepare("UPDATE jobs_queue SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,attempts=attempts+1,run_after=datetime('now','+1 minute') WHERE id=?").run(job.id); } } db.prepare("DELETE FROM revoked_tokens WHERE expires_at<?").run(now()); }, 30_000).unref();

app.use((error, _req, res, _next) => { console.error(JSON.stringify({ error: error.message, stack: error.stack })); res.status(500).json({ error: 'Unexpected server error.' }); });
app.listen(port, '0.0.0.0', () => console.log(`CareerBoard running on http://localhost:${port}`));
