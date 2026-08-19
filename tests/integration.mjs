import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-kecil-v15-'));
process.env.PORT = process.env.PORT || '18090';
process.env.DATA_DIR = path.join(runtime, 'data');
process.env.UPLOAD_DIR = path.join(runtime, 'uploads');
process.env.BACKUP_DIR = path.join(runtime, 'backups');
process.env.APP_PEPPER = 'integration-secret-v15-1234567890';
process.env.INITIAL_ADMIN_PASSWORD = 'Admin12345';
process.env.NODE_ENV = 'test';
process.env.APP_TIMEZONE = 'Asia/Jakarta';

function businessDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(Date.now() + offsetDays * 86400000));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

const today = businessDate();
const currentMonth = today.slice(0, 7);

const baseUrl = `http://127.0.0.1:${process.env.PORT}`;

async function login(username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, payload.error);
  const setCookie = response.headers.get('set-cookie');
  assert(setCookie, 'Login cookie missing');
  return setCookie.split(';')[0];
}

async function request(route, { cookie, method = 'GET', body, form, expected = 200 } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)) });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  assert.equal(response.status, expected, `${method} ${route}: ${payload.error || payload}`);
  return payload;
}

async function assertDownload(route, cookie, contentType, minimumBytes = 100) {
  const response = await fetch(`${baseUrl}${route}`, { headers: cookie ? { Cookie: cookie } : {} });
  assert.equal(response.status, 200, `Download failed: ${route}`);
  assert.match(response.headers.get('content-type') || '', contentType);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length >= minimumBytes, `Download ${route} is unexpectedly small`);
}

function approvalToken(url) {
  const token = new URL(url).searchParams.get('approval');
  assert(token, `Approval token missing from ${url}`);
  return token;
}

async function approvePublic(url, pin = '87654321', note = 'Disetujui melalui PIN') {
  const token = approvalToken(url);
  const detail = await request(`/api/public/approvals/${encodeURIComponent(token)}`);
  assert.equal(detail.decision, 'PENDING');
  const result = await request(`/api/public/approvals/${encodeURIComponent(token)}/decision`, {
    method: 'POST', body: { pin, decision: 'APPROVED', note }
  });
  assert.equal(result.decision, 'APPROVED');
  assert.equal(result.approvedByName, 'Supervisor Kas');
  return detail;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become healthy');
}

