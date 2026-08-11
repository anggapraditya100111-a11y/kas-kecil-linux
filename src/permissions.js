const PERMISSION_CATALOG = Object.freeze([
  { code: 'dashboard.view', group: 'Dashboard', label: 'Melihat dashboard' },
  { code: 'dashboard.view_all_users', group: 'Dashboard', label: 'Melihat dashboard seluruh/per pengguna' },
  { code: 'transactions.create', group: 'Transaksi', label: 'Input transaksi' },
  { code: 'ledger.view_self', group: 'Buku Kas', label: 'Melihat transaksi sendiri' },
  { code: 'ledger.view_all', group: 'Buku Kas', label: 'Melihat seluruh transaksi' },
  { code: 'mutations.view_self', group: 'Mutasi Kas', label: 'Melihat mutasi dan saldo sendiri' },
  { code: 'mutations.view_all', group: 'Mutasi Kas', label: 'Melihat mutasi dan saldo seluruh pengguna' },
  { code: 'receipts.view_self', group: 'Bukti', label: 'Melihat bukti transaksi sendiri' },
  { code: 'receipts.view_all', group: 'Bukti', label: 'Melihat seluruh bukti transaksi' },
  { code: 'approvals.view', group: 'Approval', label: 'Melihat antrean approval' },
  { code: 'approvals.decide', group: 'Approval', label: 'Menyetujui atau menolak transaksi' },
  { code: 'reports.export_self', group: 'Laporan', label: 'Export transaksi sendiri' },
  { code: 'reports.export_all', group: 'Laporan', label: 'Export seluruh transaksi' },
  { code: 'account_summary.view', group: 'Laporan', label: 'Melihat rekap dana seluruh akun' },
  { code: 'account_summary.export', group: 'Laporan', label: 'Export rekap dana seluruh akun' },
  { code: 'accounts.view', group: 'Akun Kas', label: 'Melihat daftar akun dan limit' },
  { code: 'transfers.create', group: 'Transfer Kas', label: 'Mengajukan transfer kas antar-staff' },
  { code: 'transfers.view_self', group: 'Transfer Kas', label: 'Melihat transfer terkait diri sendiri' },
  { code: 'transfers.view_all', group: 'Transfer Kas', label: 'Melihat seluruh transfer kas' },
  { code: 'umo.create', group: 'Uang Muka Operasional', label: 'Membuat dan mempertanggungjawabkan UMO sendiri' },
  { code: 'umo.view_self', group: 'Uang Muka Operasional', label: 'Melihat UMO sendiri' },
  { code: 'umo.view_all', group: 'Uang Muka Operasional', label: 'Melihat seluruh UMO' },
  { code: 'corrections.create', group: 'Koreksi', label: 'Mengajukan koreksi transaksi sendiri' },
  { code: 'corrections.view_all', group: 'Koreksi', label: 'Melihat seluruh pengajuan koreksi' },
  { code: 'accounts.manage', group: 'Administrasi', label: 'Mengelola akun kas dan limit' },
  { code: 'users.manage', group: 'Administrasi', label: 'Mengelola pengguna' },
  { code: 'permissions.manage', group: 'Administrasi', label: 'Mengatur hak akses pengguna' },
  { code: 'audit.view', group: 'Administrasi', label: 'Melihat audit log' },
  { code: 'settings.manage', group: 'Administrasi', label: 'Mengelola pengaturan aplikasi' },
  { code: 'database.manage', group: 'Administrasi', label: 'Reset dan backup database (khusus Super User)' }
]);

const ROLE_DEFAULTS = Object.freeze({
  STAFF: [
    'dashboard.view',
    'transactions.create',
    'ledger.view_self',
    'mutations.view_self',
    'receipts.view_self',
    'reports.export_self',
    'accounts.view',
    'transfers.create',
    'transfers.view_self',
    'umo.create',
    'umo.view_self',
    'corrections.create'
  ],
  SPV: [
    'dashboard.view',
    'dashboard.view_all_users',
    'ledger.view_all',
    'mutations.view_all',
    'receipts.view_all',
    'approvals.view',
    'approvals.decide',
    'reports.export_all',
    'account_summary.view',
    'account_summary.export',
    'accounts.view',
    'transfers.view_all',
    'umo.view_all',
    'corrections.view_all'
  ],
  SUPER_USER: PERMISSION_CATALOG.map(item => item.code)
});

function roleDefaults(role) {
  return new Set(ROLE_DEFAULTS[String(role || '').toUpperCase()] || []);
}

function effectivePermissions(role, overrides = []) {
  const permissions = roleDefaults(role);
  for (const override of overrides) {
    if (Number(override.allowed) === 1) permissions.add(override.permission_code);
    if (Number(override.allowed) === 0) permissions.delete(override.permission_code);
  }
  if (String(role).toUpperCase() === 'SUPER_USER') {
    return new Set(PERMISSION_CATALOG.map(item => item.code));
  }
  permissions.delete('database.manage');
  return permissions;
}

module.exports = { PERMISSION_CATALOG, ROLE_DEFAULTS, roleDefaults, effectivePermissions };
