#!/usr/bin/env bash
# moa worker 부팅 스크립트 — GCP e2-micro VM (Debian 12) 에서 1회 실행.
# 전제: ssh 접속한 셸에 아래 env 가 export 되어 있어야 함.
set -euo pipefail

require_env() {
  for v in "$@"; do
    if [[ -z "${!v:-}" ]]; then echo "ENV ${v} not set" >&2; exit 1; fi
  done
}
require_env TURSO_DATABASE_URL TURSO_AUTH_TOKEN \
  UPBIT_ACCESS_KEY UPBIT_SECRET_KEY \
  BITHUMB_ACCESS_KEY BITHUMB_SECRET_KEY \
  WORKER_SHARED_SECRET

# 1. Node 24 + Caddy 설치
sudo apt-get update -y
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs ca-certificates curl gnupg
# Caddy 공식 repo
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update -y
sudo apt-get install -y caddy

# 2. external IP → sslip.io 도메인 자동 산출
EXT_IP=$(curl -sSf -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)
WORKER_DOMAIN="${EXT_IP}.sslip.io"
echo "WORKER_DOMAIN=${WORKER_DOMAIN}"

# 3. Caddyfile 배포 (자동 Let's Encrypt cert)
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${WORKER_DOMAIN} {
    reverse_proxy 127.0.0.1:8080
}
EOF
sudo systemctl restart caddy

# 4. 워커 코드 배치 + deps
WORKER_DIR=/opt/moa-worker
sudo mkdir -p "${WORKER_DIR}"
sudo cp -r "$(dirname "$0")"/* "${WORKER_DIR}/"
( cd "${WORKER_DIR}" && sudo npm install --no-audit --no-fund )

# 5. env 파일
sudo tee /etc/moa-worker.env >/dev/null <<EOF
TURSO_DATABASE_URL=${TURSO_DATABASE_URL}
TURSO_AUTH_TOKEN=${TURSO_AUTH_TOKEN}
UPBIT_ACCESS_KEY=${UPBIT_ACCESS_KEY}
UPBIT_SECRET_KEY=${UPBIT_SECRET_KEY}
BITHUMB_ACCESS_KEY=${BITHUMB_ACCESS_KEY}
BITHUMB_SECRET_KEY=${BITHUMB_SECRET_KEY}
BINANCE_API_KEY=${BINANCE_API_KEY:-}
BINANCE_SECRET_KEY=${BINANCE_SECRET_KEY:-}
WORKER_SHARED_SECRET=${WORKER_SHARED_SECRET}
PORT=8080
EOF
sudo chmod 600 /etc/moa-worker.env
sudo chown root:root /etc/moa-worker.env

# 6. systemd unit
sudo cp "${WORKER_DIR}/moa-worker.service" /etc/systemd/system/moa-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now moa-worker

echo
echo "워커 배포 완료."
echo "  Vercel env WORKER_URL=https://${WORKER_DOMAIN}"
echo "  health  : curl https://${WORKER_DOMAIN}/"
echo "  logs    : sudo journalctl -u moa-worker -f"
