const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const multer = require('multer');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');

const {
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
} = require('./db');
const { ROLE_DEFAULTS } = require('./permissions');
const {
  randomToken,
  hashToken,
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  assertPassword,
  hashApprovalPin,
  verifyApprovalPin,
  approvalPinFingerprint,
  assertApprovalPin,
  appPepperForBackup,
  installRestoredAppPepper,
  RESTORED_PEPPER_PATH,
  newId,
  cleanText
} = require('./security');

const PORT = Number(process.env.PORT || 8090);
const APP_VERSION = '1.5.1';
const SERVICE_NAME = process.env.SERVICE_NAME || 'kas-kecil';
const DEFAULT_APP_NAME = process.env.DEFAULT_APP_NAME || 'Aplikasi Kas Kecil';
const DEFAULT_COMPANY_NAME = process.env.DEFAULT_COMPANY_NAME || 'Nama Perusahaan';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
const COOKIE_NAME = 'kk_session';
const SESSION_HOURS = () => Number(getSetting('SESSION_HOURS', 8)) || 8;
const APP_TIMEZONE = () => String(getSetting('TIMEZONE', 'Asia/Jakarta'));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function cleanUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function toBoolean(value) {
  return value === true || ['1', 'true', 'TRUE', 'yes', 'YA'].includes(String(value || ''));
}

function toAmount(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : 0;
  const raw = String(value ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  const number = Number(digits) * (raw.startsWith('-') ? -1 : 1);
  return Number.isSafeInteger(number) ? number : 0;
}

function localToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE(), year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function monthBounds(periodMonth) {
  if (!/^\d{4}-\d{2}$/.test(String(periodMonth || ''))) throw new AppError('Periode bulan tidak valid.');
  const [year, month] = String(periodMonth).split('-').map(Number);
  if (month < 1 || month > 12) throw new AppError('Periode bulan tidak valid.');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { startDate: `${periodMonth}-01`, endDate: `${periodMonth}-${String(lastDay).padStart(2, '0')}` };
}

function nextPeriodMonth(periodMonth) {
  const [year, month] = String(periodMonth).split('-').map(Number);
  const date = new Date(Date.UTC(year, month, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getOpenPeriod() {
  return db.prepare("SELECT * FROM accounting_periods WHERE status='OPEN' ORDER BY period_month DESC LIMIT 1").get() || ensureAccountingPeriod();
}

function assertOpenTransactionDate(value, label = 'Tanggal transaksi') {
  const date = validatedDate(value, label);
  if (date > localToday()) throw new AppError(`${label} tidak boleh melebihi hari ini.`);
  const open = getOpenPeriod();
  const bounds = monthBounds(open.period_month);
  if (date < bounds.startDate || date > bounds.endDate) {
    throw new AppError(`${label} wajib berada pada periode terbuka ${open.period_month}. Selesaikan End of Month bila akan berpindah bulan.`);
  }
  return date;
}

function safeFileName(value) {
  return String(value || 'bukti').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function requestFile(req, field) {
  if (req.file && req.file.fieldname === field) return req.file;
  return Array.isArray(req.files?.[field]) ? req.files[field][0] : null;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_req, file, callback) => {
      const extension = path.extname(safeFileName(file.originalname)).slice(0, 10);
      callback(null, `${crypto.randomUUID()}${extension}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(String(file.mimetype).toLowerCase())) return callback(new AppError('Bukti harus berformat JPG, PNG, WEBP, atau PDF.'));
    callback(null, true);
  }
});

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_req, file, callback) => {
      const extension = String(file.mimetype).toLowerCase() === 'image/png' ? '.png' : '.jpg';
      callback(null, `brand-${crypto.randomUUID()}${extension}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png'].includes(String(file.mimetype).toLowerCase())) {
      return callback(new AppError('Logo harus berformat JPG atau PNG.'));
    }
    callback(null, true);
  }
});

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'blob:', 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use((req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.origin) return next();
  try {
    const originHost = new URL(req.headers.origin).host;
    if (originHost !== req.headers.host) return next(new AppError('Origin permintaan tidak diizinkan.', 403));
  } catch {
    return next(new AppError('Origin permintaan tidak valid.', 403));
  }
  next();
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak kesalahan login. Tunggu maksimal 1 menit lalu coba kembali.' }
});

function authMiddleware(req, _res, next) {
  const rawToken = req.cookies[COOKIE_NAME];
  if (!rawToken) return next(new AppError('Silakan login kembali.', 401));
  const session = db.prepare(`
    SELECT s.*, u.id AS uid, u.name, u.username, u.role, u.active, u.last_login
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(hashToken('SESSION', rawToken));
  if (!session || session.revoked_at || !session.active || session.expires_at < nowIso()) {
    return next(new AppError('Sesi berakhir. Silakan login kembali.', 401));
  }
  if (Date.now() - new Date(session.last_seen_at).getTime() > 5 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), session.token_hash);
  }
  const user = {
    id: session.uid,
    name: session.name,
    username: session.username,
    role: session.role,
    active: session.active,
    last_login: session.last_login
  };
  req.auth = { user, permissions: new Set(getUserPermissions(user.id, user.role)), sessionHash: session.token_hash };
  next();
}

function requirePermission(code) {
  return (req, _res, next) => {
    if (!req.auth.permissions.has(code)) return next(new AppError('Anda tidak memiliki hak akses ke menu atau tindakan ini.', 403));
    next();
  };
}

function requireSuperUser(req, _res, next) {
  if (req.auth.user.role !== 'SUPER_USER' || !req.auth.permissions.has('database.manage')) {
    return next(new AppError('Tindakan ini hanya dapat dilakukan oleh Super User.', 403));
  }
  next();
}

function hasPermission(req, code) {
  return req.auth.permissions.has(code);
}

function revokeUserSessions(userId) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso(), userId);
}

function accountPublic(row) {
  return {
    accountId: row.id,
    accountCode: row.code,
    accountName: row.name,
    transactionScope: row.transaction_scope,
    approvalLimit: Number(row.approval_limit),
    receiptRequired: Boolean(row.receipt_required),
    underlyingRequired: Boolean(row.underlying_required),
    active: Boolean(row.active)
  };
}

function transactionPublic(row) {
  return {
    transactionId: row.id,
    transactionNo: row.transaction_no,
    transactionDate: row.transaction_date,
    type: row.type,
    accountId: row.account_id,
    accountName: row.account_name,
    amount: Number(row.amount),
    description: row.description,
    counterparty: row.counterparty || '',
    status: row.status,
    receiptAvailable: Boolean(row.receipt_path),
    receiptMime: row.receipt_mime || '',
    underlyingAvailable: Boolean(row.underlying_path),
    underlyingMime: row.underlying_mime || '',
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    approvedByName: row.approved_by_name || '',
    rejectionReason: row.rejection_reason || '',
    createdAt: row.created_at,
    correctedFromId: row.corrected_from_id || '',
    cashEffect: row.cash_effect === undefined ? true : Boolean(row.cash_effect),
    sourceType: row.source_type || 'DIRECT',
    sourceId: row.source_id || '',
    approvalId: row.approval_id || ''
  };
}

function nextDocumentNo(prefix, actorId = 'SYSTEM') {
  const dateKey = localToday().replace(/-/g, '');
  const row = db.prepare('SELECT * FROM sequences WHERE prefix=?').get(prefix);
  const sources = {
    KSK: ['transactions', 'transaction_no'],
    TRF: ['cash_transfers', 'transfer_no'],
    UMO: ['operational_advances', 'umo_no'],
    KOR: ['transaction_corrections', 'correction_no']
  };
  const source = sources[prefix];
  let existingSequence = 0;
  if (source) {
    const [table, column] = source;
    const latest = db.prepare(`SELECT ${column} AS document_no FROM ${table}
      WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`).get(`${prefix}-${dateKey}-%`);
    const match = String(latest?.document_no || '').match(/-(\d+)$/);
    existingSequence = match ? Number(match[1]) : 0;
  }
  const storedSequence = row && row.last_date === dateKey ? Number(row.last_sequence) : 0;
  const sequence = Math.max(storedSequence, existingSequence) + 1;
  db.prepare(`INSERT INTO sequences(prefix,last_date,last_sequence) VALUES(?,?,?)
    ON CONFLICT(prefix) DO UPDATE SET last_date=excluded.last_date,last_sequence=excluded.last_sequence`)
    .run(prefix, dateKey, sequence);
  audit(actorId, 'NEXT_NUMBER', 'SEQUENCE', prefix, row || '', { dateKey, sequence, existingSequence }, 'Nomor dokumen dibuat');
  return `${prefix}-${dateKey}-${String(sequence).padStart(4, '0')}`;
}

function userBalance(userId) {
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance
    FROM ledger_entries WHERE user_id=?`).get(userId);
  return Number(row.balance || 0);
}

function postLedger({ userId, entryDate, direction, amount, sourceType, sourceId, referenceNo, description, accountId = null, counterpartUserId = null, createdBy }) {
  const value = toAmount(amount);
  if (value <= 0) throw new AppError('Nominal mutasi harus lebih dari nol.');
  db.prepare(`INSERT OR IGNORE INTO ledger_entries
    (id,user_id,entry_date,direction,amount,source_type,source_id,reference_no,description,account_id,counterpart_user_id,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    newId('LED'), userId, entryDate, direction, value, sourceType, sourceId, referenceNo,
    cleanText(description, 500), accountId, counterpartUserId, createdBy, nowIso()
  );
}

function postTransactionLedger(tx, actorId) {
  if (!tx || tx.status !== 'APPROVED' || !Boolean(tx.cash_effect)) return;
  postLedger({
    userId: tx.created_by,
    entryDate: tx.transaction_date,
    direction: tx.type === 'MASUK' ? 'IN' : 'OUT',
    amount: tx.amount,
    sourceType: 'TRANSACTION',
    sourceId: tx.id,
    referenceNo: tx.transaction_no,
    description: tx.description,
    accountId: tx.account_id,
    createdBy: actorId
  });
}

function createApprovalRequest(entityType, entityId) {
  const rawToken = randomToken();
  const hours = Number(getSetting('APPROVAL_TOKEN_HOURS', 24)) || 24;
  db.prepare(`INSERT INTO approval_requests(id,entity_type,entity_id,token_hash,token_ciphertext,expires_at,decision,created_at)
    VALUES(?,?,?,?,?,?,'PENDING',?)`).run(
    newId('APR'), entityType, entityId, hashToken('APPROVAL', rawToken), encryptSecret(rawToken),
    new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(), nowIso()
  );
  return rawToken;
}

function recoverOrRotateApprovalToken(approval, actorId = 'SYSTEM') {
  if (!approval || approval.decision !== 'PENDING') throw new AppError('Approval sudah tidak menunggu keputusan.');
  if (approval.expires_at < nowIso()) throw new AppError('Approval sudah kedaluwarsa.');
  if (approval.token_ciphertext) {
    try {
      const rawToken = decryptSecret(approval.token_ciphertext);
      if (hashToken('APPROVAL', rawToken) === approval.token_hash) return rawToken;
    } catch (ignored) {}
  }
  const rawToken = randomToken();
  db.prepare('UPDATE approval_requests SET token_hash=?,token_ciphertext=? WHERE id=?')
    .run(hashToken('APPROVAL', rawToken), encryptSecret(rawToken), approval.id);
  audit(actorId, 'ROTATE_LINK', 'APPROVAL', approval.id, '', '', 'Tautan approval lama dibuat ulang secara aman');
  return rawToken;
}

function canAccessApprovalLink(req, approval) {
  if (hasPermission(req, 'approvals.view')) return true;
  if (approval.entity_type === 'TRANSACTION') {
    return Boolean(db.prepare('SELECT 1 FROM transactions WHERE id=? AND created_by=?').get(approval.entity_id, req.auth.user.id));
  }
  if (approval.entity_type === 'TRANSFER') {
    return Boolean(db.prepare('SELECT 1 FROM cash_transfers WHERE id=? AND (sender_user_id=? OR recipient_user_id=?)')
      .get(approval.entity_id, req.auth.user.id, req.auth.user.id));
  }
  if (['UMO_ISSUE', 'UMO_SETTLEMENT'].includes(approval.entity_type)) {
    return Boolean(db.prepare('SELECT 1 FROM operational_advances WHERE id=? AND user_id=?').get(approval.entity_id, req.auth.user.id));
  }
  if (approval.entity_type === 'CORRECTION') {
    return Boolean(db.prepare('SELECT 1 FROM transaction_corrections WHERE id=? AND created_by=?').get(approval.entity_id, req.auth.user.id));
  }
  return false;
}

function approvalUrl(req, rawToken) {
  return rawToken ? `${req.protocol}://${req.get('host')}/?approval=${encodeURIComponent(rawToken)}` : '';
}

function publicAppConfig() {
  const logoFile = path.basename(String(getSetting('COMPANY_LOGO_FILE', '') || ''));
  const themeColor = String(getSetting('THEME_COLOR', '#1d4ed8'));
  return {
    appName: String(getSetting('APP_NAME', DEFAULT_APP_NAME)),
    companyName: String(getSetting('COMPANY_NAME', DEFAULT_COMPANY_NAME)),
    themeColor: /^#[0-9a-f]{6}$/i.test(themeColor) ? themeColor : '#1d4ed8',
    logoUrl: logoFile ? `/api/branding/logo?v=${encodeURIComponent(logoFile)}` : ''
  };
}

function resolveLedgerScope(req, query = {}, exportMode = false) {
  const allCode = exportMode ? 'reports.export_all' : 'ledger.view_all';
  const selfCode = exportMode ? 'reports.export_self' : 'ledger.view_self';
  if (hasPermission(req, allCode)) return query.userId && query.userId !== 'ALL' ? String(query.userId) : null;
  if (hasPermission(req, selfCode)) return req.auth.user.id;
  throw new AppError('Anda tidak memiliki akses ke data buku kas.', 403);
}

function queryLedger(req, query = {}, limit = 500, exportMode = false) {
  const userScope = resolveLedgerScope(req, query, exportMode);
  const where = [];
  const params = [];
  if (userScope) { where.push('t.created_by = ?'); params.push(userScope); }
  if (query.startDate) { where.push('t.transaction_date >= ?'); params.push(String(query.startDate)); }
  if (query.endDate) { where.push('t.transaction_date <= ?'); params.push(String(query.endDate)); }
  if (query.status) { where.push('t.status = ?'); params.push(String(query.status).toUpperCase()); }
  if (query.type) { where.push('t.type = ?'); params.push(String(query.type).toUpperCase()); }
  if (query.accountId) { where.push('t.account_id = ?'); params.push(String(query.accountId)); }
  if (query.search) {
    where.push(`(LOWER(t.transaction_no || ' ' || t.description || ' ' || COALESCE(t.counterparty,'') || ' ' || a.name) LIKE ?)`);
    params.push(`%${String(query.search).trim().toLowerCase()}%`);
  }
  params.push(limit);
  const sql = `
    SELECT t.*, a.name AS account_name, cu.name AS created_by_name, au.name AS approved_by_name,
      (SELECT ar.id FROM approval_requests ar WHERE ar.entity_type='TRANSACTION' AND ar.entity_id=t.id AND ar.decision='PENDING' LIMIT 1) AS approval_id
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users au ON au.id = t.approved_by
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.transaction_date DESC, t.transaction_no DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params).map(transactionPublic);
}

function dashboardData(req, requestedUserId, requestedStartDate = '', requestedEndDate = '') {
  if (!hasPermission(req, 'dashboard.view')) throw new AppError('Anda tidak memiliki akses dashboard.', 403);
  const canViewAll = hasPermission(req, 'dashboard.view_all_users');
  const scopeUserId = canViewAll && requestedUserId && requestedUserId !== 'ALL' ? String(requestedUserId) : (canViewAll ? null : req.auth.user.id);
  const today = localToday();
  const defaultStart = `${today.slice(0, 7)}-01`;
  const startDate = validatedDate(requestedStartDate || defaultStart, 'Tanggal awal');
  const endDate = validatedDate(requestedEndDate || today, 'Tanggal akhir');
  if (startDate > endDate) throw new AppError('Tanggal awal tidak boleh melebihi tanggal akhir.');
  if (endDate > today) throw new AppError('Tanggal akhir tidak boleh melebihi hari ini.');
  const filters = ['t.transaction_date>=?', 't.transaction_date<=?'];
  const params = [startDate, endDate];
  if (scopeUserId) { filters.push('t.created_by=?'); params.push(scopeUserId); }
  const filter = ` AND ${filters.join(' AND ')}`;
  const summary = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN t.status='APPROVED' AND t.type='MASUK' THEN t.amount ELSE 0 END),0) AS total_in,
      COALESCE(SUM(CASE WHEN t.status='APPROVED' AND t.type='KELUAR' THEN t.amount ELSE 0 END),0) AS total_out,
      COALESCE(SUM(CASE WHEN t.status='APPROVED' AND t.type='PENYESUAIAN' THEN t.amount ELSE 0 END),0) AS adjustment,
      SUM(CASE WHEN t.status='PENDING' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN t.status='REJECTED' THEN 1 ELSE 0 END) AS rejected_count,
      COUNT(*) AS transaction_count
    FROM transactions t WHERE 1=1 ${filter}
  `).get(...params);
  const opening = scopeUserId ? 0 : Number(getSetting('OPENING_BALANCE', 0));

  const recent = db.prepare(`
    SELECT t.*, a.name AS account_name, cu.name AS created_by_name, au.name AS approved_by_name
    FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN users cu ON cu.id=t.created_by LEFT JOIN users au ON au.id=t.approved_by
    WHERE 1=1 ${filter}
    ORDER BY t.created_at DESC LIMIT 10
  `).all(...params).map(transactionPublic);

  let perUser = [];
  let userOptions = [];
  if (canViewAll) {
    userOptions = db.prepare('SELECT id AS userId, name, username, role FROM users WHERE active=1 ORDER BY name').all();
    perUser = db.prepare(`
      SELECT u.id AS userId, u.name, u.username, u.role,
        COUNT(t.id) AS transactionCount,
        COALESCE(SUM(CASE WHEN t.status='APPROVED' AND t.type='MASUK' THEN t.amount ELSE 0 END),0) AS totalIn,
        COALESCE(SUM(CASE WHEN t.status='APPROVED' AND t.type='KELUAR' THEN t.amount ELSE 0 END),0) AS totalOut,
        SUM(CASE WHEN t.status='PENDING' THEN 1 ELSE 0 END) AS pendingCount,
        SUM(CASE WHEN t.status='REJECTED' THEN 1 ELSE 0 END) AS rejectedCount
      FROM users u LEFT JOIN transactions t ON t.created_by=u.id AND t.transaction_date>=? AND t.transaction_date<=?
      WHERE u.active=1 ${scopeUserId ? 'AND u.id=?' : ''}
      GROUP BY u.id ORDER BY u.name
    `).all(startDate, endDate, ...(scopeUserId ? [scopeUserId] : []));
    const balances = db.prepare(`SELECT user_id,
      COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance
      FROM ledger_entries WHERE entry_date<=? ${scopeUserId ? 'AND user_id=?' : ''} GROUP BY user_id`).all(endDate, ...(scopeUserId ? [scopeUserId] : []));
    const balanceMap = Object.fromEntries(balances.map(row => [row.user_id, Number(row.balance)]));
    const outstanding = db.prepare(`SELECT user_id,COALESCE(SUM(advance_amount),0) AS total
      FROM operational_advances WHERE status IN ('OPEN','SETTLEMENT_PENDING') GROUP BY user_id`).all();
    const outstandingMap = Object.fromEntries(outstanding.map(row => [row.user_id, Number(row.total)]));
    perUser = perUser.map(row => ({ ...row, cashBalance: balanceMap[row.userId] || 0, umoOutstanding: outstandingMap[row.userId] || 0 }));
  }


  const balanceRow = db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance
    FROM ledger_entries WHERE entry_date<=? ${scopeUserId ? 'AND user_id=?' : ''}`)
    .get(endDate, ...(scopeUserId ? [scopeUserId] : []));
  const umoFilter = scopeUserId ? 'AND user_id=?' : '';
  const umoRow = db.prepare(`SELECT COALESCE(SUM(advance_amount),0) AS total FROM operational_advances
    WHERE status IN ('OPEN','SETTLEMENT_PENDING') ${umoFilter}`).get(...(scopeUserId ? [scopeUserId] : []));

  return {
    scope: scopeUserId || 'ALL',
    canViewAll,
    startDate,
    endDate,
    userOptions,
    openingBalance: opening,
    totalIn: Number(summary.total_in),
    totalOut: Number(summary.total_out),
    adjustment: Number(summary.adjustment),
    balance: opening + Number(summary.total_in) - Number(summary.total_out) + Number(summary.adjustment),
    pendingCount: Number(summary.pending_count),
    rejectedCount: Number(summary.rejected_count),
    transactionCount: Number(summary.transaction_count),
    cashBalance: Number(balanceRow.balance || 0),
    umoOutstanding: Number(umoRow.total || 0),
    recent,
    perUser
  };
}

// ---------- Public/auth routes ----------

app.get('/api/health', (_req, res) => res.json({ ok: true, service: SERVICE_NAME, version: APP_VERSION }));

app.get('/api/public/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicAppConfig());
});

app.get('/api/branding/logo', (_req, res, next) => {
  try {
    const logoFile = path.basename(String(getSetting('COMPANY_LOGO_FILE', '') || ''));
    if (!logoFile) throw new AppError('Logo perusahaan belum diatur.', 404);
    const fullPath = path.join(UPLOAD_DIR, logoFile);
    if (!fs.existsSync(fullPath)) throw new AppError('File logo perusahaan tidak tersedia.', 404);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(fullPath);
  } catch (error) { next(error); }
});

app.post('/api/auth/login', loginLimiter, (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !user.active || !verifyPassword(String(req.body.password || ''), user.password_salt, user.password_hash)) {
      throw new AppError('Username atau password salah.', 401);
    }
    const rawToken = randomToken();
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_HOURS() * 60 * 60 * 1000);
    db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)')
      .run(hashToken('SESSION', rawToken), user.id, now.toISOString(), expires.toISOString(), now.toISOString());
    db.prepare('UPDATE users SET last_login=?, updated_at=? WHERE id=?').run(now.toISOString(), now.toISOString(), user.id);
    audit(user.id, 'LOGIN', 'SESSION', '', '', '', 'Login berhasil');
    res.cookie(COOKIE_NAME, rawToken, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: 'lax',
      maxAge: SESSION_HOURS() * 60 * 60 * 1000,
      path: '/'
    });
    res.json({ user: publicUser(user), permissions: getUserPermissions(user.id, user.role) });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(nowIso(), req.auth.sessionHash);
  audit(req.auth.user.id, 'LOGOUT', 'SESSION', '', '', '', 'Logout');
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.post('/api/auth/change-password', authMiddleware, (req, res, next) => {
  try {
    const fullUser = db.prepare('SELECT * FROM users WHERE id=?').get(req.auth.user.id);
    if (!verifyPassword(String(req.body.oldPassword || ''), fullUser.password_salt, fullUser.password_hash)) throw new AppError('Password lama tidak sesuai.');
    assertPassword(req.body.newPassword);
    const passwordData = hashPassword(req.body.newPassword);
    db.prepare('UPDATE users SET password_hash=?, password_salt=?, updated_at=? WHERE id=?')
      .run(passwordData.hash, passwordData.salt, nowIso(), fullUser.id);
    revokeUserSessions(fullUser.id);
    audit(fullUser.id, 'CHANGE_PASSWORD', 'USER', fullUser.id, '', '', 'Password diubah dan sesi dicabut');
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true, logoutRequired: true });
  } catch (error) { next(error); }
});

app.get('/api/bootstrap', authMiddleware, (req, res) => {
  const accounts = db.prepare('SELECT * FROM accounts WHERE active=1 ORDER BY code').all().map(accountPublic);
  const openPeriod = getOpenPeriod();
  const approvalCount = hasPermission(req, 'approvals.view')
    ? db.prepare("SELECT COUNT(*) AS total FROM approval_requests WHERE decision='PENDING' AND expires_at>=?").get(nowIso()).total
    : 0;
  res.json({
    user: publicUser(req.auth.user),
    permissions: [...req.auth.permissions].sort(),
    config: {
      ...publicAppConfig(),
      maxUploadMb: Number(getSetting('MAX_UPLOAD_MB', 5)),
      umoApprovalLimit: Number(getSetting('UMO_APPROVAL_LIMIT', 500000)),
      umoDueDays: Number(getSetting('UMO_DUE_DAYS', 3)),
    timezone: APP_TIMEZONE(),
    appVersion: APP_VERSION
    },
    accounts,
    openPeriod: { periodMonth: openPeriod.period_month, status: openPeriod.status },
    budget: hasPermission(req, 'budgets.view') ? budgetData(openPeriod.period_month) : null,
    cashBalance: userBalance(req.auth.user.id),
    approvalCount
  });
});

app.get('/api/users/options', authMiddleware, (req, res, next) => {
  const allowed = ['dashboard.view_all_users', 'ledger.view_all', 'mutations.view_all', 'reports.export_all', 'approvals.view', 'transfers.create', 'umo.create'].some(code => hasPermission(req, code));
  if (!allowed) return next(new AppError('Anda tidak memiliki akses daftar pengguna.', 403));
  const users = db.prepare('SELECT id AS userId,name,username,role FROM users WHERE active=1 ORDER BY name').all();
  res.json({ users });
});

// ---------- Dashboard, ledger, transactions ----------

app.get('/api/dashboard', authMiddleware, requirePermission('dashboard.view'), (req, res) => {
  res.json(dashboardData(req, req.query.userId, req.query.startDate, req.query.endDate));
});

app.get('/api/ledger', authMiddleware, (req, res, next) => {
  try {
    const rows = queryLedger(req, req.query, 500, false);
    res.json({ rows, count: rows.length });
  } catch (error) { next(error); }
});

app.post('/api/transactions', authMiddleware, requirePermission('transactions.create'), upload.fields([
  { name: 'receipt', maxCount: 1 },
  { name: 'underlyingDocument', maxCount: 1 }
]), (req, res, next) => {
  try {
    const type = String(req.body.type || '').toUpperCase();
    if (!['MASUK', 'KELUAR'].includes(type)) throw new AppError('Jenis transaksi tidak valid.');
    const transactionDate = assertOpenTransactionDate(req.body.transactionDate, 'Tanggal transaksi');
    const amount = toAmount(req.body.amount);
    if (amount <= 0) throw new AppError('Nominal transaksi harus lebih dari nol.');
    const account = db.prepare('SELECT * FROM accounts WHERE id=? AND active=1').get(String(req.body.accountId || ''));
    if (!account) throw new AppError('Akun transaksi tidak ditemukan.');
    if (account.transaction_scope !== 'BOTH' && account.transaction_scope !== type) throw new AppError('Akun tidak sesuai dengan jenis transaksi.');
    const description = cleanText(req.body.description, 500);
    if (!description) throw new AppError('Keterangan transaksi wajib diisi.');
    const receiptFile = requestFile(req, 'receipt');
    const underlyingFile = requestFile(req, 'underlyingDocument');
    if (type === 'KELUAR' && account.receipt_required && !receiptFile) throw new AppError('Bukti transaksi wajib untuk akun ini.');
    if (type === 'KELUAR' && account.underlying_required && !underlyingFile) throw new AppError('Underlying document wajib untuk akun ini.');
    const maxUploadBytes = Number(getSetting('MAX_UPLOAD_MB', 5)) * 1024 * 1024;
    if ([receiptFile, underlyingFile].some(file => file && file.size > maxUploadBytes)) {
      throw new AppError(`Ukuran lampiran melebihi batas ${getSetting('MAX_UPLOAD_MB', 5)} MB per file.`);
    }

    const status = type === 'MASUK' || amount <= Number(account.approval_limit) ? 'APPROVED' : 'PENDING';
    if (status === 'APPROVED' && type === 'KELUAR' && userBalance(req.auth.user.id) < amount) {
      throw new AppError('Saldo kas tidak mencukupi untuk transaksi ini.');
    }
    let rawApprovalToken = '';
    const transactionId = newId('TRX');
    const now = nowIso();
    const saveTransaction = db.transaction(() => {
      const transactionNo = nextDocumentNo('KSK', req.auth.user.id);
      db.prepare(`
        INSERT INTO transactions(id,transaction_no,transaction_date,type,account_id,amount,approval_limit_snapshot,description,counterparty,
          receipt_path,receipt_original_name,receipt_mime,underlying_path,underlying_original_name,underlying_mime,
          status,created_by,created_at,approved_by,approved_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        transactionId, transactionNo, transactionDate, type, account.id, amount, Number(account.approval_limit), description,
        cleanText(req.body.counterparty, 150), receiptFile ? receiptFile.filename : '', receiptFile ? safeFileName(receiptFile.originalname) : '',
        receiptFile ? receiptFile.mimetype : '', underlyingFile ? underlyingFile.filename : '',
        underlyingFile ? safeFileName(underlyingFile.originalname) : '', underlyingFile ? underlyingFile.mimetype : '',
        status, req.auth.user.id, now, status === 'APPROVED' ? req.auth.user.id : null,
        status === 'APPROVED' ? now : null
      );
      if (status === 'PENDING') {
        rawApprovalToken = createApprovalRequest('TRANSACTION', transactionId);
      } else {
        postTransactionLedger(db.prepare('SELECT * FROM transactions WHERE id=?').get(transactionId), req.auth.user.id);
      }
      audit(req.auth.user.id, 'CREATE', 'TRANSACTION', transactionId, '', { transactionNo, amount, type, status }, 'Transaksi dibuat');
      return transactionNo;
    });
    const transactionNo = saveTransaction();
    res.status(201).json({
      ok: true,
      transactionId,
      transactionNo,
      status,
      approvalUrl: approvalUrl(req, rawApprovalToken)
    });
  } catch (error) { next(error); }
});

