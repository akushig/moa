# moa

한국형 통합 자산 트래커 v0.1 (1-user dogfood).

암호화폐 다중 거래소 + 한국 자산(부동산/전세/대출/현금) 단일 대시보드.

## Architecture (Day 2)

```
┌────────────┐  POST /api/sync (shared secret)   ┌──────────────────────────┐
│  Vercel    │ ────────────────────────────────► │  GCP e2-micro VM         │
│  (Hobby)   │                                   │  (Reserved External IPv4)│
│            │ ◄──────── JSON 결과 ──────────── │  • Caddy + sslip.io      │
│  page.tsx  │                                   │  • moa-worker (Hono)     │
│  /api/sync │                                   │    └→ 업비트 / 빗썸     │
│            │                                   │    └→ Turso write       │
│  prisma    │ ◄──── read latest snapshot ────── │       BalanceSnapshot    │
│  read      │                                   └──────────────────────────┘
└────────────┘                                                  │
       ▲                                                        │
       └──────────────── Turso (libSQL, Marketplace) ──────────┘
```

- **Vercel:** UI + auth + DB read + sync API gateway. **거래소 직접 호출 X**
- **GCP 워커:** 거래소 호출 전용. 화이트리스트 IP = Reserved External IPv4 1개
- **워커 도메인:** `<external-ip>.sslip.io` — Caddy 자동 Let's Encrypt cert
- **Vercel ↔ 워커:** `x-moa-secret` header (constant-time 비교)
- **DB write:** 워커가 Turso `BalanceSnapshot` 에 직접 insert (Vercel 우회)
- **Sync 트리거:** 사용자 수동 클릭만 (cron 미사용)

## Stack

- **App:** Next.js 16 App Router + Tailwind v4 + React 19
- **DB:** Turso (libSQL) via Prisma `@prisma/adapter-libsql`
- **Worker:** Hono + `@hono/node-server` + `@libsql/client`
- **Test:** Vitest 2 + decimal.js
- **Auth (UI):** Next.js 16 `proxy.ts` + 단일 `BASIC_AUTH_PASSWORD` over Vercel HTTPS
- **거래소 키 보안:** read-only 권한 + IP 화이트리스트 (GCP Reserved IPv4) + Vercel/GCP env sensitive + 90일 키 rotation

## Setup

### 1. Vercel 프로젝트 + Turso

```bash
npx vercel link
```

- Vercel 대시보드 → Storage → Marketplace → Turso → Add Integration
- moa 프로젝트 connect, Custom Prefix `TURSO` → `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` 자동 등록

### 2. GCP 워커 배포

자세한 절차는 [worker/README.md](worker/README.md) 참고.

요약:
1. e2-micro / us-west1 / Debian 12 / 10GB pd-standard 1대 + Reserved External IPv4
2. firewall: 80(ACME), 443 inbound 허용
3. `gcloud compute scp ./worker/* <vm>:/tmp/worker/`
4. SSH 후 env export + `bash setup.sh`
5. 출력 `WORKER_URL` 을 Vercel env 에 등록

### 3. Vercel env 등록

```
TURSO_DATABASE_URL=...                          # Marketplace 자동
TURSO_AUTH_TOKEN=...                            # Marketplace 자동
WORKER_URL=https://<ip>.sslip.io
WORKER_SHARED_SECRET=<openssl rand -hex 32>     # 워커 env 와 동일 값
BASIC_AUTH_PASSWORD=...
```

### 4. 거래소 키 발급

- **업비트** [open_api_management](https://upbit.com/mypage/open_api_management): 자산조회 / 주문조회. **IP = GCP Reserved IPv4 1개**
- **빗썸:** 잔고/거래내역. IP 화이트리스트 동일 IP

### 5. DB 스키마 push

```bash
npm install
npm run db:push
```

### 6. 로컬 dev (선택)

```bash
cp manual_assets.example.json manual_assets.json
npm run dev          # http://localhost:3000
```

로컬 dev 시 sync 버튼은 운영 GCP 워커를 호출. 로컬 워커 띄우려면 `cd worker && npm install && npm run dev` (포트 8080).

### 7. Deploy

```bash
git push     # main → Vercel 자동 production
```

## Test

```bash
npm test
```

## v0.1 Scope

- ✅ Day 1: 업비트 잔고 → KRW 환산, 단일 대시보드
- ✅ Day 2: 빗썸 잔고 + GCP 워커 + sslip.io + shared secret + 수동 sync 버튼
- ⏳ Day 3: `/v1/orders` + `/v1/deposits` ingestion → Transaction 테이블 → 진짜 평균단가 + 한국은행 fx live fetch + 30s 메모리 캐시
- ⏳ Day 4-5: time-to-answer 스톱워치 측정 + 본인 dogfood

## Locked-in 결정

- Recharts → v0.5 (HTML/Tailwind only)
- price_snapshots / fx_rates → v0.5
- 진짜 평균단가 (Day 3 /v1/orders ingestion)
- Prisma Decimal qty / Decimal price + decimal.js 계산
- 빗썸 v1 HMAC 직접 구현 (막히면 CCXT fallback 검토)
- Hosting: Vercel + Turso + GCP Free Tier 워커 + sslip.io

자세한 내용: `~/.gstack/projects/moa/akushi-main-design-20260503-153749.md`
