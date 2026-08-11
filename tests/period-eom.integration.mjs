import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-kecil-eom-v15-'));
const port = '18092';
const baseUrl = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: port, DATA_DIR: path.join(runtime, 'data'), UPLOAD_DIR: path.join(runtime, 'uploads'),
  BACKUP_DIR: path.join(runtime, 'backups'), APP_PEPPER: 'eom-integration-secret-v15-1234567890',
  INITIAL_ADMIN_PASSWORD: 'Admin12345', NODE_ENV: 'test' };
const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('EOM test server did not become healthy');
}

async function request(route, cookie, body) {
  const response = await fetch(`${baseUrl}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  assert.equal(response.status, 200, payload.error);
  return payload;
}

try {
  await waitForHealth();
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin12345' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const current = new Date();
  const currentMonth = `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, '0')}`;
  const previous = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
  const previousMonth = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;

  const database = new DatabaseSync(path.join(env.DATA_DIR, 'kas-kecil.sqlite'));
  database.prepare("UPDATE accounting_periods SET period_month=? WHERE status='OPEN'").run(previousMonth);
  database.close();

  const eom = await request('/api/periods/eom', cookie, { note: 'Tes penutupan bulanan' });
  assert.equal(eom.closedPeriodMonth, previousMonth);
  assert.equal(eom.openPeriodMonth, currentMonth);
  const reopened = await request(`/api/periods/${previousMonth}/reopen`, cookie, { currentPassword: 'Admin12345', reason: 'Tes koreksi EOM' });
  assert.equal(reopened.openPeriodMonth, previousMonth);
  assert.match(reopened.backupFileName, /^kas-kecil-before-clear-.*\.sqlite$/);
  const budget = await request('/api/budgets/current', cookie);
  assert.equal(budget.openPeriodMonth, previousMonth);
  console.log(JSON.stringify({ checks: 'passed', eom: true, reopenWithBackup: true }, null, 2));
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  fs.rmSync(runtime, { recursive: true, force: true });
}