app.get('/api/receipts/:transactionId', authMiddleware, (req, res, next) => {
  try {
    const row = db.prepare('SELECT id,created_by,receipt_path,receipt_original_name,receipt_mime FROM transactions WHERE id=?').get(req.params.transactionId);
    if (!row || !row.receipt_path) throw new AppError('Bukti transaksi tidak ditemukan.', 404);
    const canView = hasPermission(req, 'receipts.view_all') || (hasPermission(req, 'receipts.view_self') && row.created_by === req.auth.user.id);
    if (!canView) throw new AppError('Anda tidak memiliki akses ke bukti ini.', 403);
    const fullPath = path.join(UPLOAD_DIR, path.basename(row.receipt_path));
    if (!fs.existsSync(fullPath)) throw new AppError('File bukti tidak tersedia di penyimpanan.', 404);
    res.type(row.receipt_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${safeFileName(row.receipt_original_name)}"`);
    res.sendFile(fullPath);
  } catch (error) { next(error); }
});

app.get('/api/underlying-documents/:transactionId', authMiddleware, (req, res, next) => {
  try {
    const row = db.prepare(`SELECT id,created_by,underlying_path,underlying_original_name,underlying_mime
      FROM transactions WHERE id=?`).get(req.params.transactionId);
    if (!row || !row.underlying_path) throw new AppError('Underlying document tidak ditemukan.', 404);
    const canView = hasPermission(req, 'receipts.view_all') || (hasPermission(req, 'receipts.view_self') && row.created_by === req.auth.user.id);
    if (!canView) throw new AppError('Anda tidak memiliki akses ke dokumen ini.', 403);
    sendStoredReceipt(res, { path: row.underlying_path, name: row.underlying_original_name, mime: row.underlying_mime });
  } catch (error) { next(error); }
});

// ---------- Approval ----------

function approvalEntityDetail(approval) {
  const base = {
    approvalId: approval.id,
    entityType: approval.entity_type,
    entityId: approval.entity_id,
    expiresAt: approval.expires_at,
    expired: approval.expires_at < nowIso(),
    decision: approval.decision,
    decisionAt: approval.decision_at || '',
    note: approval.note || ''
  };
  if (approval.entity_type === 'TRANSACTION') {
    const row = db.prepare(`SELECT t.*,a.code AS account_code,a.name AS account_name,cu.name AS created_by_name,au.name AS approved_by_name
      FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN users cu ON cu.id=t.created_by
      LEFT JOIN users au ON au.id=t.approved_by WHERE t.id=?`).get(approval.entity_id);
    if (!row) return null;
    return { ...transactionPublic(row), ...base, title: 'Transaksi Kas', referenceNo: row.transaction_no, accountCode: row.account_code };
  }
  if (approval.entity_type === 'TRANSFER') {
    const row = db.prepare(`SELECT tr.*,su.name AS sender_name,ru.name AS recipient_name,cu.name AS created_by_name
      FROM cash_transfers tr JOIN users su ON su.id=tr.sender_user_id JOIN users ru ON ru.id=tr.recipient_user_id
      JOIN users cu ON cu.id=tr.created_by WHERE tr.id=?`).get(approval.entity_id);
    if (!row) return null;
    return { ...base, title: 'Transfer Kas Antar-Staff', referenceNo: row.transfer_no, transactionNo: row.transfer_no,
      transactionDate: row.transfer_date, createdByName: row.created_by_name, amount: Number(row.amount),
      accountName: `${row.sender_name} → ${row.recipient_name}`, description: row.description,
      counterparty: row.recipient_name, status: row.status, receiptAvailable: false, receiptMime: '' };
  }
  if (approval.entity_type === 'CORRECTION') {
    const row = db.prepare(`SELECT c.*,t.transaction_no,t.transaction_date,t.amount,t.description AS original_description,t.receipt_path,t.receipt_mime,
      a.name AS account_name,u.name AS created_by_name
      FROM transaction_corrections c JOIN transactions t ON t.id=c.original_transaction_id
      JOIN accounts a ON a.id=t.account_id JOIN users u ON u.id=c.created_by WHERE c.id=?`).get(approval.entity_id);
    if (!row) return null;
    return { ...base, title: row.correction_type === 'REVERSAL' ? 'Reversal Transaksi' : 'Koreksi dan Penggantian Transaksi',
      referenceNo: row.correction_no, transactionNo: row.correction_no, transactionDate: row.transaction_date,
      createdByName: row.created_by_name, amount: Number(row.proposed_amount || row.amount), accountName: row.account_name,
      description: `${row.reason} — transaksi asal ${row.transaction_no}`, counterparty: row.proposed_counterparty || '',
      status: row.status, receiptAvailable: Boolean(row.proposed_receipt_path || row.receipt_path), receiptMime: row.proposed_receipt_mime || row.receipt_mime || '' };
  }
  if (['UMO_ISSUE', 'UMO_SETTLEMENT'].includes(approval.entity_type)) {
    const row = db.prepare(`SELECT uo.*,u.name AS created_by_name FROM operational_advances uo JOIN users u ON u.id=uo.user_id WHERE uo.id=?`).get(approval.entity_id);
    if (!row) return null;
    const settlement = approval.entity_type === 'UMO_SETTLEMENT';
    return { ...base, title: settlement ? 'Pertanggungjawaban UMO' : 'Pencairan Uang Muka Operasional (UMO)',
      referenceNo: row.umo_no, transactionNo: row.umo_no, transactionDate: row.advance_date,
      createdByName: row.created_by_name, amount: Number(settlement ? row.settled_amount : row.advance_amount),
      accountName: 'Uang Muka Operasional', description: row.purpose, counterparty: row.bearer_name,
      status: row.status, receiptAvailable: Boolean(settlement && row.settlement_receipt_path),
      receiptMime: settlement ? (row.settlement_receipt_mime || '') : '', dueDate: row.due_date,
      advanceAmount: Number(row.advance_amount), settledAmount: Number(row.settled_amount),
      returnedAmount: Number(row.returned_amount), extraAmount: Number(row.extra_amount) };
  }
  return null;
}

function approvalReceipt(approval) {
  if (approval.entity_type === 'TRANSACTION') {
    return db.prepare(`SELECT receipt_path AS path,receipt_original_name AS name,receipt_mime AS mime FROM transactions WHERE id=?`).get(approval.entity_id);
  }
  if (approval.entity_type === 'CORRECTION') {
    return db.prepare(`SELECT COALESCE(c.proposed_receipt_path,t.receipt_path) AS path,
      COALESCE(c.proposed_receipt_name,t.receipt_original_name) AS name,
      COALESCE(c.proposed_receipt_mime,t.receipt_mime) AS mime
      FROM transaction_corrections c JOIN transactions t ON t.id=c.original_transaction_id WHERE c.id=?`).get(approval.entity_id);
  }
  if (approval.entity_type === 'UMO_SETTLEMENT') {
    return db.prepare(`SELECT settlement_receipt_path AS path,settlement_receipt_name AS name,settlement_receipt_mime AS mime
      FROM operational_advances WHERE id=?`).get(approval.entity_id);
  }
  return null;
}

function approvalUnderlying(approval) {
  if (approval.entity_type !== 'TRANSACTION') return null;
  return db.prepare(`SELECT underlying_path AS path,underlying_original_name AS name,underlying_mime AS mime
    FROM transactions WHERE id=?`).get(approval.entity_id);
}

function sendStoredReceipt(res, descriptor) {
  if (!descriptor || !descriptor.path) throw new AppError('Bukti transaksi tidak tersedia.', 404);
  const fullPath = path.join(UPLOAD_DIR, path.basename(descriptor.path));
  if (!fs.existsSync(fullPath)) throw new AppError('File bukti tidak tersedia di penyimpanan.', 404);
  res.type(descriptor.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `inline; filename="${safeFileName(descriptor.name || 'bukti')}"`);
  res.sendFile(fullPath);
}

function processApproval(approvalId, approverId, decision, note) {
  let orphanReceipt = '';
  const result = db.transaction(() => {
    const approval = db.prepare('SELECT * FROM approval_requests WHERE id=?').get(approvalId);
    if (!approval) throw new AppError('Approval tidak ditemukan.', 404);
    if (approval.decision !== 'PENDING') throw new AppError('Approval sudah diproses.');
    if (approval.expires_at < nowIso()) {
      db.prepare("UPDATE approval_requests SET decision='EXPIRED',decision_at=?,note='Token kedaluwarsa' WHERE id=?").run(nowIso(), approval.id);
      throw new AppError('Approval sudah kedaluwarsa.');
    }
    const now = nowIso();
    let referenceNo = '';
    if (approval.entity_type === 'TRANSACTION') {
      const tx = db.prepare('SELECT * FROM transactions WHERE id=?').get(approval.entity_id);
      if (!tx || tx.status !== 'PENDING') throw new AppError('Transaksi sudah tidak berstatus Pending.');
      if (decision === 'APPROVED' && tx.type === 'KELUAR' && userBalance(tx.created_by) < Number(tx.amount)) throw new AppError('Saldo staff tidak mencukupi.');
      db.prepare('UPDATE transactions SET status=?,approved_by=?,approved_at=?,rejection_reason=? WHERE id=?')
        .run(decision, decision === 'APPROVED' ? approverId : null, now, decision === 'REJECTED' ? note : '', tx.id);
      if (decision === 'APPROVED') postTransactionLedger(db.prepare('SELECT * FROM transactions WHERE id=?').get(tx.id), approverId);
      referenceNo = tx.transaction_no;
    } else if (approval.entity_type === 'TRANSFER') {
      const transfer = db.prepare('SELECT * FROM cash_transfers WHERE id=?').get(approval.entity_id);
      if (!transfer || transfer.status !== 'PENDING') throw new AppError('Transfer sudah tidak berstatus Pending.');
      if (decision === 'APPROVED') {
        if (userBalance(transfer.sender_user_id) < Number(transfer.amount)) throw new AppError('Saldo pengirim tidak mencukupi.');
        db.prepare("UPDATE cash_transfers SET status='APPROVED',approved_by=?,approved_at=? WHERE id=?").run(approverId, now, transfer.id);
        postLedger({ userId: transfer.sender_user_id, entryDate: transfer.transfer_date, direction: 'OUT', amount: transfer.amount,
          sourceType: 'TRANSFER', sourceId: transfer.id, referenceNo: transfer.transfer_no, description: transfer.description,
          counterpartUserId: transfer.recipient_user_id, createdBy: approverId });
        postLedger({ userId: transfer.recipient_user_id, entryDate: transfer.transfer_date, direction: 'IN', amount: transfer.amount,
          sourceType: 'TRANSFER', sourceId: transfer.id, referenceNo: transfer.transfer_no, description: transfer.description,
          counterpartUserId: transfer.sender_user_id, createdBy: approverId });
      } else db.prepare("UPDATE cash_transfers SET status='REJECTED',rejection_reason=? WHERE id=?").run(note, transfer.id);
      referenceNo = transfer.transfer_no;
    } else if (approval.entity_type === 'UMO_ISSUE') {
      const umo = db.prepare('SELECT * FROM operational_advances WHERE id=?').get(approval.entity_id);
      if (!umo || umo.status !== 'PENDING') throw new AppError('UMO sudah tidak berstatus Pending.');
      if (decision === 'APPROVED') {
        if (userBalance(umo.user_id) < Number(umo.advance_amount)) throw new AppError('Saldo staff tidak mencukupi untuk pencairan UMO.');
        db.prepare("UPDATE operational_advances SET status='OPEN',approved_by=?,approved_at=? WHERE id=?").run(approverId, now, umo.id);
        postLedger({ userId: umo.user_id, entryDate: umo.advance_date, direction: 'OUT', amount: umo.advance_amount,
          sourceType: 'UMO_ISSUE', sourceId: umo.id, referenceNo: umo.umo_no, description: umo.purpose, createdBy: approverId });
      } else db.prepare("UPDATE operational_advances SET status='REJECTED',rejection_reason=? WHERE id=?").run(note, umo.id);
      referenceNo = umo.umo_no;
    } else if (approval.entity_type === 'UMO_SETTLEMENT') {
      const umo = db.prepare('SELECT * FROM operational_advances WHERE id=?').get(approval.entity_id);
      if (!umo || umo.status !== 'SETTLEMENT_PENDING') throw new AppError('Pertanggungjawaban UMO sudah tidak menunggu approval.');
      if (decision === 'APPROVED') finalizeUmoSettlement(umo, approverId);
      else {
        orphanReceipt = umo.settlement_receipt_path || '';
        db.prepare('DELETE FROM umo_allocations WHERE umo_id=? AND transaction_id IS NULL').run(umo.id);
        db.prepare(`UPDATE operational_advances SET status='OPEN',settlement_note=NULL,settlement_receipt_path=NULL,
          settlement_receipt_name=NULL,settlement_receipt_mime=NULL,settled_amount=0,returned_amount=0,extra_amount=0,rejection_reason=? WHERE id=?`).run(note, umo.id);
      }
      referenceNo = umo.umo_no;
    } else if (approval.entity_type === 'CORRECTION') {
      const correction = db.prepare('SELECT * FROM transaction_corrections WHERE id=?').get(approval.entity_id);
      if (!correction || correction.status !== 'PENDING') throw new AppError('Koreksi sudah tidak berstatus Pending.');
      if (decision === 'APPROVED') finalizeCorrection(correction, approverId);
      else db.prepare("UPDATE transaction_corrections SET status='REJECTED',approved_by=?,approved_at=?,rejection_reason=? WHERE id=?")
        .run(approverId, now, note, correction.id);
      referenceNo = correction.correction_no;
    }
    db.prepare('UPDATE approval_requests SET decision=?,decision_by=?,decision_at=?,note=?,attempt_count=attempt_count+1 WHERE id=?')
      .run(decision, approverId, now, note, approval.id);
    audit(approverId, decision, 'APPROVAL', approval.id, { status: 'PENDING' }, { status: decision, note, entityType: approval.entity_type }, 'Keputusan approval');
    return { referenceNo, entityType: approval.entity_type };
  })();
  if (orphanReceipt) {
    const fullPath = path.join(UPLOAD_DIR, path.basename(orphanReceipt));
    try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (ignored) {}
  }
  return result;
}

function validateDecision(body) {
  const decision = String(body.decision || '').toUpperCase();
  const note = cleanText(body.note, 500);
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new AppError('Keputusan approval tidak valid.');
  if (decision === 'REJECTED' && !note) throw new AppError('Alasan penolakan wajib diisi.');
  return { decision, note };
}

function pendingApprovals() {
  return db.prepare("SELECT * FROM approval_requests WHERE decision='PENDING' AND expires_at>=? ORDER BY expires_at ASC")
    .all(nowIso()).map(approvalEntityDetail).filter(Boolean);
}

const approvalPinLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak kesalahan PIN. Tunggu maksimal 1 menit lalu coba kembali.' }
});

