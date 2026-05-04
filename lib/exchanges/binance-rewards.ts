// /sapi/v1/asset/assetDividend — 스테이킹 보상 / 에어드랍 / Launchpool / 분배 이벤트.
// deposit/hisrec 에는 안 잡히는 internal 분배. cost-basis 정합 위해 별도 ingest.
//
// 응답 shape: { rows: [{id, tranId, asset, amount, divTime, enInfo}], total }
// startTime/endTime 90일 max window, limit 500.
import { binanceAuthFetch } from './binance-auth';

export type BinanceDividend = {
  id: number;
  tranId: number;
  asset: string;
  amount: string;
  divTime: number; // epoch ms
  enInfo: string; // "Stake reward", "Airdrop", "Launchpool", ...
};

const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const SAFETY_OVERLAP_MS = 60 * 60 * 1000;
const MAX_BACKWARD_WINDOWS = 24;
const LIMIT = 500;

// 단일 window 안에서 endTime cursor 를 oldest divTime - 1 로 줄여가며 전체 페이지 수집.
// (assetDividend 는 offset/page 없이 startTime/endTime/limit 만 지원.)
async function fetchWindowAllPages(start: number, end: number): Promise<BinanceDividend[]> {
  const out: BinanceDividend[] = [];
  let cursor = end;
  for (let page = 0; page < 20; page += 1) {
    if (cursor <= start) break;
    const res = await binanceAuthFetch('/sapi/v1/asset/assetDividend', {
      startTime: String(start),
      endTime: String(cursor),
      limit: String(LIMIT),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return out; // 권한 없으면 silent skip
      throw new Error(`assetDividend ${res.status}: ${await res.text()}`);
    }
    const j = (await res.json()) as { rows?: BinanceDividend[] };
    const rows = j.rows ?? [];
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < LIMIT) break;
    const oldest = Math.min(...rows.map((r) => r.divTime));
    if (oldest >= cursor) break; // 안전: 진척 없으면 stop
    cursor = oldest - 1;
  }
  return out;
}

export async function getBinanceDividends(since?: number): Promise<BinanceDividend[]> {
  const out: BinanceDividend[] = [];
  const now = Date.now();
  if (since !== undefined && since !== null) {
    let start = Math.max(0, since - SAFETY_OVERLAP_MS);
    while (start < now) {
      const end = Math.min(start + WINDOW_MS, now);
      out.push(...(await fetchWindowAllPages(start, end)));
      start = end;
    }
    return out;
  }
  let end = now;
  for (let i = 0; i < MAX_BACKWARD_WINDOWS; i += 1) {
    const start = Math.max(0, end - WINDOW_MS);
    out.push(...(await fetchWindowAllPages(start, end)));
    if (start === 0) break;
    end = start;
  }
  return out;
}