async function main() {
  await import('../src/server.js');
  await waitForHealth();

  const health = await request('/api/health');
  assert.equal(health.version, '1.5.5');
  const shellResponse = await fetch(`${baseUrl}/`);
  assert.equal(shellResponse.headers.get('cache-control'), 'no-store');
  await shellResponse.text();
  for (const asset of ['/app.js?v=1.5.5', '/styles.css?v=1.5.5']) {
    const assetResponse = await fetch(`${baseUrl}${asset}`);
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get('cache-control'), 'no-cache, must-revalidate');
    await assetResponse.text();
  }

  const admin = await login('admin', 'Admin12345');
  await request('/api/admin/settings', {
    cookie: admin, method: 'PATCH', body: { APP_NAME: 'Kas Kecil Uji', COMPANY_NAME: 'Perusahaan Uji', THEME_COLOR: '#7c3aed' }
  });
  const logo = new FormData();
  logo.set('logo', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'logo.png');
  await request('/api/admin/settings/logo', { cookie: admin, method: 'POST', form: logo });
  const publicConfig = await request('/api/public/config');
  assert.equal(publicConfig.appName, 'Kas Kecil Uji');
  assert.equal(publicConfig.companyName, 'Perusahaan Uji');
  assert.equal(publicConfig.themeColor, '#7c3aed');
  assert.match(publicConfig.logoUrl, /^\/api\/branding\/logo\?v=brand-/);
  await assertDownload(publicConfig.logoUrl, null, /image\/png/, 60);

  const outgoing = await request('/api/admin/accounts', {
    cookie: admin, method: 'POST', expected: 201,
    body: { accountCode: 'OPS', accountName: 'Operasional', transactionScope: 'KELUAR', approvalLimit: 500, receiptRequired: true, underlyingRequired: true }
  });
  const incoming = await request('/api/admin/accounts', {
    cookie: admin, method: 'POST', expected: 201,
    body: { accountCode: 'TOPUP', accountName: 'Pengisian Kas', transactionScope: 'MASUK', approvalLimit: 0, receiptRequired: false }
  });
  const disposable = await request('/api/admin/accounts', {
    cookie: admin, method: 'POST', expected: 201,
    body: { accountCode: 'TEMP', accountName: 'Akun Salah Input', transactionScope: 'KELUAR', approvalLimit: 0, receiptRequired: false }
  });
  let adminAccounts = await request('/api/admin/accounts', { cookie: admin });
  assert.equal(adminAccounts.accounts.find(account => account.accountId === disposable.accountId).canDelete, true);
  await request(`/api/admin/accounts/${outgoing.accountId}`, {
    cookie: admin, method: 'PATCH', body: {
      accountCode: 'OPS-EDIT', accountName: 'Operasional Lapangan', transactionScope: 'KELUAR',
      approvalLimit: 500, receiptRequired: true, underlyingRequired: true
    }
  });
  adminAccounts = await request('/api/admin/accounts', { cookie: admin });
  assert.equal(adminAccounts.accounts.find(account => account.accountId === outgoing.accountId).accountCode, 'OPS-EDIT');
  assert.equal(adminAccounts.accounts.find(account => account.accountId === outgoing.accountId).accountName, 'Operasional Lapangan');
  await request(`/api/admin/accounts/${incoming.accountId}`, {
    cookie: admin, method: 'PATCH', body: { accountCode: 'OPS-EDIT' }, expected: 400
  });
  await assertDownload('/api/admin/accounts.xlsx', admin, /spreadsheetml/, 1000);
  const accountExportAudit = await request('/api/audit?limit=5', { cookie: admin });
  assert(accountExportAudit.rows.some(row => row.action === 'EXPORT_ACCOUNTS_XLSX'));
  await request(`/api/admin/accounts/${disposable.accountId}`, { cookie: admin, method: 'DELETE' });
  adminAccounts = await request('/api/admin/accounts', { cookie: admin });
  assert.equal(adminAccounts.accounts.some(account => account.accountId === disposable.accountId), false);

  const staffAResult = await request('/api/admin/users', {
    cookie: admin, method: 'POST', expected: 201,
    body: { name: 'Staff Kas A', username: 'staff.a', password: 'Staff12345', role: 'STAFF' }
  });
  const staffBResult = await request('/api/admin/users', {
    cookie: admin, method: 'POST', expected: 201,
    body: { name: 'Staff Kas B', username: 'staff.b', password: 'Staff12345', role: 'STAFF' }
  });
  const spvResult = await request('/api/admin/users', {
    cookie: admin, method: 'POST', expected: 201,
    body: { name: 'Supervisor Kas', username: 'spv.kas', password: 'Supervisor12345', role: 'SPV' }
  });
  await request(`/api/admin/users/${spvResult.userId}/approval-pin`, {
    cookie: admin, method: 'PUT', body: { pin: '87654321' }
  });

  const access = await request('/api/admin/access', { cookie: admin });
  const staffAccess = access.users.find(user => user.userId === staffAResult.userId);
  const spvAccess = access.users.find(user => user.userId === spvResult.userId);
  assert(staffAccess.effectivePermissions.includes('mutations.view_self'));
  assert(staffAccess.effectivePermissions.includes('umo.create'));
  assert(staffAccess.effectivePermissions.includes('budgets.view'));
  assert(staffAccess.effectivePermissions.includes('account_comparison.view'));
  assert(!spvAccess.effectivePermissions.includes('transactions.create'));
  assert(spvAccess.effectivePermissions.includes('mutations.view_all'));
  assert(spvAccess.effectivePermissions.includes('account_summary.view'));
  assert(spvAccess.effectivePermissions.includes('budgets.manage'));
  assert(spvAccess.effectivePermissions.includes('periods.close'));
  assert(spvAccess.effectivePermissions.includes('account_comparison.view_all_users'));
  assert(!spvAccess.effectivePermissions.includes('database.manage'));
  assert.equal(spvAccess.hasApprovalPin, true);

  const staffA = await login('staff.a', 'Staff12345');
  const staffB = await login('staff.b', 'Staff12345');
  const accounts = await request('/api/accounts', { cookie: staffA });
  assert.equal(accounts.accounts.length, 2);
  assert.equal(accounts.accounts.find(account => account.accountId === outgoing.accountId).underlyingRequired, true);

  const initialBudget = await request('/api/budgets/current', { cookie: admin });
  assert.equal(initialBudget.periodStatus, 'OPEN');
  await request(`/api/budgets/${initialBudget.periodMonth}`, {
    cookie: admin, method: 'PUT', body: { totalBudget: 20000, allocations: [{ accountId: outgoing.accountId, percentageBps: 10000 }] }
  });
  const staffBudget = await request('/api/budgets/current', { cookie: staffA });
  assert.equal(staffBudget.totalBudget, 20000);
  assert.equal(staffBudget.allocations[0].allocatedAmount, 20000);

  const cashIn = new FormData();
  cashIn.set('type', 'MASUK'); cashIn.set('transactionDate', today);
  cashIn.set('accountId', incoming.accountId); cashIn.set('amount', '10000'); cashIn.set('description', 'Pengisian kas awal');
  const inResult = await request('/api/transactions', { cookie: staffA, method: 'POST', form: cashIn, expected: 201 });
  assert.equal(inResult.status, 'APPROVED');

  const dbModule = await import('../src/db.js');
  const integrationDb = dbModule.default?.db || dbModule.db;
  integrationDb.prepare("DELETE FROM sequences WHERE prefix='KSK'").run();

  const cashOut = new FormData();
  cashOut.set('type', 'KELUAR'); cashOut.set('transactionDate', today);
  cashOut.set('accountId', outgoing.accountId); cashOut.set('amount', '1000'); cashOut.set('description', 'Pembelian perlengkapan');
  cashOut.set('counterparty', 'Toko Contoh');
  cashOut.set('receipt', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), 'bukti.pdf');
  cashOut.set('underlyingDocument', new Blob([Buffer.from('%PDF-1.4\nunderlying\n%%EOF')], { type: 'application/pdf' }), 'surat-permintaan.pdf');
  const outResult = await request('/api/transactions', { cookie: staffA, method: 'POST', form: cashOut, expected: 201 });
  assert.equal(outResult.status, 'PENDING');
  await request(`/api/admin/accounts/${outgoing.accountId}`, { cookie: admin, method: 'DELETE', expected: 409 });
  adminAccounts = await request('/api/admin/accounts', { cookie: admin });
  assert.equal(adminAccounts.accounts.find(account => account.accountId === outgoing.accountId).canDelete, false);
  integrationDb.prepare("UPDATE approval_requests SET expires_at='2000-01-01T00:00:00.000Z' WHERE entity_type='TRANSACTION' AND entity_id=?")
    .run(outResult.transactionId);
  const pendingApprovals = await request('/api/approvals', { cookie: admin });
  const transactionPending = pendingApprovals.rows.find(row => row.entityId === outResult.transactionId);
  assert(transactionPending?.approvalId, 'Pending transaction approval is missing');
  assert.equal(transactionPending.expired, undefined);
  const persistentLink = await request(`/api/approvals/${transactionPending.approvalId}/link`, { cookie: staffA, method: 'POST' });
  assert.equal(persistentLink.approvalUrl, outResult.approvalUrl);
  const transactionApproval = await approvePublic(outResult.approvalUrl);
  assert.equal(transactionApproval.entityType, 'TRANSACTION');
  await assertDownload(transactionApproval.receiptUrl, null, /application\/pdf/, 10);
  assert.match(transactionApproval.underlyingUrl, /\/underlying$/);
  await assertDownload(transactionApproval.underlyingUrl, null, /application\/pdf/, 10);

  let mutationsA = await request('/api/mutations', { cookie: staffA });
  assert.equal(mutationsA.balance, 9000);
  assert.equal(mutationsA.count, 2);

  const transfer = await request('/api/transfers', {
    cookie: staffA, method: 'POST', expected: 201,
    body: { transferDate: today, recipientUserId: staffBResult.userId, amount: 2000, description: 'Penyerahan kas operasional' }
  });
  assert.equal((await approvePublic(transfer.approvalUrl)).entityType, 'TRANSFER');
  mutationsA = await request('/api/mutations', { cookie: staffA });
  const mutationsB = await request('/api/mutations', { cookie: staffB });
  assert.equal(mutationsA.balance, 7000);
  assert.equal(mutationsB.balance, 2000);

  const umo = await request('/api/umo', {
    cookie: staffA, method: 'POST', expected: 201,
    body: { advanceDate: today, dueDate: businessDate(3),
      bearerName: 'Teknisi A', advanceAmount: 400, purpose: 'Pembelian kebutuhan lapangan' }
  });
  assert.equal(umo.status, 'OPEN');
  assert.match(umo.receiptPdfUrl, /disbursement-receipt\.pdf$/);
  await assertDownload(umo.receiptPdfUrl, staffA, /application\/pdf/, 500);
  assert.equal((await request('/api/mutations', { cookie: staffA })).balance, 6600);

  const staffUmoBeforeCorrection = await request('/api/umo', { cookie: staffA });
  assert.equal(staffUmoBeforeCorrection.canManage, false);
  const adminUmoBeforeCorrection = await request('/api/umo', { cookie: admin });
  assert.equal(adminUmoBeforeCorrection.canManage, true);
  assert.equal(adminUmoBeforeCorrection.rows.find(row => row.umoId === umo.umoId).canEdit, true);
  await request(`/api/admin/umo/${umo.umoId}`, {
    cookie: staffA, method: 'PATCH', expected: 403,
    body: { reason: 'Percobaan tanpa akses', currentPassword: 'Staff12345' }
  });
  const correctedUmo = await request(`/api/admin/umo/${umo.umoId}`, {
    cookie: admin, method: 'PATCH', body: {
      advanceDate: today, dueDate: businessDate(4), bearerName: 'Teknisi A', advanceAmount: 450,
      purpose: 'Pembelian kebutuhan lapangan terkoreksi', reason: 'Nominal awal salah input', currentPassword: 'Admin12345'
    }
  });
  assert.match(correctedUmo.backupFileName, /^kas-kecil-before-umo-change-.*\.sqlite$/);
  assert.equal(correctedUmo.balance, 6550);
  const correctedUmoRow = (await request('/api/umo', { cookie: staffA })).rows.find(row => row.umoId === umo.umoId);
  assert.equal(correctedUmoRow.advanceAmount, 450);
  assert.equal(correctedUmoRow.purpose, 'Pembelian kebutuhan lapangan terkoreksi');

  const settlement = new FormData();
  settlement.set('allocations', JSON.stringify([{ accountId: outgoing.accountId, amount: 350, description: 'Pembelian kebutuhan aktual' }]));
  settlement.set('note', 'Sisa dikembalikan');
  settlement.set('receipt', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), 'nota-umo.pdf');
  const settled = await request(`/api/umo/${umo.umoId}/settlement`, { cookie: staffA, method: 'POST', form: settlement });
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.returnedAmount, 100);
  assert.equal((await request('/api/mutations', { cookie: staffA })).balance, 6650, 'UMO realization must not reduce cash twice');
  const umoRows = await request('/api/umo', { cookie: staffA });
  assert.equal(umoRows.rows[0].status, 'SETTLED');
  assert.equal(umoRows.rows.find(row => row.umoId === umo.umoId).correctionTransactions.length, 1);
  await assertDownload(`/api/umo/${umo.umoId}/receipt`, staffA, /application\/pdf/, 10);
  await request(`/api/admin/umo/${umo.umoId}`, {
    cookie: admin, method: 'DELETE', expected: 409,
    body: { reason: 'Tidak boleh menghapus UMO selesai', currentPassword: 'Admin12345', confirmation: 'HAPUS UMO' }
  });

  const disposableUmo = await request('/api/umo', {
    cookie: staffA, method: 'POST', expected: 201,
    body: { advanceDate: today, dueDate: businessDate(2), bearerName: 'Teknisi B', advanceAmount: 100, purpose: 'UMO salah input' }
  });
  assert.equal((await request('/api/mutations', { cookie: staffA })).balance, 6550);
  await request(`/api/admin/umo/${disposableUmo.umoId}`, {
    cookie: admin, method: 'DELETE', expected: 401,
    body: { reason: 'Data ganda', currentPassword: 'password-salah', confirmation: 'HAPUS UMO' }
  });
  const deletedUmo = await request(`/api/admin/umo/${disposableUmo.umoId}`, {
    cookie: admin, method: 'DELETE',
    body: { reason: 'Data ganda', currentPassword: 'Admin12345', confirmation: 'HAPUS UMO' }
  });
  assert.match(deletedUmo.backupFileName, /^kas-kecil-before-umo-change-.*\.sqlite$/);
  assert.equal(deletedUmo.balance, 6650);
  assert.equal((await request('/api/umo', { cookie: staffA })).rows.some(row => row.umoId === disposableUmo.umoId), false);

  const correction = new FormData();
  correction.set('originalTransactionId', outResult.transactionId); correction.set('correctionType', 'REPLACEMENT');
  correction.set('reason', 'Nominal pada nota salah input'); correction.set('transactionDate', today);
  correction.set('type', 'KELUAR'); correction.set('accountId', outgoing.accountId); correction.set('amount', '800');
  correction.set('description', 'Pembelian perlengkapan terkoreksi'); correction.set('counterparty', 'Toko Contoh');
  const correctionResult = await request('/api/corrections', { cookie: staffA, method: 'POST', form: correction, expected: 201 });
  const correctionDetail = await approvePublic(correctionResult.approvalUrl);
  assert.equal(correctionDetail.entityType, 'CORRECTION');
  assert.equal((await request('/api/mutations', { cookie: staffA })).balance, 6850);
  const correctionRows = await request('/api/corrections', { cookie: staffA });
  assert.equal(correctionRows.rows[0].status, 'APPROVED');

  const staffDashboard = await request('/api/dashboard', { cookie: staffA });
  assert.equal(staffDashboard.cashBalance, 6850);
  assert.equal(staffDashboard.umoOutstanding, 0);
  assert.equal(staffDashboard.startDate, `${currentMonth}-01`);
  const filteredDashboard = await request(`/api/dashboard?startDate=${today}&endDate=${today}`, { cookie: staffA });
  assert.equal(filteredDashboard.endDate, today);
  const ledger = await request('/api/ledger', { cookie: staffA });
  assert(ledger.rows.some(row => row.status === 'CORRECTED'));
  assert(ledger.rows.some(row => row.sourceType === 'UMO' && row.cashEffect === false));

  const accountSummary = await request(`/api/account-summary?startDate=${today}&endDate=${today}`, { cookie: admin });
  const outgoingSummary = accountSummary.rows.find(row => row.accountId === outgoing.accountId);
  const incomingSummary = accountSummary.rows.find(row => row.accountId === incoming.accountId);
  assert.equal(outgoingSummary.transactionCount, 2, 'Transaksi asal yang dikoreksi harus dikeluarkan dari rekap akun');
  assert.equal(outgoingSummary.totalOut, 1150, 'Realisasi UMO dan transaksi pengganti harus masuk rekap akun');
  assert.equal(incomingSummary.totalIn, 10000);
  assert.equal(accountSummary.totals.netAmount, 8850);
  const staffComparison = await request(`/api/account-comparison?month1=${currentMonth}&month2=${currentMonth}&userId=${staffBResult.userId}`, { cookie: staffA });
  assert.equal(staffComparison.canViewAll, false);
  assert.equal(staffComparison.rows.find(row => row.accountId === outgoing.accountId).month1Amount, 1150);
  const adminComparison = await request(`/api/account-comparison?month1=${currentMonth}&month2=${currentMonth}&userId=ALL`, { cookie: admin });
  assert.equal(adminComparison.canViewAll, true);
  assert.equal(adminComparison.rows.find(row => row.accountId === outgoing.accountId).difference, 0);
  const usedBudget = await request('/api/budgets/current', { cookie: staffA });
  assert.equal(usedBudget.allocations[0].usedAmount, 1150);
  assert.equal(usedBudget.allocations[0].remainingAmount, 18850);
  await request('/api/periods/eom', { cookie: admin, method: 'POST', body: {}, expected: 400 });
  await request('/api/account-summary?startDate=2026-02-30', { cookie: admin, expected: 400 });
  await request('/api/account-summary', { cookie: staffA, expected: 403 });

  await assertDownload('/api/reports/mutations.xlsx', staffA, /spreadsheetml/);
  await assertDownload('/api/reports/mutations.pdf', staffA, /application\/pdf/);
  await assertDownload('/api/reports/ledger.xlsx', staffA, /spreadsheetml/);
  await assertDownload('/api/reports/account-summary.xlsx', admin, /spreadsheetml/);
  await assertDownload('/api/reports/account-summary.pdf', admin, /application\/pdf/);

  const spv = await login('spv.kas', 'Supervisor12345');
  await request('/api/transactions', { cookie: spv, method: 'POST', body: {}, expected: 403 });
  const allMutations = await request(`/api/mutations?userId=${staffBResult.userId}`, { cookie: spv });
  assert.equal(allMutations.balance, 2000);
  assert.equal((await request('/api/account-summary', { cookie: spv })).totals.netAmount, 8850);
  await request('/api/admin/database/clear', { cookie: spv, method: 'POST', body: { currentPassword: 'Supervisor12345', confirmation: 'HAPUS DATA TRANSAKSI' }, expected: 403 });
  await request('/api/admin/database/clear', { cookie: admin, method: 'POST', body: { currentPassword: 'salah-password', confirmation: 'HAPUS DATA TRANSAKSI' }, expected: 401 });

  const fullExportResponse = await fetch(`${baseUrl}/api/admin/full-backup/export`, {
    method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'Admin12345', backupPassword: 'BackupRahasia123' })
  });
  assert.equal(fullExportResponse.status, 200);
  assert.match(fullExportResponse.headers.get('content-disposition') || '', /\.kkbackup/);
  const fullExportBytes = Buffer.from(await fullExportResponse.arrayBuffer());
  assert(fullExportBytes.toString('utf8', 0, 10).startsWith('KKBACKUP1'));
  const invalidRestore = new FormData();
  invalidRestore.set('backupFile', new Blob([fullExportBytes], { type: 'application/octet-stream' }), 'data.kkbackup');
  invalidRestore.set('currentPassword', 'salah-password'); invalidRestore.set('backupPassword', 'BackupRahasia123');
  invalidRestore.set('confirmation', 'PULIHKAN SELURUH DATA');
  await request('/api/admin/full-backup/restore', { cookie: admin, method: 'POST', form: invalidRestore, expected: 401 });

  const cleared = await request('/api/admin/database/clear', {
    cookie: admin, method: 'POST', body: { currentPassword: 'Admin12345', confirmation: 'HAPUS DATA TRANSAKSI' }
  });
  assert.match(cleared.backup.fileName, /^kas-kecil-before-clear-.*\.sqlite$/);
  assert(cleared.recordCount > 0);
  for (const table of ['transactions', 'ledger_entries', 'cash_transfers', 'operational_advances', 'umo_allocations', 'transaction_corrections', 'approval_requests']) {
    assert.equal(integrationDb.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total, 0, `${table} belum kosong`);
  }
  assert.equal(integrationDb.prepare('SELECT COUNT(*) AS total FROM users').get().total, 4, 'Pengguna harus dipertahankan');
  assert.equal(integrationDb.prepare('SELECT COUNT(*) AS total FROM accounts').get().total, 2, 'Akun harus dipertahankan');
  assert.equal(integrationDb.prepare("SELECT COUNT(*) AS total FROM accounting_periods WHERE status='OPEN'").get().total, 1, 'Periode terbuka harus dibuat kembali');
  assert.equal(integrationDb.prepare('SELECT COUNT(*) AS total FROM cash_budgets').get().total, 0, 'Pagu lama harus dibersihkan');
  assert.equal((await request('/api/account-summary', { cookie: admin })).totals.transactionCount, 0);
  const backupHistory = await request('/api/admin/database/backups', { cookie: admin });
  assert(backupHistory.backups.some(backup => backup.fileName === cleared.backup.fileName && backup.type === 'BEFORE_CLEAR'));
  await assertDownload(`/api/admin/database/backups/${encodeURIComponent(cleared.backup.fileName)}`, admin, /octet-stream|sqlite/, 1000);
  const auditRows = await request('/api/audit?limit=20', { cookie: admin });
  assert(auditRows.rows.some(row => row.action === 'CLEAR_DATABASE'));

  console.log(JSON.stringify({
    checks: 'passed', version: '1.5.5', users: 4, publicPinApproval: true, persistentApprovalLink: true,
    branding: true, responsiveTheme: true, mutationBalance: true, transferDoubleEntry: true,
    umoNoDoubleCharge: true, umoReceiptPdf: true, correctionReversal: true, accountList: true,
    accountSummary: true, accountSummaryExport: true, accountComparison: true, underlyingDocument: true,
    monthlyBudget: true, monthlyPeriodLock: true, accountDeletionGuard: true, accountEdit: true, accountExcelExport: true,
    umoCorrectionAndDeletion: true,
    fullEncryptedBackup: true, protectedDatabaseReset: true, historicalBackup: true
  }, null, 2));
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