app.get('/api/approvals', authMiddleware, requirePermission('approvals.view'), (_req, res) => res.json({ rows: pendingApprovals() }));

app.post('/api/approvals/:approvalId/link', authMiddleware, (req, res, next) => {
  try {
    const approval = db.prepare('SELECT * FROM approval_requests WHERE id=?').get(req.params.approvalId);
    if (!approval) throw new AppError('Approval tidak ditemukan.', 404);
    if (!canAccessApprovalLink(req, approval)) throw new AppError('Anda tidak memiliki akses tautan approval ini.', 403);
    const rawToken = recoverOrRotateApprovalToken(approval, req.auth.user.id);
    res.json({ ok: true, approvalUrl: approvalUrl(req, rawToken) });
  } catch (error) { next(error); }
});

app.get('/api/approvals/:approvalId/receipt', authMiddleware, requirePermission('approvals.view'), (req, res, next) => {
  try {
    const approval = db.prepare('SELECT * FROM approval_requests WHERE id=?').get(req.params.approvalId);
    if (!approval) throw new AppError('Approval tidak ditemukan.', 404);
    sendStoredReceipt(res, approvalReceipt(approval));
  } catch (error) { next(error); }
});

app.get('/api/approvals/:approvalId/underlying', authMiddleware, requirePermission('approvals.view'), (req, res, next) => {
  try {
    const approval = db.prepare('SELECT * FROM approval_requests WHERE id=?').get(req.params.approvalId);
    if (!approval) throw new AppError('Approval tidak ditemukan.', 404);
    sendStoredReceipt(res, approvalUnderlying(approval));
  } catch (error) { next(error); }
});

app.post('/api/approvals/:approvalId/decision', authMiddleware, requirePermission('approvals.decide'), (req, res, next) => {
  try {
    const { decision, note } = validateDecision(req.body);
    const result = processApproval(req.params.approvalId, req.auth.user.id, decision, note);
    res.json({ ok: true, ...result, decision });
  } catch (error) { next(error); }
});

app.get('/api/public/approvals/:token', (req, res, next) => {
  try {
    const approval = db.prepare('SELECT * FROM approval_requests WHERE token_hash=?').get(hashToken('APPROVAL', req.params.token));
    if (!approval) throw new AppError('Tautan approval tidak valid.', 404);
    const detail = approvalEntityDetail(approval);
    if (!detail) throw new AppError('Data approval tidak ditemukan.', 404);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...detail,
      receiptUrl: detail.receiptAvailable ? `/api/public/approvals/${encodeURIComponent(req.params.token)}/receipt` : '',
      underlyingUrl: detail.underlyingAvailable ? `/api/public/approvals/${encodeURIComponent(req.params.token)}/underlying` : ''
    });
  } catch (error) { next(error); }
});

app.get('/api/public/approvals/:token/receipt', (req, res, next) => {
  try {
    const approval = db.prepare('SELECT * FROM approval_requests WHERE token_hash=?').get(hashToken('APPROVAL', req.params.token));
    if (!approval) throw new AppError('Tautan approval tidak valid.', 404);
    sendStoredReceipt(res, approvalReceipt(approval));
  } catch (error) { next(error); }
});

app.get('/api/public/approvals/:token/underlying', (req, res, next) => {
  try {
    const approval = db.prepare('SELECT * FROM approval_requests WHERE token_hash=?').get(hashToken('APPROVAL', req.params.token));
    if (!approval) throw new AppError('Tautan approval tidak valid.', 404);
    sendStoredReceipt(res, approvalUnderlying(approval));
  } catch (error) { next(error); }
});

app.post('/api/public/approvals/:token/decision', approvalPinLimiter, (req, res, next) => {
  try {
    const { decision, note } = validateDecision(req.body);
    const pin = String(req.body.pin || '');
    assertApprovalPin(pin);
    const approval = db.prepare('SELECT * FROM approval_requests WHERE token_hash=?').get(hashToken('APPROVAL', req.params.token));
    if (!approval) throw new AppError('Tautan approval tidak valid.', 404);
    const approver = db.prepare('SELECT * FROM users WHERE approval_pin_fingerprint=? AND active=1').get(approvalPinFingerprint(pin));
    const allowed = approver && getUserPermissions(approver.id, approver.role).includes('approvals.decide');
    if (!allowed || !verifyApprovalPin(pin, approver.approval_pin_salt, approver.approval_pin_hash)) {
      db.prepare('UPDATE approval_requests SET attempt_count=attempt_count+1 WHERE id=?').run(approval.id);
      audit('SYSTEM', 'PIN_FAILED', 'APPROVAL', approval.id, '', '', 'PIN approval tidak valid');
      throw new AppError('PIN approval tidak valid.', 401);
    }
    const result = processApproval(approval.id, approver.id, decision, note);
    res.json({ ok: true, ...result, decision, approvedByName: approver.name });
  } catch (error) { next(error); }
});

// ---------- Mutasi kas per pengguna ----------

function resolveMutationScope(req, requestedUserId) {
  if (hasPermission(req, 'mutations.view_all')) return requestedUserId && requestedUserId !== 'ALL' ? String(requestedUserId) : null;
  if (hasPermission(req, 'mutations.view_self')) return req.auth.user.id;
  throw new AppError('Anda tidak memiliki akses mutasi kas.', 403);
}

function queryMutations(req, query = {}) {
  const scope = resolveMutationScope(req, query.userId);
  const params = [];
  const where = [];
  if (scope) { where.push('le.user_id=?'); params.push(scope); }
  if (query.endDate) { where.push('le.entry_date<=?'); params.push(String(query.endDate)); }
  const rows = db.prepare(`SELECT le.*,u.name AS user_name,a.code AS account_code,a.name AS account_name,cu.name AS counterpart_name
    FROM ledger_entries le JOIN users u ON u.id=le.user_id LEFT JOIN accounts a ON a.id=le.account_id
    LEFT JOIN users cu ON cu.id=le.counterpart_user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY le.user_id,le.entry_date,le.created_at,le.id`).all(...params);
  const balances = {};
  const start = query.startDate ? String(query.startDate) : '';
  const sourceType = query.sourceType ? String(query.sourceType).toUpperCase() : '';
  const accountId = query.accountId ? String(query.accountId) : '';
  const search = cleanText(query.search, 120).toLowerCase();
  const visible = [];
  for (const row of rows) {
    balances[row.user_id] = Number(balances[row.user_id] || 0) + (row.direction === 'IN' ? Number(row.amount) : -Number(row.amount));
    const item = { entryId: row.id, userId: row.user_id, userName: row.user_name, entryDate: row.entry_date,
      direction: row.direction, amount: Number(row.amount), sourceType: row.source_type, sourceId: row.source_id,
      referenceNo: row.reference_no, description: row.description, accountId: row.account_id || '',
      accountCode: row.account_code || '', accountName: row.account_name || '', counterpartName: row.counterpart_name || '',
      createdAt: row.created_at, balanceAfter: balances[row.user_id] };
    if (start && row.entry_date < start) continue;
    if (sourceType && row.source_type !== sourceType) continue;
    if (accountId && row.account_id !== accountId) continue;
    if (search && !`${row.reference_no} ${row.description} ${row.user_name} ${row.account_name || ''} ${row.counterpart_name || ''}`.toLowerCase().includes(search)) continue;
    visible.push(item);
  }
  visible.sort((a, b) => `${b.entryDate}|${b.createdAt}|${b.entryId}`.localeCompare(`${a.entryDate}|${a.createdAt}|${a.entryId}`));
  return { scope: scope || 'ALL', rows: visible.slice(0, 2000), count: visible.length,
    balance: scope ? userBalance(scope) : Object.values(balances).reduce((sum, value) => sum + Number(value), 0) };
}

app.get('/api/mutations', authMiddleware, (req, res, next) => {
  try { res.json(queryMutations(req, req.query)); } catch (error) { next(error); }
});

// ---------- Rekap dana per akun ----------

function validatedDate(value, label) {
  if (!value) return '';
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || new Date(`${text}T00:00:00.000Z`).toISOString().slice(0, 10) !== text) {
    throw new AppError(`${label} tidak valid.`);
  }
  return text;
}

