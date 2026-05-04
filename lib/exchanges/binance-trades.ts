// /api/v3/myTrades — symbol 필수, 보유 코인 USDT 페어마다 호출.
// fromId 파라미터로 forward walk: id 가 ascending 으로 반환되어 incremental
// 동기화에 적합. 첫 ingest = fromId=0 부터, 이후 = DB 최신 externalId+1.
import { binanceAuthFetch } from './binance-auth';

export type BinanceTrade = {
  id: number;
  orderId: number;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
};

const LIMIT = 1000;
const MAX_PAGES = 20; // symbol 당 20k trades 까지 (충분)

export async function getBinanceMyTrades(
  symbol: string,
  fromIdStart: number,
): Promise<BinanceTrade[]> {
  const out: BinanceTrade[] = [];
  let fromId = fromIdStart;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await binanceAuthFetch('/api/v3/myTrades', {
      symbol,
      fromId: String(fromId),
      limit: String(LIMIT),
    });
    if (!res.ok) {
      throw new Error(
        `Binance myTrades ${symbol} (fromId=${fromId}) ${res.status}: ${await res.text()}`,
      );
    }
    const arr = (await res.json()) as BinanceTrade[];
    if (!Array.isArray(arr) || arr.length === 0) break;
    out.push(...arr);
    if (arr.length < LIMIT) break;
    fromId = Math.max(...arr.map((t) => t.id)) + 1;
  }
  return out;
}
