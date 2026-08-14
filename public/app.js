const approvalToken = new URLSearchParams(location.search).get('approval') || '';
const state = {
  user: null,
  permissions: new Set(),
  config: {},
  accounts: [],
  approvalCount: 0,
  currentPage: '',
  openGroups: new Set(),
  loadingCount: 0,
  userOptions: [],
  budget: null,
  openPeriod: null
};

const pages = [
  { id: 'dashboard', label: 'Dashboard', group: 'Utama', any: ['dashboard.view'] },
  { id: 'budget', label: 'Pagu Kas', group: 'Utama', any: ['budgets.view'] },
  { id: 'transaction', label: 'Input Transaksi', group: 'Utama', any: ['transactions.create'] },
  { id: 'ledger', label: 'Buku Kas', group: 'Utama', any: ['ledger.view_self', 'ledger.view_all'] },
  { id: 'transfers', label: 'Transfer Kas', group: 'Utama', any: ['transfers.create', 'transfers.view_self', 'transfers.view_all'] },
  { id: 'umo', label: 'Uang Muka Operasional', group: 'Utama', any: ['umo.create', 'umo.view_self', 'umo.view_all'] },
  { id: 'corrections', label: 'Koreksi Transaksi', group: 'Utama', any: ['corrections.create', 'corrections.view_all'] },
  { id: 'approval', label: 'Approval', group: 'Utama', any: ['approvals.view'], badge: true },
  { id: 'mutations', label: 'Mutasi Kas', group: 'Laporan', any: ['mutations.view_self', 'mutations.view_all'] },
  { id: 'account-summary', label: 'Rekap Dana per Akun', group: 'Laporan', any: ['account_summary.view'] },
  { id: 'account-comparison', label: 'Perbandingan Dana per Akun', group: 'Laporan', any: ['account_comparison.view'] },
  { id: 'account-list', label: 'Daftar Akun', group: 'Laporan', any: ['accounts.view'] },
  { id: 'users', label: 'Pengguna', group: 'Super User', any: ['users.manage'] },
  { id: 'access', label: 'Hak Akses', group: 'Super User', any: ['permissions.manage'] },
  { id: 'accounts', label: 'Akun Kas', group: 'Super User', any: ['accounts.manage'] },
  { id: 'settings', label: 'Pengaturan', group: 'Super User', any: ['settings.manage'] },
  { id: 'database', label: 'Pemeliharaan Data', group: 'Super User', any: ['database.manage'] },
  { id: 'audit', label: 'Audit Log', group: 'Super User', any: ['audit.view'] },
  { id: 'profile', label: 'Ubah Password', group: 'Akun', always: true }
];

