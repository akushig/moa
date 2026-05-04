import { Decimal } from '@/lib/decimal';

export type TxRowExt = {
  exchange: string | null;
  assetSymbol: string;
  timestamp: Date | number;
  side: string;
  qty: string | number | { toString(): string };
};

export type HoldingAtT = {
  exchange: string;
  symbol: string;
  qty: Decimal;
};

// 주어진 시점까지의 transaction 들을 replay → (exchange, symbol) 별 보유 수량.
//   buy + deposit: qty 증가
//   sell + withdraw: qty 감소
// 결과는 qty>0 인 것만 반환.
export function computeHoldingsAt(txs: TxRowExt[], asOfMs: number): HoldingAtT[] {
  const map = new Map<string, Decimal>();
  for (const t of txs) {
    const ts = t.timestamp instanceof Date ? t.timestamp.getTime() : Number(t.timestamp);
    if (ts > asOfMs) continue;
    const key = `${t.exchange ?? ''}::${t.assetSymbol}`;
    const cur = map.get(key) ?? new Decimal(0);
    const q = new Decimal(t.qty.toString());
    if (q.lte(0)) continue;
    if (t.side === 'buy' || t.side === 'deposit') {
      map.set(key, cur.plus(q));
    } else if (t.side === 'sell' || t.side === 'withdraw') {
      map.set(key, cur.minus(q));
    }
  }
  return Array.from(map.entries())
    .filter(([, qty]) => qty.gt(0))
    .map(([key, qty]) => {
      const [exchange, symbol] = key.split('::');
      return { exchange, symbol, qty };
    });
}
