const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('database v1.0 dimigrasikan tanpa kehilangan transaksi', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ainet-migration-v10-'));
  process.env.DATA_DIR = path.join(runtime, 'data');
  process.env.BACKUP_DIR = path.join(runtime, 'backups');
  process.env.APP_PEPPER = 'migration-test-pepper-1234567890';
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

  const file = path.join(process.env.DATA_DIR, 'kas-kecil.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('STAFF','SPV','SUPER_USER')),active INTEGER NOT NULL DEFAULT 1,last_login TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,transaction_scope TEXT NOT NULL,
      approval_limit INTEGER NOT NULL DEFAULT 0,receipt_required INTEGER NOT NULL DEFAULT 1,active INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,transaction_no TEXT NOT NULL UNIQUE,transaction_date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('MASUK','KELUAR')),account_id TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount > 0),
      approval_limit_snapshot INTEGER NOT NULL DEFAULT 0,description TEXT NOT NULL,counterparty TEXT,receipt_path TEXT,
      receipt_original_name TEXT,receipt_mime TEXT,status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')),
      created_by TEXT NOT NULL,created_at TEXT NOT NULL,approved_by TEXT,approved_at TEXT,rejection_reason TEXT
    );
    INSERT INTO users VALUES('USR-OLD','Staff Lama','staff.lama','hash','salt','STAFF',1,NULL,'2026-01-01','2026-01-01');
    INSERT INTO accounts VALUES('ACC-OLD','OPS','Operasional','KELUAR',500,1,1,NULL,'2026-01-01','2026-01-01');
    INSERT INTO transactions VALUES('TX-OLD','KK-20260101-0001','2026-01-01','KELUAR','ACC-OLD',100,500,'Data lama',NULL,NULL,NULL,NULL,'APPROVED','USR-OLD','2026-01-01',NULL,NULL,NULL);
  `);
  legacy.close();

  const { db } = require('../src/db');
  const row = db.prepare('SELECT * FROM transactions WHERE id=?').get('TX-OLD');
  assert.equal(row.amount, 100);
  assert.equal(row.cash_effect, 1);
  assert.equal(row.source_type, 'DIRECT');
  assert.doesNotThrow(() => db.prepare("UPDATE transactions SET status='CORRECTED' WHERE id='TX-OLD'").run());
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM ledger_entries WHERE source_id='TX-OLD'").get().total, 1);
  assert(db.prepare('PRAGMA table_info(approval_requests)').all().some(column => column.name === 'token_ciphertext'));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='THEME_COLOR'").get().value, '#1d4ed8');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='COMPANY_LOGO_FILE'").get().value, '');
  assert(db.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'underlying_required'));
  assert(db.prepare('PRAGMA table_info(transactions)').all().some(column => column.name === 'underlying_path'));
  for (const table of ['accounting_periods', 'period_balances', 'cash_budgets', 'cash_budget_allocations']) {
    assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} belum dibuat`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM accounting_periods WHERE status='OPEN'").get().total, 1);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
