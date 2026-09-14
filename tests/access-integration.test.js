const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-kecil-access-'));
process.env.DATA_DIR = path.join(runtime, 'data');
process.env.BACKUP_DIR = path.join(runtime, 'backups');
process.env.APP_PEPPER = 'access-test-pepper-1234567890';
process.env.INITIAL_ADMIN_PASSWORD = 'AdminAccess123';
process.env.ACCESS_HANDOFF_ENABLED = 'true';
process.env.PUBLIC_APP_URL = 'https://kaskecil.axindo.my.id';
process.env.ACCESS_PORTAL_URL = 'https://akses.axindo.my.id';
process.env.ACCESS_PORTAL_INTERNAL_URL = 'http://host.docker.internal:8096';

const access = require('../src/access');
const { db, upsertAccessUser } = require('../src/db');
const { hashPassword } = require('../src/security');

test.after(() => fs.rmSync(runtime, { recursive: true, force: true }));

test('manifest Kas Kecil memakai slug, URL, dan grup AXINDO yang stabil', () => {
  const manifest = access.manifest();
  assert.equal(manifest.id, 'kas-kecil');
  assert.equal(manifest.url, 'https://kaskecil.axindo.my.id');
  assert.deepEqual(manifest.roles.map(item => item.group), [
    'AXINDO - KAS KECIL - SUPER USER',
    'AXINDO - KAS KECIL - SPV',
    'AXINDO - KAS KECIL - STAFF'
  ]);
  assert.equal(access.roleForGroups(['AXINDO - KAS KECIL - SPV']), 'SPV');
});

test('handoff menukar code secara backend dengan audience Kas Kecil', async () => {
  let request;
  const result = await access.exchangeHandoff('A'.repeat(40), 'v'.repeat(43), async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      audience: 'kas-kecil',
      identity: { subject: 'authentik|staff-1', email: 'staff@axindo.my.id', username: 'staff', name: 'Staff AXINDO' },
      groups: ['AXINDO - KAS KECIL - STAFF']
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(request.url, 'http://host.docker.internal:8096/api/auth/handoff/exchange');
  assert.equal(request.options.headers['x-axindo-handoff'], '1');
  assert.equal(JSON.parse(request.options.body).audience, 'kas-kecil');
  assert.equal(result.role, 'STAFF');
});

test('AXINDO ID menautkan pengguna lama tanpa mengganti ID dan riwayat', () => {
  const password = hashPassword('LegacyStaff123');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users(id,name,username,email,password_hash,password_salt,role,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,1,?,?)`).run('USR-LEGACY', 'Staff Lama', 'staff.lama', 'staff@axindo.my.id', password.hash, password.salt, 'STAFF', now, now);
  const linked = upsertAccessUser({
    subject: 'authentik|staff-lama', email: 'staff@axindo.my.id', username: 'staff.lama', name: 'Staff Baru'
  }, ['AXINDO - KAS KECIL - SPV'], 'SPV');
  assert.equal(linked.userId, 'USR-LEGACY');
  assert.equal(linked.authSource, 'ACCESS');
  assert.equal(linked.role, 'SPV');
  assert.equal(linked.canChangePassword, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE action='LINK_ACCESS_ID'").get().total, 1);
});

test('AXINDO ID baru dibuat sebagai pengguna ACCESS dan login lokal dibatasi', () => {
  const created = upsertAccessUser({
    subject: 'authentik|new-staff', email: 'new.staff@axindo.my.id', username: 'new.staff', name: 'Staff Baru'
  }, ['AXINDO - KAS KECIL - STAFF'], 'STAFF');
  assert.equal(created.authSource, 'ACCESS');
  assert.equal(created.role, 'STAFF');
  assert.equal(access.allowLocalUser(db.prepare("SELECT * FROM users WHERE username='new.staff'").get()), false);
  assert.equal(access.allowLocalUser(db.prepare("SELECT * FROM users WHERE role='SUPER_USER'").get()), true);
});
