const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('members cannot read another team through a valid session', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'careerboard-auth-'));
  const databasePath = path.join(dataDir, 'test.sqlite');
  const port = 32000 + (process.pid % 1000);
  const server = spawn(process.execPath, ['index.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: databasePath, PORT: String(port), JWT_SECRET: 'test-secret' }, stdio: 'ignore' });
  const baseUrl = `http://127.0.0.1:${port}`;
  const request = (url, options) => fetch(`${baseUrl}${url}`, { ...options, headers: { 'content-type': 'application/json', ...(options?.headers || {}) } });
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const register = async (name, email) => request('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password: 'correct-horse-battery-staple', teamName: `${name}'s team` }) }).then(response => response.json());
    const alice = await register('Alice', 'alice@example.com');
    const bob = await register('Bob', 'bob@example.com');
    const response = await request(`/api/teams/${bob.team.id}/members`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'You are not a member of this team.' });
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
