import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-kecil-restore-v15-'));
const port = '18091';
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: port,
  DATA_DIR: path.join(runtime, 'data'),
  UPLOAD_DIR: path.join(runtime, 'uploads'),
  BACKUP_DIR: path.join(runtime, 'backups'),
  APP_PEPPER: 'restore-integration-secret-v15-1234567890',
  INITIAL_ADMIN_PASSWORD: 'Admin12345',
  NODE_ENV: 'test'
};

function startServer() {
  return spawn(process.execPath, ['src/server.js'], { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Restore test server did not become healthy');
}

async function login() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin12345' })
  });
  assert.equal(response.status, 200, await response.text());
  return response.headers.get('set-cookie').split(';')[0];
}

async function jsonRequest(route, cookie, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.status, method === 'POST' && route === '/api/admin/users' ? 201 : 200, payload.error);
  return payload;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
}

let child = startServer();
try {
  await waitForHealth();
  let cookie = await login();
  await jsonRequest('/api/admin/users', cookie, 'POST', { name: 'Pengguna Dipulihkan', username: 'restored.user', password: 'Restore12345', role: 'STAFF' });

  const exported = await fetch(`${baseUrl}/api/admin/full-backup/export`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'Admin12345', backupPassword: 'BackupRestore123' })
  });
  assert.equal(exported.status, 200);
  const backup = Buffer.from(await exported.arrayBuffer());
  assert(backup.toString('utf8', 0, 10).startsWith('KKBACKUP1'));

  await jsonRequest('/api/admin/users', cookie, 'POST', { name: 'Pengguna Sementara', username: 'temporary.user', password: 'Temporary12345', role: 'STAFF' });
  const form = new FormData();
  form.set('backupFile', new Blob([backup], { type: 'application/octet-stream' }), 'restore-test.kkbackup');
  form.set('currentPassword', 'Admin12345');
  form.set('backupPassword', 'BackupRestore123');
  form.set('confirmation', 'PULIHKAN SELURUH DATA');
  const restored = await fetch(`${baseUrl}/api/admin/full-backup/restore`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  const restoredPayload = await restored.json();
  assert.equal(restored.status, 200, restoredPayload.error);
  assert.equal(restoredPayload.restarting, true);
  await new Promise(resolve => child.once('exit', resolve));

  env.APP_PEPPER = 'different-destination-pepper-v15-1234567890';
  child = startServer();
  await waitForHealth();
  cookie = await login();
  const users = await jsonRequest('/api/admin/users', cookie);
  assert(users.users.some(user => user.username === 'restored.user'));
  assert(!users.users.some(user => user.username === 'temporary.user'));
  assert(fs.readdirSync(env.BACKUP_DIR).some(name => /^kas-kecil-full-before-restore-.*\.kkbackup$/.test(name)));
  console.log(JSON.stringify({ checks: 'passed', fullRestoreRoundTrip: true }, null, 2));
} finally {
  await stopServer(child);
  fs.rmSync(runtime, { recursive: true, force: true });
}
