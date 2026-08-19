# Aplikasi Kas Kecil untuk Linux

Aplikasi kas kecil berbasis web yang dapat dijalankan mandiri pada server Linux menggunakan Docker. Database SQLite, bukti transaksi, dan backup tersimpan di server Anda sendiri.

## Perbaikan versi 1.5.5

- Tombol **Koreksi** dan **Hapus** ditambahkan pada kolom Aksi di menu Uang Muka Operasional.
- UMO berstatus `PENDING` atau `OPEN` dapat dikoreksi oleh Super User; perubahan nominal otomatis menyesuaikan mutasi pencairan dan saldo.
- UMO berstatus `PENDING`, `OPEN`, atau `REJECTED` yang belum memiliki realisasi dapat dihapus permanen setelah backup otomatis, verifikasi password, alasan, dan konfirmasi.
- UMO yang sudah direalisasikan tidak dapat dihapus; transaksi hasil realisasinya diarahkan ke mekanisme koreksi/reversal yang sudah memiliki approval dan audit trail.
- Periode yang sudah ditutup tetap dilindungi dari koreksi dan penghapusan UMO.

## Perbaikan versi 1.5.4

- Tombol **Edit** tersedia pada kolom Aksi di menu Super User → Akun Kas untuk mengubah kode, nama, cakupan, limit auto-approval, kewajiban bukti, dan underlying document.
- Daftar akun aktif maupun nonaktif dapat diekspor ke Excel, termasuk status dan jumlah referensi transaksi/pembukuan; aktivitas ekspor tercatat di audit log.

## Perbaikan versi 1.5.3

- Akun kas yang belum pernah digunakan dapat dihapus dari kolom Aksi.
- Akun yang sudah memiliki riwayat transaksi, pembukuan, UMO, koreksi, atau pagu hanya dapat dinonaktifkan.

## Perbaikan versi 1.5.2

- Tautan approval tidak memiliki masa kedaluwarsa; keputusan tetap memerlukan PIN approver dan hanya dapat dilakukan selama pengajuan berstatus menunggu.
- Pengaturan durasi token approval dihapus karena tidak lagi digunakan.

## Perbaikan versi 1.5.1

- Restore `.kkbackup` mendukung volume database dan upload yang terpasang terpisah di Docker.
- Lampiran dipulihkan melalui area swap di dalam volume upload, tanpa memindahkan folder mount dan dengan rollback otomatis jika proses gagal.

## Fitur utama

- Pencatatan kas masuk dan kas keluar dengan bukti transaksi.
- Approval melalui tautan publik tanpa masa kedaluwarsa dan PIN approver 8 digit tanpa login.
- Hak akses granular untuk Staff, SPV, dan Super User.
- Mutasi kas per pengguna seperti rekening koran.
- Rekap total dana seluruh akun dengan filter tanggal/akun dan export Excel/PDF.
- Perbandingan dana per akun antara dua bulan dengan cakupan data sesuai role.
- Pagu kas per bulan, pembagian persentase per akun, periode terkunci, dan End of Month.
- Underlying document gambar/PDF yang dapat diwajibkan untuk akun pengeluaran tertentu.
- Transfer kas antar-staff dengan approval.
- Uang Muka Operasional (UMO) dan PDF tanda terima.
- Koreksi transaksi dengan reversal agar jejak audit tetap utuh.
- Branding, warna tema, dark mode, dan tampilan desktop/mobile.
- Export Excel/PDF, backup otomatis/manual, dan riwayat backup.
- Reset data transaksi khusus Super User dengan backup historis otomatis sebelum penghapusan.
- Export dan restore data lengkap terenkripsi (`.kkbackup`) untuk pemindahan server, termasuk database dan seluruh lampiran.

## Persyaratan

- Server Linux 64-bit.
- Git.
- Docker Engine dan plugin Docker Compose.
- Port `8090` atau port lain yang Anda tentukan di `.env`.

## Instalasi

```bash
sudo mkdir -p /opt/kas-kecil
sudo git clone https://github.com/anggapraditya100111-a11y/kas-kecil-linux.git /opt/kas-kecil
cd /opt/kas-kecil
sudo chmod +x install.sh update.sh
sudo ./install.sh
```

Installer membuat secret aplikasi dan password Administrator secara acak. Simpan password yang tampil di terminal, lalu buka:

```text
http://IP-SERVER:8090
```

Setelah login pertama, ubah password Administrator, isi nama/logo perusahaan dari menu **Pengaturan**, lalu buat akun kas, pengguna, hak akses, dan PIN approval.

## Memperbarui aplikasi

```bash
cd /opt/kas-kecil
sudo ./update.sh
```

Script pembaruan membuat backup database, mengambil perubahan terbaru dengan fast-forward, membangun image baru, dan memeriksa versi aplikasi.

## Lokasi data

Secara bawaan data persisten berada di:

- Database: `/var/lib/kas-kecil/database`
- Bukti transaksi: `/var/lib/kas-kecil/uploads`
- Backup: `/var/lib/kas-kecil/backups`

Lokasi ini dapat diubah melalui `DATA_ROOT` pada `.env`. Jangan menghapus `.env` atau folder data ketika melakukan pembaruan. Backup harian otomatis menyimpan 30 versi terakhir; backup manual dan backup sebelum reset tidak masuk rotasi tersebut.

Menu **Pemeliharaan Data** hanya tersedia bagi Super User. Reset memerlukan password aktif dan konfirmasi khusus, lalu menghapus data operasional setelah backup berhasil. Pengguna, akun, hak akses, pengaturan, logo, dan file bukti tetap dipertahankan.

Untuk migrasi server, buat **Export Data Lengkap**, instal aplikasi pada server tujuan, lalu lakukan restore menggunakan password backup. Konfigurasi keamanan yang diperlukan untuk password, PIN, dan tautan approval ikut dipulihkan dari paket terenkripsi.

## Domain dan HTTPS

Pasang reverse proxy yang mengarah ke `http://IP-SERVER:8090`, aktifkan HTTPS, kemudian ubah konfigurasi berikut pada `.env`:

```env
TRUST_PROXY=true
COOKIE_SECURE=true
```

Terapkan perubahan dengan `docker compose up -d`. Tautan approval harus menggunakan domain/IP yang dapat dijangkau perangkat approver. Jangan membuka aplikasi ke internet tanpa HTTPS, firewall, dan pembatasan akses yang sesuai.

## Perintah pemeliharaan

```bash
docker compose ps
docker compose logs -f kas-kecil
docker compose restart kas-kecil
curl http://127.0.0.1:8090/api/health
```

## Pengembangan

```bash
npm ci
npm run verify
```

## Lisensi

Proyek ini tersedia dengan [Lisensi MIT](LICENSE).
