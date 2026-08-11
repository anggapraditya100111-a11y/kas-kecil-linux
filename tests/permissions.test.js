const test = require('node:test');
const assert = require('node:assert/strict');
const { effectivePermissions } = require('../src/permissions');
const { hashPassword, verifyPassword, hashApprovalPin, verifyApprovalPin, encryptSecret, decryptSecret } = require('../src/security');

test('SPV default dapat dashboard seluruh user dan approval, tanpa input transaksi', () => {
  const permissions = effectivePermissions('SPV');
  assert.equal(permissions.has('dashboard.view_all_users'), true);
  assert.equal(permissions.has('approvals.decide'), true);
  assert.equal(permissions.has('transactions.create'), false);
  assert.equal(permissions.has('mutations.view_all'), true);
  assert.equal(permissions.has('transfers.view_all'), true);
  assert.equal(permissions.has('umo.view_all'), true);
});

test('Staff default hanya melihat data sendiri dan dapat input', () => {
  const permissions = effectivePermissions('STAFF');
  assert.equal(permissions.has('transactions.create'), true);
  assert.equal(permissions.has('ledger.view_self'), true);
  assert.equal(permissions.has('ledger.view_all'), false);
  assert.equal(permissions.has('accounts.view'), true);
  assert.equal(permissions.has('transfers.create'), true);
  assert.equal(permissions.has('umo.create'), true);
  assert.equal(permissions.has('corrections.create'), true);
});

test('override pengguna mengalahkan default role', () => {
  const permissions = effectivePermissions('SPV', [
    { permission_code: 'transactions.create', allowed: 1 },
    { permission_code: 'approvals.decide', allowed: 0 }
  ]);
  assert.equal(permissions.has('transactions.create'), true);
  assert.equal(permissions.has('approvals.decide'), false);
});

test('Super User tidak dapat kehilangan akses akibat override', () => {
  const permissions = effectivePermissions('SUPER_USER', [
    { permission_code: 'users.manage', allowed: 0 },
    { permission_code: 'permissions.manage', allowed: 0 }
  ]);
  assert.equal(permissions.has('users.manage'), true);
  assert.equal(permissions.has('permissions.manage'), true);
});

test('password hash memakai salt dan dapat diverifikasi', () => {
  const password = 'Password123';
  const first = hashPassword(password);
  const second = hashPassword(password);
  assert.notEqual(first.hash, second.hash);
  assert.equal(verifyPassword(password, first.salt, first.hash), true);
  assert.equal(verifyPassword('Password124', first.salt, first.hash), false);
});

test('PIN approval harus 8 digit, di-hash, dan dapat diverifikasi', () => {
  const first = hashApprovalPin('12345678');
  const second = hashApprovalPin('12345678');
  assert.notEqual(first.hash, second.hash);
  assert.equal(verifyApprovalPin('12345678', first.salt, first.hash), true);
  assert.equal(verifyApprovalPin('12345679', first.salt, first.hash), false);
  assert.throws(() => hashApprovalPin('1234'));
});

test('token approval dapat disimpan terenkripsi dan dipulihkan', () => {
  const token = 'approval-token-rahasia';
  const encrypted = encryptSecret(token);
  assert.notEqual(encrypted, token);
  assert.equal(decryptSecret(encrypted), token);
  assert.throws(() => decryptSecret(`${encrypted}rusak`));
});
