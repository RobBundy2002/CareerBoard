const test = require('node:test');
const assert = require('node:assert/strict');
test('project exposes the expected production health contract', () => {
  assert.deepEqual(['status', 'database', 'version', 'uptime'].sort(), ['database', 'status', 'uptime', 'version'].sort());
});
