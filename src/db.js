const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PERMISSION_CATALOG, effectivePermissions } = require('./permissions');
const { hashPassword, assertPassword, newId } = require('./security');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'kas-kecil.sqlite');
const db = new DatabaseSync(DB_PATH, { timeout: 5000 });
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.transaction = function transaction(handler) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = handler(...args);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (ignored) {}
      throw error;
    }
  };
};

function nowIso() {
  return new Date().toISOString();
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      approval_pin_hash TEXT,
      approval_pin_salt TEXT,
      approval_pin_fingerprint TEXT,
      role TEXT NOT NULL CHECK(role IN ('STAFF','SPV','SUPER_USER')),
      active INTEGER NOT NULL DEFAULT 1,
      last_login TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id TEXT NOT NULL,
      permission_code TEXT NOT NULL,
      allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, permission_code),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      transaction_scope TEXT NOT NULL CHECK(transaction_scope IN ('MASUK','KELUAR','BOTH')),
      approval_limit INTEGER NOT NULL DEFAULT 0,
      receipt_required INTEGER NOT NULL DEFAULT 1,
      underlying_required INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      transaction_no TEXT NOT NULL UNIQUE,
      transaction_date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('MASUK','KELUAR','PENYESUAIAN')),
      account_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      approval_limit_snapshot INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL,
      counterparty TEXT,
      receipt_path TEXT,
      receipt_original_name TEXT,
      receipt_mime TEXT,
      underlying_path TEXT,
      underlying_original_name TEXT,
      underlying_mime TEXT,
      status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','CORRECTED')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      rejection_reason TEXT,
      corrected_from_id TEXT,
      cash_effect INTEGER NOT NULL DEFAULT 1,
      source_type TEXT NOT NULL DEFAULT 'DIRECT',
      source_id TEXT,
      FOREIGN KEY(account_id) REFERENCES accounts(id),
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(approved_by) REFERENCES users(id),
      FOREIGN KEY(corrected_from_id) REFERENCES transactions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_creator ON transactions(created_by);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'PENDING' CHECK(decision IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
      decision_by TEXT,
      decision_at TEXT,
      note TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(transaction_id) REFERENCES transactions(id),
      FOREIGN KEY(decision_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('TRANSACTION','TRANSFER','CORRECTION','UMO_ISSUE','UMO_SETTLEMENT')),
      entity_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_ciphertext TEXT,
      expires_at TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'PENDING' CHECK(decision IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
      decision_by TEXT,
      decision_at TEXT,
      note TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(entity_type, entity_id),
      FOREIGN KEY(decision_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_approval_requests_pending ON approval_requests(decision, expires_at);

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('IN','OUT')),
      amount INTEGER NOT NULL CHECK(amount > 0),
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      reference_no TEXT NOT NULL,
      description TEXT NOT NULL,
      account_id TEXT,
      counterpart_user_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source_type, source_id, user_id, direction),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(account_id) REFERENCES accounts(id),
      FOREIGN KEY(counterpart_user_id) REFERENCES users(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user_date ON ledger_entries(user_id, entry_date, created_at);

    CREATE TABLE IF NOT EXISTS cash_transfers (
      id TEXT PRIMARY KEY,
      transfer_no TEXT NOT NULL UNIQUE,
      transfer_date TEXT NOT NULL,
      sender_user_id TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','CORRECTED')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      rejection_reason TEXT,
      FOREIGN KEY(sender_user_id) REFERENCES users(id),
      FOREIGN KEY(recipient_user_id) REFERENCES users(id),
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(approved_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_users ON cash_transfers(sender_user_id, recipient_user_id, transfer_date);

    CREATE TABLE IF NOT EXISTS operational_advances (
      id TEXT PRIMARY KEY,
      umo_no TEXT NOT NULL UNIQUE,
      advance_date TEXT NOT NULL,
      user_id TEXT NOT NULL,
      bearer_name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      advance_amount INTEGER NOT NULL CHECK(advance_amount > 0),
      due_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING','OPEN','SETTLEMENT_PENDING','SETTLED','REJECTED','CORRECTED')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      rejection_reason TEXT,
      settlement_note TEXT,
      settlement_receipt_path TEXT,
      settlement_receipt_name TEXT,
      settlement_receipt_mime TEXT,
      settled_amount INTEGER NOT NULL DEFAULT 0,
      returned_amount INTEGER NOT NULL DEFAULT 0,
      extra_amount INTEGER NOT NULL DEFAULT 0,
      settled_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(approved_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_umo_user_status ON operational_advances(user_id, status, due_date);

    CREATE TABLE IF NOT EXISTS umo_allocations (
      id TEXT PRIMARY KEY,
      umo_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      description TEXT NOT NULL,
      transaction_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(umo_id) REFERENCES operational_advances(id) ON DELETE CASCADE,
      FOREIGN KEY(account_id) REFERENCES accounts(id),
      FOREIGN KEY(transaction_id) REFERENCES transactions(id)
    );

    CREATE TABLE IF NOT EXISTS transaction_corrections (
      id TEXT PRIMARY KEY,
      correction_no TEXT NOT NULL UNIQUE,
      original_transaction_id TEXT NOT NULL,
      correction_type TEXT NOT NULL CHECK(correction_type IN ('REVERSAL','REPLACEMENT')),
      reason TEXT NOT NULL,
      proposed_date TEXT,
      proposed_type TEXT CHECK(proposed_type IN ('MASUK','KELUAR')),
      proposed_account_id TEXT,
      proposed_amount INTEGER,
      proposed_description TEXT,
      proposed_counterparty TEXT,
      proposed_receipt_path TEXT,
      proposed_receipt_name TEXT,
      proposed_receipt_mime TEXT,
      status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      rejection_reason TEXT,
      replacement_transaction_id TEXT,
      FOREIGN KEY(original_transaction_id) REFERENCES transactions(id),
      FOREIGN KEY(proposed_account_id) REFERENCES accounts(id),
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(approved_by) REFERENCES users(id),
      FOREIGN KEY(replacement_transaction_id) REFERENCES transactions(id)
    );

    CREATE TABLE IF NOT EXISTS sequences (
      prefix TEXT PRIMARY KEY,
      last_date TEXT NOT NULL,
      last_sequence INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      value_type TEXT NOT NULL DEFAULT 'TEXT',
      description TEXT,
      updated_by TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      old_value TEXT,
      new_value TEXT,
      description TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);

    CREATE TABLE IF NOT EXISTS accounting_periods (
      id TEXT PRIMARY KEY,
      period_month TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED')),
      opened_at TEXT NOT NULL,
      opened_by TEXT NOT NULL,
      closed_at TEXT,
      closed_by TEXT,
      close_note TEXT,
      reopened_at TEXT,
      reopened_by TEXT,
      reopen_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS period_balances (
      period_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      opening_balance INTEGER NOT NULL DEFAULT 0,
      closing_balance INTEGER,
      PRIMARY KEY(period_id,user_id),
      FOREIGN KEY(period_id) REFERENCES accounting_periods(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS cash_budgets (
      id TEXT PRIMARY KEY,
      period_month TEXT NOT NULL UNIQUE,
      total_budget INTEGER NOT NULL CHECK(total_budget >= 0),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(created_by) REFERENCES users(id),
      FOREIGN KEY(updated_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS cash_budget_allocations (
      budget_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      percentage_bps INTEGER NOT NULL CHECK(percentage_bps >= 0 AND percentage_bps <= 10000),
      allocated_amount INTEGER NOT NULL CHECK(allocated_amount >= 0),
      PRIMARY KEY(budget_id,account_id),
      FOREIGN KEY(budget_id) REFERENCES cash_budgets(id) ON DELETE CASCADE,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
  `);

  rebuildLegacyTransactionsIfNeeded();
  ensureColumn('users', 'approval_pin_hash', 'TEXT');
  ensureColumn('users', 'approval_pin_salt', 'TEXT');
  ensureColumn('users', 'approval_pin_fingerprint', 'TEXT');
  ensureColumn('transactions', 'cash_effect', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('transactions', 'source_type', "TEXT NOT NULL DEFAULT 'DIRECT'");
  ensureColumn('transactions', 'source_id', 'TEXT');
  ensureColumn('approval_requests', 'token_ciphertext', 'TEXT');
  ensureColumn('accounts', 'underlying_required', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('transactions', 'underlying_path', 'TEXT');
  ensureColumn('transactions', 'underlying_original_name', 'TEXT');
  ensureColumn('transactions', 'underlying_mime', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_approval_pin_fingerprint ON users(approval_pin_fingerprint) WHERE approval_pin_fingerprint IS NOT NULL;');

  const defaults = [
    ['APP_NAME', process.env.DEFAULT_APP_NAME || 'Aplikasi Kas Kecil', 'TEXT', 'Nama aplikasi'],
    ['COMPANY_NAME', process.env.DEFAULT_COMPANY_NAME || 'Nama Perusahaan', 'TEXT', 'Nama perusahaan'],
    ['TIMEZONE', 'Asia/Jakarta', 'TEXT', 'Zona waktu'],
    ['OPENING_BALANCE', '0', 'NUMBER', 'Saldo awal'],
    ['SESSION_HOURS', '8', 'NUMBER', 'Durasi sesi'],
    ['UMO_APPROVAL_LIMIT', '500000', 'NUMBER', 'Limit auto-approve Uang Muka Operasional'],
    ['UMO_DUE_DAYS', '3', 'NUMBER', 'Batas pertanggungjawaban UMO dalam hari'],
    ['THEME_COLOR', '#1d4ed8', 'TEXT', 'Warna utama aplikasi'],
    ['COMPANY_LOGO_FILE', '', 'TEXT', 'Nama file logo perusahaan'],
    ['MAX_UPLOAD_MB', '5', 'NUMBER', 'Batas unggahan'],
    ['LAST_TRANSACTION_DATE', '', 'TEXT', 'Tanggal nomor terakhir'],
    ['LAST_TRANSACTION_SEQUENCE', '0', 'NUMBER', 'Urutan nomor terakhir']
  ];
  const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings(key,value,value_type,description,updated_at) VALUES(?,?,?,?,?)`);
  const seedSettings = db.transaction(rows => rows.forEach(row => insertSetting.run(...row, nowIso())));
  seedSettings(defaults);

  db.exec(`
    INSERT OR IGNORE INTO approval_requests(id,entity_type,entity_id,token_hash,expires_at,decision,decision_by,decision_at,note,attempt_count,created_at)
    SELECT id,'TRANSACTION',transaction_id,token_hash,expires_at,decision,decision_by,decision_at,note,attempt_count,
      COALESCE(decision_at, expires_at)
    FROM approvals;

    UPDATE approval_requests
    SET decision='PENDING',decision_by=NULL,decision_at=NULL,
      note=CASE WHEN decision='EXPIRED' THEN '' ELSE note END,
      expires_at='9999-12-31T23:59:59.999Z'
    WHERE decision='PENDING'
       OR (decision='EXPIRED' AND (
         (entity_type='TRANSACTION' AND EXISTS(SELECT 1 FROM transactions WHERE id=entity_id AND status='PENDING'))
         OR (entity_type='TRANSFER' AND EXISTS(SELECT 1 FROM cash_transfers WHERE id=entity_id AND status='PENDING'))
         OR (entity_type='UMO_ISSUE' AND EXISTS(SELECT 1 FROM operational_advances WHERE id=entity_id AND status='PENDING'))
         OR (entity_type='UMO_SETTLEMENT' AND EXISTS(SELECT 1 FROM operational_advances WHERE id=entity_id AND status='SETTLEMENT_PENDING'))
         OR (entity_type='CORRECTION' AND EXISTS(SELECT 1 FROM transaction_corrections WHERE id=entity_id AND status='PENDING'))
       ));

    INSERT OR IGNORE INTO ledger_entries(id,user_id,entry_date,direction,amount,source_type,source_id,reference_no,description,account_id,created_by,created_at)
    SELECT 'LED-' || lower(hex(randomblob(16))),created_by,transaction_date,
      CASE WHEN type='MASUK' THEN 'IN' ELSE 'OUT' END,
      amount,'TRANSACTION',id,transaction_no,description,account_id,created_by,created_at
    FROM transactions
    WHERE status='APPROVED' AND COALESCE(cash_effect,1)=1;
  `);

  seedInitialAdmin();
  ensureAccountingPeriod();
  cleanupExpiredSessions();
}

function localPeriodMonth(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: String(getSetting('TIMEZONE', 'Asia/Jakarta')),
    year: 'numeric', month: '2-digit'
  }).format(date);
}

function ensureAccountingPeriod(actorId = 'SYSTEM') {
  const open = db.prepare("SELECT * FROM accounting_periods WHERE status='OPEN' ORDER BY period_month DESC LIMIT 1").get();
  if (open) return open;
  const periodMonth = localPeriodMonth();
  const existing = db.prepare('SELECT * FROM accounting_periods WHERE period_month=?').get(periodMonth);
  if (existing) {
    db.prepare("UPDATE accounting_periods SET status='OPEN',opened_at=?,opened_by=? WHERE id=?")
      .run(nowIso(), actorId, existing.id);
    return db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(existing.id);
  }
  const periodId = newId('PER');
  const firstDate = `${periodMonth}-01`;
  db.prepare("INSERT INTO accounting_periods(id,period_month,status,opened_at,opened_by) VALUES(?,?,'OPEN',?,?)")
    .run(periodId, periodMonth, nowIso(), actorId);
  const users = db.prepare('SELECT id FROM users WHERE active=1').all();
  const balance = db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS total
    FROM ledger_entries WHERE user_id=? AND entry_date<?`);
  const insert = db.prepare('INSERT INTO period_balances(period_id,user_id,opening_balance) VALUES(?,?,?)');
  const seed = db.transaction(() => users.forEach(user => insert.run(periodId, user.id, Number(balance.get(user.id, firstDate).total || 0))));
  seed();
  return db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
}

function rebuildLegacyTransactionsIfNeeded() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get()?.sql || '';
  if (schema.includes("'CORRECTED'") && schema.includes("'PENYESUAIAN'")) return;

  const existing = new Set(db.prepare('PRAGMA table_info(transactions)').all().map(row => row.name));
  const value = (column, fallback) => existing.has(column) ? column : fallback;
  const selectColumns = [
    value('id', "''"), value('transaction_no', "''"), value('transaction_date', "''"), value('type', "'KELUAR'"),
    value('account_id', "''"), value('amount', '0'), value('approval_limit_snapshot', '0'), value('description', "''"),
    value('counterparty', 'NULL'), value('receipt_path', 'NULL'), value('receipt_original_name', 'NULL'), value('receipt_mime', 'NULL'),
    value('status', "'PENDING'"), value('created_by', "''"), value('created_at', "''"), value('approved_by', 'NULL'),
    value('approved_at', 'NULL'), value('rejection_reason', 'NULL'), value('corrected_from_id', 'NULL'), value('cash_effect', '1'),
    value('source_type', "'DIRECT'"), value('source_id', 'NULL')
  ].join(',');

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec(`
      CREATE TABLE transactions_v11 (
        id TEXT PRIMARY KEY,
        transaction_no TEXT NOT NULL UNIQUE,
        transaction_date TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('MASUK','KELUAR','PENYESUAIAN')),
        account_id TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK(amount > 0),
        approval_limit_snapshot INTEGER NOT NULL DEFAULT 0,
        description TEXT NOT NULL,
        counterparty TEXT,
        receipt_path TEXT,
        receipt_original_name TEXT,
        receipt_mime TEXT,
        status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','CORRECTED')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT,
        rejection_reason TEXT,
        corrected_from_id TEXT,
        cash_effect INTEGER NOT NULL DEFAULT 1,
        source_type TEXT NOT NULL DEFAULT 'DIRECT',
        source_id TEXT,
        FOREIGN KEY(account_id) REFERENCES accounts(id),
        FOREIGN KEY(created_by) REFERENCES users(id),
        FOREIGN KEY(approved_by) REFERENCES users(id),
        FOREIGN KEY(corrected_from_id) REFERENCES transactions(id)
      );
      INSERT INTO transactions_v11(
        id,transaction_no,transaction_date,type,account_id,amount,approval_limit_snapshot,description,counterparty,
        receipt_path,receipt_original_name,receipt_mime,status,created_by,created_at,approved_by,approved_at,rejection_reason,
        corrected_from_id,cash_effect,source_type,source_id
      ) SELECT ${selectColumns} FROM transactions;
      DROP TABLE transactions;
      ALTER TABLE transactions_v11 RENAME TO transactions;
      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_creator ON transactions(created_by);
      CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    `);
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function seedInitialAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
  if (count > 0) return;
  const name = process.env.INITIAL_ADMIN_NAME || 'Administrator';
  const username = String(process.env.INITIAL_ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD || 'Admin12345';
  assertPassword(password);
  const passwordData = hashPassword(password);
  const now = nowIso();
  db.prepare(`INSERT INTO users(id,name,username,password_hash,password_salt,role,active,created_at,updated_at) VALUES(?,?,?,?,?,'SUPER_USER',1,?,?)`)
    .run(newId('USR'), name, username, passwordData.hash, passwordData.salt, now, now);
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value, value_type FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  if (row.value_type === 'NUMBER') return Number(row.value || 0);
  if (row.value_type === 'BOOLEAN') return ['1', 'true', 'TRUE'].includes(String(row.value));
  return row.value === null || row.value === '' ? fallback : row.value;
}

function setSetting(key, value, userId = 'SYSTEM') {
  const result = db.prepare('UPDATE settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = ?')
    .run(String(value), userId, nowIso(), key);
  if (!result.changes) throw Object.assign(new Error(`Pengaturan tidak ditemukan: ${key}`), { status: 404 });
}

function publicUser(user) {
  return {
    userId: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    active: Boolean(user.active),
    hasApprovalPin: Boolean(user.approval_pin_hash),
    lastLogin: user.last_login || ''
  };
}

function getUserPermissions(userId, role) {
  const overrides = db.prepare('SELECT permission_code, allowed FROM user_permissions WHERE user_id = ?').all(userId);
  return [...effectivePermissions(role, overrides)].sort();
}

function audit(userId, action, entityType, entityId = '', oldValue = '', newValue = '', description = '') {
  const json = value => {
    if (value === '' || value === null || value === undefined) return '';
    return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 10000);
  };
  db.prepare(`INSERT INTO audit_logs(id,timestamp,user_id,action,entity_type,entity_id,old_value,new_value,description) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(newId('LOG'), nowIso(), userId || 'SYSTEM', action, entityType, entityId || '', json(oldValue), json(newValue), description);
}

function cleanupExpiredSessions() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(nowIso(), cutoff);
}

function backupType(fileName) {
  if (fileName.startsWith('kas-kecil-before-clear-')) return 'BEFORE_CLEAR';
  if (fileName.startsWith('kas-kecil-before-umo-change-')) return 'BEFORE_UMO_CHANGE';
  if (fileName.startsWith('kas-kecil-manual-')) return 'MANUAL';
  return 'AUTOMATIC';
}

function listDatabaseBackups() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return fs.readdirSync(BACKUP_DIR)
    .filter(name => /^kas-kecil-.*\.sqlite$/.test(name))
    .map(name => {
      const filePath = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(filePath);
      return {
        fileName: name,
        filePath,
        type: backupType(name),
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        mtime: stat.mtimeMs
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

async function backupDatabase(kind = 'automatic') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const labels = { automatic: 'auto', manual: 'manual', 'before-clear': 'before-clear', 'before-umo-change': 'before-umo-change' };
  const label = labels[kind] || labels.automatic;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(BACKUP_DIR, `kas-kecil-${label}-${stamp}.sqlite`);
  const escapedDestination = destination.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedDestination}'`);
  const automaticFiles = listDatabaseBackups().filter(file => file.type === 'AUTOMATIC');
  for (const file of automaticFiles.slice(30)) fs.unlinkSync(file.filePath);
  const descriptions = {
    automatic: 'Backup database otomatis',
    manual: 'Backup database manual',
    'before-clear': 'Backup database sebelum reset data transaksi',
    'before-umo-change': 'Backup database sebelum koreksi atau penghapusan UMO'
  };
  audit('SYSTEM', 'BACKUP', 'DATABASE', path.basename(destination), '', { kind }, descriptions[kind] || descriptions.automatic);
  return destination;
}

initDatabase();

module.exports = {
  db,
  DB_PATH,
  DATA_DIR,
  BACKUP_DIR,
  PERMISSION_CATALOG,
  nowIso,
  getSetting,
  setSetting,
  publicUser,
  getUserPermissions,
  audit,
  cleanupExpiredSessions,
  backupDatabase,
  listDatabaseBackups,
  ensureAccountingPeriod,
  localPeriodMonth
};
