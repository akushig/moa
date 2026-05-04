import { Decimal } from '@/lib/decimal';

export type TxRow = {
  timestamp: Date | number;
  side: string; // buy | sell | deposit | withdraw | ...
  qty: string | number | { toString(): string };
  price: string | number | { toString(): string };
  fee: string | number | { toString(): string };
};

export type CostBasis = {
  qty: Decimal; // 현재 보유 수량
  cost: Decimal; // 보유분의 누적 KRW 매입 비용 (수수료 포함)
  avgPrice: Decimal; // cost / qty (qty=0 → 0)
  realizedPnl: Decimal; // 누적 실현 손익 (KRW)
  buyCount: number;
  sellCount: number;
};

const Z = new Decimal(0);

// Moving-average (이동평균) 평균단가. 거래소 평균매입가 정의와 동일.
//   buy:  cost  += qty × price + fee
//         qty   += qty
//   sell: realized += (price × qty) - (avg × qty) - fee
//         cost  *= (qty - sellQty) / qty   (보유분의 평균단가는 변하지 않음)
//         qty   -= sellQty
// deposit/withdraw 는 평균단가 변경하지 않음 (입출고 = 외부 이벤트).
//   - deposit: qty += qty (cost 는 모르므로 0 으로 본다 — 보수적)
//     이렇게 두면 후속 buy 에서 평균단가 희석 → 정확하지 않음. v0.5+ 에서
//     deposit 가격을 timestamp 시점 price 로 마킹하는 옵션 추가.
//   - withdraw: qty -= qty, cost 비례 감소.
export function computeCostBasis(txs: TxRow[]): CostBasis {
  // sort ascending by timestamp
  const sorted = [...txs].sort((a, b) => {
    const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : Number(a.timestamp);
    const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : Number(b.timestamp);
    return ta - tb;
  });

  let qty = Z;
  let cost = Z;
  let realized = Z;
  let buyCount = 0;
  let sellCount = 0;

  for (const t of sorted) {
    const q = new Decimal(t.qty.toString());
    const p = new Decimal(t.price.toString());
    const f = new Decimal(t.fee.toString());
    if (q.lte(0)) continue;

    if (t.side === 'buy') {
      cost = cost.plus(q.times(p)).plus(f);
      qty = qty.plus(q);
      buyCount += 1;
    } else if (t.side === 'sell') {
      sellCount += 1;
      if (qty.lte(0)) {
        // short / 데이터 누락. 부호 안 맞으면 이번 거래 무시 (fallback).
        continue;
      }
      const sellQty = Decimal.min(q, qty);
      const avg = qty.gt(0) ? cost.div(qty) : Z;
      realized = realized.plus(sellQty.times(p)).minus(sellQty.times(avg)).minus(f);
      const remain = qty.minus(sellQty);
      cost = qty.gt(0) ? cost.times(remain).div(qty) : Z;
      qty = remain;
    } else if (t.side === 'deposit') {
      qty = qty.plus(q);
      // cost 는 모름 → 0 처리 (보수적). 평균단가 ↓ 위험 — 메모리 노트 참고.
    } else if (t.side === 'withdraw') {
      if (qty.gt(0)) {
        const wq = Decimal.min(q, qty);
        const remain = qty.minus(wq);
        cost = cost.times(remain).div(qty);
        qty = remain;
      }
    }
    // interest / dividend 등은 평균단가 영향 X
  }

  const avgPrice = qty.gt(0) ? cost.div(qty) : Z;
  return { qty, cost, avgPrice, realizedPnl: realized, buyCount, sellCount };
}

// 여러 (exchange, symbol) 별로 그룹핑 → 각 그룹별 cost basis 반환.
export type GroupedCostBasis = Map<string, CostBasis>; // key = `${exchange}::${symbol}`

export function groupCostBasis(
  txs: (TxRow & { exchange: string | null; assetSymbol: string })[],
): GroupedCostBasis {
  const groups = new Map<string, (TxRow & { exchange: string | null; assetSymbol: string })[]>();
  for (const t of txs) {
    const key = `${t.exchange ?? ''}::${t.assetSymbol}`;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }
  const out: GroupedCostBasis = new Map();
  for (const [k, arr] of groups) {
    out.set(k, computeCostBasis(arr));
  }
  return out;
}
