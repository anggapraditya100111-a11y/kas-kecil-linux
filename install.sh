#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Jalankan installer sebagai root: sudo ./install.sh"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker tidak ditemukan. Instal Docker Engine dan plugin Docker Compose terlebih dahulu."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Plugin Docker Compose tidak ditemukan. Instal docker-compose-plugin terlebih dahulu."
  exit 1
fi

created_env=false
if [ ! -f .env ]; then
  if command -v openssl >/dev/null 2>&1; then
    app_pepper="$(openssl rand -hex 48)"
    admin_password="Admin-$(openssl rand -hex 6)A1"
  else
    app_pepper="$(od -An -N48 -tx1 /dev/urandom | tr -d ' \n')"
    admin_password="Admin-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')A1"
  fi
  cp .env.example .env
  sed -i "s/GANTI_DENGAN_RANDOM_SECRET_MINIMAL_64_KARAKTER/$app_pepper/" .env
  sed -i "s/GantiPasswordAdmin123/$admin_password/" .env
  chmod 600 .env
  created_env=true
fi

data_root="$(sed -n 's/^DATA_ROOT=//p' .env | tail -n 1)"
data_root="${data_root:-/var/lib/kas-kecil}"
case "$data_root" in
  ""|"/")
    echo "DATA_ROOT tidak aman: '$data_root'. Gunakan folder khusus seperti /var/lib/kas-kecil."
    exit 1
    ;;
esac

mkdir -p "$data_root/database" "$data_root/uploads" "$data_root/backups"
chown -R 1000:1000 "$data_root/database" "$data_root/uploads" "$data_root/backups"

docker compose up -d --build

app_port="$(sed -n 's/^APP_PORT=//p' .env | tail -n 1)"
app_port="${app_port:-8090}"
if [ "$created_env" = true ]; then
  echo ""
  echo "Kredensial awal:"
  echo "Username: admin"
  echo "Password: $admin_password"
  echo "Simpan password ini dan ubah setelah login pertama."
fi
echo ""
echo "Aplikasi aktif di http://IP-SERVER:$app_port"
echo "Status: docker compose ps"
echo "Log: docker compose logs -f kas-kecil"
