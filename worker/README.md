# moa-worker

거래소 호출 전용 워커. GCP e2-micro VM (Free Tier, us-west1) 위에서 영구 무료 운영.

- **endpoint:** `https://<external-ip>.sslip.io/sync` — Caddy + sslip.io 자동 Let's Encrypt cert
- **auth:** `x-moa-secret: <WORKER_SHARED_SECRET>` (constant-time 비교)
- **flow:** Vercel `/api/sync` POST → 이 워커 → 업비트+빗썸 호출 → Turso `BalanceSnapshot` 직접 write → 반환
- **거래소 화이트리스트:** GCP **Reserved External IPv4** 1개 (영구 고정) 를 업비트/빗썸 키 IP 등록

## GCP 셋업 요약

1. e2-micro / us-west1 / Debian 12 / 10GB pd-standard VM 1대 생성
2. **Reserved External IPv4** 발급 후 VM 에 attach (VM 정지 X — 정지 시 IP 청구)
3. firewall: HTTPS(443) + HTTP(80, ACME challenge) inbound 허용
4. `gcloud compute scp ./worker/* <vm>:/tmp/worker/`
5. SSH 접속 후 env export + setup.sh 실행

```bash
ssh <vm>
cd /tmp/worker
export TURSO_DATABASE_URL=...
export TURSO_AUTH_TOKEN=...
export UPBIT_ACCESS_KEY=...
export UPBIT_SECRET_KEY=...
export BITHUMB_ACCESS_KEY=...
export BITHUMB_SECRET_KEY=...
export WORKER_SHARED_SECRET=$(openssl rand -hex 32)   # 같은 값 Vercel env 에도 등록
bash setup.sh
```

6. 출력된 `WORKER_URL` 을 Vercel 프로젝트 Settings → Environment Variables 에 등록
7. 업비트/빗썸 키 발급 페이지에서 **IP 등록 = Reserved External IPv4 1개**

## 거래소 키 권한

- **업비트:** 자산 조회 ✅ / 주문 조회 ✅ / 출금 ❌ / 입금주소 ❌
- **빗썸:** 잔고조회 ✅ / 거래내역 ✅ / 출금 ❌

## 운영

```bash
sudo systemctl status moa-worker
sudo journalctl -u moa-worker -f
sudo systemctl restart moa-worker
sudo systemctl status caddy        # 인증서 자동 갱신
```

## Free Tier 함정 회피

- e2-micro 1대만 무료 (us-west1 / us-central1 / us-east1)
- VM 정지 X (정지 시 attached IP 청구)
- Disk 30GB 한도 → 10GB pd-standard
- Egress 1GB/월 한도 → manual sync 시나리오 충분
- Budget alert $1 limit 필수 설정
