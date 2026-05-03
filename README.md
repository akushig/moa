# moa

한국형 통합 자산 트래커 v0.1 (1-user dogfood, Vercel hosted).

암호화폐 다중 거래소 + 한국 자산(부동산/전세/대출/현금) 단일 대시보드.

## Stack

- **Hosting:** Vercel (Hobby tier, $0/월)
- **DB:** [Turso](https://turso.tech) (libSQL, SQLite 호환) via Prisma `@prisma/adapter-libsql`
- **Outbound static IP:** [Fixie](https://usefixie.com) 직접 가입 (무료 plan) — `FIXIE_URL` 환경변수 설정 시 [lib/proxy.ts](lib/proxy.ts) 가 자동으로 모든 outbound HTTP 를 Fixie 통해 라우팅. 거래소 (업비트/빗썸) 가 IP 화이트리스트 필수라 필요. Fixie 무료 plan limit 도달 시 paid plan 또는 Fly.io 마이그 검토.
- **거래소 키 보안:** read-only 권한 + IP 화이트리스트 (Fixie static IPs) + Vercel env sensitive + private repo + strong basic auth + 90일 키 rotation
- **App:** Next.js 16 App Router + Tailwind v4 + React 19
- **Test:** Vitest 2 + decimal.js 정밀도
- **Auth:** Next.js 16 `proxy.ts` + 단일 BASIC_AUTH_PASSWORD over HTTPS (Vercel 자동)
- **거래소:** 업비트 (read-only JWT, Day 1) / 빗썸 (HMAC + CCXT fallback, Day 2)
- **FX:** 한국은행 API live fetch + 1h 메모리 캐시 (Day 2-3, stablecoin 환산)

## Setup

### 1. Vercel 프로젝트 생성

```bash
npx vercel link        # 또는 Vercel 대시보드에서 GitHub repo 연결
```

### 2. Turso 설치 (Vercel Storage → Marketplace)

- Vercel 대시보드 → Storage → Marketplace → Turso → Add Integration
- moa 프로젝트 connect, Custom Prefix `TURSO` 로 설정 → `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` 자동 등록

### 3. Fixie 직접 가입 (Vercel marketplace 우회)

- [usefixie.com](https://usefixie.com) sign up → 무료 plan
- 대시보드에서 `FIXIE_URL` 복사 (`http://fixie:<token>@<host>.usefixie.com:80` 형태)
- **Outbound IPs** 메뉴에서 발급된 static IP 2개 확인 (업비트/빗썸 화이트리스트용)
- Vercel project Settings → Environment Variables 에 `FIXIE_URL` 수기 등록

### 4. 거래소 키 등록

- 업비트: [open_api_management](https://upbit.com/mypage/open_api_management) 에서 read-only 키 발급
  - 권한: 자산 조회 ✅ / 주문 조회 ✅ (Day 3) / 출금 ❌ / 입금주소 조회 ❌
  - **IP 등록 = Fixie static IP 2개** (Fixie 대시보드에서 복사)
- 빗썸: 동일 패턴 (Day 2), 최대 5개 IP 한도

### 4. 환경변수 설정

Vercel 프로젝트 Settings → Environment Variables 에서:

```
UPBIT_ACCESS_KEY=...
UPBIT_SECRET_KEY=...
BITHUMB_ACCESS_KEY=...     # Day 2
BITHUMB_SECRET_KEY=...     # Day 2
BASIC_AUTH_PASSWORD=...
```

(Turso, Fixie 는 Marketplace 자동 등록)

### 5. DB 스키마 push

```bash
npm install
npm run db:push     # prisma db push (Turso libSQL, migrate dev 대신)
```

### 6. 로컬 dev (선택)

```bash
cp .env.example .env.local      # Turso/Fixie 키 채우기 (turso CLI 또는 Fixie 대시보드)
cp manual_assets.example.json manual_assets.json
npm run dev                      # http://localhost:3000
```

### 7. Deploy

```bash
git push                         # main → Vercel 자동 production deploy
                                 # PR → branch preview URL (mobile 접속 가능)
```

## Test

```bash
npm test            # vitest run
npm run test:watch
```

## v0.1 Scope

- ✅ 업비트 잔고 → KRW 환산 (현금 + 코인 평가)
- ✅ manual_assets.json 통합 (부동산/대출/현금/마이너스통장)
- ✅ 단일 대시보드 (총자산 한 줄 + 자산군별 표)
- ✅ Next.js 16 proxy basic auth + Vercel HTTPS
- ✅ Turso libSQL + Prisma adapter
- ✅ Fixie outbound static IP (거래소 화이트리스트)
- ⏳ Day 2: 빗썸 잔고 + CCXT fallback
- ⏳ Day 3: `/v1/orders` + `/v1/deposits` ingestion → Transaction 테이블 → 진짜 평균단가 + 한국은행 fx live fetch + 30s 메모리 캐시
- ⏳ Day 4-5: time-to-answer 스톱워치 측정 + 본인 dogfood

## Locked-in 결정 (plan-eng-review 2026-05-03)

- Recharts → v0.5 (HTML/Tailwind only)
- price_snapshots / fx_rates → v0.5 (DB 미사용, fx 는 live fetch + memory cache)
- 진짜 평균단가 (Day 3 /v1/orders ingestion)
- Prisma Decimal(20,8) qty / Decimal(20,2) price + decimal.js 계산
- 빗썸 timebox + CCXT fallback
- 30s 메모리 캐시 (F5 hammering 방지)
- **Hosting: Vercel + Fixie + Turso** (v0.5 plan 을 v0.1 로 앞당김)

자세한 내용: `~/.gstack/projects/moa/akushi-main-design-20260503-153749.md`
