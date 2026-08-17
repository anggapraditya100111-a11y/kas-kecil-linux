const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { db, nowIso, audit } = require('./db');
const { newId } = require('./security');

const PORT = Number(process.env.INTEGRATION_PORT || 8095);
const INTEGRATION_KEY = String(process.env.KAS_BESAR_INTEGRATION_KEY || '').trim();
const SERVICE_NAME = 'kas-kecil-integration';

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function toAmount(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : 0;
  const digits = String(value ?? '').replace(/\D/g, '');
  const amount = Number(digits);
  return Number.isSafeInteger(amount) ? amount : 0;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function requireIntegrationKey(req, _res, next) {
  if (!INTEGRATION_KEY) return next(new AppError('KAS_BESAR_INTEGRATION_KEY belum dikonfigurasi.', 503));
  if (!safeEqual(req.get('X-Integration-Key'), INTEGRATION_KEY)) {
    return next(new AppError('Integration key tidak valid.', 401));
  }
  next();
}

function validateDate(value) {
  const date = cleanText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('transactionDate tidak valid.');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new AppError('transactionDate tidak valid.');
  }
  return date;
}

function getOpenPeriod() {
  return db.prepare("SELECT * FROM accounting_periods WHERE status='OPEN' ORDER BY period_month DESC LIMIT 1").get();
}

function assertOpenPeriodDate(date) {
  const open = getOpenPeriod();
  if (!open) throw new AppError('Tidak ada periode Kas Kecil yang terbuka.', 409);
  if (!date.startsWith(`${open.period_month}-`)) {
    throw new AppError(`Tanggal pendanaan wajib berada pada periode terbuka ${open.period_month}.`, 409);
  }
}

function nextReferenceNo(date) {
  const compact = date.replaceAll('-', '');
  const prefix = `KBI-${compact}`;
  const row = db.prepare('SELECT last_sequence FROM sequences WHERE prefix=?').get(prefix);
  const next = Number(row?.last_sequence || 0) + 1;
  db.prepare(`INSERT INTO sequences(prefix,last_date,last_sequence) VALUES(?,?,?)
    ON CONFLICT(prefix) DO UPDATE SET last_date=excluded.last_date,last_sequence=excluded.last_sequence`)
    .run(prefix, date, next);
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

function ensureIntegrationAccount() {
  let account = db.prepare("SELECT * FROM accounts WHERE code='PENDANAAN-KB' COLLATE NOCASE LIMIT 1").get();
  if (account) return account;
  const now = nowIso();
  const id = newId('ACC');
  db.prepare(`INSERT INTO accounts(
    id,code,name,transaction_scope,approval_limit,receipt_required,underlying_required,active,updated_by,created_at,updated_at
  ) VALUES(?,?,?,'MASUK',0,0,0,1,'SYSTEM',?,?)`)
    .run(id, 'PENDANAAN-KB', 'Pendanaan dari Kas Besar', now, now);
  account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  audit('SYSTEM', 'CREATE', 'ACCOUNT', id, '', { code: account.code, name: account.name }, 'Akun integrasi Kas Besar dibuat otomatis');
  return account;
}

function publicUser(row) {
  return row ? { userId: row.id, name: row.name, username: row.username, active: Boolean(row.active) } : null;
}

function existingFunding(integrationId) {
  return db.prepare(`
    SELECT t.*, u.name AS recipient_name, a.code AS account_code, a.name AS account_name
    FROM transactions t
    LEFT JOIN users u ON u.id=t.created_by
    LEFT JOIN accounts a ON a.id=t.account_id
    WHERE t.source_type='KAS_BESAR' AND t.source_id=?
    LIMIT 1
  `).get(integrationId);
}

function fundingResponse(row, duplicate = false) {
  return {
    ok: true,
    duplicate,
    integrationId: row.source_id,
    transactionId: row.id,
    transactionNo: row.transaction_no,
    transactionDate: row.transaction_date,
    amount: Number(row.amount),
    recipientUserId: row.created_by,
    status: row.status,
    sourceType: row.source_type,
    accountCode: row.account_code || 'PENDANAAN-KB'
  };
}

const createFunding = db.transaction(payload => {
  const existing = existingFunding(payload.integrationId);
  if (existing) return fundingResponse(existing, true);

  const recipient = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(payload.recipientUserId);
  if (!recipient) throw new AppError('Penerima Kas Kecil tidak ditemukan atau nonaktif.', 404);

  const account = ensureIntegrationAccount();
  const transactionId = newId('TRX');
  const referenceNo = nextReferenceNo(payload.transactionDate);
  const now = nowIso();
  const description = payload.description || `Pendanaan Kas Kecil dari Kas Besar ${payload.integrationId}`;

  db.prepare(`INSERT INTO transactions(
    id,transaction_no,transaction_date,type,account_id,amount,approval_limit_snapshot,description,counterparty,
    status,created_by,created_at,approved_by,approved_at,cash_effect,source_type,source_id
  ) VALUES(?,?,?,'MASUK',?,?,0,?,?,'APPROVED',?,?,?, ?,1,'KAS_BESAR',?)`)
    .run(
      transactionId,
      referenceNo,
      payload.transactionDate,
      account.id,
      payload.amount,
      description,
      payload.counterparty || 'Kas Besar',
      recipient.id,
      now,
      recipient.id,
      now,
      payload.integrationId
    );

  db.prepare(`INSERT INTO ledger_entries(
    id,user_id,entry_date,direction,amount,source_type,source_id,reference_no,description,account_id,created_by,created_at
  ) VALUES(?,?,?,'IN',?,'TRANSACTION',?,?,?,?,?,?,?)`)
    .run(
      newId('LED'), recipient.id, payload.transactionDate, payload.amount,
      transactionId, referenceNo, description, account.id, recipient.id, now
    );

  audit('SYSTEM', 'INTEGRATION_FUNDING', 'TRANSACTION', transactionId, '', {
    integrationId: payload.integrationId,
    amount: payload.amount,
    recipientUserId: recipient.id,
    referenceNo: payload.referenceNo || ''
  }, 'Pendanaan Kas Kecil diterima dari Kas Besar');

  return fundingResponse({
    id: transactionId,
    transaction_no: referenceNo,
    transaction_date: payload.transactionDate,
    amount: payload.amount,
    created_by: recipient.id,
    status: 'APPROVED',
    source_type: 'KAS_BESAR',
    source_id: payload.integrationId,
    account_code: account.code
  });
});

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '128kb' }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: SERVICE_NAME, integrationConfigured: Boolean(INTEGRATION_KEY) });
});

