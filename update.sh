#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Jalankan updater sebagai root: sudo ./update.sh"
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Docker Engine dan plugin Docker Compose wajib tersedia."
  exit 1
fi
if [ ! -d .git ]; then
  echo "Folder ini bukan clone GitHub. Clone repository private ke /opt/ainet-kas-kecil."
  exit 1
fi
if [ ! -f .env ]; then
  echo "File .env tidak ditemukan. Jalankan install.sh terlebih dahulu."
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Ada perubahan source lokal. Commit atau simpan perubahan tersebut sebelum update."
  exit 1
fi

echo "Membuat backup database sebelum update..."
docker compose exec -T kas-kecil node -e "require('./src/db').backupDatabase().then(p=>console.log('Backup:',p)).catch(e=>{console.error(e);process.exit(1)})"

git fetch origin main
git switch main
git pull --ff-only origin main

data_root="$(sed -n 's/^DATA_ROOT=//p' .env | tail -n 1)"
data_root="${data_root:-/srv/storage/axindo-kas-kecil}"
case "$data_root" in
  ""|"/"|"/srv"|"/srv/storage"|"/opt"|"/var"|"/var/lib")
    echo "DATA_ROOT tidak aman: '$data_root'."
    exit 1
    ;;
esac
install -d -m 0750 -o 1000 -g 1000 \
  "$data_root/database" "$data_root/uploads" "$data_root/backups"
docker network inspect ainet-finance >/dev/null 2>&1 || docker network create ainet-finance >/dev/null

docker compose config --quiet
docker compose up -d --build --force-recreate

app_port="$(sed -n 's/^APP_PORT=//p' .env | tail -n 1)"
app_port="${app_port:-8090}"
ready=false
for _attempt in $(seq 1 30); do
  if health="$(curl --fail --silent "http://127.0.0.1:$app_port/api/health")"; then
    ready=true
    echo "Update selesai: $health"
    break
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  echo "Versi baru belum sehat. Periksa log dan gunakan commit sebelumnya untuk rollback."
  exit 1
fi
