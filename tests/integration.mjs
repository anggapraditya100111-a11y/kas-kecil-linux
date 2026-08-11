import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-kecil-v13-'));
process.env.PORT = process.env.PORT || '18090';
process.env.DATA_DIR = path.join(runtime, 'data');
process.env.UPLOAD_DIR = path.join(runtime, 'uploads');
process.env.BACKUP_DIR = path.join(runtime, 'backups');
process.env.APP_PEPPER = 'integration-secret-v13-1234567890';
process.env.INITIAL_ADMIN_PASSWORD = 'Admin12345';
process.env.NODE_ENV = 'test';

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
  assert.equal(health.version, '1.3.0');
  const shellResponse = await fetch(`${baseUrl}/`);
  assert.equal(shellResponse.headers.get('cache-control'), 'no-store');
  await shellResponse.text();
  for (const asset of ['/app.js?v=1.3.0', '/styles.css?v=1.3.0']) {
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
    body: { accountCode: 'OPS', accountName: 'Operasional', transactionScope: 'KELUAR', approvalLimit: 500, receiptRequired: true }
  });
  const incoming = await request('/api/admin/accounts', {
    cookie: admin, method: 'POST', expected: 201,
    body: { accountCode: 'TOPUP', accountName: 'Pengisian Kas', transactionScope: 'MASUK', approvalLimit: 0, receiptRequired: false }
  });

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
  assert(!spvAccess.effectivePermissions.includes('transactions.create'));
  assert(spvAccess.effectivePermissions.includes('mutations.view_all'));
  assert.equal(spvAccess.hasApprovalPin, true);

  const staffA = await login('staff.a', 'Staff12345');
  const staffB = await login('staff.b', 'Staff12345');
  const accounts = await request('/api/accounts', { cookie: staffA });
  assert.equal(accounts.accounts.length, 2);

  const cashIn = new FormData();
  cashIn.set('type', 'MASUK'); cashIn.set('transactionDate', new Date().toISOString().slice(0, 10));
  cashIn.set('accountId', incoming.accountId); cashIn.set('amount', '10000'); cashIn.set('description', 'Pengisian kas awal');
  const inResult = await request('/api/transactions', { cookie: staffA, method: 'POST', form: cashIn, expected: 201 });
  assert.equal(inResult.status, 'APPROVED');

  const dbModule = await import('../src/db.js');
  const integrationDb = dbModule.default?.db || dbModule.db;
  integrationDb.prepare("DELETE FROM sequences WHERE prefix='KSK'").run();

  const cashOut = new FormData();
  cashOut.set('type', 'KELUAR'); cashOut.set('transactionDate', new Date().toISOString().slice(0, 10));
  cashOut.set('accountId', outgoing.accountId); cashOut.set('amount', '1000'); cashOut.set('description', 'Pembelian perlengkapan');
  cashOut.set('counterparty', 'Toko Contoh');
  cashOut.set('receipt', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), 'bukti.pdf');
  const outResult = await request('/api/transactions', { cookie: staffA, method: 'POST', form: cashOut, expected: 201 });
  assert.equal(outResult.status, 'PENDING');
  const pendingApprovals = await request('/api/approvals', { cookie: admin });
  const transactionPending = pendingApprovals.rows.find(row => row.entityId === outResult.transactionId);
  assert(transactionPending?.approvalId, 'Pending transaction approval is missing');
  const persistentLink = await request(`/api/approvals/${transactionPending.approvalId}/link`, { cookie: staffA, method: 'POST' });
  assert.equal(persistentLink.approvalUrl, outResult.approvalUrl);
  const transactionApproval = await approvePublic(outResult.approvalUrl);
  assert.equal(transactionApproval.entityType, 'TRANSACTION');
  await assertDownload(transactionApproval.receiptUrl, null, /application\/pdf/, 10);

  let mutationsA = await request('/api/mutations', { cookie: staffA });
  assert.equal(mutationsA.balance, 9000);
  assert.equal(mutationsA.count, 2);

  const transfer = await request('/api/transfers', {
    cookie: staffA, method: 'POST', expected: 201,
    body: { transferDate: new Date().toISOString().slice(0, 10), recipientUserId: staffBResult.userId, amount: 2000, description: 'Penyerahan kas operasional' }
  });
  assert.equal((await approvePublic(transfer.approvalUrl)).entityType, 'TRANSFER');
  mutationsA = await request('/api/mutations', { cookie: staffA });
  const mutationsB = await request('/api/mutations', { cookie: staffB });
  assert.equal(mutationsA.balance, 7000);
  assert.equal(mutationsB.balance, 2000);

  const umo = await request('/api/umo', {
    cookie: staffA, method: 'POST', expected: 201,
    body: { advanceDate: new Date().toISOString().slice(0, 10), dueDate: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
      bearerName: 'Teknisi A', advanceAmount: 400, purpose: 'Pembelian kebutuhan lapangan' }
  });
  assert.equal(umo.status, 'OPEN');
  assert.match(umo.receiptPdfUrl, /disbursement-receipt\.pdf$/);
  await assertDownload(umo.receiptPdfUrl, staffA, /application\/pdf/, 500);
  assert.equal((await request('/api/mutations', { cookie: staffA })).balance, 6600);

  const settlement = new FormData();
  settlement.set('allocations', JSON.stringify([{ accountId: outgoing.accountId, amount: 350, description: 'Pembelian kebutuhan aktual' }]));
  settlement.set('note', 'Sisa dikembalikan');
  settlement.set('receipt', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), 'nota-umo.pdf');
  const settled = await request(`/api/umo/${umo.umoId}/settlement`, { cookie: staffA, method: 'POST', form: settlement });
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.returnedAmount, 50);
  assert.equal((await request('/api/mutations', { cookie: staffA })).balance, 6650, 'UMO realization must not reduce cash twice');
  const umoRows = await request('/api/umo', { cookie: staffA });
  assert.equal(umoRows.rows[0].status, 'SETTLED');
  await assertDownload(`/api/umo/${umo.umoId}/receipt`, staffA, /application\/pdf/, 10);

  const correction = new FormData();
  correction.set('originalTransactionId', outResult.transactionId); correction.set('correctionType', 'REPLACEMENT');
  correction.set('reason', 'Nominal pada nota salah input'); correction.set('transactionDate', new Date().toISOString().slice(0, 10));
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
  const ledger = await request('/api/ledger', { cookie: staffA });
  assert(ledger.rows.some(row => row.status === 'CORRECTED'));
  assert(ledger.rows.some(row => row.sourceType === 'UMO' && row.cashEffect === false));

  await assertDownload('/api/reports/mutations.xlsx', staffA, /spreadsheetml/);
  await assertDownload('/api/reports/mutations.pdf', staffA, /application\/pdf/);
  await assertDownload('/api/reports/ledger.xlsx', staffA, /spreadsheetml/);

  const spv = await login('spv.kas', 'Supervisor12345');
  await request('/api/transactions', { cookie: spv, method: 'POST', body: {}, expected: 403 });
  const allMutations = await request(`/api/mutations?userId=${staffBResult.userId}`, { cookie: spv });
  assert.equal(allMutations.balance, 2000);

  console.log(JSON.stringify({
    checks: 'passed', version: '1.3.0', users: 4, publicPinApproval: true, persistentApprovalLink: true,
    branding: true, responsiveTheme: true, mutationBalance: true, transferDoubleEntry: true,
    umoNoDoubleCharge: true, umoReceiptPdf: true, correctionReversal: true, accountList: true
  }, null, 2));
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