app.use('/api/integration', requireIntegrationKey);

app.get('/api/integration/v1/users', (_req, res) => {
  const users = db.prepare("SELECT * FROM users WHERE active=1 ORDER BY name COLLATE NOCASE").all().map(publicUser);
  res.json({ users });
});

app.get('/api/integration/v1/funding/:integrationId', (req, res, next) => {
  try {
    const integrationId = cleanText(req.params.integrationId, 100);
    const row = existingFunding(integrationId);
    if (!row) throw new AppError('Transaksi integrasi tidak ditemukan.', 404);
    res.json(fundingResponse(row));
  } catch (error) { next(error); }
});

app.post('/api/integration/v1/funding', (req, res, next) => {
  try {
    const integrationId = cleanText(req.body.integrationId, 100);
    if (!/^[A-Za-z0-9._:-]{6,100}$/.test(integrationId)) throw new AppError('integrationId tidak valid.');

    const transactionDate = validateDate(req.body.transactionDate);
    assertOpenPeriodDate(transactionDate);

    const amount = toAmount(req.body.amount);
    if (amount <= 0) throw new AppError('amount harus lebih dari 0.');

    const recipientUserId = cleanText(req.body.recipientUserId, 100);
    if (!recipientUserId) throw new AppError('recipientUserId wajib diisi.');

    const result = createFunding({
      integrationId,
      transactionDate,
      amount,
      recipientUserId,
      description: cleanText(req.body.description, 500),
      counterparty: cleanText(req.body.counterparty, 200),
      referenceNo: cleanText(req.body.referenceNo, 100)
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  const status = Number(error.status || 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ ok: false, error: status >= 500 ? 'Terjadi kesalahan pada service integrasi.' : error.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Service integrasi Kas Kecil berjalan di port ${PORT}`);
});

module.exports = { app, createFunding, existingFunding };
