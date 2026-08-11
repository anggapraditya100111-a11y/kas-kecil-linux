const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const html = fs.readFileSync('public/index.html', 'utf8');
const client = fs.readFileSync('public/app.js', 'utf8');
const styles = fs.readFileSync('public/styles.css', 'utf8');
const compose = fs.readFileSync('docker-compose.yml', 'utf8');
const server = fs.readFileSync('src/server.js', 'utf8');
const isPrivateSource = fs.existsSync('docker-compose.public.yml');
const publicCompose = fs.readFileSync(isPrivateSource ? 'docker-compose.public.yml' : 'docker-compose.yml', 'utf8');
const publicEnv = fs.readFileSync(isPrivateSource ? '.env.public.example' : '.env.example', 'utf8');
const publicReadme = fs.readFileSync(isPrivateSource ? 'README_PUBLIC.md' : 'README.md', 'utf8');
const syncWorkflow = isPrivateSource ? fs.readFileSync('.github/workflows/sync-public.yml', 'utf8') : '';
const publicTreeScript = isPrivateSource ? fs.readFileSync('scripts/build-public-tree.sh', 'utf8') : '';

test('client JavaScript dapat diparse', () => {
  assert.doesNotThrow(() => new Function(client));
});

test('elemen shell utama dan approval publik tersedia', () => {
  for (const id of ['public-approval-view', 'public-approval-page', 'login-view', 'login-form', 'app-view', 'navigation', 'page', 'loading', 'toast']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('tidak menggunakan inline event handler agar sesuai CSP', () => {
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test('menu Hak Akses dan dashboard per user terhubung', () => {
  assert.match(client, /permissions\.manage/);
  assert.match(client, /data\.canViewAll/);
  assert.match(client, /Hak Akses/);
  assert.match(client, /Ringkasan per pengguna/);
});

test('workflow keuangan v1.1 terhubung di client', () => {
  for (const feature of ['Mutasi Kas', 'Daftar Akun', 'Transfer Kas', 'Uang Muka Operasional', 'Koreksi Transaksi', 'PIN approval']) {
    assert.match(client, new RegExp(feature));
  }
  assert.match(client, /api\/public\/approvals/);
  assert.match(client, /api\/mutations/);
});

test('compose memasang semua persistent volume dan healthcheck', () => {
  if (isPrivateSource) {
    for (const persistentPath of ['/DATA/AppData/kas-kecil/database', '/DATA/AppData/kas-kecil/uploads', '/DATA/AppData/kas-kecil/backups']) {
      assert.match(compose, new RegExp(persistentPath.replaceAll('/', '\\/')));
    }
  } else {
    assert.match(compose, /\$\{DATA_ROOT:-\/var\/lib\/kas-kecil\}\/database/);
    assert.match(compose, /\$\{DATA_ROOT:-\/var\/lib\/kas-kecil\}\/uploads/);
    assert.match(compose, /\$\{DATA_ROOT:-\/var\/lib\/kas-kecil\}\/backups/);
  }
  assert.match(compose, /healthcheck:/);
  assert.match(compose, /restart: unless-stopped/);
});

test('blokir 15 menit dihapus dan kegagalan dibatasi singkat', () => {
  assert.doesNotMatch(server, /15 menit/);
  assert.match(server, /windowMs: 60 \* 1000/);
  assert.match(server, /limit: 10/);
  assert.match(server, /skipSuccessfulRequests: true/);
});

test('nomor dokumen diselaraskan dengan nomor yang sudah tersimpan', () => {
  assert.match(server, /existingSequence/);
  assert.match(server, /Math\.max\(storedSequence, existingSequence\) \+ 1/);
  assert.match(server, /WHERE \$\{column\} LIKE/);
});

test('input nominal Rupiah memakai pemisah ribuan tanpa desimal', () => {
  assert.match(client, /class="money-input"/);
  assert.match(client, /Intl\.NumberFormat\('id-ID'\)/);
  assert.match(client, /function parseMoney/);
  assert.match(server, /raw\.replace\(\/\\D\/g, ''\)/);
});

test('branding, warna tema, dark mode, dan navigasi mobile tersedia', () => {
  assert.match(html, /data-brand-logo/);
  assert.match(html, /class="[^"]*theme-toggle/);
  assert.match(html, /id="menu-toggle"/);
  assert.match(client, /api\/public\/config/);
  assert.match(client, /api\/admin\/settings\/logo/);
  assert.match(client, /THEME_COLOR/);
  assert.match(client, /prefers-color-scheme: dark/);
  assert.match(styles, /html\[data-theme="dark"\]/);
  assert.match(styles, /@media \(max-width:900px\)/);
  assert.match(styles, /body\.nav-open \.sidebar/);
  assert.match(client, /nav-group-toggle/);
  assert.match(html, /Create By Apraditya/);
  assert.match(html, /id="sidebar-version"/);
});

test('bukti dapat dipilih dari kamera perangkat', () => {
  assert.match(client, /capture="environment"/);
  assert.match(client, /Ambil dari kamera/);
  assert.match(client, /selectedReceipt/);
});

test('tautan approval hanya-baca tersedia lintas menu', () => {
  assert.match(client, /readonly aria-readonly="true"/);
  assert.match(client, /data-approval-link/);
  assert.match(server, /api\/approvals\/:approvalId\/link/);
  assert.match(server, /token_ciphertext/);
});

test('UMO menyediakan PDF tanda terima pencairan', () => {
  assert.match(client, /PDF tanda terima/);
  assert.match(server, /disbursement-receipt\.pdf/);
  assert.match(server, /TANDA TERIMA UANG MUKA OPERASIONAL/);
});

test('rekap dana per akun menyediakan filter dan export', () => {
  assert.match(client, /Rekap Dana per Akun/);
  assert.match(client, /account-summary-start/);
  assert.match(client, /reports\/account-summary/);
  assert.match(server, /queryAccountSummary/);
  assert.match(server, /account_summary\.export/);
  assert.match(server, /t\.status='APPROVED'/);
});

test('fitur periode, pagu, perbandingan, dan underlying document terhubung', () => {
  for (const feature of ['Pagu Kas', 'Perbandingan Dana per Akun', 'Underlying document', 'End of Month']) assert.match(client, new RegExp(feature));
  assert.match(server, /api\/budgets\/current/);
  assert.match(server, /api\/periods\/eom/);
  assert.match(server, /api\/account-comparison/);
  assert.match(server, /underlying_required/);
  assert.match(server, /assertOpenTransactionDate/);
});

test('backup lengkap terenkripsi mendukung export dan restore', () => {
  assert.match(client, /\.kkbackup/);
  assert.match(client, /PULIHKAN SELURUH DATA/);
  assert.match(server, /aes-256-gcm/);
  assert.match(server, /api\/admin\/full-backup\/export/);
  assert.match(server, /api\/admin\/full-backup\/restore/);
  assert.match(server, /BACKUP_BEFORE_RESTORE/);
  assert.match(server, /installRestoredAppPepper/);
});

test('reset database dilindungi dan selalu membuat backup historical', () => {
  assert.match(client, /HAPUS DATA TRANSAKSI/);
  assert.match(client, /api\/admin\/database\/clear/);
  assert.match(server, /requireSuperUser/);
  assert.match(server, /verifyPassword/);
  assert.match(server, /backupDatabase\('before-clear'\)/);
  assert.match(server, /CLEAR_DATABASE/);
});

test('aset frontend domain tidak tertahan cache versi lama', () => {
  assert.match(html, /styles\.css\?v=1\.5\.0/);
  assert.match(html, /app\.js\?v=1\.5\.0/);
  assert.match(server, /cacheControl: false/);
  assert.match(server, /isShell \? 'no-store' : 'no-cache, must-revalidate'/);
  assert.doesNotMatch(server, /maxAge: process\.env\.NODE_ENV === 'production' \? '1h'/);
});

test('paket Linux publik memakai branding dan lokasi data generik', () => {
  assert.match(publicCompose, /name: kas-kecil/);
  assert.match(publicCompose, /\$\{DATA_ROOT:-\/var\/lib\/kas-kecil\}/);
  assert.match(publicCompose, /DEFAULT_COMPANY_NAME:-Nama Perusahaan/);
  assert.match(publicEnv, /DATA_ROOT=\/var\/lib\/kas-kecil/);
  assert.match(publicEnv, /DEFAULT_COMPANY_NAME=Nama Perusahaan/);
  assert.doesNotMatch(publicCompose + publicEnv + publicReadme, /PT Axindo|AINET/);
  assert.match(publicReadme, /sudo \.\/install\.sh/);
  assert.equal(fs.existsSync('LICENSE'), true);
});

test('sinkronisasi publik memakai token dan allowlist file', { skip: !isPrivateSource }, () => {
  assert.match(syncWorkflow, /PUBLIC_REPO_TOKEN/);
  assert.match(syncWorkflow, /anggapraditya100111-a11y\/kas-kecil-linux/);
  assert.match(syncWorkflow, /build-public-tree\.sh/);
  assert.match(publicTreeScript, /README_PUBLIC\.md/);
  assert.match(publicTreeScript, /docker-compose\.public\.yml/);
  assert.match(publicTreeScript, /! -name \.git ! -name \.github/);
});

test('builder menghasilkan tree publik tanpa file khusus private', { skip: !isPrivateSource }, () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kas-kecil-public-'));
  fs.mkdirSync(path.join(target, '.git'));
  fs.mkdirSync(path.join(target, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(target, '.github', 'workflows', 'test.yml'), 'name: Public Test\n');
  fs.writeFileSync(path.join(target, 'private-only.txt'), 'hapus');

  const result = spawnSync('bash', ['scripts/build-public-tree.sh', target], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const item of ['README.md', '.env.example', 'docker-compose.yml', 'install.sh', 'update.sh', 'src', 'public', 'tests', 'LICENSE']) {
    assert.equal(fs.existsSync(path.join(target, item)), true, `${item} tidak tersalin`);
  }
  for (const item of ['README_PUBLIC.md', '.env.public.example', 'docker-compose.public.yml', 'install-linux.sh', 'private-only.txt']) {
    assert.equal(fs.existsSync(path.join(target, item)), false, `${item} seharusnya tidak ada`);
  }
  assert.equal(fs.existsSync(path.join(target, '.github', 'workflows', 'test.yml')), true);
  fs.rmSync(target, { recursive: true, force: true });
});
