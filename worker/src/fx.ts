// USD/KRW 환율 가져오기 + 30초 메모리 캐시.
// 우선순위:
//   1) BoK ECOS API — BOK_API_KEY 가 set 이면 한국은행 일별 매매기준율 사용.
//   2) Frankfurter (ECB 기반, key 불필요) — fallback.
//
// 30s 캐시는 manual sync 시나리오상 충분 (사용자가 같은 분에 여러 번 클릭해도 1회만 hit).
// 더 긴 TTL 은 stablecoin 평가가 시세에 못 따라가는 위험 있음.

const TTL_MS = 30_000;
let cache: { rate: number; expiresAt: number } | null = null;

async function fetchFromBok(key: string): Promise<number> {
  // ECOS API: 통계코드 731Y001 = 시장평균환율 (서울외환시장).
  // 일자별 last entry 가 가장 최신. 응답 = JSON.
  // 형식 예시:
  //   /api/StatisticSearch/{key}/json/kr/1/1/731Y001/D/{yyyymmdd}/{yyyymmdd}/0000001
  // 0000001 = 미국달러.
  const today = new Date();
  const ymd = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const start = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/10/731Y001/D/${ymd(start)}/${ymd(today)}/0000001`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BoK ECOS ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as Record<string, unknown>;
  const rows = (j as { StatisticSearch?: { row?: { DATA_VALUE?: string }[] } })
    .StatisticSearch?.row;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`BoK ECOS: empty response — ${JSON.stringify(j).slice(0, 200)}`);
  }
  const last = rows[rows.length - 1];
  const rate = Number(last.DATA_VALUE);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`BoK ECOS: invalid rate ${last.DATA_VALUE}`);
  }
  return rate;
}

async function fetchFromFrankfurter(): Promise<number> {
  const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=KRW');
  if (!res.ok) throw new Error(`Frankfurter ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { rates?: { KRW?: number } };
  const rate = j.rates?.KRW;
  if (!rate || rate <= 0) throw new Error(`Frankfurter: invalid rate ${JSON.stringify(j)}`);
  return rate;
}

export async function getUsdKrwRate(): Promise<number> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.rate;

  const bokKey = process.env.BOK_API_KEY;
  let rate: number;
  if (bokKey) {
    try {
      rate = await fetchFromBok(bokKey);
    } catch (e) {
      console.warn(`fx: BoK failed, falling back to Frankfurter — ${e instanceof Error ? e.message : e}`);
      rate = await fetchFromFrankfurter();
    }
  } else {
    rate = await fetchFromFrankfurter();
  }

  cache = { rate, expiresAt: now + TTL_MS };
  return rate;
}

// 테스트 / 디버그용
export function _resetFxCache(): void {
  cache = null;
}