function queryAccountSummary(query = {}) {
  const startDate = validatedDate(query.startDate, 'Tanggal awal');
  const endDate = validatedDate(query.endDate, 'Tanggal akhir');
  if (startDate && endDate && startDate > endDate) throw new AppError('Tanggal awal tidak boleh melebihi tanggal akhir.');
  const accountId = String(query.accountId || '').trim();
  const joinConditions = ["t.account_id=a.id", "t.status='APPROVED'"];
  const params = [];
  if (startDate) { joinConditions.push('t.transaction_date>=?'); params.push(startDate); }
  if (endDate) { joinConditions.push('t.transaction_date<=?'); params.push(endDate); }
  const where = [];
  if (accountId) { where.push('a.id=?'); params.push(accountId); }
  const rows = db.prepare(`
    SELECT a.id AS account_id,a.code AS account_code,a.name AS account_name,a.transaction_scope,a.active,
      COUNT(t.id) AS transaction_count,
      COALESCE(SUM(CASE WHEN t.type='MASUK' THEN t.amount ELSE 0 END),0) AS total_in,
      COALESCE(SUM(CASE WHEN t.type='KELUAR' THEN t.amount ELSE 0 END),0) AS total_out,
      COALESCE(SUM(CASE WHEN t.type='PENYESUAIAN' THEN t.amount ELSE 0 END),0) AS total_adjustment
    FROM accounts a
    LEFT JOIN transactions t ON ${joinConditions.join(' AND ')}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY a.id,a.code,a.name,a.transaction_scope,a.active
    ORDER BY a.code
  `).all(...params).map(row => ({
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    transactionScope: row.transaction_scope,
    active: Boolean(row.active),
    transactionCount: Number(row.transaction_count),
    totalIn: Number(row.total_in),
    totalOut: Number(row.total_out),
    totalAdjustment: Number(row.total_adjustment),
    netAmount: Number(row.total_in) - Number(row.total_out) + Number(row.total_adjustment)
  }));
  const totals = rows.reduce((sum, row) => ({
    transactionCount: sum.transactionCount + row.transactionCount,
    totalIn: sum.totalIn + row.totalIn,
    totalOut: sum.totalOut + row.totalOut,
    totalAdjustment: sum.totalAdjustment + row.totalAdjustment,
    netAmount: sum.netAmount + row.netAmount
  }), { transactionCount: 0, totalIn: 0, totalOut: 0, totalAdjustment: 0, netAmount: 0 });
  return { startDate, endDate, accountId, rows, totals };
}

app.get('/api/account-summary', authMiddleware, requirePermission('account_summary.view'), (req, res, next) => {
  try { res.json(queryAccountSummary(req.query)); } catch (error) { next(error); }
});

function previousPeriodMonth(periodMonth) {
  const [year, month] = String(periodMonth).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function queryAccountComparison(req, query = {}) {
  const currentMonth = localPeriodMonth();
  const month1 = String(query.month1 || previousPeriodMonth(currentMonth));
  const month2 = String(query.month2 || currentMonth);
  monthBounds(month1); monthBounds(month2);
  const canViewAll = hasPermission(req, 'account_comparison.view_all_users');
  const requestedUser = String(query.userId || '').trim();
  const userId = canViewAll ? (requestedUser && requestedUser !== 'ALL' ? requestedUser : '') : req.auth.user.id;
  if (userId && !db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) throw new AppError('Pengguna tidak ditemukan.', 404);
  const join = ["t.account_id=a.id", "t.status='APPROVED'", "substr(t.transaction_date,1,7) IN (?,?)"];
  const params = [month1, month2];
  if (userId) { join.push('t.created_by=?'); params.push(userId); }
  const rows = db.prepare(`
    SELECT a.id AS account_id,a.code AS account_code,a.name AS account_name,
      COALESCE(SUM(CASE WHEN substr(t.transaction_date,1,7)=? THEN t.amount ELSE 0 END),0) AS month_1,
      COALESCE(SUM(CASE WHEN substr(t.transaction_date,1,7)=? THEN t.amount ELSE 0 END),0) AS month_2
    FROM accounts a LEFT JOIN transactions t ON ${join.join(' AND ')}
    GROUP BY a.id,a.code,a.name ORDER BY a.code
  `).all(month1, month2, ...params).map(row => ({
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    month1Amount: Number(row.month_1),
    month2Amount: Number(row.month_2),
    difference: Number(row.month_2) - Number(row.month_1)
  }));
  const users = canViewAll ? db.prepare('SELECT id AS userId,name,username,role FROM users WHERE active=1 ORDER BY name').all() : [];
  return { month1, month2, canViewAll, userId: userId || 'ALL', users, rows };
}

app.get('/api/account-comparison', authMiddleware, requirePermission('account_comparison.view'), (req, res, next) => {
  try { res.json(queryAccountComparison(req, req.query)); } catch (error) { next(error); }
});

// ---------- Pagu kas dan periode bulanan ----------

function budgetData(periodMonth) {
  monthBounds(periodMonth);
  const period = db.prepare('SELECT * FROM accounting_periods WHERE period_month=?').get(periodMonth);
  const budget = db.prepare('SELECT * FROM cash_budgets WHERE period_month=?').get(periodMonth);
  const bounds = monthBounds(periodMonth);
  const allocationRows = budget
    ? db.prepare(`SELECT ba.*,a.code AS account_code,a.name AS account_name,a.active
        FROM cash_budget_allocations ba JOIN accounts a ON a.id=ba.account_id
        WHERE ba.budget_id=? ORDER BY a.code`).all(budget.id)
    : db.prepare("SELECT id AS account_id,code AS account_code,name AS account_name,active,0 AS percentage_bps,0 AS allocated_amount FROM accounts WHERE active=1 AND transaction_scope='KELUAR' ORDER BY code").all();
  const usage = db.prepare(`SELECT account_id,
      COALESCE(SUM(CASE WHEN status='APPROVED' THEN amount ELSE 0 END),0) AS used_amount,
      COALESCE(SUM(CASE WHEN status='PENDING' THEN amount ELSE 0 END),0) AS pending_amount
    FROM transactions WHERE type='KELUAR' AND transaction_date>=? AND transaction_date<=?
    GROUP BY account_id`).all(bounds.startDate, bounds.endDate);
  const usageMap = Object.fromEntries(usage.map(row => [row.account_id, row]));
  const allocations = allocationRows.map(row => {
    const item = usageMap[row.account_id] || {};
    const allocated = Number(row.allocated_amount || 0);
    const used = Number(item.used_amount || 0);
    const pending = Number(item.pending_amount || 0);
    return {
      accountId: row.account_id,
      accountCode: row.account_code,
      accountName: row.account_name,
      active: Boolean(row.active),
      percentageBps: Number(row.percentage_bps || 0),
      percentage: Number(row.percentage_bps || 0) / 100,
      allocatedAmount: allocated,
      usedAmount: used,
      pendingAmount: pending,
      remainingAmount: allocated - used
    };
  });
  const totals = allocations.reduce((sum, row) => ({
    allocatedAmount: sum.allocatedAmount + row.allocatedAmount,
    usedAmount: sum.usedAmount + row.usedAmount,
    pendingAmount: sum.pendingAmount + row.pendingAmount,
    remainingAmount: sum.remainingAmount + row.remainingAmount
  }), { allocatedAmount: 0, usedAmount: 0, pendingAmount: 0, remainingAmount: 0 });
  return {
    periodMonth,
    periodStatus: period?.status || '',
    totalBudget: Number(budget?.total_budget || 0),
    configured: Boolean(budget),
    allocations,
    totals
  };
}

app.get('/api/budgets/current', authMiddleware, requirePermission('budgets.view'), (req, res, next) => {
  try {
    const open = getOpenPeriod();
    const requested = String(req.query.periodMonth || open.period_month);
    const periods = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM cash_budgets b WHERE b.period_month=p.period_month) AS has_budget
      FROM accounting_periods p ORDER BY p.period_month DESC LIMIT 24`).all().map(row => ({
      periodMonth: row.period_month, status: row.status, openedAt: row.opened_at,
      closedAt: row.closed_at || '', hasBudget: Boolean(row.has_budget)
    }));
    res.json({
      ...budgetData(requested),
      openPeriodMonth: open.period_month,
      currentCalendarMonth: localPeriodMonth(),
      canManage: hasPermission(req, 'budgets.manage'),
      canClose: hasPermission(req, 'periods.close'),
      canReopen: hasPermission(req, 'periods.reopen'),
      periods
    });
  } catch (error) { next(error); }
});

app.put('/api/budgets/:periodMonth', authMiddleware, requirePermission('budgets.manage'), (req, res, next) => {
  try {
    const periodMonth = String(req.params.periodMonth);
    const open = getOpenPeriod();
    if (periodMonth !== open.period_month) throw new AppError('Pagu hanya dapat diubah pada periode yang sedang terbuka.');
    const totalBudget = toAmount(req.body.totalBudget);
    if (totalBudget <= 0) throw new AppError('Total pagu kas harus lebih dari nol.');
    const input = Array.isArray(req.body.allocations) ? req.body.allocations : [];
    if (!input.length) throw new AppError('Pembagian pagu per akun wajib diisi.');
    const seen = new Set();
    const normalized = input.map(item => {
      const accountId = String(item.accountId || '');
      if (seen.has(accountId)) throw new AppError('Akun pada pembagian pagu tidak boleh duplikat.');
      seen.add(accountId);
      const account = db.prepare("SELECT * FROM accounts WHERE id=? AND active=1 AND transaction_scope='KELUAR'").get(accountId);
      const percentageBps = Number(item.percentageBps);
      if (!account || !Number.isInteger(percentageBps) || percentageBps < 0 || percentageBps > 10000) {
        throw new AppError('Akun atau persentase pembagian pagu tidak valid.');
      }
      return { account, percentageBps, allocatedAmount: Math.floor(totalBudget * percentageBps / 10000) };
    });
    if (normalized.reduce((sum, item) => sum + item.percentageBps, 0) !== 10000) throw new AppError('Total persentase pembagian pagu wajib tepat 100%.');
    const roundingDifference = totalBudget - normalized.reduce((sum, item) => sum + item.allocatedAmount, 0);
    normalized[normalized.length - 1].allocatedAmount += roundingDifference;
    const save = db.transaction(() => {
      let budget = db.prepare('SELECT * FROM cash_budgets WHERE period_month=?').get(periodMonth);
      const now = nowIso();
      if (!budget) {
        const id = newId('BDG');
        db.prepare(`INSERT INTO cash_budgets(id,period_month,total_budget,created_by,created_at,updated_by,updated_at)
          VALUES(?,?,?,?,?,?,?)`).run(id, periodMonth, totalBudget, req.auth.user.id, now, req.auth.user.id, now);
        budget = db.prepare('SELECT * FROM cash_budgets WHERE id=?').get(id);
      } else {
        db.prepare('UPDATE cash_budgets SET total_budget=?,updated_by=?,updated_at=? WHERE id=?')
          .run(totalBudget, req.auth.user.id, now, budget.id);
        db.prepare('DELETE FROM cash_budget_allocations WHERE budget_id=?').run(budget.id);
      }
      const insert = db.prepare(`INSERT INTO cash_budget_allocations(budget_id,account_id,percentage_bps,allocated_amount)
        VALUES(?,?,?,?)`);
      normalized.forEach(item => insert.run(budget.id, item.account.id, item.percentageBps, item.allocatedAmount));
      audit(req.auth.user.id, 'UPSERT', 'CASH_BUDGET', budget.id, '', { periodMonth, totalBudget, allocations: normalized.length }, 'Pagu kas bulanan disimpan');
    });
    save();
    res.json({ ok: true, ...budgetData(periodMonth) });
  } catch (error) { next(error); }
});

function pendingPeriodItems(bounds) {
  return {
    transactions: Number(db.prepare("SELECT COUNT(*) AS total FROM transactions WHERE status='PENDING' AND transaction_date BETWEEN ? AND ?").get(bounds.startDate, bounds.endDate).total),
    transfers: Number(db.prepare("SELECT COUNT(*) AS total FROM cash_transfers WHERE status='PENDING' AND transfer_date BETWEEN ? AND ?").get(bounds.startDate, bounds.endDate).total),
    umo: Number(db.prepare("SELECT COUNT(*) AS total FROM operational_advances WHERE status IN ('PENDING','SETTLEMENT_PENDING')").get().total),
    corrections: Number(db.prepare("SELECT COUNT(*) AS total FROM transaction_corrections WHERE status='PENDING'").get().total)
  };
}

app.post('/api/periods/eom', authMiddleware, requirePermission('periods.close'), (req, res, next) => {
  try {
    const open = getOpenPeriod();
    if (open.period_month >= localPeriodMonth()) throw new AppError('End of Month baru dapat dilakukan setelah bulan periode berakhir.');
    const bounds = monthBounds(open.period_month);
    const pending = pendingPeriodItems(bounds);
    if (Object.values(pending).some(Boolean)) throw new AppError(`EOM belum dapat dilakukan. Masih ada data pending: transaksi ${pending.transactions}, transfer ${pending.transfers}, UMO ${pending.umo}, koreksi ${pending.corrections}.`);
    const nextMonth = nextPeriodMonth(open.period_month);
    const close = db.transaction(() => {
      const users = db.prepare('SELECT id FROM users WHERE active=1').all();
      const closing = db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS total
        FROM ledger_entries WHERE user_id=? AND entry_date<=?`);
      const upsertBalance = db.prepare(`INSERT INTO period_balances(period_id,user_id,opening_balance,closing_balance)
        VALUES(?,?,0,?) ON CONFLICT(period_id,user_id) DO UPDATE SET closing_balance=excluded.closing_balance`);
      users.forEach(user => upsertBalance.run(open.id, user.id, Number(closing.get(user.id, bounds.endDate).total || 0)));
      db.prepare("UPDATE accounting_periods SET status='CLOSED',closed_at=?,closed_by=?,close_note=? WHERE id=?")
        .run(nowIso(), req.auth.user.id, cleanText(req.body.note, 500), open.id);
      let next = db.prepare('SELECT * FROM accounting_periods WHERE period_month=?').get(nextMonth);
      if (!next) {
        const nextId = newId('PER');
        db.prepare("INSERT INTO accounting_periods(id,period_month,status,opened_at,opened_by) VALUES(?,?,'OPEN',?,?)")
          .run(nextId, nextMonth, nowIso(), req.auth.user.id);
        next = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(nextId);
      } else db.prepare("UPDATE accounting_periods SET status='OPEN',opened_at=?,opened_by=? WHERE id=?").run(nowIso(), req.auth.user.id, next.id);
      const copy = db.prepare(`INSERT INTO period_balances(period_id,user_id,opening_balance)
        SELECT ?,user_id,COALESCE(closing_balance,opening_balance) FROM period_balances WHERE period_id=?
        ON CONFLICT(period_id,user_id) DO UPDATE SET opening_balance=excluded.opening_balance`);
      copy.run(next.id, open.id);
      audit(req.auth.user.id, 'CLOSE_PERIOD', 'ACCOUNTING_PERIOD', open.id, { status: 'OPEN' }, { status: 'CLOSED', nextMonth }, 'End of Month selesai');
    });
    close();
    res.json({ ok: true, closedPeriodMonth: open.period_month, openPeriodMonth: nextMonth });
  } catch (error) { next(error); }
});

app.post('/api/periods/:periodMonth/reopen', authMiddleware, requireSuperUser, asyncRoute(async (req, res) => {
  if (!hasPermission(req, 'periods.reopen')) throw new AppError('Anda tidak memiliki hak membuka kembali periode.', 403);
  const target = db.prepare("SELECT * FROM accounting_periods WHERE period_month=? AND status='CLOSED'").get(String(req.params.periodMonth));
  const open = getOpenPeriod();
  if (!target || nextPeriodMonth(target.period_month) !== open.period_month) throw new AppError('Hanya periode terakhir sebelum periode terbuka yang dapat dibuka kembali.');
  const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(req.auth.user.id);
  if (!user || !verifyPassword(String(req.body.currentPassword || ''), user.password_salt, user.password_hash)) throw new AppError('Password Super User tidak sesuai.', 401);
  const reason = cleanText(req.body.reason, 500);
  if (!reason) throw new AppError('Alasan membuka kembali periode wajib diisi.');
  const bounds = monthBounds(open.period_month);
  const activity = [
    db.prepare('SELECT COUNT(*) AS total FROM transactions WHERE transaction_date BETWEEN ? AND ?').get(bounds.startDate, bounds.endDate).total,
    db.prepare('SELECT COUNT(*) AS total FROM cash_transfers WHERE transfer_date BETWEEN ? AND ?').get(bounds.startDate, bounds.endDate).total,
    db.prepare('SELECT COUNT(*) AS total FROM operational_advances WHERE advance_date BETWEEN ? AND ?').get(bounds.startDate, bounds.endDate).total,
    db.prepare('SELECT COUNT(*) AS total FROM cash_budgets WHERE period_month=?').get(open.period_month).total
  ].reduce((sum, count) => sum + Number(count), 0);
  if (activity) throw new AppError('Periode baru sudah memiliki aktivitas atau pagu sehingga periode lama tidak aman untuk dibuka kembali.');
  const destination = await backupDatabase('before-clear');
  db.transaction(() => {
    db.prepare('DELETE FROM accounting_periods WHERE id=?').run(open.id);
    db.prepare(`UPDATE accounting_periods SET status='OPEN',closed_at=NULL,closed_by=NULL,close_note=NULL,
      reopened_at=?,reopened_by=?,reopen_reason=? WHERE id=?`).run(nowIso(), req.auth.user.id, reason, target.id);
    db.prepare('UPDATE period_balances SET closing_balance=NULL WHERE period_id=?').run(target.id);
    audit(req.auth.user.id, 'REOPEN_PERIOD', 'ACCOUNTING_PERIOD', target.id, { status: 'CLOSED' }, { status: 'OPEN', reason, backup: path.basename(destination) }, 'Periode dibuka kembali');
  })();
  res.json({ ok: true, openPeriodMonth: target.period_month, backupFileName: path.basename(destination) });
}));

