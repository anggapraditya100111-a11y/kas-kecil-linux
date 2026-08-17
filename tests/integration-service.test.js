const test = require('node:test');
const assert = require('node:assert/strict');

// Static guardrails for the Kas Besar integration service.
// Full DB-level integration tests are added when the Kas Besar application is connected.

test('integration environment variable is not hard-coded', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/integration-server'), 'utf8');
  assert.match(source, /process\.env\.KAS_BESAR_INTEGRATION_KEY/);
  assert.doesNotMatch(source, /X-Integration-Key['"]\s*:\s*['"][^'"]+['"]/);
});

test('funding integration is idempotent by source id', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/integration-server'), 'utf8');
  assert.match(source, /(?:t\.)?source_type='KAS_BESAR' AND (?:t\.)?source_id=\?/);
  assert.match(source, /if \(existing\) return fundingResponse\(existing, true\)/);
});