document.addEventListener('DOMContentLoaded', init);
document.getElementById('login-form').addEventListener('submit', login);
document.getElementById('logout-button').addEventListener('click', logout);
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal').addEventListener('click', event => { if (event.target.id === 'modal') closeModal(); });
document.getElementById('menu-toggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
document.getElementById('nav-backdrop').addEventListener('click', closeMobileNavigation);
document.querySelectorAll('.theme-toggle').forEach(button => button.addEventListener('click', toggleTheme));
document.addEventListener('input', event => {
  if (event.target.matches('.money-input')) event.target.value = formatMoneyInput(event.target.value);
});

async function init() {
  applySavedTheme();
  setLoading(true);
  try {
    await loadPublicConfig();
    if (approvalToken) {
      showPublicApproval();
      await renderPublicApproval();
      return;
    }
    await bootstrap();
    showApp();
    const target = approvalToken && allowedPage('approval') ? 'approval' : firstAllowedPage();
    await openPage(target);
  } catch (error) {
    if (error.status !== 401) toast(error.message, true);
    if (!approvalToken) showLogin();
  } finally { setLoading(false); }
}

async function renderPublicApproval() {
  const page = document.getElementById('public-approval-page');
  const row = await api(`/api/public/approvals/${encodeURIComponent(approvalToken)}`);
  const unavailable = row.decision !== 'PENDING';
  const receipt = row.receiptUrl
    ? (String(row.receiptMime).startsWith('image/')
      ? `<div class="public-receipt"><img src="${escapeHtml(row.receiptUrl)}" alt="Bukti transaksi"></div>`
      : `<div class="public-receipt"><iframe src="${escapeHtml(row.receiptUrl)}" title="Bukti transaksi"></iframe><a class="btn btn-ghost" href="${escapeHtml(row.receiptUrl)}" target="_blank" rel="noopener">Buka bukti</a></div>`)
    : '<div class="notice warn">Transaksi ini tidak memiliki bukti yang dapat ditampilkan.</div>';
  const underlying = row.underlyingUrl
    ? (String(row.underlyingMime).startsWith('image/')
      ? `<div class="public-receipt"><img src="${escapeHtml(row.underlyingUrl)}" alt="Underlying document"></div>`
      : `<div class="public-receipt"><iframe src="${escapeHtml(row.underlyingUrl)}" title="Underlying document"></iframe><a class="btn btn-ghost" href="${escapeHtml(row.underlyingUrl)}" target="_blank" rel="noopener">Buka underlying document</a></div>`)
    : '<div class="notice warn">Tidak ada underlying document.</div>';
  page.innerHTML = `
    <div class="page-head"><div><h2>${escapeHtml(row.title || 'Detail Approval')}</h2><p>${escapeHtml(row.referenceNo || row.transactionNo)}</p></div>${statusHtml(row.decision)}</div>
    ${row.decision !== 'PENDING' ? `<div class="notice success">Approval sudah diproses dengan keputusan <strong>${escapeHtml(row.decision)}</strong>.</div>` : ''}
    <div class="card approval-detail-card">
      <div class="grid-3"><div><span class="muted">Tanggal</span><h3>${escapeHtml(row.transactionDate || '-')}</h3></div>
      <div><span class="muted">Akun/Alur</span><h3>${escapeHtml(row.accountName || '-')}</h3></div>
      <div><span class="muted">Nominal</span><h3>${money(row.amount)}</h3></div></div>
      <div class="detail-list"><p><strong>Dibuat oleh:</strong> ${escapeHtml(row.createdByName || '-')}</p>
      <p><strong>Pihak terkait:</strong> ${escapeHtml(row.counterparty || '-')}</p>
      ${row.dueDate ? `<p><strong>Batas pertanggungjawaban:</strong> ${escapeHtml(row.dueDate)}</p>` : ''}
      <p><strong>Keterangan:</strong><br>${escapeHtml(row.description || '-')}</p></div>
      <h3>Bukti transaksi</h3>${receipt}
      ${row.entityType === 'TRANSACTION' ? `<h3 style="margin-top:18px">Underlying document</h3>${underlying}` : ''}
    </div>
    ${unavailable ? '' : `<div class="card approval-pin-card"><h3>Keputusan SPV</h3><p class="muted">Masukkan PIN approval 8 digit. Identitas approver akan dikenali dari PIN tersebut.</p>
      <div class="field"><label for="public-pin">PIN approval</label><input id="public-pin" type="password" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="one-time-code" placeholder="8 digit" required></div>
      <div class="field"><label for="public-note">Catatan/alasan penolakan</label><textarea id="public-note" maxlength="500" placeholder="Wajib diisi jika transaksi ditolak"></textarea></div>
      <div class="actions"><button class="btn btn-success" data-public-decision="APPROVED">Setujui</button><button class="btn btn-danger" data-public-decision="REJECTED">Tolak</button></div></div>`}`;
  document.querySelectorAll('[data-public-decision]').forEach(button => button.addEventListener('click', () => decidePublicApproval(button.dataset.publicDecision)));
}

async function decidePublicApproval(decision) {
  const pin = value('public-pin');
  const note = value('public-note');
  if (!/^\d{8}$/.test(pin)) return toast('PIN harus terdiri dari tepat 8 digit.', true);
  if (decision === 'REJECTED' && !note) return toast('Alasan penolakan wajib diisi.', true);
  setLoading(true);
  try {
    const result = await api(`/api/public/approvals/${encodeURIComponent(approvalToken)}/decision`, { method: 'POST', body: { pin, decision, note } });
    toast(`${result.referenceNo} diproses oleh ${result.approvedByName}.`);
    await renderPublicApproval();
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function api(url, options = {}) {
  const request = { method: options.method || 'GET', headers: { ...(options.headers || {}) }, credentials: 'same-origin' };
  if (options.body instanceof FormData) request.body = options.body;
  else if (options.body !== undefined) {
    request.headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, request);
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload && payload.error ? payload.error : `Permintaan gagal (${response.status}).`);
    error.status = response.status;
    if (response.status === 401 && !approvalToken) showLogin();
    throw error;
  }
  return payload;
}

async function apiBlob(url, options = {}) {
  const request = { method: options.method || 'GET', headers: { ...(options.headers || {}) }, credentials: 'same-origin' };
  if (options.body instanceof FormData) request.body = options.body;
  else if (options.body !== undefined) { request.headers['Content-Type'] = 'application/json'; request.body = JSON.stringify(options.body); }
  const response = await fetch(url, request);
  if (!response.ok) {
    let message = 'File gagal dibuat.';
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return { blob: await response.blob(), disposition: response.headers.get('content-disposition') || '' };
}

async function login(event) {
  event.preventDefault(); setLoading(true);
  try {
    await api('/api/auth/login', { method: 'POST', body: { username: value('username'), password: value('password') } });
    document.getElementById('password').value = '';
    await bootstrap(); showApp();
    await openPage(approvalToken && allowedPage('approval') ? 'approval' : firstAllowedPage());
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function logout() {
  setLoading(true);
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  state.user = null; state.permissions = new Set(); showLogin(); setLoading(false);
}

async function bootstrap() {
  const data = await api('/api/bootstrap');
  state.user = data.user;
  state.permissions = new Set(data.permissions || []);
  state.config = data.config || {};
  state.accounts = data.accounts || [];
  state.budget = data.budget || null;
  state.openPeriod = data.openPeriod || null;
  state.approvalCount = Number(data.approvalCount || 0);
  text('app-name', state.config.appName);
  text('company-name', state.config.companyName);
  text('user-name', state.user.name);
  text('user-role', roleLabel(state.user.role));
  text('sidebar-version', `Versi ${state.config.appVersion || '-'}`);
  applyBranding(state.config);
  renderNavigation();
}

function has(code) { return state.permissions.has(code); }
function allowedPage(pageId) {
  const page = pages.find(item => item.id === pageId);
  return page && (page.always || page.any.some(has));
}
function firstAllowedPage() { return pages.find(page => allowedPage(page.id)).id; }

function renderNavigation() {
  const visible = pages.filter(page => allowedPage(page.id));
  const grouped = visible.reduce((groups, page) => {
    if (!groups.has(page.group)) groups.set(page.group, []);
    groups.get(page.group).push(page);
    return groups;
  }, new Map());
  const html = [...grouped.entries()].map(([group, items]) => {
    const open = state.openGroups.has(group);
    const badgeCount = items.some(page => page.badge) ? state.approvalCount : 0;
    return `<section class="nav-group ${open ? 'open' : ''}">
      <button class="nav-group-toggle" type="button" data-nav-group="${escapeHtml(group)}" aria-expanded="${open}">
        <span>${escapeHtml(group)}</span><span class="nav-group-meta">${badgeCount ? `<span class="badge">${badgeCount}</span>` : ''}<span class="nav-arrow">⌄</span></span>
      </button>
      <div class="nav-submenu" ${open ? '' : 'hidden'}>${items.map(page => {
        const badge = page.badge && state.approvalCount ? `<span class="badge">${state.approvalCount}</span>` : '';
        return `<button class="nav-btn ${state.currentPage === page.id ? 'active' : ''}" data-page="${page.id}"><span>${escapeHtml(page.label)}</span>${badge}</button>`;
      }).join('')}</div>
    </section>`;
  }).join('');
  const nav = document.getElementById('navigation');
  nav.innerHTML = html;
  nav.querySelectorAll('[data-nav-group]').forEach(button => button.addEventListener('click', () => {
    const group = button.dataset.navGroup;
    if (state.openGroups.has(group)) state.openGroups.delete(group); else state.openGroups.add(group);
    renderNavigation();
  }));
  nav.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => { closeMobileNavigation(); openPage(button.dataset.page); }));
}

async function openPage(pageId) {
  if (!allowedPage(pageId)) return toast('Anda tidak memiliki akses ke menu tersebut.', true);
  state.currentPage = pageId;
  const activePage = pages.find(page => page.id === pageId);
  if (activePage) state.openGroups.add(activePage.group);
  renderNavigation();
  const renderers = { dashboard: renderDashboard, transaction: renderTransaction, ledger: renderLedger, mutations: renderMutations,
    budget: renderBudget, 'account-list': renderAccountList, 'account-summary': renderAccountSummary, 'account-comparison': renderAccountComparison,
    transfers: renderTransfers, umo: renderUmo, corrections: renderCorrections,
    approval: renderApproval, users: renderUsers, access: renderAccess, accounts: renderAccounts, settings: renderSettings,
    database: renderDatabaseMaintenance, audit: renderAudit, profile: renderProfile };
  setLoading(true);
  try { await renderers[pageId](); }
  catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function renderDashboard(userId = 'ALL', startDate = '', endDate = '') {
  const query = new URLSearchParams({ userId, startDate, endDate });
  [...query.keys()].forEach(key => { if (!query.get(key)) query.delete(key); });
  const data = await api(`/api/dashboard?${query}`);
  state.userOptions = data.userOptions || [];
  const selector = data.canViewAll ? `
    <div class="field"><label for="dashboard-user">Tampilkan data</label><select id="dashboard-user"><option value="ALL">Seluruh pengguna</option>${data.userOptions.map(user => `<option value="${escapeHtml(user.userId)}" ${data.scope === user.userId ? 'selected' : ''}>${escapeHtml(user.name)} — ${escapeHtml(roleLabel(user.role))}</option>`).join('')}</select></div>` : '';
  document.getElementById('page').innerHTML = `
    <div class="page-head"><div><h2>Dashboard</h2><p>${data.canViewAll ? 'Ringkasan dapat dilihat seluruhnya atau difilter per pengguna.' : 'Ringkasan transaksi yang dibuat oleh akun Anda.'}</p></div></div>
    <div class="card"><form id="dashboard-filter" class="grid-4">${selector}
      <div class="field"><label for="dashboard-start">Dari tanggal</label><input id="dashboard-start" type="date" value="${escapeHtml(data.startDate)}"></div>
      <div class="field"><label for="dashboard-end">Sampai tanggal</label><input id="dashboard-end" type="date" value="${escapeHtml(data.endDate)}"></div>
      <div class="field" style="align-self:end"><button class="btn btn-primary" type="submit">Terapkan</button></div>
    </form></div>
    <div class="grid-3">
      <div class="card metric"><span>Saldo kas sampai ${escapeHtml(data.endDate)}</span><strong>${money(data.cashBalance)}</strong></div>
      <div class="card metric pending"><span>UMO belum dipertanggungjawabkan</span><strong>${money(data.umoOutstanding)}</strong></div>
      <div class="card metric in"><span>Kas masuk approved</span><strong>${money(data.totalIn)}</strong></div>
      <div class="card metric out"><span>Kas keluar approved</span><strong>${money(data.totalOut)}</strong></div>
      <div class="card metric pending"><span>Menunggu approval</span><strong>${data.pendingCount}</strong></div>
      <div class="card metric"><span>Jumlah transaksi</span><strong>${data.transactionCount}</strong></div>
    </div>
    ${data.canViewAll ? `<div class="card"><h3>Ringkasan per pengguna</h3>${perUserTable(data.perUser)}</div>` : ''}
    <div class="card"><h3>10 transaksi terbaru</h3>${transactionTable(data.recent || [], false)}</div>`;
  document.getElementById('dashboard-filter').addEventListener('submit', event => {
    event.preventDefault();
    const selectedUser = document.getElementById('dashboard-user') ? value('dashboard-user') : 'ALL';
    renderDashboard(selectedUser, value('dashboard-start'), value('dashboard-end')).catch(error => toast(error.message, true));
  });
}

function perUserTable(rows) {
  if (!rows.length) return empty('Belum ada pengguna aktif.');
  return `<div class="table-wrap"><table><thead><tr><th>Pengguna</th><th>Role</th><th>Saldo Kas</th><th>UMO Terbuka</th><th>Transaksi</th><th>Kas Masuk</th><th>Kas Keluar</th><th>Pending</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.name)}</strong><br><span class="muted">${escapeHtml(row.username)}</span></td><td>${escapeHtml(roleLabel(row.role))}</td><td class="amount">${money(row.cashBalance)}</td><td class="amount">${money(row.umoOutstanding)}</td><td>${row.transactionCount}</td><td class="amount">${money(row.totalIn)}</td><td class="amount">${money(row.totalOut)}</td><td>${row.pendingCount}</td></tr>`).join('')}</tbody></table></div>`;
}

async function renderBudget(periodMonth = '') {
  const query = periodMonth ? `?periodMonth=${encodeURIComponent(periodMonth)}` : '';
  const data = await api(`/api/budgets/current${query}`);
  state.budget = data.periodMonth === data.openPeriodMonth ? data : state.budget;
  const editable = data.canManage && data.periodStatus === 'OPEN';
  const periodOptions = data.periods.map(period => `<option value="${escapeHtml(period.periodMonth)}" ${period.periodMonth === data.periodMonth ? 'selected' : ''}>${escapeHtml(monthLabel(period.periodMonth))} — ${escapeHtml(period.status)}</option>`).join('');
  const allocationRows = data.allocations.map(row => `<tr>
    <td><strong>${escapeHtml(row.accountCode)}</strong><br><span class="muted">${escapeHtml(row.accountName)}</span></td>
    <td>${editable ? `<input class="budget-percentage" data-budget-account="${escapeHtml(row.accountId)}" type="number" min="0" max="100" step="0.01" value="${row.percentage}">` : `${Number(row.percentage).toLocaleString('id-ID')}%`}</td>
    <td class="amount">${money(row.allocatedAmount)}</td><td class="amount amount-out">${money(row.usedAmount)}</td>
    <td class="amount">${money(row.pendingAmount)}</td><td class="amount ${row.remainingAmount < 0 ? 'amount-out' : 'amount-in'}">${money(row.remainingAmount)}</td>
  </tr>`).join('');
  document.getElementById('page').innerHTML = `
    <div class="page-head"><div><h2>Pagu Kas</h2><p>Pagu bulanan merupakan informasi dan pengingat; transaksi tetap dapat diajukan saat pagu terlampaui.</p></div>
      <div class="field"><label>Periode</label><select id="budget-period">${periodOptions}</select></div></div>
    ${data.openPeriodMonth !== data.currentCalendarMonth ? `<div class="notice warn"><strong>Periode terbuka masih ${escapeHtml(monthLabel(data.openPeriodMonth))}.</strong> Transaksi bulan baru terkunci sampai End of Month diselesaikan.</div>` : ''}
    <div class="grid-4 summary-metrics">
      <div class="card metric"><span>Total pagu</span><strong>${money(data.totalBudget)}</strong></div>
      <div class="card metric out"><span>Terpakai approved</span><strong>${money(data.totals.usedAmount)}</strong></div>
      <div class="card metric pending"><span>Masih pending</span><strong>${money(data.totals.pendingAmount)}</strong></div>
      <div class="card metric in"><span>Sisa pagu</span><strong>${money(data.totals.remainingAmount)}</strong></div>
    </div>
    <div class="card"><form id="budget-form">
      ${editable ? `<div class="grid-2"><div class="field"><label>Total pagu kas bulan ini</label><input id="budget-total" class="money-input" type="text" inputmode="numeric" value="${formatMoneyInput(data.totalBudget)}" required></div>
        <div class="notice"><strong>Total persentase:</strong> <span id="budget-percentage-total">${data.allocations.reduce((sum, row) => sum + row.percentage, 0).toLocaleString('id-ID')}%</span></div></div>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Kode/Nama Akun</th><th>Persentase</th><th>Alokasi</th><th>Terpakai</th><th>Pending</th><th>Sisa</th></tr></thead><tbody>${allocationRows || `<tr><td colspan="6">Belum ada akun Kas Keluar aktif.</td></tr>`}</tbody></table></div>
      ${editable ? '<div class="actions" style="margin-top:14px"><button class="btn btn-primary" type="submit">Simpan Pagu Kas</button></div>' : ''}
    </form></div>
    ${(data.canClose || data.canReopen) ? `<div class="card"><div class="page-head"><div><h3>Periode Bulanan</h3><p>Penutupan periode memindahkan snapshot saldo akhir menjadi saldo awal periode berikutnya.</p></div>
      ${data.canClose && data.periodStatus === 'OPEN' ? '<button id="run-eom" class="btn btn-danger">Jalankan End of Month</button>' : ''}</div>
      ${periodHistoryTable(data.periods, data.canReopen)}</div>` : ''}`;
  document.getElementById('budget-period').addEventListener('change', event => renderBudget(event.target.value));
  if (editable) {
    document.getElementById('budget-form').addEventListener('submit', saveBudget);
    document.querySelectorAll('.budget-percentage').forEach(input => input.addEventListener('input', updateBudgetPercentageTotal));
  }
  document.getElementById('run-eom')?.addEventListener('click', runEndOfMonth);
  document.querySelectorAll('[data-reopen-period]').forEach(button => button.addEventListener('click', () => reopenPeriod(button.dataset.reopenPeriod)));
}

function updateBudgetPercentageTotal() {
  const total = [...document.querySelectorAll('.budget-percentage')].reduce((sum, input) => sum + Number(String(input.value).replace(',', '.') || 0), 0);
  const target = document.getElementById('budget-percentage-total');
  if (target) target.textContent = `${total.toLocaleString('id-ID', { maximumFractionDigits: 2 })}%`;
}

async function saveBudget(event) {
  event.preventDefault();
  const allocations = [...document.querySelectorAll('.budget-percentage')].map(input => ({
    accountId: input.dataset.budgetAccount,
    percentageBps: Math.round(Number(String(input.value).replace(',', '.') || 0) * 100)
  }));
  setLoading(true);
  try {
    await api(`/api/budgets/${encodeURIComponent(value('budget-period'))}`, { method: 'PUT', body: { totalBudget: parseMoney(value('budget-total')), allocations } });
    toast('Pagu kas berhasil disimpan.'); await bootstrap(); await renderBudget(value('budget-period'));
  } catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

function periodHistoryTable(periods, canReopen) {
  if (!periods.length) return empty('Belum ada riwayat periode.');
  return `<div class="table-wrap"><table><thead><tr><th>Periode</th><th>Status</th><th>Pagu</th><th>Dibuka</th><th>Ditutup</th><th>Aksi</th></tr></thead><tbody>${periods.map(period => `<tr><td>${escapeHtml(monthLabel(period.periodMonth))}</td><td>${statusHtml(period.status)}</td><td>${period.hasBudget ? 'Ada' : '-'}</td><td>${escapeHtml(formatDateTime(period.openedAt))}</td><td>${escapeHtml(formatDateTime(period.closedAt))}</td><td>${canReopen && period.status === 'CLOSED' ? `<button class="btn btn-sm" data-reopen-period="${escapeHtml(period.periodMonth)}">Buka kembali</button>` : '-'}</td></tr>`).join('')}</tbody></table></div>`;
}

async function runEndOfMonth() {
  if (!confirm('Tutup periode ini dan buat periode bulan berikutnya? Data periode yang ditutup tidak dapat diubah.')) return;
  const note = prompt('Catatan End of Month (opsional):') || '';
  setLoading(true);
  try { const result = await api('/api/periods/eom', { method: 'POST', body: { note } }); toast(`EOM ${result.closedPeriodMonth} selesai.`); await bootstrap(); await renderBudget(); }
  catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function reopenPeriod(periodMonth) {
  const currentPassword = prompt('Masukkan password Super User:');
  if (!currentPassword) return;
  const reason = prompt('Alasan membuka kembali periode (wajib):');
  if (!reason) return;
  setLoading(true);
  try { await api(`/api/periods/${encodeURIComponent(periodMonth)}/reopen`, { method: 'POST', body: { currentPassword, reason } }); toast(`Periode ${periodMonth} dibuka kembali.`); await bootstrap(); await renderBudget(periodMonth); }
  catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

function renderTransaction() {
  document.getElementById('page').innerHTML = `
    <div class="page-head"><div><h2>Input Transaksi</h2><p>Menu ini hanya tampil untuk pengguna yang diberi izin input transaksi.</p></div></div>
    <div class="card">
      <div class="notice">Periode transaksi aktif: <strong>${escapeHtml(monthLabel(state.openPeriod?.periodMonth || ''))}</strong>.</div>
      ${state.accounts.length ? '' : '<div class="notice warn">Belum ada akun kas aktif. Hubungi Super User.</div>'}
      <form id="transaction-form">
        <div class="grid-3">
          <div class="field"><label for="tx-type">Jenis transaksi</label><select id="tx-type" name="type"><option value="KELUAR">Kas Keluar</option><option value="MASUK">Kas Masuk</option></select></div>
          <div class="field"><label for="tx-date">Tanggal</label><input id="tx-date" name="transactionDate" type="date" value="${todayInput()}" required></div>
          <div class="field"><label for="tx-account">Akun</label><select id="tx-account" name="accountId" required></select><small id="tx-account-info" class="muted"></small></div>
        </div>
        <div class="grid-2"><div class="field"><label for="tx-amount">Nominal (Rp)</label><input id="tx-amount" class="money-input" name="amount" type="text" inputmode="numeric" autocomplete="off" placeholder="0" required><small class="muted">Pemisah ribuan tampil otomatis, contoh: 1.000.000</small></div><div class="field"><label for="tx-counterparty">Pihak terkait</label><input id="tx-counterparty" name="counterparty" maxlength="150"></div></div>
        <div class="field"><label for="tx-description">Keterangan</label><textarea id="tx-description" name="description" maxlength="500" required></textarea></div>
        ${receiptPicker('tx-receipt', `Bukti transaksi (maks. ${state.config.maxUploadMb} MB)`)}
        ${receiptPicker('tx-underlying', `Underlying document dasar pengeluaran, gambar/PDF (maks. ${state.config.maxUploadMb} MB)`, 'underlyingDocument')}
        <div id="tx-result"></div><button class="btn btn-primary" type="submit" ${state.accounts.length ? '' : 'disabled'}>Simpan transaksi</button>
      </form>
    </div>`;
  const type = document.getElementById('tx-type');
  type.addEventListener('change', updateAccountOptions);
  document.getElementById('tx-account').addEventListener('change', updateTransactionAccountInfo);
  updateAccountOptions();
  bindReceiptPickers(document.getElementById('transaction-form'));
  document.getElementById('transaction-form').addEventListener('submit', submitTransaction);
}

function updateAccountOptions() {
  const type = value('tx-type');
  const accounts = state.accounts.filter(account => account.transactionScope === 'BOTH' || account.transactionScope === type);
  document.getElementById('tx-account').innerHTML = `<option value="">Pilih akun...</option>${accounts.map(account => `<option value="${escapeHtml(account.accountId)}">${escapeHtml(account.accountCode)} — ${escapeHtml(account.accountName)} (limit ${money(account.approvalLimit)})</option>`).join('')}`;
  updateTransactionAccountInfo();
}

function updateTransactionAccountInfo() {
  const account = state.accounts.find(item => item.accountId === (document.getElementById('tx-account')?.value || ''));
  const target = document.getElementById('tx-account-info');
  if (!target) return;
  if (!account) { target.textContent = ''; return; }
  const budget = state.budget?.allocations?.find(item => item.accountId === account.accountId);
  const requirements = [account.receiptRequired ? 'bukti wajib' : 'bukti opsional', account.underlyingRequired ? 'underlying document wajib' : 'underlying document opsional'];
  target.textContent = `${requirements.join(' • ')}${budget ? ` • sisa pagu ${money(budget.remainingAmount)} (pending ${money(budget.pendingAmount)})` : ' • pagu belum ditetapkan'}`;
}

async function submitTransaction(event) {
  event.preventDefault(); setLoading(true);
  try {
    const form = new FormData(event.target);
    form.set('amount', String(parseMoney(value('tx-amount'))));
    form.delete('receipt');
    form.delete('underlyingDocument');
    const receipt = selectedReceipt('tx-receipt'); if (receipt) form.set('receipt', receipt);
    const underlying = selectedReceipt('tx-underlying'); if (underlying) form.set('underlyingDocument', underlying);
    const result = await api('/api/transactions', { method: 'POST', body: form });
    document.getElementById('tx-result').innerHTML = `<div class="notice success"><strong>${escapeHtml(result.transactionNo)}</strong> tersimpan dengan status <strong>${escapeHtml(result.status)}</strong>.${result.approvalUrl ? `<br><br><label>Tautan approval</label><div class="copy-row"><input id="approval-url" class="readonly-link" readonly aria-readonly="true" value="${escapeHtml(result.approvalUrl)}"><button id="copy-approval" type="button" class="btn btn-sm">Salin tautan</button></div>` : ''}</div>`;
    if (result.approvalUrl) document.getElementById('copy-approval').addEventListener('click', () => copyText(result.approvalUrl));
    event.target.reset(); resetReceiptPicker('tx-receipt'); resetReceiptPicker('tx-underlying'); document.getElementById('tx-date').value = todayInput(); updateAccountOptions();
    await bootstrap();
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function loadUserOptions() {
  if (state.userOptions.length) return state.userOptions;
  try { state.userOptions = (await api('/api/users/options')).users || []; } catch { state.userOptions = []; }
  return state.userOptions;
}

async function renderLedger() {
  const canAll = has('ledger.view_all');
  const users = canAll ? await loadUserOptions() : [];
  document.getElementById('page').innerHTML = `
    <div class="page-head"><div><h2>Buku Kas</h2><p>${canAll ? 'Data seluruh pengguna dapat difilter.' : 'Anda hanya melihat transaksi yang dibuat sendiri.'}</p></div><div class="actions">${has('reports.export_all') || has('reports.export_self') ? '<button class="btn btn-ghost" data-export="xlsx">Export Excel</button><button class="btn btn-ghost" data-export="pdf">Export PDF</button>' : ''}</div></div>
    <div class="card"><form id="ledger-filter" class="grid-4">
      ${canAll ? `<div class="field"><label for="filter-user">Pengguna</label><select id="filter-user"><option value="ALL">Seluruh pengguna</option>${users.map(user => `<option value="${escapeHtml(user.userId)}">${escapeHtml(user.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="filter-start">Dari tanggal</label><input id="filter-start" type="date"></div><div class="field"><label for="filter-end">Sampai tanggal</label><input id="filter-end" type="date"></div>
      <div class="field"><label for="filter-status">Status</label><select id="filter-status"><option value="">Semua</option><option>APPROVED</option><option>PENDING</option><option>REJECTED</option></select></div>
      <div class="field"><label for="filter-type">Jenis</label><select id="filter-type"><option value="">Semua</option><option value="MASUK">Kas Masuk</option><option value="KELUAR">Kas Keluar</option></select></div>
      <div class="field"><label for="filter-search">Pencarian</label><input id="filter-search" placeholder="No., pihak, keterangan"></div><div class="field" style="align-self:end"><button class="btn btn-primary" type="submit">Terapkan</button></div>
    </form></div><div id="ledger-result" class="card">${empty('Memuat data...')}</div>`;
  document.getElementById('ledger-filter').addEventListener('submit', event => { event.preventDefault(); loadLedger(); });
  document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', () => exportLedger(button.dataset.export)));
  await loadLedger();
}

function ledgerQuery() {
  const get = id => document.getElementById(id) ? value(id) : '';
  const params = new URLSearchParams({ userId: get('filter-user'), startDate: get('filter-start'), endDate: get('filter-end'), status: get('filter-status'), type: get('filter-type'), search: get('filter-search') });
  [...params.keys()].forEach(key => { if (!params.get(key)) params.delete(key); });
  return params;
}

async function loadLedger() {
  setLoading(true);
  try {
    const data = await api(`/api/ledger?${ledgerQuery()}`);
    document.getElementById('ledger-result').innerHTML = `<h3>${data.count} transaksi ditampilkan</h3>${transactionTable(data.rows || [], true)}`;
    bindReceiptButtons(); bindApprovalLinkButtons();
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function exportLedger(format) {
  setLoading(true);
  try {
    const result = await apiBlob(`/api/reports/ledger.${format}?${ledgerQuery()}`);
    const match = result.disposition.match(/filename="?([^";]+)"?/i);
    downloadBlob(result.blob, match ? match[1] : `Buku_Kas.${format}`);
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function renderMutations() {
  const canAll = has('mutations.view_all');
  const users = canAll ? await loadUserOptions() : [];
  document.getElementById('page').innerHTML = `
    <div class="page-head"><div><h2>Mutasi Kas</h2><p>Rekening koran kas dengan saldo berjalan per pengguna.</p></div><div class="actions"><button class="btn btn-ghost" data-mutation-export="xlsx">Export Excel</button><button class="btn btn-ghost" data-mutation-export="pdf">Export PDF</button></div></div>
    <div class="card"><form id="mutation-filter" class="grid-4">
      ${canAll ? `<div class="field"><label>Pengguna</label><select id="mutation-user"><option value="ALL">Seluruh pengguna</option>${users.map(user => `<option value="${escapeHtml(user.userId)}">${escapeHtml(user.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>Dari tanggal</label><input id="mutation-start" type="date"></div><div class="field"><label>Sampai tanggal</label><input id="mutation-end" type="date"></div>
      <div class="field"><label>Sumber mutasi</label><select id="mutation-source"><option value="">Semua</option><option value="TRANSACTION">Transaksi</option><option value="TRANSFER">Transfer</option><option value="UMO_ISSUE">Pencairan UMO</option><option value="UMO_RETURN">Pengembalian UMO</option><option value="UMO_EXTRA">Tambahan UMO</option><option value="CORRECTION_REVERSAL">Koreksi</option></select></div>
      <div class="field"><label>Akun</label><select id="mutation-account"><option value="">Semua akun</option>${state.accounts.map(account => `<option value="${escapeHtml(account.accountId)}">${escapeHtml(account.accountCode)} — ${escapeHtml(account.accountName)}</option>`).join('')}</select></div>
      <div class="field"><label>Pencarian</label><input id="mutation-search" placeholder="Referensi atau keterangan"></div><div class="field" style="align-self:end"><button class="btn btn-primary" type="submit">Terapkan</button></div>
    </form></div><div id="mutation-result" class="card">${empty('Memuat mutasi...')}</div>`;
  document.getElementById('mutation-filter').addEventListener('submit', event => { event.preventDefault(); loadMutations(); });
  document.querySelectorAll('[data-mutation-export]').forEach(button => button.addEventListener('click', () => exportMutations(button.dataset.mutationExport)));
  await loadMutations();
}

function mutationQuery() {
  const get = id => document.getElementById(id) ? value(id) : '';
  const params = new URLSearchParams({ userId: get('mutation-user'), startDate: get('mutation-start'), endDate: get('mutation-end'),
    sourceType: get('mutation-source'), accountId: get('mutation-account'), search: get('mutation-search') });
  [...params.keys()].forEach(key => { if (!params.get(key)) params.delete(key); });
  return params;
}

async function loadMutations() {
  const data = await api(`/api/mutations?${mutationQuery()}`);
  const rows = data.rows || [];
  document.getElementById('mutation-result').innerHTML = `<div class="page-head"><div><h3>${data.count} mutasi</h3><p>Saldo akhir cakupan: <strong>${money(data.balance)}</strong></p></div></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Referensi</th><th>Pengguna</th><th>Sumber/Akun</th><th>Keterangan</th><th>Masuk</th><th>Keluar</th><th>Saldo</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.entryDate)}</td><td>${escapeHtml(row.referenceNo)}</td><td>${escapeHtml(row.userName)}</td><td>${escapeHtml(sourceLabel(row.sourceType))}<br><span class="muted">${escapeHtml(row.accountName || row.counterpartName || '-')}</span></td><td>${escapeHtml(row.description)}</td><td class="amount amount-in">${row.direction === 'IN' ? money(row.amount) : '-'}</td><td class="amount amount-out">${row.direction === 'OUT' ? money(row.amount) : '-'}</td><td class="amount"><strong>${money(row.balanceAfter)}</strong></td></tr>`).join('')}</tbody></table></div>` : empty('Belum ada mutasi.')}`;
}

async function exportMutations(format) {
  setLoading(true);
  try {
    const result = await apiBlob(`/api/reports/mutations.${format}?${mutationQuery()}`);
    const match = result.disposition.match(/filename="?([^";]+)"?/i);
    downloadBlob(result.blob, match ? match[1] : `Mutasi_Kas.${format}`);
  } catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function renderAccountSummary() {
  const initial = await api('/api/account-summary');
  document.getElementById('page').innerHTML = `
    <div class="page-head"><div><h2>Rekap Dana per Akun</h2><p>Total dana seluruh pengguna yang dikelompokkan berdasarkan akun transaksi.</p></div>
      <div class="actions">${has('account_summary.export') ? '<button class="btn btn-ghost" data-account-summary-export="xlsx">Export Excel</button><button class="btn btn-ghost" data-account-summary-export="pdf">Export PDF</button>' : ''}</div></div>
    <div class="notice">Hanya transaksi berstatus <strong>APPROVED</strong> yang dihitung. Transaksi asal yang sudah dikoreksi tidak dihitung; realisasi UMO masuk ke akun biaya sesuai pertanggungjawabannya.</div>
    <div class="card"><form id="account-summary-filter" class="grid-4">
      <div class="field"><label>Dari tanggal</label><input id="account-summary-start" type="date"></div>
      <div class="field"><label>Sampai tanggal</label><input id="account-summary-end" type="date"></div>
      <div class="field"><label>Akun</label><select id="account-summary-account"><option value="">Semua akun</option>${initial.rows.map(row => `<option value="${escapeHtml(row.accountId)}">${escapeHtml(row.accountCode)} — ${escapeHtml(row.accountName)}${row.active ? '' : ' (nonaktif)'}</option>`).join('')}</select></div>
      <div class="field" style="align-self:end"><button class="btn btn-primary" type="submit">Terapkan</button></div>
    </form></div>
    <div id="account-summary-result"></div>`;
  document.getElementById('account-summary-filter').addEventListener('submit', event => { event.preventDefault(); loadAccountSummary(); });
  document.querySelectorAll('[data-account-summary-export]').forEach(button => button.addEventListener('click', () => exportAccountSummary(button.dataset.accountSummaryExport)));
  drawAccountSummary(initial);
}

function accountSummaryQuery() {
  const params = new URLSearchParams({
    startDate: value('account-summary-start'),
    endDate: value('account-summary-end'),
    accountId: value('account-summary-account')
  });
  [...params.keys()].forEach(key => { if (!params.get(key)) params.delete(key); });
  return params;
}

async function loadAccountSummary() {
  setLoading(true);
  try { drawAccountSummary(await api(`/api/account-summary?${accountSummaryQuery()}`)); }
  catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

function drawAccountSummary(data) {
  const rows = data.rows || [];
  const totals = data.totals || {};
  document.getElementById('account-summary-result').innerHTML = `
    <div class="grid-4 summary-metrics">
      <div class="card metric in"><span>Total dana masuk</span><strong>${money(totals.totalIn)}</strong></div>
      <div class="card metric out"><span>Total dana keluar</span><strong>${money(totals.totalOut)}</strong></div>
      <div class="card metric"><span>Penyesuaian</span><strong>${money(totals.totalAdjustment)}</strong></div>
      <div class="card metric ${Number(totals.netAmount) < 0 ? 'out' : 'in'}"><span>Neto periode</span><strong>${money(totals.netAmount)}</strong></div>
    </div>
    <div class="card"><div class="page-head"><div><h3>${rows.length} akun ditampilkan</h3><p>${Number(totals.transactionCount || 0)} transaksi approved</p></div></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Kode</th><th>Nama akun</th><th>Cakupan</th><th>Status</th><th>Jumlah transaksi</th><th>Dana masuk</th><th>Dana keluar</th><th>Penyesuaian</th><th>Neto</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.accountCode)}</strong></td><td>${escapeHtml(row.accountName)}</td><td>${escapeHtml(typeLabel(row.transactionScope))}</td><td>${statusHtml(row.active ? 'ACTIVE' : 'INACTIVE')}</td><td class="amount">${row.transactionCount}</td><td class="amount amount-in">${money(row.totalIn)}</td><td class="amount amount-out">${money(row.totalOut)}</td><td class="amount">${money(row.totalAdjustment)}</td><td class="amount ${row.netAmount < 0 ? 'amount-out' : 'amount-in'}"><strong>${money(row.netAmount)}</strong></td></tr>`).join('')}</tbody></table></div>` : empty('Belum ada akun.')}
    </div>`;
}

async function exportAccountSummary(format) {
  setLoading(true);
  try {
    const result = await apiBlob(`/api/reports/account-summary.${format}?${accountSummaryQuery()}`);
    const match = result.disposition.match(/filename="?([^";]+)"?/i);
    downloadBlob(result.blob, match ? match[1] : `Rekap_Dana_Akun.${format}`);
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function renderAccountComparison(month1 = '', month2 = '', userId = '') {
  const query = new URLSearchParams({ month1, month2, userId });
  [...query.keys()].forEach(key => { if (!query.get(key)) query.delete(key); });
  const data = await api(`/api/account-comparison?${query}`);
  document.getElementById('page').innerHTML = `
    <div class="page-head"><div><h2>Perbandingan Dana per Akun</h2><p>Perbandingan total transaksi approved antara dua bulan.</p></div></div>
    <div class="card"><form id="account-comparison-filter" class="grid-4">
      <div class="field"><label>Bulan 1</label><input id="comparison-month-1" type="month" value="${escapeHtml(data.month1)}" required></div>
      <div class="field"><label>Bulan 2</label><input id="comparison-month-2" type="month" value="${escapeHtml(data.month2)}" required></div>
      ${data.canViewAll ? `<div class="field"><label>Pengguna</label><select id="comparison-user"><option value="ALL">Seluruh pengguna</option>${data.users.map(user => `<option value="${escapeHtml(user.userId)}" ${data.userId === user.userId ? 'selected' : ''}>${escapeHtml(user.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field" style="align-self:end"><button class="btn btn-primary" type="submit">Bandingkan</button></div>
    </form></div>
    <div class="card">${accountComparisonTable(data)}</div>`;
  document.getElementById('account-comparison-filter').addEventListener('submit', event => {
    event.preventDefault();
    renderAccountComparison(value('comparison-month-1'), value('comparison-month-2'), document.getElementById('comparison-user') ? value('comparison-user') : '');
  });
}

function accountComparisonTable(data) {
  const rows = data.rows || [];
  if (!rows.length) return empty('Belum ada akun untuk dibandingkan.');
  return `<div class="table-wrap"><table><thead><tr><th>Kode</th><th>Nama Akun</th><th>${escapeHtml(monthLabel(data.month1))}</th><th>${escapeHtml(monthLabel(data.month2))}</th><th>Selisih</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.accountCode)}</strong></td><td>${escapeHtml(row.accountName)}</td><td class="amount">${money(row.month1Amount)}</td><td class="amount">${money(row.month2Amount)}</td><td class="amount ${row.difference < 0 ? 'amount-out' : row.difference > 0 ? 'amount-in' : ''}"><strong>${money(row.difference)}</strong></td></tr>`).join('')}</tbody></table></div>`;
}

async function renderAccountList() {
  const data = await api('/api/accounts');
  document.getElementById('page').innerHTML = `<div class="page-head"><div><h2>Daftar Akun</h2><p>Referensi akun transaksi dan batas auto-approval yang berlaku.</p></div></div><div class="card">${readOnlyAccountTable(data.accounts || [])}</div>`;
}

function readOnlyAccountTable(accounts) {
  if (!accounts.length) return empty('Belum ada akun aktif.');
  return `<div class="table-wrap"><table><thead><tr><th>Kode</th><th>Nama akun</th><th>Jenis transaksi</th><th>Limit auto-approval</th><th>Bukti</th><th>Underlying document</th></tr></thead><tbody>${accounts.map(account => `<tr><td><strong>${escapeHtml(account.accountCode)}</strong></td><td>${escapeHtml(account.accountName)}</td><td>${escapeHtml(typeLabel(account.transactionScope))}</td><td class="amount">${money(account.approvalLimit)}</td><td>${account.receiptRequired ? 'Wajib' : 'Opsional'}</td><td>${account.underlyingRequired ? 'Wajib' : 'Opsional'}</td></tr>`).join('')}</tbody></table></div>`;
}

function approvalResultHtml(result) {
  if (!result.approvalUrl) return '';
  return `<br><br><label>Tautan approval</label><div class="copy-row"><input class="approval-url-field readonly-link" readonly aria-readonly="true" value="${escapeHtml(result.approvalUrl)}"><button type="button" class="btn btn-sm copy-generated-link">Salin tautan</button></div>`;
}

function bindGeneratedLink() {
  const button = document.querySelector('.copy-generated-link');
  const input = document.querySelector('.approval-url-field');
  if (button && input) button.addEventListener('click', () => copyText(input.value));
}

async function renderTransfers() {
  const data = await api('/api/transfers');
  const form = has('transfers.create') ? `<div class="card"><h3>Ajukan Transfer Kas</h3><p class="muted">Saldo Anda: <strong>${money(data.balance)}</strong>. Transfer selalu memerlukan approval SPV.</p><form id="transfer-form"><div class="grid-3"><div class="field"><label>Tanggal</label><input id="transfer-date" type="date" value="${todayInput()}" required></div><div class="field"><label>Penerima</label><select id="transfer-recipient" required><option value="">Pilih staff...</option>${(data.recipients || []).map(user => `<option value="${escapeHtml(user.userId)}">${escapeHtml(user.name)}</option>`).join('')}</select></div><div class="field"><label>Nominal</label><input id="transfer-amount" class="money-input" type="text" inputmode="numeric" autocomplete="off" placeholder="0" required></div></div><div class="field"><label>Keterangan</label><textarea id="transfer-description" maxlength="500" required></textarea></div><div id="transfer-result"></div><button class="btn btn-primary" type="submit">Ajukan transfer</button></form></div>` : '';
  document.getElementById('page').innerHTML = `<div class="page-head"><div><h2>Transfer Kas Antar-Staff</h2><p>Transfer hanya menggeser saldo antar pengguna dan tidak menjadi biaya.</p></div></div>${form}<div class="card"><h3>Riwayat Transfer</h3>${transferTable(data.rows || [])}</div>`;
  const element = document.getElementById('transfer-form'); if (element) element.addEventListener('submit', submitTransfer);
  bindApprovalLinkButtons();
}

function transferTable(rows) {
  if (!rows.length) return empty('Belum ada transfer kas.');
  return `<div class="table-wrap"><table><thead><tr><th>No.</th><th>Tanggal</th><th>Dari</th><th>Ke</th><th>Keterangan</th><th>Status</th><th>Nominal</th><th>Aksi</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.transferNo)}</td><td>${escapeHtml(row.transferDate)}</td><td>${escapeHtml(row.senderName)}</td><td>${escapeHtml(row.recipientName)}</td><td>${escapeHtml(row.description)}</td><td>${statusHtml(row.status)}</td><td class="amount">${money(row.amount)}</td><td>${row.approvalId ? `<button class="btn btn-sm" data-approval-link="${escapeHtml(row.approvalId)}">Salin link approval</button>` : '-'}</td></tr>`).join('')}</tbody></table></div>`;
}

async function submitTransfer(event) {
  event.preventDefault(); setLoading(true);
  try {
    const result = await api('/api/transfers', { method: 'POST', body: { transferDate: value('transfer-date'), recipientUserId: value('transfer-recipient'), amount: parseMoney(value('transfer-amount')), description: value('transfer-description') } });
    document.getElementById('transfer-result').innerHTML = `<div class="notice success"><strong>${escapeHtml(result.transferNo)}</strong> menunggu approval.${approvalResultHtml(result)}</div>`;
    bindGeneratedLink();
  } catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function renderUmo() {
  const data = await api('/api/umo'); state.umoRows = data.rows || [];
  const defaultDue = datePlusDays(Number(data.dueDays || 3));
  const form = has('umo.create') ? `<div class="card"><h3>Buat Uang Muka Operasional</h3><p class="muted">Saldo Anda ${money(data.balance)}. UMO di atas ${money(data.approvalLimit)} memerlukan approval.</p><form id="umo-form"><div class="grid-4"><div class="field"><label>Tanggal</label><input id="umo-date" type="date" value="${todayInput()}" required></div><div class="field"><label>Batas pertanggungjawaban</label><input id="umo-due" type="date" value="${defaultDue}" required></div><div class="field"><label>Pembawa/penerima uang</label><input id="umo-bearer" maxlength="120" required></div><div class="field"><label>Nominal UMO</label><input id="umo-amount" class="money-input" type="text" inputmode="numeric" autocomplete="off" placeholder="0" required></div></div><div class="field"><label>Keperluan sementara</label><textarea id="umo-purpose" maxlength="500" required></textarea></div><div id="umo-result"></div><button class="btn btn-primary" type="submit">Catat UMO</button></form></div>` : '';
  document.getElementById('page').innerHTML = `<div class="page-head"><div><h2>Uang Muka Operasional (UMO)</h2><p>Pengeluaran sementara yang belum diketahui akun dan realisasi akhirnya.</p></div></div>${form}<div class="card"><h3>Daftar UMO</h3>${umoTable(data.rows || [])}</div>`;
  const formElement = document.getElementById('umo-form'); if (formElement) formElement.addEventListener('submit', submitUmo);
  document.querySelectorAll('[data-umo-settle]').forEach(button => button.addEventListener('click', () => openUmoSettlement(button.dataset.umoSettle)));
  document.querySelectorAll('[data-umo-receipt]').forEach(button => button.addEventListener('click', () => window.open(`/api/umo/${encodeURIComponent(button.dataset.umoReceipt)}/receipt`, '_blank', 'noopener')));
  document.querySelectorAll('[data-umo-pdf]').forEach(button => button.addEventListener('click', () => window.open(`/api/umo/${encodeURIComponent(button.dataset.umoPdf)}/disbursement-receipt.pdf`, '_blank', 'noopener')));
  bindApprovalLinkButtons();
}

function umoTable(rows) {
  if (!rows.length) return empty('Belum ada UMO.');
  return `<div class="table-wrap"><table><thead><tr><th>No.</th><th>Staff/Pembawa</th><th>Keperluan</th><th>Jatuh tempo</th><th>UMO</th><th>Realisasi</th><th>Status</th><th>Aksi</th></tr></thead><tbody>${rows.map(row => `<tr class="${row.overdue ? 'row-overdue' : ''}"><td>${escapeHtml(row.umoNo)}<br><span class="muted">${escapeHtml(row.advanceDate)}</span></td><td>${escapeHtml(row.userName)}<br><span class="muted">${escapeHtml(row.bearerName)}</span></td><td>${escapeHtml(row.purpose)}</td><td>${escapeHtml(row.dueDate)}${row.overdue ? '<br><span class="status status-rejected">TERLAMBAT</span>' : ''}</td><td class="amount">${money(row.advanceAmount)}</td><td class="amount">${row.settledAmount ? money(row.settledAmount) : '-'}</td><td>${statusHtml(row.status)}</td><td><div class="actions">${row.status === 'OPEN' && (row.userId === state.user.userId || has('umo.view_all')) ? `<button class="btn btn-primary btn-sm" data-umo-settle="${escapeHtml(row.umoId)}">Pertanggungjawabkan</button>` : ''}${row.receiptPdfAvailable ? `<button class="btn btn-sm" data-umo-pdf="${escapeHtml(row.umoId)}">PDF tanda terima</button>` : ''}${row.receiptAvailable ? `<button class="btn btn-sm" data-umo-receipt="${escapeHtml(row.umoId)}">Bukti</button>` : ''}${row.approvalId ? `<button class="btn btn-sm" data-approval-link="${escapeHtml(row.approvalId)}">Salin link approval</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
}

async function submitUmo(event) {
  event.preventDefault(); setLoading(true);
  try {
    const result = await api('/api/umo', { method: 'POST', body: { advanceDate: value('umo-date'), dueDate: value('umo-due'), bearerName: value('umo-bearer'), advanceAmount: parseMoney(value('umo-amount')), purpose: value('umo-purpose') } });
    const pdfButton = result.receiptPdfUrl ? `<br><br><a class="btn btn-sm" href="${escapeHtml(result.receiptPdfUrl)}" target="_blank" rel="noopener">Cetak PDF tanda terima</a>` : '';
    document.getElementById('umo-result').innerHTML = `<div class="notice success"><strong>${escapeHtml(result.umoNo)}</strong> tersimpan dengan status ${escapeHtml(result.status)}.${approvalResultHtml(result)}${pdfButton}</div>`;
    bindGeneratedLink();
  } catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

function openUmoSettlement(umoId) {
  const row = (state.umoRows || []).find(item => item.umoId === umoId); if (!row) return;
  const accountOptions = state.accounts.filter(account => ['KELUAR','BOTH'].includes(account.transactionScope)).map(account => `<option value="${escapeHtml(account.accountId)}">${escapeHtml(account.accountCode)} — ${escapeHtml(account.accountName)} (limit ${money(account.approvalLimit)})</option>`).join('');
  openModal(`<h2>Pertanggungjawaban ${escapeHtml(row.umoNo)}</h2><p>UMO awal: <strong>${money(row.advanceAmount)}</strong></p><form id="umo-settlement-form"><div id="umo-allocation-list"><div class="allocation-row grid-3"><div class="field"><label>Akun</label><select class="umo-allocation-account" required><option value="">Pilih akun...</option>${accountOptions}</select></div><div class="field"><label>Nominal realisasi</label><input class="umo-allocation-amount money-input" type="text" inputmode="numeric" autocomplete="off" placeholder="0" required></div><div class="field"><label>Keterangan</label><input class="umo-allocation-description" value="${escapeHtml(row.purpose)}" required></div></div></div><button id="add-umo-allocation" class="btn btn-sm" type="button">Tambah akun</button>${receiptPicker('umo-settlement-receipt', 'Nota/bukti realisasi')}<div class="field"><label>Catatan</label><textarea id="umo-settlement-note"></textarea></div><button class="btn btn-primary" type="submit">Simpan pertanggungjawaban</button></form>`);
  bindReceiptPickers(document.getElementById('umo-settlement-form'));
  document.getElementById('add-umo-allocation').addEventListener('click', () => {
    const first = document.querySelector('.allocation-row'); const clone = first.cloneNode(true); clone.querySelectorAll('input,select').forEach(input => { input.value = ''; }); document.getElementById('umo-allocation-list').appendChild(clone);
  });
  document.getElementById('umo-settlement-form').addEventListener('submit', event => submitUmoSettlement(event, umoId));
}

async function submitUmoSettlement(event, umoId) {
  event.preventDefault();
  const allocations = [...document.querySelectorAll('.allocation-row')].map(row => ({ accountId: row.querySelector('.umo-allocation-account').value, amount: parseMoney(row.querySelector('.umo-allocation-amount').value), description: row.querySelector('.umo-allocation-description').value }));
  const receipt = selectedReceipt('umo-settlement-receipt'); if (!receipt) return toast('Nota atau bukti realisasi wajib dipilih.', true);
  const form = new FormData(); form.set('allocations', JSON.stringify(allocations)); form.set('note', value('umo-settlement-note')); form.set('receipt', receipt);
  setLoading(true);
  try { const result = await api(`/api/umo/${encodeURIComponent(umoId)}/settlement`, { method: 'POST', body: form }); closeModal(); toast(`${result.umoNo} dipertanggungjawabkan dengan status ${result.status}.`); await renderUmo(); }
  catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function renderCorrections() {
  const data = await api('/api/corrections'); state.correctableTransactions = data.transactions || [];
  const form = has('corrections.create') ? `<div class="card"><h3>Ajukan Koreksi</h3><form id="correction-form"><div class="grid-2"><div class="field"><label>Transaksi asal</label><select id="correction-original" required><option value="">Pilih transaksi...</option>${(data.transactions || []).map(tx => `<option value="${escapeHtml(tx.transactionId)}">${escapeHtml(tx.transactionNo)} — ${money(tx.amount)} — ${escapeHtml(tx.description)}</option>`).join('')}</select></div><div class="field"><label>Jenis koreksi</label><select id="correction-type"><option value="REVERSAL">Reversal/pembatalan penuh</option><option value="REPLACEMENT">Koreksi dan transaksi pengganti</option></select></div></div><div class="field"><label>Alasan koreksi</label><textarea id="correction-reason" required></textarea></div><div id="correction-replacement" class="hidden"><div class="grid-3"><div class="field"><label>Tanggal pengganti</label><input id="correction-date" type="date"></div><div class="field"><label>Jenis</label><select id="correction-tx-type"><option value="KELUAR">Kas Keluar</option><option value="MASUK">Kas Masuk</option></select></div><div class="field"><label>Akun</label><select id="correction-account">${state.accounts.map(account => `<option value="${escapeHtml(account.accountId)}">${escapeHtml(account.accountCode)} — ${escapeHtml(account.accountName)}</option>`).join('')}</select></div></div><div class="grid-2"><div class="field"><label>Nominal</label><input id="correction-amount" class="money-input" type="text" inputmode="numeric" autocomplete="off" placeholder="0"></div><div class="field"><label>Pihak terkait</label><input id="correction-counterparty"></div></div><div class="field"><label>Keterangan transaksi pengganti</label><textarea id="correction-description"></textarea></div>${receiptPicker('correction-receipt', 'Bukti pengganti (opsional)')}</div><div id="correction-result"></div><button class="btn btn-primary" type="submit">Ajukan koreksi</button></form></div>` : '';
  document.getElementById('page').innerHTML = `<div class="page-head"><div><h2>Koreksi Transaksi</h2><p>Transaksi approved tidak dihapus; sistem membuat reversal dan, bila perlu, transaksi pengganti.</p></div></div>${form}<div class="card"><h3>Riwayat Koreksi</h3>${correctionTable(data.rows || [])}</div>`;
  const formElement = document.getElementById('correction-form');
  if (formElement) { document.getElementById('correction-type').addEventListener('change', updateCorrectionForm); document.getElementById('correction-original').addEventListener('change', prefillCorrection); formElement.addEventListener('submit', submitCorrection); bindReceiptPickers(formElement); }
  bindApprovalLinkButtons();
}

function updateCorrectionForm() { document.getElementById('correction-replacement').classList.toggle('hidden', value('correction-type') !== 'REPLACEMENT'); }
function prefillCorrection() { const tx = (state.correctableTransactions || []).find(item => item.transactionId === value('correction-original')); if (!tx) return; document.getElementById('correction-date').value = tx.transactionDate; document.getElementById('correction-tx-type').value = tx.type; document.getElementById('correction-account').value = tx.accountId; document.getElementById('correction-amount').value = formatMoneyInput(tx.amount); document.getElementById('correction-counterparty').value = tx.counterparty || ''; document.getElementById('correction-description').value = tx.description; }

function correctionTable(rows) {
  if (!rows.length) return empty('Belum ada koreksi transaksi.');
  return `<div class="table-wrap"><table><thead><tr><th>No. Koreksi</th><th>Transaksi Asal</th><th>Jenis</th><th>Alasan</th><th>Pengaju</th><th>Status</th><th>Aksi</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.correctionNo)}</td><td>${escapeHtml(row.originalTransactionNo)}</td><td>${escapeHtml(row.correctionType)}</td><td>${escapeHtml(row.reason)}</td><td>${escapeHtml(row.createdByName)}</td><td>${statusHtml(row.status)}</td><td>${row.approvalId ? `<button class="btn btn-sm" data-approval-link="${escapeHtml(row.approvalId)}">Salin link approval</button>` : '-'}</td></tr>`).join('')}</tbody></table></div>`;
}

async function submitCorrection(event) {
  event.preventDefault(); const form = new FormData(); const type = value('correction-type'); form.set('originalTransactionId', value('correction-original')); form.set('correctionType', type); form.set('reason', value('correction-reason'));
  if (type === 'REPLACEMENT') { form.set('transactionDate', value('correction-date')); form.set('type', value('correction-tx-type')); form.set('accountId', value('correction-account')); form.set('amount', String(parseMoney(value('correction-amount')))); form.set('counterparty', value('correction-counterparty')); form.set('description', value('correction-description')); const receipt = selectedReceipt('correction-receipt'); if (receipt) form.set('receipt', receipt); }
  setLoading(true);
  try { const result = await api('/api/corrections', { method: 'POST', body: form }); document.getElementById('correction-result').innerHTML = `<div class="notice success"><strong>${escapeHtml(result.correctionNo)}</strong> menunggu approval.${approvalResultHtml(result)}</div>`; bindGeneratedLink(); }
  catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function renderApproval() {
  const data = await api('/api/approvals');
  state.approvalCount = data.rows.length; renderNavigation();
  document.getElementById('page').innerHTML = `<div class="page-head"><div><h2>Approval</h2><p>Transaksi, transfer, koreksi, dan UMO yang menunggu keputusan.</p></div></div><div class="card">${approvalTable(data.rows)}</div>`;
  bindApprovalButtons(); bindApprovalReceiptButtons(); bindApprovalUnderlyingButtons(); bindApprovalLinkButtons();
}

function approvalCard(row) {
  const decisions = has('approvals.decide') && row.status === 'PENDING'
    ? `<button class="btn btn-success" data-decision="APPROVED" data-approval-id="${escapeHtml(row.approvalId)}">Setujui</button><button class="btn btn-danger" data-decision="REJECTED" data-approval-id="${escapeHtml(row.approvalId)}">Tolak</button>`
    : '';
  return `<div class="card"><div class="grid-3"><div><span class="muted">Tanggal</span><h3>${escapeHtml(row.transactionDate)}</h3></div><div><span class="muted">Akun</span><h3>${escapeHtml(row.accountName)}</h3></div><div><span class="muted">Nominal</span><h3>${money(row.amount)}</h3></div></div><p><strong>Dibuat oleh:</strong> ${escapeHtml(row.createdByName)}</p><p><strong>Pihak terkait:</strong> ${escapeHtml(row.counterparty || '-')}</p><p><strong>Keterangan:</strong><br>${escapeHtml(row.description)}</p><div class="actions">${row.receiptAvailable ? `<button class="btn btn-ghost" data-receipt="${escapeHtml(row.transactionId)}">Lihat bukti</button>` : ''}${decisions}</div></div>`;
}

function approvalTable(rows) {
  if (!rows.length) return empty('Tidak ada data yang menunggu approval.');
  return `<div class="table-wrap"><table><thead><tr><th>No./Jenis</th><th>Tanggal</th><th>Pengguna</th><th>Akun/Alur</th><th>Keterangan</th><th>Nominal</th><th>Aksi</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.referenceNo || row.transactionNo)}</strong><br><span class="muted">${escapeHtml(row.title || row.entityType)}</span></td><td>${escapeHtml(row.transactionDate)}</td><td>${escapeHtml(row.createdByName)}</td><td>${escapeHtml(row.accountName)}</td><td>${escapeHtml(row.description)}</td><td class="amount">${money(row.amount)}</td><td><div class="actions"><button class="btn btn-sm" data-approval-link="${escapeHtml(row.approvalId)}">Salin link</button>${row.receiptAvailable ? `<button class="btn btn-sm" data-approval-receipt="${escapeHtml(row.approvalId)}">Bukti</button>` : ''}${row.underlyingAvailable ? `<button class="btn btn-sm" data-approval-underlying="${escapeHtml(row.approvalId)}">Underlying</button>` : ''}${has('approvals.decide') ? `<button class="btn btn-success btn-sm" data-decision="APPROVED" data-approval-id="${escapeHtml(row.approvalId)}">Setujui</button><button class="btn btn-danger btn-sm" data-decision="REJECTED" data-approval-id="${escapeHtml(row.approvalId)}">Tolak</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
}

function bindApprovalReceiptButtons() { document.querySelectorAll('[data-approval-receipt]').forEach(button => button.addEventListener('click', () => window.open(`/api/approvals/${encodeURIComponent(button.dataset.approvalReceipt)}/receipt`, '_blank', 'noopener'))); }
function bindApprovalUnderlyingButtons() { document.querySelectorAll('[data-approval-underlying]').forEach(button => button.addEventListener('click', () => window.open(`/api/approvals/${encodeURIComponent(button.dataset.approvalUnderlying)}/underlying`, '_blank', 'noopener'))); }

function bindApprovalButtons() {
  document.querySelectorAll('[data-decision]').forEach(button => button.addEventListener('click', async () => {
    const decision = button.dataset.decision;
    const note = decision === 'REJECTED' ? prompt('Alasan penolakan (wajib):') : (prompt('Catatan approval (opsional):') || '');
    if (decision === 'REJECTED' && !note) return;
    setLoading(true);
    try {
      const result = await api(`/api/approvals/${encodeURIComponent(button.dataset.approvalId)}/decision`, { method: 'POST', body: { decision, note: note || '' } });
      toast(`${result.referenceNo} berhasil diproses.`); await bootstrap(); await renderApproval();
    } catch (error) { toast(error.message, true); }
    finally { setLoading(false); }
  }));
}

async function renderUsers() {
  const data = await api('/api/admin/users');
  document.getElementById('page').innerHTML = `
    <div class="page-head"><div><h2>Pengguna</h2><p>Buat akun dan tentukan role dasar. Izin detail diatur dari menu Hak Akses.</p></div></div>
    <div class="section-grid"><div class="card"><h3>Tambah pengguna</h3><form id="user-form"><div class="field"><label>Nama</label><input id="new-name" required></div><div class="field"><label>Username</label><input id="new-username" required></div><div class="field"><label>Password awal</label><input id="new-password" type="password" minlength="8" required></div><div class="field"><label>Role dasar</label><select id="new-role"><option value="STAFF">Staff</option><option value="SPV">Supervisor</option><option value="SUPER_USER">Super User</option></select></div><button class="btn btn-primary" type="submit">Simpan pengguna</button></form></div>
    <div class="card"><h3>Daftar pengguna</h3>${userTable(data.users)}</div></div>`;
  document.getElementById('user-form').addEventListener('submit', createUser);
  document.querySelectorAll('[data-user-role]').forEach(select => select.addEventListener('change', () => updateUser(select.dataset.userRole, { role: select.value })));
  document.querySelectorAll('[data-user-active]').forEach(button => button.addEventListener('click', () => updateUser(button.dataset.userActive, { active: button.dataset.nextActive === 'true' })));
  document.querySelectorAll('[data-user-password]').forEach(button => button.addEventListener('click', () => {
    const password = prompt('Masukkan password baru (minimal 8 karakter, huruf dan angka):');
    if (password) updateUser(button.dataset.userPassword, { password });
  }));
  document.querySelectorAll('[data-user-pin]').forEach(button => button.addEventListener('click', () => {
    const pin = prompt('Masukkan PIN approval unik sebanyak 8 digit:');
    if (pin) setUserApprovalPin(button.dataset.userPin, pin);
  }));
}

function userTable(users) {
  return `<div class="table-wrap"><table><thead><tr><th>Nama</th><th>Username</th><th>Role</th><th>PIN Approval</th><th>Status</th><th>Aksi</th></tr></thead><tbody>${users.map(user => `<tr><td><strong>${escapeHtml(user.name)}</strong></td><td>${escapeHtml(user.username)}</td><td><select data-user-role="${escapeHtml(user.userId)}"><option value="STAFF" ${user.role === 'STAFF' ? 'selected' : ''}>Staff</option><option value="SPV" ${user.role === 'SPV' ? 'selected' : ''}>Supervisor</option><option value="SUPER_USER" ${user.role === 'SUPER_USER' ? 'selected' : ''}>Super User</option></select></td><td>${(user.permissions || []).includes('approvals.decide') ? `<button class="btn btn-sm" data-user-pin="${escapeHtml(user.userId)}">${user.hasApprovalPin ? 'Reset PIN' : 'Buat PIN'}</button>` : '-'}</td><td>${statusHtml(user.active ? 'ACTIVE' : 'INACTIVE')}</td><td><div class="actions"><button class="btn btn-sm" data-user-password="${escapeHtml(user.userId)}">Reset password</button><button class="btn btn-sm" data-user-active="${escapeHtml(user.userId)}" data-next-active="${!user.active}" ${user.userId === state.user.userId ? 'disabled' : ''}>${user.active ? 'Nonaktifkan' : 'Aktifkan'}</button></div></td></tr>`).join('')}</tbody></table></div>`;
}

async function setUserApprovalPin(userId, pin) {
  if (!/^\d{8}$/.test(String(pin))) return toast('PIN harus tepat 8 digit angka.', true);
  setLoading(true);
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}/approval-pin`, { method: 'PUT', body: { pin } }); toast('PIN approval berhasil disimpan.'); await renderUsers(); }
  catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function createUser(event) {
  event.preventDefault(); setLoading(true);
  try {
    await api('/api/admin/users', { method: 'POST', body: { name: value('new-name'), username: value('new-username'), password: value('new-password'), role: value('new-role') } });
    toast('Pengguna berhasil dibuat.'); await renderUsers();
  } catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function updateUser(userId, patch) {
  setLoading(true);
  try { await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: patch }); toast('Pengguna diperbarui.'); await renderUsers(); }
  catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function renderAccess(selectedUserId = '') {
  const data = await api('/api/admin/access');
  const selected = data.users.find(user => user.userId === selectedUserId) || data.users.find(user => user.role !== 'SUPER_USER') || data.users[0];
  document.getElementById('page').innerHTML = `
    <div class="page-head"><div><h2>Hak Akses Pengguna</h2><p>Role menjadi template awal. Setiap izin dapat dioverride khusus untuk satu pengguna.</p></div></div>
    <div class="card"><div class="grid-2"><div class="field"><label for="access-user">Pilih pengguna</label><select id="access-user">${data.users.map(user => `<option value="${escapeHtml(user.userId)}" ${selected && selected.userId === user.userId ? 'selected' : ''}>${escapeHtml(user.name)} — ${escapeHtml(roleLabel(user.role))}</option>`).join('')}</select></div><div class="notice"><strong>Role dasar:</strong> ${selected ? escapeHtml(roleLabel(selected.role)) : '-'}<br><span class="muted">Default SPV tidak memiliki akses Input Transaksi.</span></div></div>
    <div id="access-matrix">${selected ? accessMatrix(data, selected) : empty('Belum ada pengguna.')}</div></div>`;
  document.getElementById('access-user').addEventListener('change', event => renderAccess(event.target.value));
  const form = document.getElementById('access-form');
  if (form) form.addEventListener('submit', event => saveAccess(event, selected.userId));
}

function accessMatrix(data, user) {
  if (user.role === 'SUPER_USER') return '<div class="notice warn">Super User selalu memiliki seluruh akses agar sistem tidak terkunci. Hak aksesnya tidak dapat dikurangi.</div>';
  const roleDefault = new Set(data.roleDefaults[user.role] || []);
  const groups = data.catalog.reduce((map, item) => { (map[item.group] ||= []).push(item); return map; }, {});
  return `<form id="access-form">${Object.entries(groups).map(([group, items]) => `<div class="permission-group"><h4>${escapeHtml(group)}</h4>${items.map(item => {
    const overrideExists = Object.prototype.hasOwnProperty.call(user.overrides, item.code);
    const selected = overrideExists ? String(user.overrides[item.code]) : 'default';
    const defaultLabel = roleDefault.has(item.code) ? 'Diizinkan' : 'Ditolak';
    return `<div class="permission-row"><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.code)} <span class="role-note">Default: ${defaultLabel}</span></small></div><select class="permission-select" data-code="${escapeHtml(item.code)}"><option value="default" ${selected === 'default' ? 'selected' : ''}>Ikuti default role</option><option value="true" ${selected === 'true' ? 'selected' : ''}>Izinkan khusus user ini</option><option value="false" ${selected === 'false' ? 'selected' : ''}>Tolak khusus user ini</option></select></div>`;
  }).join('')}</div>`).join('')}<br><button class="btn btn-primary" type="submit">Simpan hak akses</button></form>`;
}

async function saveAccess(event, userId) {
  event.preventDefault();
  const permissions = {};
  document.querySelectorAll('.permission-select').forEach(select => { permissions[select.dataset.code] = select.value === 'default' ? null : select.value === 'true'; });
  setLoading(true);
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}/permissions`, { method: 'PUT', body: { permissions } });
    toast('Hak akses berhasil disimpan. User tersebut perlu login kembali.'); await renderAccess(userId);
  } catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function renderAccounts() {
  const data = await api('/api/admin/accounts');
  document.getElementById('page').innerHTML = `
    <div class="page-head"><div><h2>Akun Kas</h2><p>Atur kategori transaksi dan batas auto-approve.</p></div></div>
    <div class="section-grid"><div class="card"><h3>Tambah akun</h3><form id="account-form"><div class="grid-2"><div class="field"><label>Kode</label><input id="account-code" required></div><div class="field"><label>Nama akun</label><input id="account-name" required></div></div><div class="field"><label>Cakupan</label><select id="account-scope"><option value="KELUAR">Kas Keluar</option><option value="MASUK">Kas Masuk</option><option value="BOTH">Keduanya</option></select></div><div class="field"><label>Limit auto-approve</label><input id="account-limit" class="money-input" type="text" inputmode="numeric" value="0"></div><div class="field check"><input id="account-receipt" type="checkbox" checked><label for="account-receipt">Bukti transaksi wajib</label></div><div class="field check"><input id="account-underlying" type="checkbox"><label for="account-underlying">Underlying document wajib</label></div><button class="btn btn-primary" type="submit">Simpan akun</button></form></div>
    <div class="card"><h3>Daftar akun</h3>${accountTable(data.accounts)}</div></div>`;
  document.getElementById('account-form').addEventListener('submit', createAccount);
  document.querySelectorAll('[data-account-active]').forEach(button => button.addEventListener('click', () => updateAccount(button.dataset.accountActive, { active: button.dataset.nextActive === 'true' })));
  document.querySelectorAll('[data-account-receipt]').forEach(input => input.addEventListener('change', () => updateAccount(input.dataset.accountReceipt, { receiptRequired: input.checked })));
  document.querySelectorAll('[data-account-underlying]').forEach(input => input.addEventListener('change', () => updateAccount(input.dataset.accountUnderlying, { underlyingRequired: input.checked })));
}

function accountTable(accounts) {
  if (!accounts.length) return empty('Belum ada akun kas.');
  return `<div class="table-wrap"><table><thead><tr><th>Kode</th><th>Nama</th><th>Cakupan</th><th>Limit</th><th>Bukti wajib</th><th>Underlying wajib</th><th>Status</th><th>Aksi</th></tr></thead><tbody>${accounts.map(account => `<tr><td>${escapeHtml(account.accountCode)}</td><td>${escapeHtml(account.accountName)}</td><td>${escapeHtml(account.transactionScope)}</td><td class="amount">${money(account.approvalLimit)}</td><td><input data-account-receipt="${escapeHtml(account.accountId)}" type="checkbox" ${account.receiptRequired ? 'checked' : ''}></td><td><input data-account-underlying="${escapeHtml(account.accountId)}" type="checkbox" ${account.underlyingRequired ? 'checked' : ''}></td><td>${statusHtml(account.active ? 'ACTIVE' : 'INACTIVE')}</td><td><button class="btn btn-sm" data-account-active="${escapeHtml(account.accountId)}" data-next-active="${!account.active}">${account.active ? 'Nonaktifkan' : 'Aktifkan'}</button></td></tr>`).join('')}</tbody></table></div>`;
}

async function createAccount(event) {
  event.preventDefault(); setLoading(true);
  try {
    await api('/api/admin/accounts', { method: 'POST', body: { accountCode: value('account-code'), accountName: value('account-name'), transactionScope: value('account-scope'), approvalLimit: parseMoney(value('account-limit')), receiptRequired: document.getElementById('account-receipt').checked, underlyingRequired: document.getElementById('account-underlying').checked } });
    toast('Akun kas berhasil dibuat.'); await bootstrap(); await renderAccounts();
  } catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function updateAccount(accountId, patch) {
  setLoading(true);
  try { await api(`/api/admin/accounts/${encodeURIComponent(accountId)}`, { method: 'PATCH', body: patch }); toast('Akun kas diperbarui.'); await bootstrap(); await renderAccounts(); }
  catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function renderSettings() {
  const data = await api('/api/admin/settings');
  const map = Object.fromEntries(data.settings.map(item => [item.key, item.value]));
  const branding = data.branding || {};
  document.getElementById('page').innerHTML = `<div class="page-head"><div><h2>Pengaturan</h2><p>Konfigurasi umum dan identitas visual aplikasi.</p></div></div><div class="settings-grid"><div class="card"><h3>Pengaturan Umum</h3><form id="settings-form"><div class="grid-2"><div class="field"><label>Nama aplikasi</label><input id="setting-app" value="${escapeHtml(map.APP_NAME || '')}"></div><div class="field"><label>Nama perusahaan</label><input id="setting-company" value="${escapeHtml(map.COMPANY_NAME || '')}"></div><div class="field"><label>Saldo awal global (legacy)</label><input id="setting-opening" class="money-input" type="text" inputmode="numeric" value="${escapeHtml(formatMoneyInput(map.OPENING_BALANCE || 0))}"></div><div class="field"><label>Durasi sesi (jam)</label><input id="setting-session" type="number" min="1" value="${escapeHtml(map.SESSION_HOURS || 8)}"></div><div class="field"><label>Maksimum upload (MB)</label><input id="setting-upload" type="number" min="1" max="20" value="${escapeHtml(map.MAX_UPLOAD_MB || 5)}"></div><div class="field"><label>Limit auto-approval UMO</label><input id="setting-umo-limit" class="money-input" type="text" inputmode="numeric" value="${escapeHtml(formatMoneyInput(map.UMO_APPROVAL_LIMIT || 500000))}"></div><div class="field"><label>Jatuh tempo UMO (hari)</label><input id="setting-umo-days" type="number" min="1" value="${escapeHtml(map.UMO_DUE_DAYS || 3)}"></div></div><div class="field"><label for="setting-theme">Warna tema aplikasi</label><div class="theme-color-row"><input id="setting-theme" type="color" value="${escapeHtml(branding.themeColor || map.THEME_COLOR || '#1d4ed8')}"><span id="theme-color-code">${escapeHtml(branding.themeColor || map.THEME_COLOR || '#1d4ed8')}</span></div><small class="muted">Warna berlaku pada tombol, menu, dan identitas aplikasi seluruh pengguna.</small></div><button class="btn btn-primary" type="submit">Simpan pengaturan</button></form></div><div class="card branding-card"><h3>Logo Perusahaan</h3><div class="branding-preview">${branding.logoUrl ? `<img src="${escapeHtml(branding.logoUrl)}" alt="Logo perusahaan saat ini">` : '<div class="brand-mark">AK</div>'}</div><p class="muted">Gunakan logo JPG atau PNG maksimal 2 MB. Logo tampil pada login, header, approval, dan PDF UMO.</p><form id="logo-form"><div class="field"><label for="setting-logo">Pilih logo</label><input id="setting-logo" name="logo" type="file" accept="image/jpeg,image/png" required></div><button class="btn btn-primary" type="submit">Upload logo</button></form></div></div>`;
  document.getElementById('settings-form').addEventListener('submit', saveSettings);
  document.getElementById('logo-form').addEventListener('submit', uploadLogo);
  document.getElementById('setting-theme').addEventListener('input', event => {
    document.getElementById('theme-color-code').textContent = event.target.value;
    applyBranding({ ...state.config, themeColor: event.target.value });
  });
}

async function saveSettings(event) {
  event.preventDefault(); setLoading(true);
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: { APP_NAME: value('setting-app'), COMPANY_NAME: value('setting-company'), OPENING_BALANCE: parseMoney(value('setting-opening')), SESSION_HOURS: Number(value('setting-session')), MAX_UPLOAD_MB: Number(value('setting-upload')), UMO_APPROVAL_LIMIT: parseMoney(value('setting-umo-limit')), UMO_DUE_DAYS: Number(value('setting-umo-days')), THEME_COLOR: value('setting-theme') } });
    toast('Pengaturan disimpan.'); await bootstrap();
  } catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function uploadLogo(event) {
  event.preventDefault();
  const file = document.getElementById('setting-logo').files[0];
  if (!file) return toast('Pilih file logo terlebih dahulu.', true);
  const form = new FormData(); form.set('logo', file);
  setLoading(true);
  try { await api('/api/admin/settings/logo', { method: 'POST', body: form }); toast('Logo perusahaan berhasil diperbarui.'); await bootstrap(); await renderSettings(); }
  catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function renderDatabaseMaintenance() {
  const data = await api('/api/admin/database/backups');
  document.getElementById('page').innerHTML = `
    <div class="page-head"><div><h2>Pemeliharaan Data</h2><p>Backup, riwayat arsip, dan reset data transaksi khusus Super User.</p></div><button id="create-backup" class="btn btn-ghost">Buat backup sekarang</button></div>
    <div class="card"><h3>Export & Restore Data Lengkap</h3>
      <div class="notice">Paket <strong>.kkbackup</strong> terenkripsi memuat database, pengguna dan password, konfigurasi keamanan, pengaturan, audit log, logo, bukti transaksi, serta underlying document. Simpan password backup secara terpisah.</div>
      <div class="section-grid"><form id="full-backup-export-form"><h3>Export untuk Pemindahan Server</h3>
        <div class="field"><label>Password Super User saat ini</label><input id="full-export-current-password" type="password" autocomplete="current-password" required></div>
        <div class="field"><label>Password enkripsi backup (minimal 8 karakter)</label><input id="full-export-backup-password" type="password" autocomplete="new-password" minlength="8" required></div>
        <button class="btn btn-primary" type="submit">Export Data Lengkap</button></form>
      <form id="full-backup-restore-form"><h3>Restore di Server</h3>
        <div class="field"><label>File .kkbackup</label><input id="full-restore-file" type="file" accept=".kkbackup,application/octet-stream" required></div>
        <div class="grid-2"><div class="field"><label>Password Super User saat ini</label><input id="full-restore-current-password" type="password" autocomplete="current-password" required></div>
        <div class="field"><label>Password backup</label><input id="full-restore-backup-password" type="password" required></div></div>
        <div class="field"><label>Ketik PULIHKAN SELURUH DATA</label><input id="full-restore-confirmation" autocomplete="off" required></div>
        <button class="btn btn-danger" type="submit">Backup Kondisi Saat Ini & Restore</button></form></div>
    </div>
    <div class="card danger-zone"><h3>Reset Data Transaksi</h3>
      <div class="notice warn"><strong>Perhatian:</strong> transaksi, mutasi, transfer, UMO, koreksi, approval, nomor urut, dan audit log akan dikosongkan. Pengguna, akun, hak akses, logo, pengaturan, serta file bukti tetap dipertahankan. Database lama otomatis diarsipkan sebelum reset.</div>
      <form id="database-clear-form">
        <div class="grid-2"><div class="field"><label>Password Super User saat ini</label><input id="database-password" type="password" autocomplete="current-password" required></div>
        <div class="field"><label>Ketik HAPUS DATA TRANSAKSI</label><input id="database-confirmation" autocomplete="off" required></div></div>
        <button class="btn btn-danger" type="submit">Backup dan Reset Data Transaksi</button>
      </form><div id="database-clear-result"></div>
    </div>
    <div class="card"><div class="page-head"><div><h3>Riwayat Backup Database</h3><p>Backup sebelum reset dipertahankan sebagai historical database.</p></div></div>${backupTable(data.backups || [])}</div>`;
  document.getElementById('create-backup').addEventListener('click', createManualBackup);
  document.getElementById('full-backup-export-form').addEventListener('submit', exportFullBackup);
  document.getElementById('full-backup-restore-form').addEventListener('submit', restoreFullBackup);
  document.getElementById('database-clear-form').addEventListener('submit', clearDatabase);
  bindBackupDownloads();
}

async function exportFullBackup(event) {
  event.preventDefault(); setLoading(true);
  try {
    const result = await apiBlob('/api/admin/full-backup/export', { method: 'POST', body: {
      currentPassword: value('full-export-current-password'), backupPassword: value('full-export-backup-password')
    } });
    const match = result.disposition.match(/filename="?([^";]+)"?/i);
    downloadBlob(result.blob, match ? match[1] : 'Kas_Kecil_Lengkap.kkbackup');
    toast('Export data lengkap berhasil dibuat.');
  } catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function restoreFullBackup(event) {
  event.preventDefault();
  const confirmation = value('full-restore-confirmation');
  if (confirmation.toUpperCase() !== 'PULIHKAN SELURUH DATA') return toast('Teks konfirmasi restore belum sesuai.', true);
  if (!confirm('Seluruh data server ini akan diganti oleh isi backup. Backup kondisi saat ini akan dibuat terlebih dahulu. Lanjutkan?')) return;
  const form = new FormData();
  form.set('backupFile', document.getElementById('full-restore-file').files[0]);
  form.set('currentPassword', value('full-restore-current-password'));
  form.set('backupPassword', value('full-restore-backup-password'));
  form.set('confirmation', confirmation);
  setLoading(true);
  try {
    await api('/api/admin/full-backup/restore', { method: 'POST', body: form });
    toast('Restore berhasil. Aplikasi sedang restart; silakan login kembali beberapa saat lagi.');
    setTimeout(() => location.reload(), 4000);
  } catch (error) { toast(error.message, true); setLoading(false); }
}

function backupTable(backups) {
  if (!backups.length) return empty('Belum ada backup database.');
  return `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Jenis</th><th>Nama file</th><th>Ukuran</th><th>Aksi</th></tr></thead><tbody>${backups.map(backup => `<tr><td>${escapeHtml(formatDateTime(backup.createdAt))}</td><td>${escapeHtml(backup.typeLabel)}</td><td><span class="backup-name">${escapeHtml(backup.fileName)}</span></td><td>${escapeHtml(formatBytes(backup.size))}</td><td><button class="btn btn-sm" data-backup-download="${escapeHtml(backup.downloadUrl)}" data-backup-name="${escapeHtml(backup.fileName)}">Download</button></td></tr>`).join('')}</tbody></table></div>`;
}

function bindBackupDownloads() {
  document.querySelectorAll('[data-backup-download]').forEach(button => button.addEventListener('click', async () => {
    setLoading(true);
    try {
      const result = await apiBlob(button.dataset.backupDownload);
      downloadBlob(result.blob, button.dataset.backupName || 'backup.sqlite');
    } catch (error) { toast(error.message, true); }
    finally { setLoading(false); }
  }));
}

async function createManualBackup() {
  setLoading(true);
  try {
    const result = await api('/api/admin/database/backups', { method: 'POST' });
    toast(`Backup ${result.backup.fileName} berhasil dibuat.`);
    await renderDatabaseMaintenance();
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function clearDatabase(event) {
  event.preventDefault();
  const confirmation = value('database-confirmation');
  if (confirmation.toUpperCase() !== 'HAPUS DATA TRANSAKSI') return toast('Teks konfirmasi belum sesuai.', true);
  if (!window.confirm('Data transaksi aktif akan dikosongkan setelah backup dibuat. Lanjutkan reset?')) return;
  setLoading(true);
  try {
    const result = await api('/api/admin/database/clear', { method: 'POST', body: { currentPassword: value('database-password'), confirmation } });
    await bootstrap();
    await renderDatabaseMaintenance();
    const target = document.getElementById('database-clear-result');
    if (target) target.innerHTML = `<div class="notice success">Reset berhasil. ${Number(result.recordCount || 0).toLocaleString('id-ID')} record operasional dibersihkan. Backup historical: <strong>${escapeHtml(result.backup.fileName)}</strong>.</div>`;
    toast('Data transaksi berhasil direset dan backup historical tersimpan.');
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

async function renderAudit() {
  const data = await api('/api/audit?limit=300');
  document.getElementById('page').innerHTML = `<div class="page-head"><div><h2>Audit Log</h2><p>Riwayat aktivitas penting aplikasi.</p></div></div><div class="card">${auditTable(data.rows)}</div>`;
}

function auditTable(rows) {
  if (!rows.length) return empty('Belum ada audit log.');
  return `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Pengguna</th><th>Aksi</th><th>Entitas</th><th>Keterangan</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(formatDateTime(row.timestamp))}</td><td>${escapeHtml(row.user_name || row.user_id || 'SYSTEM')}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.entity_type)}<br><span class="muted">${escapeHtml(row.entity_id || '')}</span></td><td>${escapeHtml(row.description || '')}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderProfile() {
  document.getElementById('page').innerHTML = `<div class="page-head"><div><h2>Keamanan Akun</h2><p>Kelola password dan PIN approval Anda.</p></div></div><div class="section-grid"><div class="card"><h3>Ubah Password</h3><form id="password-form"><div class="field"><label>Password lama</label><input id="old-password" type="password" required></div><div class="field"><label>Password baru</label><input id="new-password-profile" type="password" minlength="8" required></div><div class="field"><label>Ulangi password baru</label><input id="confirm-password" type="password" minlength="8" required></div><button class="btn btn-primary" type="submit">Ubah password</button></form></div>${has('approvals.decide') ? `<div class="card"><h3>PIN Approval</h3><p class="muted">PIN harus unik dan terdiri dari tepat 8 digit angka.</p><form id="pin-form"><div class="field"><label>Password saat ini</label><input id="pin-current-password" type="password" required></div><div class="field"><label>PIN baru</label><input id="profile-pin" type="password" inputmode="numeric" maxlength="8" pattern="[0-9]{8}" required></div><div class="field"><label>Ulangi PIN</label><input id="profile-pin-confirm" type="password" inputmode="numeric" maxlength="8" pattern="[0-9]{8}" required></div><button class="btn btn-primary" type="submit">Simpan PIN</button></form></div>` : ''}</div>`;
  document.getElementById('password-form').addEventListener('submit', changePassword);
  const pinForm = document.getElementById('pin-form'); if (pinForm) pinForm.addEventListener('submit', changeApprovalPin);
}

async function changeApprovalPin(event) {
  event.preventDefault(); const pin = value('profile-pin');
  if (pin !== value('profile-pin-confirm')) return toast('Konfirmasi PIN tidak sama.', true);
  if (!/^\d{8}$/.test(pin)) return toast('PIN harus tepat 8 digit angka.', true);
  setLoading(true);
  try { await api('/api/auth/approval-pin', { method: 'PUT', body: { currentPassword: value('pin-current-password'), pin } }); toast('PIN approval berhasil disimpan.'); event.target.reset(); }
  catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

async function changePassword(event) {
  event.preventDefault();
  if (value('new-password-profile') !== value('confirm-password')) return toast('Konfirmasi password baru tidak sama.', true);
  setLoading(true);
  try { await api('/api/auth/change-password', { method: 'POST', body: { oldPassword: value('old-password'), newPassword: value('new-password-profile') } }); showLogin(); toast('Password berhasil diubah. Silakan login kembali.'); }
  catch (error) { toast(error.message, true); } finally { setLoading(false); }
}

function transactionTable(rows, withReceipt) {
  if (!rows.length) return empty('Belum ada transaksi.');
  const canReceipt = has('receipts.view_all') || has('receipts.view_self');
  const hasActions = withReceipt && (canReceipt || rows.some(row => row.approvalId));
  return `<div class="table-wrap"><table><thead><tr><th>No.</th><th>Tanggal</th><th>Pengguna</th><th>Jenis</th><th>Akun</th><th>Keterangan</th><th>Status</th><th>Nominal</th>${hasActions ? '<th>Aksi</th>' : ''}</tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.transactionNo)}</td><td>${escapeHtml(row.transactionDate)}</td><td>${escapeHtml(row.createdByName)}</td><td>${escapeHtml(typeLabel(row.type))}</td><td>${escapeHtml(row.accountName)}</td><td>${escapeHtml(row.description)}</td><td>${statusHtml(row.status)}</td><td class="amount">${money(row.amount)}</td>${hasActions ? `<td><div class="actions">${canReceipt && row.receiptAvailable ? `<button class="btn btn-sm" data-receipt="${escapeHtml(row.transactionId)}">Bukti</button>` : ''}${canReceipt && row.underlyingAvailable ? `<button class="btn btn-sm" data-underlying="${escapeHtml(row.transactionId)}">Underlying</button>` : ''}${row.approvalId ? `<button class="btn btn-sm" data-approval-link="${escapeHtml(row.approvalId)}">Salin link approval</button>` : ''}</div></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

function bindReceiptButtons() {
  document.querySelectorAll('[data-receipt]').forEach(button => button.addEventListener('click', () => window.open(`/api/receipts/${encodeURIComponent(button.dataset.receipt)}`, '_blank', 'noopener')));
  document.querySelectorAll('[data-underlying]').forEach(button => button.addEventListener('click', () => window.open(`/api/underlying-documents/${encodeURIComponent(button.dataset.underlying)}`, '_blank', 'noopener')));
}

async function loadPublicConfig() {
  try {
    const config = await api('/api/public/config');
    state.config = { ...state.config, ...config };
    applyBranding(state.config);
  } catch (ignored) {}
}

function applyBranding(config = {}) {
  const appName = config.appName || 'Aplikasi Kas Kecil';
  const companyName = config.companyName || 'Nama Perusahaan';
  document.querySelectorAll('[data-brand-app]').forEach(element => { element.textContent = appName; });
  document.querySelectorAll('[data-brand-company]').forEach(element => { element.textContent = companyName; });
  document.title = appName;
  if (config.themeColor && /^#[0-9a-f]{6}$/i.test(config.themeColor)) {
    document.documentElement.style.setProperty('--blue', config.themeColor);
    document.documentElement.style.setProperty('--navy', shadeColor(config.themeColor, -58));
    document.documentElement.style.setProperty('--sky', shadeColor(config.themeColor, 88));
  }
  document.querySelectorAll('[data-brand-logo]').forEach(image => {
    const fallback = image.parentElement.querySelector('[data-brand-fallback]');
    if (!config.logoUrl) { image.classList.add('hidden'); if (fallback) fallback.classList.remove('hidden'); return; }
    image.onload = () => { image.classList.remove('hidden'); if (fallback) fallback.classList.add('hidden'); };
    image.onerror = () => { image.classList.add('hidden'); if (fallback) fallback.classList.remove('hidden'); };
    image.src = config.logoUrl;
  });
}

function shadeColor(hex, percent) {
  const value = String(hex).replace('#', '');
  const target = percent < 0 ? 0 : 255;
  const ratio = Math.abs(percent) / 100;
  const channels = [0, 2, 4].map(index => Math.round(parseInt(value.slice(index, index + 2), 16) + (target - parseInt(value.slice(index, index + 2), 16)) * ratio));
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function applySavedTheme() {
  let theme = '';
  try { theme = localStorage.getItem('ak_theme') || ''; } catch {}
  if (!['light', 'dark'].includes(theme)) theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  updateThemeButtons();
}

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('ak_theme', theme); } catch {}
  updateThemeButtons();
}

function updateThemeButtons() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.querySelectorAll('.theme-toggle').forEach(button => { button.textContent = dark ? 'Mode terang' : 'Mode gelap'; });
}

function closeMobileNavigation() { document.body.classList.remove('nav-open'); }

function parseMoney(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  const number = Number(digits || 0);
  return Number.isSafeInteger(number) ? number : 0;
}

function formatMoneyInput(value) {
  const number = parseMoney(value);
  return number ? new Intl.NumberFormat('id-ID').format(number) : '';
}

function receiptPicker(baseId, label, name = 'receipt') {
  const cameraId = `${baseId}-camera`;
  return `<div class="field receipt-picker"><label for="${escapeHtml(baseId)}">${escapeHtml(label)}</label><div class="receipt-actions"><input id="${escapeHtml(baseId)}" name="${escapeHtml(name)}" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" data-receipt-input data-pair="${escapeHtml(cameraId)}"><button class="btn btn-sm" type="button" data-camera-trigger="${escapeHtml(cameraId)}">Ambil dari kamera</button><input id="${escapeHtml(cameraId)}" name="${escapeHtml(name)}" class="visually-hidden" type="file" accept="image/*" capture="environment" data-receipt-input data-pair="${escapeHtml(baseId)}"></div><small id="${escapeHtml(baseId)}-selection" class="muted">Pilih file atau gunakan kamera perangkat.</small></div>`;
}

function bindReceiptPickers(root = document) {
  root.querySelectorAll('[data-camera-trigger]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.cameraTrigger)?.click()));
  root.querySelectorAll('[data-receipt-input]').forEach(input => input.addEventListener('change', () => {
    if (!input.files?.length) return;
    const pair = document.getElementById(input.dataset.pair);
    if (pair) pair.value = '';
    const baseId = input.id.endsWith('-camera') ? input.id.slice(0, -7) : input.id;
    const label = document.getElementById(`${baseId}-selection`);
    if (label) label.textContent = `Dipilih: ${input.files[0].name}`;
  }));
}

function selectedReceipt(baseId) {
  return document.getElementById(baseId)?.files?.[0] || document.getElementById(`${baseId}-camera`)?.files?.[0] || null;
}

function resetReceiptPicker(baseId) {
  const label = document.getElementById(`${baseId}-selection`);
  if (label) label.textContent = 'Pilih file atau gunakan kamera perangkat.';
}

async function copyText(value) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard tidak tersedia');
    await navigator.clipboard.writeText(value);
    toast('Tautan approval disalin.');
  } catch {
    openModal(`<h2>Tautan Approval</h2><p class="muted">Tautan ini hanya-baca. Tekan lama atau pilih teks untuk menyalin.</p><input class="readonly-link" readonly aria-readonly="true" value="${escapeHtml(value)}">`);
  }
}

async function copyApprovalLink(approvalId) {
  setLoading(true);
  try {
    const result = await api(`/api/approvals/${encodeURIComponent(approvalId)}/link`, { method: 'POST' });
    await copyText(result.approvalUrl);
  } catch (error) { toast(error.message, true); }
  finally { setLoading(false); }
}

function bindApprovalLinkButtons(root = document) {
  root.querySelectorAll('[data-approval-link]').forEach(button => button.addEventListener('click', () => copyApprovalLink(button.dataset.approvalLink)));
}

function statusHtml(status) { const value = String(status || '').toUpperCase(); return `<span class="status status-${value.toLowerCase()}">${escapeHtml(value)}</span>`; }
function roleLabel(role) { return ({ STAFF: 'Staff', SPV: 'Supervisor', SUPER_USER: 'Super User' })[role] || role; }
function typeLabel(type) { return ({ MASUK: 'Kas Masuk', KELUAR: 'Kas Keluar', BOTH: 'Kas Masuk & Keluar', PENYESUAIAN: 'Penyesuaian' })[type] || type; }
function sourceLabel(type) { return ({ TRANSACTION: 'Transaksi', TRANSFER: 'Transfer Kas', UMO_ISSUE: 'Pencairan UMO', UMO_RETURN: 'Pengembalian UMO', UMO_EXTRA: 'Tambahan UMO', CORRECTION_REVERSAL: 'Koreksi/Reversal' })[type] || type; }
function money(number) { return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(number || 0)); }
function formatBytes(number) { const bytes = Number(number || 0); if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function todayInput() { const d = new Date(); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); }
function monthLabel(value) { if (!/^\d{4}-\d{2}$/.test(String(value || ''))) return String(value || '-'); const [year, month] = String(value).split('-').map(Number); return new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1))); }
function datePlusDays(days) { const date = new Date(); date.setDate(date.getDate() + Number(days || 0)); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'); }
function formatDateTime(value) { return value ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : ''; }
function value(id) { return document.getElementById(id).value.trim(); }
function text(id, content) { document.getElementById(id).textContent = content || ''; }
function empty(message) { return `<div class="empty">${escapeHtml(message)}</div>`; }
function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }

function showLogin() { document.getElementById('public-approval-view').classList.add('hidden'); document.getElementById('login-view').classList.remove('hidden'); document.getElementById('app-view').classList.add('hidden'); }
function showApp() { document.getElementById('public-approval-view').classList.add('hidden'); document.getElementById('login-view').classList.add('hidden'); document.getElementById('app-view').classList.remove('hidden'); }
function showPublicApproval() { document.getElementById('public-approval-view').classList.remove('hidden'); document.getElementById('login-view').classList.add('hidden'); document.getElementById('app-view').classList.add('hidden'); }
function setLoading(active) { state.loadingCount = Math.max(0, state.loadingCount + (active ? 1 : -1)); document.getElementById('loading').classList.toggle('hidden', state.loadingCount === 0); }
let toastTimer;
function toast(message, error = false) { const element = document.getElementById('toast'); element.textContent = message || 'Terjadi kesalahan.'; element.classList.toggle('error', error); element.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.add('hidden'), 5000); }
function openModal(html) { document.getElementById('modal-body').innerHTML = html; document.getElementById('modal').classList.remove('hidden'); }
function closeModal() { document.getElementById('modal').classList.add('hidden'); document.getElementById('modal-body').innerHTML = ''; }
function downloadBlob(blob, fileName) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