// ---------- Transfer kas antar-staff ----------

function transferPublic(row) {
  return { transferId: row.id, transferNo: row.transfer_no, transferDate: row.transfer_date,
    senderUserId: row.sender_user_id, senderName: row.sender_name || '', recipientUserId: row.recipient_user_id,
    recipientName: row.recipient_name || '', amount: Number(row.amount), description: row.description,
    status: row.status, createdAt: row.created_at, approvedByName: row.approved_by_name || '',
    rejectionReason: row.rejection_reason || '', approvalId: row.approval_id || '' };
}

app.get('/api/transfers', authMiddleware, (req, res, next) => {
  try {
    const canAll = hasPermission(req, 'transfers.view_all');
    if (!canAll && !hasPermission(req, 'transfers.view_self')) throw new AppError('Anda tidak memiliki akses transfer kas.', 403);
    const rows = db.prepare(`SELECT tr.*,su.name AS sender_name,ru.name AS recipient_name,au.name AS approved_by_name,
      (SELECT ar.id FROM approval_requests ar WHERE ar.entity_type='TRANSFER' AND ar.entity_id=tr.id AND ar.decision='PENDING' LIMIT 1) AS approval_id
      FROM cash_transfers tr JOIN users su ON su.id=tr.sender_user_id JOIN users ru ON ru.id=tr.recipient_user_id
      LEFT JOIN users au ON au.id=tr.approved_by ${canAll ? '' : 'WHERE tr.sender_user_id=? OR tr.recipient_user_id=?'}
      ORDER BY tr.created_at DESC LIMIT 1000`).all(...(canAll ? [] : [req.auth.user.id, req.auth.user.id])).map(transferPublic);
    const recipients = hasPermission(req, 'transfers.create')
      ? db.prepare("SELECT id AS userId,name,username FROM users WHERE active=1 AND role='STAFF' AND id<>? ORDER BY name").all(req.auth.user.id) : [];
    res.json({ rows, recipients, balance: userBalance(req.auth.user.id) });
  } catch (error) { next(error); }
});

app.post('/api/transfers', authMiddleware, requirePermission('transfers.create'), (req, res, next) => {
  try {
    const recipient = db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND role='STAFF'").get(String(req.body.recipientUserId || ''));
    if (!recipient || recipient.id === req.auth.user.id) throw new AppError('Penerima transfer tidak valid.');
    const amount = toAmount(req.body.amount);
    if (amount <= 0) throw new AppError('Nominal transfer harus lebih dari nol.');
    if (userBalance(req.auth.user.id) < amount) throw new AppError('Saldo kas tidak mencukupi.');
    const transferDate = assertOpenTransactionDate(req.body.transferDate || localToday(), 'Tanggal transfer');
    const description = cleanText(req.body.description, 500);
    if (!description) throw new AppError('Keterangan transfer wajib diisi.');
    let rawToken = '';
    let transferNo = '';
    const id = newId('TRF');
    db.transaction(() => {
      transferNo = nextDocumentNo('TRF', req.auth.user.id);
      db.prepare(`INSERT INTO cash_transfers(id,transfer_no,transfer_date,sender_user_id,recipient_user_id,amount,description,status,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,'PENDING',?,?)`).run(id, transferNo, transferDate, req.auth.user.id, recipient.id, amount, description, req.auth.user.id, nowIso());
      rawToken = createApprovalRequest('TRANSFER', id);
      audit(req.auth.user.id, 'CREATE', 'TRANSFER', id, '', { transferNo, recipient: recipient.name, amount }, 'Transfer kas diajukan');
    })();
    res.status(201).json({ ok: true, transferId: id, transferNo, status: 'PENDING', approvalUrl: approvalUrl(req, rawToken) });
  } catch (error) { next(error); }
});

// ---------- Uang Muka Operasional (UMO) ----------

function indonesianNumberWords(value) {
  const number = Math.floor(Math.abs(Number(value || 0)));
  if (number === 0) return 'nol';
  const words = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
  if (number < 12) return words[number];
  if (number < 20) return `${indonesianNumberWords(number - 10)} belas`;
  if (number < 100) return `${indonesianNumberWords(Math.floor(number / 10))} puluh${number % 10 ? ` ${indonesianNumberWords(number % 10)}` : ''}`;
  if (number < 200) return `seratus${number > 100 ? ` ${indonesianNumberWords(number - 100)}` : ''}`;
  if (number < 1000) return `${indonesianNumberWords(Math.floor(number / 100))} ratus${number % 100 ? ` ${indonesianNumberWords(number % 100)}` : ''}`;
  if (number < 2000) return `seribu${number > 1000 ? ` ${indonesianNumberWords(number - 1000)}` : ''}`;
  if (number < 1000000) return `${indonesianNumberWords(Math.floor(number / 1000))} ribu${number % 1000 ? ` ${indonesianNumberWords(number % 1000)}` : ''}`;
  if (number < 1000000000) return `${indonesianNumberWords(Math.floor(number / 1000000))} juta${number % 1000000 ? ` ${indonesianNumberWords(number % 1000000)}` : ''}`;
  if (number < 1000000000000) return `${indonesianNumberWords(Math.floor(number / 1000000000))} miliar${number % 1000000000 ? ` ${indonesianNumberWords(number % 1000000000)}` : ''}`;
  return `${indonesianNumberWords(Math.floor(number / 1000000000000))} triliun${number % 1000000000000 ? ` ${indonesianNumberWords(number % 1000000000000)}` : ''}`;
}

function pdfDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return String(value || '-');
  const [year, month, day] = String(value).split('-');
  return `${day}/${month}/${year}`;
}

function umoPublic(row) {
  return { umoId: row.id, umoNo: row.umo_no, advanceDate: row.advance_date, userId: row.user_id,
    userName: row.user_name || '', bearerName: row.bearer_name, purpose: row.purpose, advanceAmount: Number(row.advance_amount),
    dueDate: row.due_date, overdue: ['OPEN','SETTLEMENT_PENDING'].includes(row.status) && row.due_date < localToday(),
    status: row.status, settledAmount: Number(row.settled_amount), returnedAmount: Number(row.returned_amount),
    extraAmount: Number(row.extra_amount), settlementNote: row.settlement_note || '', receiptAvailable: Boolean(row.settlement_receipt_path),
    receiptMime: row.settlement_receipt_mime || '', createdAt: row.created_at, approvedByName: row.approved_by_name || '',
    rejectionReason: row.rejection_reason || '', approvalId: row.approval_id || '',
    receiptPdfAvailable: ['OPEN','SETTLEMENT_PENDING','SETTLED'].includes(row.status) };
}

function finalizeUmoSettlement(umo, actorId) {
  const allocations = db.prepare(`SELECT ua.*,a.code AS account_code,a.name AS account_name FROM umo_allocations ua
    JOIN accounts a ON a.id=ua.account_id WHERE ua.umo_id=? AND ua.transaction_id IS NULL`).all(umo.id);
  if (!allocations.length) throw new AppError('Rincian realisasi UMO tidak ditemukan.');
  if (Number(umo.extra_amount) > 0 && userBalance(umo.user_id) < Number(umo.extra_amount)) throw new AppError('Saldo staff tidak mencukupi untuk selisih UMO.');
  const now = nowIso();
  for (const allocation of allocations) {
    const txId = newId('TRX');
    const txNo = nextDocumentNo('KSK', actorId);
    db.prepare(`INSERT INTO transactions(id,transaction_no,transaction_date,type,account_id,amount,approval_limit_snapshot,description,
      counterparty,receipt_path,receipt_original_name,receipt_mime,status,created_by,created_at,approved_by,approved_at,cash_effect,source_type,source_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'APPROVED',?,?,?,?,0,'UMO',?)`).run(
      txId, txNo, localToday(), 'KELUAR', allocation.account_id, allocation.amount, 0, allocation.description,
      umo.bearer_name, umo.settlement_receipt_path || '', umo.settlement_receipt_name || '', umo.settlement_receipt_mime || '',
      umo.user_id, now, actorId, now, umo.id
    );
    db.prepare('UPDATE umo_allocations SET transaction_id=? WHERE id=?').run(txId, allocation.id);
  }
  if (Number(umo.returned_amount) > 0) postLedger({ userId: umo.user_id, entryDate: localToday(), direction: 'IN', amount: umo.returned_amount,
    sourceType: 'UMO_RETURN', sourceId: umo.id, referenceNo: umo.umo_no, description: `Pengembalian sisa ${umo.umo_no}`, createdBy: actorId });
  if (Number(umo.extra_amount) > 0) postLedger({ userId: umo.user_id, entryDate: localToday(), direction: 'OUT', amount: umo.extra_amount,
    sourceType: 'UMO_EXTRA', sourceId: umo.id, referenceNo: umo.umo_no, description: `Tambahan realisasi ${umo.umo_no}`, createdBy: actorId });
  db.prepare("UPDATE operational_advances SET status='SETTLED',settled_at=?,approved_by=?,approved_at=?,rejection_reason=NULL WHERE id=?")
    .run(now, actorId, now, umo.id);
  audit(actorId, 'SETTLE', 'UMO', umo.id, '', { settledAmount: umo.settled_amount, returnedAmount: umo.returned_amount, extraAmount: umo.extra_amount }, 'UMO dipertanggungjawabkan');
}

app.get('/api/umo', authMiddleware, (req, res, next) => {
  try {
    const canAll = hasPermission(req, 'umo.view_all');
    if (!canAll && !hasPermission(req, 'umo.view_self')) throw new AppError('Anda tidak memiliki akses UMO.', 403);
    const rows = db.prepare(`SELECT uo.*,u.name AS user_name,au.name AS approved_by_name,
      (SELECT ar.id FROM approval_requests ar WHERE ar.entity_id=uo.id AND ar.decision='PENDING' ORDER BY ar.created_at DESC LIMIT 1) AS approval_id
      FROM operational_advances uo
      JOIN users u ON u.id=uo.user_id LEFT JOIN users au ON au.id=uo.approved_by ${canAll ? '' : 'WHERE uo.user_id=?'}
      ORDER BY uo.created_at DESC LIMIT 1000`).all(...(canAll ? [] : [req.auth.user.id])).map(umoPublic);
    res.json({ rows, balance: userBalance(req.auth.user.id), approvalLimit: Number(getSetting('UMO_APPROVAL_LIMIT', 500000)), dueDays: Number(getSetting('UMO_DUE_DAYS', 3)) });
  } catch (error) { next(error); }
});

app.post('/api/umo', authMiddleware, requirePermission('umo.create'), (req, res, next) => {
  try {
    const amount = toAmount(req.body.advanceAmount);
    if (amount <= 0) throw new AppError('Nominal UMO harus lebih dari nol.');
    if (userBalance(req.auth.user.id) < amount) throw new AppError('Saldo kas tidak mencukupi.');
    const bearerName = cleanText(req.body.bearerName, 120);
    const purpose = cleanText(req.body.purpose, 500);
    if (!bearerName || !purpose) throw new AppError('Pembawa uang dan keperluan wajib diisi.');
    const advanceDate = assertOpenTransactionDate(req.body.advanceDate || localToday(), 'Tanggal UMO');
    const dueDate = String(req.body.dueDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || dueDate < advanceDate) throw new AppError('Batas pertanggungjawaban tidak valid.');
    const needsApproval = amount > Number(getSetting('UMO_APPROVAL_LIMIT', 500000));
    const status = needsApproval ? 'PENDING' : 'OPEN';
    const id = newId('UMO');
    let umoNo = '';
    let rawToken = '';
    db.transaction(() => {
      umoNo = nextDocumentNo('UMO', req.auth.user.id);
      db.prepare(`INSERT INTO operational_advances(id,umo_no,advance_date,user_id,bearer_name,purpose,advance_amount,due_date,status,created_by,created_at,approved_by,approved_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,?)`).run(id, umoNo, advanceDate, req.auth.user.id, bearerName, purpose, amount, dueDate, status,
        req.auth.user.id, nowIso(), needsApproval ? null : req.auth.user.id, needsApproval ? null : nowIso());
      if (needsApproval) rawToken = createApprovalRequest('UMO_ISSUE', id);
      else postLedger({ userId: req.auth.user.id, entryDate: advanceDate, direction: 'OUT', amount, sourceType: 'UMO_ISSUE',
        sourceId: id, referenceNo: umoNo, description: purpose, createdBy: req.auth.user.id });
      audit(req.auth.user.id, 'CREATE', 'UMO', id, '', { umoNo, amount, status }, 'UMO dibuat');
    })();
    res.status(201).json({ ok: true, umoId: id, umoNo, status, approvalUrl: approvalUrl(req, rawToken),
      receiptPdfUrl: status === 'OPEN' ? `/api/umo/${encodeURIComponent(id)}/disbursement-receipt.pdf` : '' });
  } catch (error) { next(error); }
});

app.post('/api/umo/:umoId/settlement', authMiddleware, upload.single('receipt'), (req, res, next) => {
  try {
    assertOpenTransactionDate(localToday(), 'Tanggal pertanggungjawaban UMO');
    if (!hasPermission(req, 'umo.create') && !hasPermission(req, 'umo.view_all')) throw new AppError('Anda tidak memiliki akses pertanggungjawaban UMO.', 403);
    const umo = db.prepare('SELECT * FROM operational_advances WHERE id=?').get(req.params.umoId);
    if (!umo || umo.status !== 'OPEN') throw new AppError('UMO tidak tersedia untuk dipertanggungjawabkan.', 404);
    if (umo.user_id !== req.auth.user.id && !hasPermission(req, 'umo.view_all')) throw new AppError('Anda tidak memiliki akses ke UMO ini.', 403);
    if (!req.file) throw new AppError('Nota atau bukti realisasi wajib diunggah.');
    let allocations;
    try { allocations = JSON.parse(String(req.body.allocations || '[]')); } catch { throw new AppError('Rincian akun realisasi tidak valid.'); }
    if (!Array.isArray(allocations) || !allocations.length || allocations.length > 20) throw new AppError('Tambahkan minimal satu rincian akun realisasi.');
    const normalized = allocations.map(item => {
      const account = db.prepare("SELECT * FROM accounts WHERE id=? AND active=1 AND transaction_scope IN ('KELUAR','BOTH')").get(String(item.accountId || ''));
      const amount = toAmount(item.amount);
      const description = cleanText(item.description || umo.purpose, 500);
      if (!account || amount <= 0 || !description) throw new AppError('Akun, nominal, atau keterangan realisasi tidak valid.');
      return { account, amount, description };
    });
    const settledAmount = normalized.reduce((sum, item) => sum + item.amount, 0);
    const returnedAmount = Math.max(0, Number(umo.advance_amount) - settledAmount);
    const extraAmount = Math.max(0, settledAmount - Number(umo.advance_amount));
    if (extraAmount > 0 && userBalance(umo.user_id) < extraAmount) throw new AppError('Saldo kas tidak mencukupi untuk selisih realisasi UMO.');
    const needsApproval = extraAmount > 0 || normalized.some(item => item.amount > Number(item.account.approval_limit));
    let rawToken = '';
    db.transaction(() => {
      db.prepare('DELETE FROM umo_allocations WHERE umo_id=? AND transaction_id IS NULL').run(umo.id);
      const insert = db.prepare('INSERT INTO umo_allocations(id,umo_id,account_id,amount,description,created_at) VALUES(?,?,?,?,?,?)');
      normalized.forEach(item => insert.run(newId('UAL'), umo.id, item.account.id, item.amount, item.description, nowIso()));
      db.prepare(`UPDATE operational_advances SET status=?,settlement_note=?,settlement_receipt_path=?,settlement_receipt_name=?,settlement_receipt_mime=?,
        settled_amount=?,returned_amount=?,extra_amount=?,rejection_reason=NULL WHERE id=?`).run(
        needsApproval ? 'SETTLEMENT_PENDING' : 'OPEN', cleanText(req.body.note, 500), req.file.filename, safeFileName(req.file.originalname),
        req.file.mimetype, settledAmount, returnedAmount, extraAmount, umo.id
      );
      if (needsApproval) rawToken = createApprovalRequest('UMO_SETTLEMENT', umo.id);
      else finalizeUmoSettlement(db.prepare('SELECT * FROM operational_advances WHERE id=?').get(umo.id), req.auth.user.id);
    })();
    res.json({ ok: true, umoNo: umo.umo_no, status: needsApproval ? 'SETTLEMENT_PENDING' : 'SETTLED', settledAmount, returnedAmount, extraAmount, approvalUrl: approvalUrl(req, rawToken) });
  } catch (error) { next(error); }
});

app.get('/api/umo/:umoId/receipt', authMiddleware, (req, res, next) => {
  try {
    const umo = db.prepare('SELECT * FROM operational_advances WHERE id=?').get(req.params.umoId);
    if (!umo) throw new AppError('UMO tidak ditemukan.', 404);
    const canView = hasPermission(req, 'umo.view_all') || (hasPermission(req, 'umo.view_self') && umo.user_id === req.auth.user.id);
    if (!canView) throw new AppError('Anda tidak memiliki akses bukti UMO.', 403);
    sendStoredReceipt(res, { path: umo.settlement_receipt_path, name: umo.settlement_receipt_name, mime: umo.settlement_receipt_mime });
  } catch (error) { next(error); }
});

