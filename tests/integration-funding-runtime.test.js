const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-kecil-integration-runtime-'));
process.env.DATA_DIR = path.join(temp, 'data');
process.env.BACKUP_DIR = path.join(temp, 'backups');
process.env.APP_PEPPER = 'integration-runtime-test-pepper';
process.env.INITIAL_ADMIN_PASSWORD = 'TestAdmin123';
process.env.KAS_BESAR_INTEGRATION_KEY = 'integration-runtime-test-key';

const dbmod = require('../src/db');
const { createFunding } = require('../src/integration-server');

test('pendanaan Kas Besar membuat satu transaksi dan satu ledger entry', () => {
  const recipient = dbmod.db.prepare("SELECT * FROM users WHERE active=1 ORDER BY created_at LIMIT 1").get();
  const period = dbmod.db.prepare("SELECT * FROM accounting_periods WHERE status='OPEN' ORDER BY period_month DESC LIMIT 1").get();
  assert.ok(recipient);
  assert.ok(period);

  const integrationId = 'KB-TEST-000001';
  const transactionDate = `${period.period_month}-01`;
  const first = createFunding({
    integrationId,
    transactionDate,
    amount: 100000,
    recipientUserId: recipient.id,
    description: 'Test pendanaan Kas Kecil',
    counterparty: 'Kas Besar',
    referenceNo: 'TRF-TEST-000001'
  });

  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);

  const txCount = dbmod.db.prepare("SELECT COUNT(*) AS total FROM transactions WHERE source_type='KAS_BESAR' AND source_id=?").get(integrationId).total;
  const ledgerCount = dbmod.db.prepare("SELECT COUNT(*) AS total FROM ledger_entries WHERE source_type='TRANSACTION' AND source_id=?").get(first.transactionId).total;
  assert.equal(Number(txCount), 1);
  assert.equal(Number(ledgerCount), 1);

  const second = createFunding({
    integrationId,
    transactionDate,
    amount: 100000,
    recipientUserId: recipient.id,
    description: 'Test pendanaan Kas Kecil',
    counterparty: 'Kas Besar',
    referenceNo: 'TRF-TEST-000001'
  });

  assert.equal(second.duplicate, true);
  const txCountAfterRetry = dbmod.db.prepare("SELECT COUNT(*) AS total FROM transactions WHERE source_type='KAS_BESAR' AND source_id=?").get(integrationId).total;
  const ledgerCountAfterRetry = dbmod.db.prepare("SELECT COUNT(*) AS total FROM ledger_entries WHERE source_type='TRANSACTION' AND source_id=?").get(first.transactionId).total;
  assert.equal(Number(txCountAfterRetry), 1);
  assert.equal(Number(ledgerCountAfterRetry), 1);
});

test.after(() => {
  try { dbmod.db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
