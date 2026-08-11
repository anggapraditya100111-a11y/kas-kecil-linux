#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker tidak ditemukan. Pastikan Docker dan Docker Compose aktif."
  exit 1
fi

if [ ! -d .git ]; then
  echo "Folder ini bukan hasil clone GitHub. Unduh rilis terbaru lalu salin source tanpa menimpa .env."
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Ada perubahan source lokal. Commit atau simpan perubahan tersebut sebelum update."
  exit 1
fi

echo "Membuat backup database sebelum update..."
docker compose exec -T kas-kecil node -e "require('./src/db').backupDatabase().then(p=>console.log('Backup:',p)).catch(e=>{console.error(e);process.exit(1)})"

current_branch="$(git branch --show-current)"
if [ -z "$current_branch" ]; then
  echo "Branch Git tidak terdeteksi. Pindah ke branch main terlebih dahulu."
  exit 1
fi

git fetch origin "$current_branch"
git pull --ff-only origin "$current_branch"
docker compose up -d --build --force-recreate

app_port="$(sed -n 's/^APP_PORT=//p' .env 2>/dev/null | tail -n 1)"
app_port="${app_port:-8090}"
echo "Update selesai. Aplikasi aktif di http://IP-SERVER:$app_port"
echo "Versi aktif:"
curl --fail --silent "http://127.0.0.1:$app_port/api/health" || true
echo