app.get('/api/umo/:umoId/disbursement-receipt.pdf', authMiddleware, (req, res, next) => {
  try {
    const umo = db.prepare(`SELECT uo.*,u.name AS user_name,au.name AS approved_by_name FROM operational_advances uo
      JOIN users u ON u.id=uo.user_id LEFT JOIN users au ON au.id=uo.approved_by WHERE uo.id=?`).get(req.params.umoId);
    if (!umo) throw new AppError('UMO tidak ditemukan.', 404);
    const canView = hasPermission(req, 'umo.view_all') || (hasPermission(req, 'umo.view_self') && umo.user_id === req.auth.user.id);
    if (!canView) throw new AppError('Anda tidak memiliki akses tanda terima UMO.', 403);
    if (!['OPEN','SETTLEMENT_PENDING','SETTLED'].includes(umo.status)) throw new AppError('Tanda terima tersedia setelah UMO disetujui.');

    const fileName = `Tanda_Terima_${safeFileName(umo.umo_no)}.pdf`;
    res.type('application/pdf');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Tanda Terima ${umo.umo_no}` } });
    doc.pipe(res);

    const branding = publicAppConfig();
    const logoFile = path.basename(String(getSetting('COMPANY_LOGO_FILE', '') || ''));
    const logoPath = logoFile ? path.join(UPLOAD_DIR, logoFile) : '';
    if (logoPath && fs.existsSync(logoPath)) {
      try { doc.image(logoPath, 48, 42, { fit: [72, 58], align: 'left', valign: 'center' }); } catch (ignored) {}
    }
    doc.fontSize(15).fillColor('#172033').text(branding.companyName, 135, 48, { align: 'left' });
    doc.fontSize(9).fillColor('#64748b').text(branding.appName, 135, 69);
    doc.moveTo(48, 112).lineTo(547, 112).strokeColor(branding.themeColor).lineWidth(2).stroke();
    doc.moveDown(3).fontSize(17).fillColor('#172033').text('TANDA TERIMA UANG MUKA OPERASIONAL', { align: 'center' });
    doc.fontSize(10).fillColor('#64748b').text(umo.umo_no, { align: 'center' });

    const startY = doc.y + 28;
    const rows = [
      ['Tanggal pencairan', pdfDate(umo.advance_date)],
      ['Penerima uang', umo.bearer_name],
      ['Diserahkan oleh', umo.user_name],
      ['Nominal', `Rp ${Number(umo.advance_amount).toLocaleString('id-ID')}`],
      ['Terbilang', `${indonesianNumberWords(umo.advance_amount)} rupiah`],
      ['Keperluan', umo.purpose],
      ['Batas pertanggungjawaban', pdfDate(umo.due_date)]
    ];
    let y = startY;
    for (const [label, value] of rows) {
      const height = label === 'Keperluan' ? 54 : 29;
      doc.rect(48, y, 150, height).fillAndStroke('#f1f5f9', '#cbd5e1');
      doc.rect(198, y, 349, height).fillAndStroke('#ffffff', '#cbd5e1');
      doc.fontSize(9).fillColor('#475569').text(label, 58, y + 9, { width: 130 });
      doc.fontSize(10).fillColor('#172033').text(String(value || '-'), 210, y + 8, { width: 325, height: height - 12, ellipsis: true });
      y += height;
    }
    doc.fontSize(9).fillColor('#64748b').text('Dengan menandatangani dokumen ini, penerima menyatakan telah menerima uang sesuai nominal di atas dan wajib mempertanggungjawabkannya dengan bukti yang sah.', 48, y + 18, { width: 499, align: 'justify' });

    const signY = y + 88;
    const signers = [
      ['Diserahkan oleh', umo.user_name],
      ['Penerima', umo.bearer_name],
      ['Mengetahui', umo.approved_by_name || '-']
    ];
    signers.forEach(([label, name], index) => {
      const x = 48 + index * 166;
      doc.fontSize(9).fillColor('#475569').text(label, x, signY, { width: 150, align: 'center' });
      doc.moveTo(x + 12, signY + 78).lineTo(x + 138, signY + 78).strokeColor('#64748b').lineWidth(1).stroke();
      doc.fontSize(9).fillColor('#172033').text(name, x, signY + 83, { width: 150, align: 'center' });
    });
    doc.fontSize(8).fillColor('#94a3b8').text(`Dicetak dari ${branding.appName} pada ${new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: APP_TIMEZONE() }).format(new Date())}`, 48, 782, { width: 499, align: 'center' });
    audit(req.auth.user.id, 'PRINT_UMO_RECEIPT', 'UMO', umo.id, '', '', 'Tanda terima pencairan UMO dicetak');
    doc.end();
  } catch (error) { next(error); }
});

// ---------- Koreksi dan reversal transaksi ----------

function correctionPublic(row) {
  return { correctionId: row.id, correctionNo: row.correction_no, originalTransactionId: row.original_transaction_id,
    originalTransactionNo: row.transaction_no || '', correctionType: row.correction_type, reason: row.reason,
    proposedDate: row.proposed_date || '', proposedType: row.proposed_type || '', proposedAccountId: row.proposed_account_id || '',
    proposedAccountName: row.proposed_account_name || '', proposedAmount: Number(row.proposed_amount || 0),
    proposedDescription: row.proposed_description || '', status: row.status, createdByName: row.created_by_name || '',
    approvedByName: row.approved_by_name || '', rejectionReason: row.rejection_reason || '', createdAt: row.created_at,
    approvalId: row.approval_id || '' };
}

function finalizeCorrection(correction, actorId) {
  const original = db.prepare('SELECT * FROM transactions WHERE id=?').get(correction.original_transaction_id);
  if (!original || original.status !== 'APPROVED') throw new AppError('Transaksi asal sudah tidak dapat dikoreksi.');
  if (Boolean(original.cash_effect)) {
    const reverseDirection = original.type === 'MASUK' ? 'OUT' : 'IN';
    if (reverseDirection === 'OUT' && userBalance(original.created_by) < Number(original.amount)) throw new AppError('Saldo tidak mencukupi untuk membalik transaksi kas masuk.');
    postLedger({ userId: original.created_by, entryDate: localToday(), direction: reverseDirection, amount: original.amount,
      sourceType: 'CORRECTION_REVERSAL', sourceId: correction.id, referenceNo: correction.correction_no,
      description: `Reversal ${original.transaction_no}: ${correction.reason}`, accountId: original.account_id, createdBy: actorId });
  }
  db.prepare("UPDATE transactions SET status='CORRECTED' WHERE id=?").run(original.id);
  let replacementId = null;
  if (correction.correction_type === 'REPLACEMENT') {
    const account = db.prepare('SELECT * FROM accounts WHERE id=? AND active=1').get(correction.proposed_account_id);
    if (!account) throw new AppError('Akun transaksi pengganti tidak tersedia.');
    if (account.transaction_scope !== 'BOTH' && account.transaction_scope !== correction.proposed_type) throw new AppError('Akun tidak sesuai transaksi pengganti.');
    if (Boolean(original.cash_effect) && correction.proposed_type === 'KELUAR' && userBalance(original.created_by) < Number(correction.proposed_amount)) throw new AppError('Saldo tidak mencukupi untuk transaksi pengganti.');
    replacementId = newId('TRX');
    const replacementNo = nextDocumentNo('KSK', actorId);
    const now = nowIso();
    db.prepare(`INSERT INTO transactions(id,transaction_no,transaction_date,type,account_id,amount,approval_limit_snapshot,description,counterparty,
      receipt_path,receipt_original_name,receipt_mime,status,created_by,created_at,approved_by,approved_at,corrected_from_id,cash_effect,source_type,source_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'APPROVED',?,?,?,?,?,?, 'CORRECTION',?)`).run(
      replacementId, replacementNo, correction.proposed_date, correction.proposed_type, correction.proposed_account_id,
      correction.proposed_amount, Number(account.approval_limit), correction.proposed_description, correction.proposed_counterparty || '',
      correction.proposed_receipt_path || original.receipt_path || '', correction.proposed_receipt_name || original.receipt_original_name || '',
      correction.proposed_receipt_mime || original.receipt_mime || '', original.created_by, now, actorId, now, original.id,
      Number(original.cash_effect), correction.id
    );
    postTransactionLedger(db.prepare('SELECT * FROM transactions WHERE id=?').get(replacementId), actorId);
  }
  db.prepare("UPDATE transaction_corrections SET status='APPROVED',approved_by=?,approved_at=?,replacement_transaction_id=? WHERE id=?")
    .run(actorId, nowIso(), replacementId, correction.id);
  audit(actorId, 'CORRECT', 'TRANSACTION', original.id, { status: 'APPROVED' }, { status: 'CORRECTED', replacementId }, correction.reason);
}

app.get('/api/corrections', authMiddleware, (req, res, next) => {
  try {
    const canAll = hasPermission(req, 'corrections.view_all');
    if (!canAll && !hasPermission(req, 'corrections.create')) throw new AppError('Anda tidak memiliki akses koreksi.', 403);
    const rows = db.prepare(`SELECT c.*,t.transaction_no,pa.name AS proposed_account_name,cu.name AS created_by_name,au.name AS approved_by_name,
      (SELECT ar.id FROM approval_requests ar WHERE ar.entity_type='CORRECTION' AND ar.entity_id=c.id AND ar.decision='PENDING' LIMIT 1) AS approval_id
      FROM transaction_corrections c JOIN transactions t ON t.id=c.original_transaction_id
      LEFT JOIN accounts pa ON pa.id=c.proposed_account_id JOIN users cu ON cu.id=c.created_by LEFT JOIN users au ON au.id=c.approved_by
      ${canAll ? '' : 'WHERE c.created_by=?'} ORDER BY c.created_at DESC LIMIT 1000`).all(...(canAll ? [] : [req.auth.user.id])).map(correctionPublic);
    const transactions = db.prepare(`SELECT t.*,a.name AS account_name,u.name AS created_by_name,'' AS approved_by_name FROM transactions t
      JOIN accounts a ON a.id=t.account_id JOIN users u ON u.id=t.created_by
      WHERE t.status='APPROVED' ${canAll ? '' : 'AND t.created_by=?'}
      AND NOT EXISTS(SELECT 1 FROM transaction_corrections c WHERE c.original_transaction_id=t.id AND c.status IN ('PENDING','APPROVED'))
      ORDER BY t.transaction_date DESC,t.transaction_no DESC LIMIT 500`).all(...(canAll ? [] : [req.auth.user.id])).map(transactionPublic);
    res.json({ rows, transactions });
  } catch (error) { next(error); }
});

app.post('/api/corrections', authMiddleware, requirePermission('corrections.create'), upload.single('receipt'), (req, res, next) => {
  try {
    assertOpenTransactionDate(localToday(), 'Tanggal koreksi');
    const original = db.prepare('SELECT * FROM transactions WHERE id=?').get(String(req.body.originalTransactionId || ''));
    if (!original || original.status !== 'APPROVED') throw new AppError('Transaksi asal tidak dapat dikoreksi.');
    if (original.created_by !== req.auth.user.id && !hasPermission(req, 'corrections.view_all')) throw new AppError('Anda tidak memiliki akses ke transaksi tersebut.', 403);
    const existing = db.prepare("SELECT 1 FROM transaction_corrections WHERE original_transaction_id=? AND status IN ('PENDING','APPROVED')").get(original.id);
    if (existing) throw new AppError('Transaksi tersebut sudah memiliki pengajuan koreksi.');
    const correctionType = String(req.body.correctionType || '').toUpperCase();
    if (!['REVERSAL','REPLACEMENT'].includes(correctionType)) throw new AppError('Jenis koreksi tidak valid.');
    const reason = cleanText(req.body.reason, 500);
    if (!reason) throw new AppError('Alasan koreksi wajib diisi.');
    let proposed = { date: null, type: null, accountId: null, amount: null, description: null, counterparty: null };
    if (correctionType === 'REPLACEMENT') {
      proposed = { date: assertOpenTransactionDate(req.body.transactionDate || localToday(), 'Tanggal transaksi pengganti'), type: String(req.body.type || original.type).toUpperCase(),
        accountId: String(req.body.accountId || original.account_id), amount: toAmount(req.body.amount || original.amount),
        description: cleanText(req.body.description || original.description, 500), counterparty: cleanText(req.body.counterparty || original.counterparty, 150) };
      const account = db.prepare('SELECT * FROM accounts WHERE id=? AND active=1').get(proposed.accountId);
      if (!['MASUK','KELUAR'].includes(proposed.type) ||
          !account || proposed.amount <= 0 || !proposed.description) throw new AppError('Data transaksi pengganti tidak valid.');
    }
    const id = newId('COR');
    let correctionNo = '';
    let rawToken = '';
    db.transaction(() => {
      correctionNo = nextDocumentNo('KOR', req.auth.user.id);
      db.prepare(`INSERT INTO transaction_corrections(id,correction_no,original_transaction_id,correction_type,reason,proposed_date,proposed_type,
        proposed_account_id,proposed_amount,proposed_description,proposed_counterparty,proposed_receipt_path,proposed_receipt_name,proposed_receipt_mime,
        status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?)`).run(
        id, correctionNo, original.id, correctionType, reason, proposed.date, proposed.type, proposed.accountId, proposed.amount,
        proposed.description, proposed.counterparty, req.file ? req.file.filename : null, req.file ? safeFileName(req.file.originalname) : null,
        req.file ? req.file.mimetype : null, req.auth.user.id, nowIso()
      );
      rawToken = createApprovalRequest('CORRECTION', id);
      audit(req.auth.user.id, 'CREATE', 'CORRECTION', id, '', { correctionNo, original: original.transaction_no, correctionType }, 'Koreksi diajukan');
    })();
    res.status(201).json({ ok: true, correctionId: id, correctionNo, status: 'PENDING', approvalUrl: approvalUrl(req, rawToken) });
  } catch (error) { next(error); }
});

// ---------- Super User: users & granular permissions ----------

app.get('/api/admin/users', authMiddleware, requirePermission('users.manage'), (_req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY name').all().map(user => ({
    ...publicUser(user),
    permissions: getUserPermissions(user.id, user.role)
  }));
  res.json({ users });
});

app.post('/api/admin/users', authMiddleware, requirePermission('users.manage'), (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 120);
    const username = cleanUsername(req.body.username);
    const role = String(req.body.role || '').toUpperCase();
    if (!name || !/^[a-z0-9._-]{3,40}$/.test(username)) throw new AppError('Nama atau username tidak valid.');
    if (!['STAFF', 'SPV', 'SUPER_USER'].includes(role)) throw new AppError('Role pengguna tidak valid.');
    assertPassword(req.body.password);
    const passwordData = hashPassword(req.body.password);
    const id = newId('USR');
    const now = nowIso();
    db.prepare('INSERT INTO users(id,name,username,password_hash,password_salt,role,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)')
      .run(id, name, username, passwordData.hash, passwordData.salt, role, now, now);
    audit(req.auth.user.id, 'CREATE', 'USER', id, '', { name, username, role }, 'Pengguna dibuat');
    res.status(201).json({ ok: true, userId: id });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return next(new AppError('Username sudah digunakan.'));
    next(error);
  }
});

app.patch('/api/admin/users/:userId', authMiddleware, requirePermission('users.manage'), (req, res, next) => {
  try {
    const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.userId);
    if (!target) throw new AppError('Pengguna tidak ditemukan.', 404);
    const patch = {
      name: req.body.name === undefined ? target.name : cleanText(req.body.name, 120),
      username: req.body.username === undefined ? target.username : cleanUsername(req.body.username),
      role: req.body.role === undefined ? target.role : String(req.body.role).toUpperCase(),
      active: req.body.active === undefined ? target.active : Number(toBoolean(req.body.active))
    };
    if (!patch.name || !/^[a-z0-9._-]{3,40}$/.test(patch.username)) throw new AppError('Nama atau username tidak valid.');
    if (!['STAFF', 'SPV', 'SUPER_USER'].includes(patch.role)) throw new AppError('Role tidak valid.');
    if (target.id === req.auth.user.id && !patch.active) throw new AppError('Anda tidak dapat menonaktifkan akun sendiri.');

    const updateUser = db.transaction(() => {
      db.prepare('UPDATE users SET name=?,username=?,role=?,active=?,updated_at=? WHERE id=?')
        .run(patch.name, patch.username, patch.role, patch.active, nowIso(), target.id);
      if (patch.role !== target.role) db.prepare('DELETE FROM user_permissions WHERE user_id=?').run(target.id);
      if (req.body.password) {
        assertPassword(req.body.password);
        const passwordData = hashPassword(req.body.password);
        db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').run(passwordData.hash, passwordData.salt, target.id);
        revokeUserSessions(target.id);
      }
      if (!patch.active) revokeUserSessions(target.id);
      audit(req.auth.user.id, 'UPDATE', 'USER', target.id, publicUser(target), patch, 'Pengguna diperbarui');
    });
    updateUser();
    res.json({ ok: true });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return next(new AppError('Username sudah digunakan.'));
    next(error);
  }
});

function saveApprovalPin(userId, pin, actorId) {
  assertApprovalPin(pin);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user) throw new AppError('Pengguna tidak ditemukan.', 404);
  if (!getUserPermissions(user.id, user.role).includes('approvals.decide')) throw new AppError('Pengguna belum memiliki hak untuk memberikan approval.');
  const pinData = hashApprovalPin(pin);
  try {
    db.prepare('UPDATE users SET approval_pin_hash=?,approval_pin_salt=?,approval_pin_fingerprint=?,updated_at=? WHERE id=?')
      .run(pinData.hash, pinData.salt, pinData.fingerprint, nowIso(), user.id);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) throw new AppError('PIN tersebut sudah digunakan approver lain. Gunakan PIN yang berbeda.');
    throw error;
  }
  audit(actorId, 'SET_APPROVAL_PIN', 'USER', user.id, '', '', 'PIN approval dibuat atau diubah');
}

app.put('/api/admin/users/:userId/approval-pin', authMiddleware, requirePermission('users.manage'), (req, res, next) => {
  try {
    saveApprovalPin(req.params.userId, String(req.body.pin || ''), req.auth.user.id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.put('/api/auth/approval-pin', authMiddleware, (req, res, next) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.auth.user.id);
    if (!verifyPassword(String(req.body.currentPassword || ''), user.password_salt, user.password_hash)) throw new AppError('Password saat ini tidak sesuai.');
    saveApprovalPin(user.id, String(req.body.pin || ''), user.id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/admin/access', authMiddleware, requirePermission('permissions.manage'), (_req, res) => {
  const overrides = db.prepare('SELECT user_id,permission_code,allowed FROM user_permissions').all();
  const byUser = overrides.reduce((map, row) => {
    map[row.user_id] ||= {};
    map[row.user_id][row.permission_code] = Boolean(row.allowed);
    return map;
  }, {});
  const users = db.prepare('SELECT * FROM users ORDER BY name').all().map(user => ({
    ...publicUser(user),
    effectivePermissions: getUserPermissions(user.id, user.role),
    overrides: byUser[user.id] || {}
  }));
  res.json({ catalog: PERMISSION_CATALOG, roleDefaults: ROLE_DEFAULTS, users });
});

app.put('/api/admin/users/:userId/permissions', authMiddleware, requirePermission('permissions.manage'), (req, res, next) => {
  try {
    const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.userId);
    if (!target) throw new AppError('Pengguna tidak ditemukan.', 404);
    if (target.role === 'SUPER_USER') throw new AppError('Super User selalu memiliki seluruh akses agar sistem tidak terkunci.');
    const validCodes = new Set(PERMISSION_CATALOG.map(item => item.code));
    const values = req.body.permissions || {};
    const save = db.transaction(() => {
      const upsert = db.prepare(`INSERT INTO user_permissions(user_id,permission_code,allowed,updated_by,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,permission_code) DO UPDATE SET allowed=excluded.allowed,updated_by=excluded.updated_by,updated_at=excluded.updated_at`);
      const remove = db.prepare('DELETE FROM user_permissions WHERE user_id=? AND permission_code=?');
      for (const [code, allowed] of Object.entries(values)) {
        if (!validCodes.has(code)) continue;
        if (allowed === null || allowed === 'default') remove.run(target.id, code);
        else upsert.run(target.id, code, Number(toBoolean(allowed)), req.auth.user.id, nowIso());
      }
      audit(req.auth.user.id, 'UPDATE_PERMISSIONS', 'USER', target.id, '', values, 'Hak akses pengguna diperbarui');
    });
    save();
    revokeUserSessions(target.id);
    res.json({ ok: true, effectivePermissions: getUserPermissions(target.id, target.role) });
  } catch (error) { next(error); }
});

// ---------- Super User: accounts, settings, audit ----------

app.get('/api/accounts', authMiddleware, requirePermission('accounts.view'), (_req, res) => {
  res.json({ accounts: db.prepare('SELECT * FROM accounts WHERE active=1 ORDER BY code').all().map(accountPublic) });
});

app.get('/api/admin/accounts', authMiddleware, requirePermission('accounts.manage'), (_req, res) => {
  res.json({ accounts: db.prepare('SELECT * FROM accounts ORDER BY code').all().map(accountPublic) });
});

app.post('/api/admin/accounts', authMiddleware, requirePermission('accounts.manage'), (req, res, next) => {
  try {
    const code = cleanText(req.body.accountCode, 30).toUpperCase();
    const name = cleanText(req.body.accountName, 120);
    const scope = String(req.body.transactionScope || 'BOTH').toUpperCase();
    const limit = Math.max(0, toAmount(req.body.approvalLimit));
    if (!code || !name || !['MASUK', 'KELUAR', 'BOTH'].includes(scope)) throw new AppError('Data akun tidak valid.');
    const id = newId('ACC');
    const now = nowIso();
    db.prepare(`INSERT INTO accounts(id,code,name,transaction_scope,approval_limit,receipt_required,underlying_required,active,updated_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,1,?,?,?)`)
      .run(id, code, name, scope, limit, Number(toBoolean(req.body.receiptRequired)), Number(toBoolean(req.body.underlyingRequired)), req.auth.user.id, now, now);
    audit(req.auth.user.id, 'CREATE', 'ACCOUNT', id, '', { code, name, scope, limit, receiptRequired: toBoolean(req.body.receiptRequired), underlyingRequired: toBoolean(req.body.underlyingRequired) }, 'Akun kas dibuat');
    res.status(201).json({ ok: true, accountId: id });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return next(new AppError('Kode akun sudah digunakan.'));
    next(error);
  }
});

app.patch('/api/admin/accounts/:accountId', authMiddleware, requirePermission('accounts.manage'), (req, res, next) => {
  try {
    const target = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.accountId);
    if (!target) throw new AppError('Akun tidak ditemukan.', 404);
    const code = req.body.accountCode === undefined ? target.code : cleanText(req.body.accountCode, 30).toUpperCase();
    const name = req.body.accountName === undefined ? target.name : cleanText(req.body.accountName, 120);
    const scope = req.body.transactionScope === undefined ? target.transaction_scope : String(req.body.transactionScope).toUpperCase();
    const limit = req.body.approvalLimit === undefined ? target.approval_limit : Math.max(0, toAmount(req.body.approvalLimit));
    const required = req.body.receiptRequired === undefined ? target.receipt_required : Number(toBoolean(req.body.receiptRequired));
    const underlyingRequired = req.body.underlyingRequired === undefined ? target.underlying_required : Number(toBoolean(req.body.underlyingRequired));
    const active = req.body.active === undefined ? target.active : Number(toBoolean(req.body.active));
    if (!code || !name || !['MASUK', 'KELUAR', 'BOTH'].includes(scope)) throw new AppError('Data akun tidak valid.');
    db.prepare('UPDATE accounts SET code=?,name=?,transaction_scope=?,approval_limit=?,receipt_required=?,underlying_required=?,active=?,updated_by=?,updated_at=? WHERE id=?')
      .run(code, name, scope, limit, required, underlyingRequired, active, req.auth.user.id, nowIso(), target.id);
    audit(req.auth.user.id, 'UPDATE', 'ACCOUNT', target.id, accountPublic(target), { code, name, scope, limit, required, underlyingRequired, active }, 'Akun kas diperbarui');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/admin/settings', authMiddleware, requirePermission('settings.manage'), (_req, res) => {
  const settings = db.prepare('SELECT key,value,value_type,description FROM settings ORDER BY key').all();
  res.json({ settings, branding: publicAppConfig() });
});

app.post('/api/admin/settings/logo', authMiddleware, requirePermission('settings.manage'), logoUpload.single('logo'), (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Pilih file logo JPG atau PNG.');
    const oldFile = path.basename(String(getSetting('COMPANY_LOGO_FILE', '') || ''));
    setSetting('COMPANY_LOGO_FILE', req.file.filename, req.auth.user.id);
    audit(req.auth.user.id, 'UPDATE_LOGO', 'SETTING', 'COMPANY_LOGO_FILE', oldFile, req.file.filename, 'Logo perusahaan diperbarui');
    if (oldFile && oldFile !== req.file.filename && oldFile.startsWith('brand-')) {
      const oldPath = path.join(UPLOAD_DIR, oldFile);
      try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (ignored) {}
    }
    res.json({ ok: true, ...publicAppConfig() });
  } catch (error) { next(error); }
});

app.patch('/api/admin/settings', authMiddleware, requirePermission('settings.manage'), (req, res, next) => {
  try {
    const allowed = new Set(['APP_NAME', 'COMPANY_NAME', 'OPENING_BALANCE', 'SESSION_HOURS', 'APPROVAL_TOKEN_HOURS', 'MAX_UPLOAD_MB', 'UMO_APPROVAL_LIMIT', 'UMO_DUE_DAYS', 'THEME_COLOR']);
    for (const [key, value] of Object.entries(req.body || {})) {
      if (!allowed.has(key)) continue;
      if (key === 'THEME_COLOR' && !/^#[0-9a-f]{6}$/i.test(String(value || ''))) throw new AppError('Warna tema tidak valid.');
      setSetting(key, value, req.auth.user.id);
    }
    audit(req.auth.user.id, 'UPDATE', 'SETTING', '', '', req.body, 'Pengaturan aplikasi diperbarui');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

function backupPublic(record) {
  const labels = { AUTOMATIC: 'Otomatis', MANUAL: 'Manual', BEFORE_CLEAR: 'Sebelum reset' };
  return {
    fileName: record.fileName,
    type: record.type,
    typeLabel: labels[record.type] || record.type,
    size: Number(record.size),
    createdAt: record.createdAt,
    downloadUrl: `/api/admin/database/backups/${encodeURIComponent(record.fileName)}`
  };
}

function assertBackupPassword(password) {
  const value = String(password || '');
  if (value.length < 8 || value.length > 128) throw new AppError('Password backup minimal 8 karakter dan maksimal 128 karakter.');
  return value;
}

function assertCurrentSuperUserPassword(req, password) {
  const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(req.auth.user.id);
  if (!user || !verifyPassword(String(password || ''), user.password_salt, user.password_hash)) {
    throw new AppError('Password Super User tidak sesuai.', 401);
  }
}

function encryptedBackupBuffer(payload, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const wrapper = {
    format: 'KAS_KECIL_FULL_BACKUP', version: 1, algorithm: 'aes-256-gcm+scrypt+gzip',
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
  return Buffer.from(`KKBACKUP1\n${JSON.stringify(wrapper)}`);
}

function decryptedBackupPayload(buffer, password) {
  try {
    const text = buffer.toString('utf8');
    if (!text.startsWith('KKBACKUP1\n')) throw new Error('signature');
    const wrapper = JSON.parse(text.slice('KKBACKUP1\n'.length));
    if (wrapper.format !== 'KAS_KECIL_FULL_BACKUP' || Number(wrapper.version) !== 1) throw new Error('format');
    const key = crypto.scryptSync(password, Buffer.from(wrapper.salt, 'base64'), 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(wrapper.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(wrapper.tag, 'base64'));
    const compressed = Buffer.concat([decipher.update(Buffer.from(wrapper.data, 'base64')), decipher.final()]);
    return JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
  } catch {
    throw new AppError('File atau password backup tidak valid.');
  }
}

function uploadFilesForBackup() {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const filePath = path.join(UPLOAD_DIR, entry.name);
      const stat = fs.statSync(filePath);
      return { name: entry.name, size: stat.size, data: fs.readFileSync(filePath).toString('base64') };
    });
}

function createFullBackupBuffer(password, actorId, purpose = 'export') {
  audit(actorId, purpose === 'export' ? 'EXPORT_FULL_BACKUP' : 'BACKUP_BEFORE_RESTORE', 'DATABASE', '', '', '',
    purpose === 'export' ? 'Export data lengkap dibuat' : 'Backup lengkap dibuat sebelum restore');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshot = path.join(DATA_DIR, `full-backup-${crypto.randomUUID()}.sqlite`);
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    const uploads = uploadFilesForBackup();
    const payload = {
      manifest: {
        format: 'KAS_KECIL_FULL_BACKUP', version: 1, appVersion: APP_VERSION, createdAt: nowIso(),
        purpose, uploadCount: uploads.length, databaseFile: 'kas-kecil.sqlite', containsSecurityPepper: true
      },
      database: fs.readFileSync(snapshot).toString('base64'),
      uploads,
      security: { appPepper: appPepperForBackup() }
    };
    return { buffer: encryptedBackupBuffer(payload, password), stamp, manifest: payload.manifest };
  } finally {
    try { if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot); } catch (ignored) {}
  }
}

function validateRestorePayload(payload, stageDir) {
  if (payload?.manifest?.format !== 'KAS_KECIL_FULL_BACKUP' || !payload.database || !Array.isArray(payload.uploads) ||
      !payload.security?.appPepper || String(payload.security.appPepper).length < 16) {
    throw new AppError('Isi backup lengkap tidak valid.');
  }
  if (payload.uploads.length > 20000) throw new AppError('Jumlah lampiran dalam backup melebihi batas aman.');
  fs.mkdirSync(stageDir, { recursive: true });
  const candidateDb = path.join(stageDir, 'kas-kecil.sqlite');
  fs.writeFileSync(candidateDb, Buffer.from(payload.database, 'base64'));
  const candidate = new DatabaseSync(candidateDb, { readOnly: true });
  try {
    const result = candidate.prepare('PRAGMA quick_check').get();
    if (String(Object.values(result || {})[0] || '').toLowerCase() !== 'ok') throw new Error('quick-check');
    const required = new Set(['users', 'settings', 'audit_logs', 'transactions']);
    candidate.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().forEach(row => required.delete(row.name));
    if (required.size) throw new Error('schema');
  } catch {
    throw new AppError('Database di dalam backup rusak atau tidak kompatibel.');
  } finally { candidate.close(); }
  const uploadsDir = path.join(stageDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  let totalSize = 0;
  for (const file of payload.uploads) {
    const name = path.basename(String(file.name || ''));
    if (!name || name !== file.name) throw new AppError('Nama lampiran dalam backup tidak valid.');
    const data = Buffer.from(String(file.data || ''), 'base64');
    totalSize += data.length;
    if (totalSize > 500 * 1024 * 1024) throw new AppError('Total lampiran dalam backup melebihi 500 MB.');
    fs.writeFileSync(path.join(uploadsDir, name), data);
  }
  return { candidateDb, uploadsDir };
}

function prepareUploadRestore(stagedUploadsDir) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const swapName = `.restore-swap-${crypto.randomUUID()}`;
  const swapDir = path.join(UPLOAD_DIR, swapName);
  const nextDir = path.join(swapDir, 'next');
  const previousDir = path.join(swapDir, 'previous');
  fs.mkdirSync(nextDir, { recursive: true });
  fs.mkdirSync(previousDir, { recursive: true });

  for (const entry of fs.readdirSync(stagedUploadsDir, { withFileTypes: true })) {
    if (!entry.isFile()) throw new AppError('Isi lampiran dalam backup tidak valid.');
    fs.copyFileSync(path.join(stagedUploadsDir, entry.name), path.join(nextDir, entry.name));
  }

  let applied = false;
  const cleanupSwap = () => {
    try { fs.rmSync(swapDir, { recursive: true, force: true }); } catch (ignored) {}
  };
  const moveBackPrevious = () => {
    if (!fs.existsSync(previousDir)) return;
    for (const entry of fs.readdirSync(previousDir, { withFileTypes: true })) {
      const destination = path.join(UPLOAD_DIR, entry.name);
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(path.join(previousDir, entry.name), destination);
    }
  };

  return {
    apply() {
      const originalNames = fs.readdirSync(UPLOAD_DIR).filter(name => name !== swapName);
      const replacementNames = fs.readdirSync(nextDir);
      const movedOriginal = [];
      const movedReplacement = [];
      try {
        for (const name of originalNames) {
          fs.renameSync(path.join(UPLOAD_DIR, name), path.join(previousDir, name));
          movedOriginal.push(name);
        }
        for (const name of replacementNames) {
          fs.renameSync(path.join(nextDir, name), path.join(UPLOAD_DIR, name));
          movedReplacement.push(name);
        }
        applied = true;
      } catch (error) {
        for (const name of movedReplacement.reverse()) {
          const installed = path.join(UPLOAD_DIR, name);
          if (fs.existsSync(installed)) fs.rmSync(installed, { recursive: true, force: true });
        }
        for (const name of movedOriginal.reverse()) {
          const previous = path.join(previousDir, name);
          if (fs.existsSync(previous)) fs.renameSync(previous, path.join(UPLOAD_DIR, name));
        }
        cleanupSwap();
        throw error;
      }
    },
    rollback() {
      if (!applied) {
        cleanupSwap();
        return;
      }
      for (const name of fs.readdirSync(UPLOAD_DIR).filter(name => name !== swapName)) {
        fs.rmSync(path.join(UPLOAD_DIR, name), { recursive: true, force: true });
      }
      moveBackPrevious();
      applied = false;
      cleanupSwap();
    },
    commit() {
      applied = false;
      cleanupSwap();
    }
  };
}

const fullBackupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, String(file.originalname || '').toLowerCase().endsWith('.kkbackup'))
});

app.post('/api/admin/full-backup/export', authMiddleware, requireSuperUser, (req, res, next) => {
  try {
    assertCurrentSuperUserPassword(req, req.body.currentPassword);
    const password = assertBackupPassword(req.body.backupPassword);
    const result = createFullBackupBuffer(password, req.auth.user.id, 'export');
    const fileName = `Kas_Kecil_Lengkap_${result.stamp}.kkbackup`;
    res.type('application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(result.buffer);
  } catch (error) { next(error); }
});

app.post('/api/admin/full-backup/restore', authMiddleware, requireSuperUser, fullBackupUpload.single('backupFile'), asyncRoute(async (req, res) => {
  if (String(req.body.confirmation || '').trim().toUpperCase() !== 'PULIHKAN SELURUH DATA') {
    throw new AppError('Ketik PULIHKAN SELURUH DATA untuk mengonfirmasi restore.');
  }
  assertCurrentSuperUserPassword(req, req.body.currentPassword);
  const password = assertBackupPassword(req.body.backupPassword);
  if (!req.file?.buffer) throw new AppError('Pilih file backup lengkap berformat .kkbackup.');
  const payload = decryptedBackupPayload(req.file.buffer, password);
  const stageDir = path.join(DATA_DIR, `restore-${crypto.randomUUID()}`);
  const staged = validateRestorePayload(payload, stageDir);
  const uploadRestore = prepareUploadRestore(staged.uploadsDir);
  const current = createFullBackupBuffer(password, req.auth.user.id, 'before-restore');
  const beforeRestoreName = `kas-kecil-full-before-restore-${current.stamp}.kkbackup`;
  fs.writeFileSync(path.join(BACKUP_DIR, beforeRestoreName), current.buffer);

  const oldDatabase = `${DB_PATH}.pre-restore`;
  const previousPepper = fs.existsSync(RESTORED_PEPPER_PATH) ? fs.readFileSync(RESTORED_PEPPER_PATH) : null;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    for (const file of [oldDatabase, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (ignored) {}
    }
    if (fs.existsSync(DB_PATH)) fs.renameSync(DB_PATH, oldDatabase);
    fs.renameSync(staged.candidateDb, DB_PATH);
    uploadRestore.apply();
    installRestoredAppPepper(payload.security.appPepper);
    uploadRestore.commit();
    fs.rmSync(stageDir, { recursive: true, force: true });
    try { if (fs.existsSync(oldDatabase)) fs.unlinkSync(oldDatabase); } catch (ignored) {}
    res.json({ ok: true, restarting: true, restoredFrom: payload.manifest.createdAt, beforeRestoreBackup: beforeRestoreName });
    setTimeout(() => process.exit(0), 500);
  } catch (error) {
    try {
      uploadRestore.rollback();
      if (fs.existsSync(oldDatabase)) {
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
        fs.renameSync(oldDatabase, DB_PATH);
      }
      if (previousPepper) fs.writeFileSync(RESTORED_PEPPER_PATH, previousPepper, { mode: 0o600 });
      else if (fs.existsSync(RESTORED_PEPPER_PATH)) fs.unlinkSync(RESTORED_PEPPER_PATH);
    } catch (ignored) {}
    setTimeout(() => process.exit(1), 500);
    throw error;
  }
}));

app.get('/api/admin/database/backups', authMiddleware, requireSuperUser, (_req, res) => {
  res.json({ backups: listDatabaseBackups().map(backupPublic) });
});

app.post('/api/admin/database/backups', authMiddleware, requireSuperUser, asyncRoute(async (req, res) => {
  const destination = await backupDatabase('manual');
  const record = listDatabaseBackups().find(item => item.fileName === path.basename(destination));
  audit(req.auth.user.id, 'CREATE_BACKUP', 'DATABASE', path.basename(destination), '', '', 'Super User membuat backup manual');
  res.status(201).json({ ok: true, backup: record ? backupPublic(record) : { fileName: path.basename(destination) } });
}));

app.get('/api/admin/database/backups/:fileName', authMiddleware, requireSuperUser, (req, res, next) => {
  const fileName = path.basename(String(req.params.fileName || ''));
  if (!/^kas-kecil-.*\.sqlite$/.test(fileName)) return next(new AppError('File backup tidak valid.', 400));
  const record = listDatabaseBackups().find(item => item.fileName === fileName);
  if (!record || path.dirname(path.resolve(record.filePath)) !== path.resolve(BACKUP_DIR)) return next(new AppError('File backup tidak ditemukan.', 404));
  audit(req.auth.user.id, 'DOWNLOAD_BACKUP', 'DATABASE', fileName, '', '', 'Backup database diunduh');
  res.download(record.filePath, fileName, error => {
    if (error && !res.headersSent) next(error);
  });
});

app.post('/api/admin/database/clear', authMiddleware, requireSuperUser, asyncRoute(async (req, res) => {
  if (String(req.body.confirmation || '').trim().toUpperCase() !== 'HAPUS DATA TRANSAKSI') {
    throw new AppError('Ketik HAPUS DATA TRANSAKSI untuk mengonfirmasi reset.');
  }
  const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(req.auth.user.id);
  if (!user || !verifyPassword(String(req.body.currentPassword || ''), user.password_salt, user.password_hash)) {
    throw new AppError('Password Super User tidak sesuai.', 401);
  }

  const tableOrder = [
    'approval_requests', 'approvals', 'transaction_corrections', 'umo_allocations',
    'ledger_entries', 'cash_transfers', 'operational_advances', 'transactions', 'sequences',
    'cash_budget_allocations', 'cash_budgets', 'period_balances', 'accounting_periods', 'audit_logs'
  ];
  const destination = await backupDatabase('before-clear');
  const cleared = Object.fromEntries(tableOrder.map(table => [table, Number(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total)]));
  const clearOperationalData = db.transaction(() => {
    for (const table of tableOrder) db.prepare(`DELETE FROM ${table}`).run();
    db.prepare("UPDATE settings SET value='',updated_by=?,updated_at=? WHERE key='LAST_TRANSACTION_DATE'").run(req.auth.user.id, nowIso());
    db.prepare("UPDATE settings SET value='0',updated_by=?,updated_at=? WHERE key='LAST_TRANSACTION_SEQUENCE'").run(req.auth.user.id, nowIso());
  });
  clearOperationalData();
  ensureAccountingPeriod(req.auth.user.id);
  const recordCount = Object.values(cleared).reduce((sum, count) => sum + count, 0);
  audit(req.auth.user.id, 'CLEAR_DATABASE', 'DATABASE', path.basename(destination), cleared, { recordCount: 0 }, 'Data transaksi direset setelah backup otomatis');
  const record = listDatabaseBackups().find(item => item.fileName === path.basename(destination));
  res.json({ ok: true, backup: record ? backupPublic(record) : { fileName: path.basename(destination) }, cleared, recordCount });
}));

app.get('/api/audit', authMiddleware, requirePermission('audit.view'), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
  const rows = db.prepare(`SELECT l.*, u.name AS user_name FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.timestamp DESC LIMIT ?`).all(limit);
  res.json({ rows });
});

// ---------- Reports ----------

app.get('/api/reports/account-summary.:format', authMiddleware, requirePermission('account_summary.export'), asyncRoute(async (req, res) => {
  const format = String(req.params.format).toLowerCase();
  if (!['xlsx', 'pdf'].includes(format)) throw new AppError('Format laporan tidak didukung.', 404);
  const data = queryAccountSummary(req.query);
  const stamp = localToday().replace(/-/g, '');
  const period = data.startDate || data.endDate
    ? `${data.startDate || 'awal'} s.d. ${data.endDate || 'sekarang'}`
    : 'Seluruh periode';
  audit(req.auth.user.id, `EXPORT_ACCOUNT_SUMMARY_${format.toUpperCase()}`, 'ACCOUNT', data.accountId || 'ALL', '', { count: data.rows.length, period }, 'Export rekap dana per akun');

  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = getSetting('COMPANY_NAME', DEFAULT_COMPANY_NAME);
    const sheet = workbook.addWorksheet('Rekap Dana per Akun', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Kode', key: 'accountCode', width: 15 },
      { header: 'Nama Akun', key: 'accountName', width: 30 },
      { header: 'Cakupan', key: 'transactionScope', width: 15 },
      { header: 'Status Akun', key: 'accountStatus', width: 14 },
      { header: 'Jumlah Transaksi', key: 'transactionCount', width: 18 },
      { header: 'Dana Masuk', key: 'totalIn', width: 18 },
      { header: 'Dana Keluar', key: 'totalOut', width: 18 },
      { header: 'Penyesuaian', key: 'totalAdjustment', width: 18 },
      { header: 'Neto', key: 'netAmount', width: 18 }
    ];
    data.rows.forEach(row => sheet.addRow({ ...row, accountStatus: row.active ? 'Aktif' : 'Nonaktif' }));
    const totalRow = sheet.addRow({ accountCode: 'TOTAL', accountName: period, ...data.totals });
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2747' } };
    totalRow.font = { bold: true };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2FF' } };
    ['totalIn', 'totalOut', 'totalAdjustment', 'netAmount'].forEach(key => { sheet.getColumn(key).numFmt = 'Rp #,##0;[Red]-Rp #,##0'; });
    res.attachment(`Rekap_Dana_Akun_${stamp}.xlsx`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res); return res.end();
  }

  res.attachment(`Rekap_Dana_Akun_${stamp}.pdf`); res.type('application/pdf');
  const doc = new PDFDocument({ size: 'A4', margin: 34, layout: 'landscape' }); doc.pipe(res);
  doc.fontSize(17).fillColor('#0f2747').text('Rekap Dana per Akun');
  doc.fontSize(9).fillColor('#64748b').text(`${getSetting('COMPANY_NAME', DEFAULT_COMPANY_NAME)} | Periode: ${period}`); doc.moveDown();
  const columns = [34, 92, 215, 282, 338, 430, 522, 614];
  const widths = columns.map((x, index) => (columns[index + 1] || 807) - x - 5);
  const headers = ['Kode', 'Nama akun', 'Cakupan', 'Jml.', 'Masuk', 'Keluar', 'Penyesuaian', 'Neto'];
  const rupiah = amount => `Rp ${Number(amount).toLocaleString('id-ID')}`;
  const drawHeader = () => {
    const top = doc.y;
    doc.rect(34, top, 773, 20).fill('#0f2747');
    headers.forEach((label, index) => doc.fontSize(7.5).fillColor('#ffffff').text(label, columns[index], top + 6, { width: widths[index] }));
    doc.y = top + 25;
  };
  drawHeader();
  const reportRows = [...data.rows, { accountCode: 'TOTAL', accountName: period, transactionScope: '', ...data.totals, total: true }];
  for (const row of reportRows) {
    if (doc.y > 535) { doc.addPage(); drawHeader(); }
    const y = doc.y;
    const values = [row.accountCode, row.accountName, row.transactionScope, row.transactionCount, rupiah(row.totalIn), rupiah(row.totalOut), rupiah(row.totalAdjustment), rupiah(row.netAmount)];
    if (row.total) doc.rect(34, y - 3, 773, 23).fill('#eaf2ff');
    values.forEach((value, index) => doc.fontSize(7.3).fillColor('#172033').font(row.total ? 'Helvetica-Bold' : 'Helvetica').text(String(value ?? ''), columns[index], y, { width: widths[index], height: 18, ellipsis: true }));
    doc.y = y + 23;
  }
  doc.end();
}));

app.get('/api/reports/mutations.:format', authMiddleware, asyncRoute(async (req, res) => {
  const format = String(req.params.format).toLowerCase();
  if (!['xlsx', 'pdf'].includes(format)) throw new AppError('Format laporan tidak didukung.', 404);
  const data = queryMutations(req, req.query);
  const rows = [...data.rows].reverse();
  const stamp = localToday().replace(/-/g, '');
  audit(req.auth.user.id, `EXPORT_MUTATIONS_${format.toUpperCase()}`, 'LEDGER', '', '', { count: rows.length }, 'Export mutasi kas');
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = getSetting('COMPANY_NAME', DEFAULT_COMPANY_NAME);
    const sheet = workbook.addWorksheet('Mutasi Kas', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Tanggal', key: 'entryDate', width: 13 }, { header: 'No. Referensi', key: 'referenceNo', width: 23 },
      { header: 'Pengguna', key: 'userName', width: 22 }, { header: 'Sumber', key: 'sourceType', width: 20 },
      { header: 'Akun', key: 'accountName', width: 22 }, { header: 'Keterangan', key: 'description', width: 38 },
      { header: 'Masuk', key: 'incoming', width: 16 }, { header: 'Keluar', key: 'outgoing', width: 16 },
      { header: 'Saldo', key: 'balanceAfter', width: 18 }
    ];
    rows.forEach(row => sheet.addRow({ ...row, incoming: row.direction === 'IN' ? row.amount : 0, outgoing: row.direction === 'OUT' ? row.amount : 0 }));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2747' } };
    ['incoming','outgoing','balanceAfter'].forEach(key => { sheet.getColumn(key).numFmt = 'Rp #,##0'; });
    res.attachment(`Mutasi_Kas_${stamp}.xlsx`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res); return res.end();
  }
  res.attachment(`Mutasi_Kas_${stamp}.pdf`); res.type('application/pdf');
  const doc = new PDFDocument({ size: 'A4', margin: 34, layout: 'landscape' }); doc.pipe(res);
  doc.fontSize(17).fillColor('#0f2747').text('Mutasi Kas Per Pengguna');
  doc.fontSize(9).fillColor('#64748b').text(getSetting('COMPANY_NAME', DEFAULT_COMPANY_NAME)); doc.moveDown();
  for (const row of rows) {
    if (doc.y > 530) doc.addPage();
    doc.fontSize(8).fillColor('#172033').text(`${row.entryDate}  ${row.referenceNo}  ${row.userName}`, { continued: false });
    doc.fontSize(7.5).fillColor('#64748b').text(`${row.description} | Masuk: ${row.direction === 'IN' ? `Rp ${row.amount.toLocaleString('id-ID')}` : '-'} | Keluar: ${row.direction === 'OUT' ? `Rp ${row.amount.toLocaleString('id-ID')}` : '-'} | Saldo: Rp ${row.balanceAfter.toLocaleString('id-ID')}`);
    doc.moveDown(0.5);
  }
  doc.end();
}));

app.get('/api/reports/ledger.:format', authMiddleware, asyncRoute(async (req, res) => {
  const format = String(req.params.format).toLowerCase();
  if (!['xlsx', 'pdf'].includes(format)) throw new AppError('Format laporan tidak didukung.', 404);
  const rows = queryLedger(req, req.query, 5000, true);
  const stamp = localToday().replace(/-/g, '');
  audit(req.auth.user.id, `EXPORT_${format.toUpperCase()}`, 'TRANSACTION', '', '', { count: rows.length }, 'Export buku kas');

  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = getSetting('COMPANY_NAME', DEFAULT_COMPANY_NAME);
    const sheet = workbook.addWorksheet('Buku Kas', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'No. Transaksi', key: 'transactionNo', width: 22 },
      { header: 'Tanggal', key: 'transactionDate', width: 13 },
      { header: 'Jenis', key: 'type', width: 13 },
      { header: 'Akun', key: 'accountName', width: 22 },
      { header: 'Nominal', key: 'amount', width: 16 },
      { header: 'Status', key: 'status', width: 13 },
      { header: 'Pihak Terkait', key: 'counterparty', width: 22 },
      { header: 'Keterangan', key: 'description', width: 38 },
      { header: 'Dibuat Oleh', key: 'createdByName', width: 20 },
      { header: 'Disetujui Oleh', key: 'approvedByName', width: 20 }
    ];
    rows.forEach(row => sheet.addRow(row));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    sheet.getColumn('amount').numFmt = 'Rp #,##0';
    res.attachment(`Buku_Kas_${stamp}.xlsx`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    return res.end();
  }

  res.attachment(`Buku_Kas_${stamp}.pdf`);
  res.type('application/pdf');
  const doc = new PDFDocument({ size: 'A4', margin: 36, layout: 'landscape' });
  doc.pipe(res);
  doc.fontSize(17).fillColor('#0f2747').text('Buku Kas Kecil');
  doc.fontSize(9).fillColor('#64748b').text(getSetting('COMPANY_NAME', DEFAULT_COMPANY_NAME));
  doc.moveDown();
  const columns = [36, 150, 220, 310, 430, 505, 575, 660];
  const drawHeader = () => {
    doc.fontSize(8).fillColor('#ffffff').rect(36, doc.y, 735, 18).fill('#1d4ed8');
    const y = doc.y + 5;
    ['No.', 'Tanggal', 'Jenis', 'Akun', 'Nominal', 'Status', 'User', 'Keterangan'].forEach((label, i) => doc.fillColor('#ffffff').text(label, columns[i], y, { width: (columns[i + 1] || 771) - columns[i] - 5 }));
    doc.y = y + 18;
  };
  drawHeader();
  for (const row of rows) {
    if (doc.y > 535) { doc.addPage(); drawHeader(); }
    const y = doc.y;
    const values = [row.transactionNo, row.transactionDate, row.type, row.accountName, `Rp ${Number(row.amount).toLocaleString('id-ID')}`, row.status, row.createdByName, row.description];
    values.forEach((value, i) => doc.fontSize(7.5).fillColor('#172033').text(String(value || ''), columns[i], y, { width: (columns[i + 1] || 771) - columns[i] - 5, height: 24, ellipsis: true }));
    doc.moveTo(36, y + 27).lineTo(771, y + 27).strokeColor('#d8e0ea').stroke();
    doc.y = y + 31;
  }
  doc.end();
}));

// ---------- Static SPA & errors ----------

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, {
  etag: true,
  cacheControl: false,
  setHeaders: (res, filePath) => {
    const isShell = path.basename(filePath) === 'index.html';
    res.setHeader('Cache-Control', isShell ? 'no-store' : 'no-cache, must-revalidate');
  }
}));
app.use('/api', (_req, _res, next) => next(new AppError('Endpoint tidak ditemukan.', 404)));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((error, req, res, _next) => {
  const uploaded = [req.file, ...Object.values(req.files || {}).flat()].filter(Boolean);
  for (const file of uploaded) {
    if (file.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch (ignored) {}
    }
  }
  const status = Number(error.status || (error.code === 'LIMIT_FILE_SIZE' ? 400 : 500));
  const message = error.code === 'LIMIT_FILE_SIZE'
    ? (error.field === 'logo' ? 'Ukuran logo melebihi batas 2 MB.' : `Ukuran bukti melebihi batas ${getSetting('MAX_UPLOAD_MB', 5)} MB.`)
    : (status >= 500 ? 'Terjadi kesalahan pada server.' : error.message);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: message });
});

cron.schedule('30 2 * * *', async () => {
  try { cleanupExpiredSessions(); await backupDatabase(); }
  catch (error) { console.error('Backup gagal:', error); }
}, { timezone: APP_TIMEZONE() });

app.listen(PORT, '0.0.0.0', () => {
  if (appPepperForBackup() === 'change-this-pepper-before-production') {
    console.warn('PERINGATAN: APP_PEPPER belum diubah. Atur secret yang kuat sebelum digunakan.');
  }
  console.log(`Aplikasi Kas Kecil berjalan di port ${PORT}`);
});

module.exports = { app, dashboardData, queryLedger, resolveLedgerScope };
