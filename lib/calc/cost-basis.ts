import { Decimal } from '@/lib/decimal';

export type TxRow = {
  timestamp: Date | number;
  side: string; // buy | sell | deposit | withdraw | ...
  qty: string | number | { toString(): string };
  price: string | number | { toString(): string };
  fee: string | number | { toString(): string };
};

export type CostBasis = {
  trackedQty: Decimal; // cost basis 의 분모. 매수만 카운트 (deposit 제외).
  cost: Decimal; // 누적 매입 KRW (수수료 제외)
  avgPrice: Decimal; // cost / trackedQty (trackedQty=0 → 0)
  realizedPnl: Decimal; // 누적 실현 손익
  buyCount: number;
  sellCount: number;
  depositQty: Decimal; // staking 보상 등 외부 입금 누적 (참고용)
  withdrawQty: Decimal; // 외부 출금 누적 (참고용)
};

const Z = new Decimal(0);

// Moving-average 평균단가. 거래소 (업비트/빗썸) 표시 convention 과 일치하도록 조정:
//
//   buy:      cost      += qty × price            (fee 제외)
//             trackedQty += qty
//   sell:     realized  += qty × price - sellQty × avg - sellFee
//             cost      *= (trackedQty - sellQty) / trackedQty
//             trackedQty -= sellQty
//   withdraw: cost      *= (trackedQty - wQty) / trackedQty   (qty 만큼 cost 비례 차감)
//             trackedQty -= wQty                              (실현 손익 이벤트 X)
//   deposit:  cost      변경 없음
//             trackedQty 변경 없음
//             depositQty += qty                  (참고용 카운터만)
//
// → 평균단가 = 매입 거래분에 대한 가중평균. staking 보상 등 외부 입금이 평균단가를
//   희석하지 않음 (거래소 표시값과 정합).
// → 실제 보유수량은 BalanceSnapshot 에서 별도로 가져옴 (deposit 도 반영된 진짜 잔고).
//   여기서는 cost basis 기준 trackedQty 만 다룸.
export function computeCostBasis(txs: TxRow[]): CostBasis {
  const sorted = [...txs].sort((a, b) => {
    const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : Number(a.timestamp);
    const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : Number(b.timestamp);
    return ta - tb;
  });

  let trackedQty = Z;
  let cost = Z;
  let realized = Z;
  let buyCount = 0;
  let sellCount = 0;
  let depositQty = Z;
  let withdrawQty = Z;

  for (const t of sorted) {
    const q = new Decimal(t.qty.toString());
    const p = new Decimal(t.price.toString());
    const f = new Decimal(t.fee.toString());
    if (q.lte(0)) continue;

    if (t.side === 'buy') {
      cost = cost.plus(q.times(p));
      trackedQty = trackedQty.plus(q);
      buyCount += 1;
    } else if (t.side === 'sell') {
      sellCount += 1;
      if (trackedQty.lte(0)) continue;
      const sellQty = Decimal.min(q, trackedQty);
      const avg = trackedQty.gt(0) ? cost.div(trackedQty) : Z;
      realized = realized.plus(sellQty.times(p)).minus(sellQty.times(avg)).minus(f);
      const remain = trackedQty.minus(sellQty);
      cost = trackedQty.gt(0) ? cost.times(remain).div(trackedQty) : Z;
      trackedQty = remain;
    } else if (t.side === 'withdraw') {
      withdrawQty = withdrawQty.plus(q);
      if (trackedQty.lte(0)) continue;
      const wQty = Decimal.min(q, trackedQty);
      const remain = trackedQty.minus(wQty);
      cost = trackedQty.gt(0) ? cost.times(remain).div(trackedQty) : Z;
      trackedQty = remain;
    } else if (t.side === 'deposit') {
      depositQty = depositQty.plus(q);
      // cost / trackedQty 변경 없음 — 외부 입금은 평균단가에 영향 X
    }
    // interest / dividend 등은 평균단가 영향 X
  }

  const avgPrice = trackedQty.gt(0) ? cost.div(trackedQty) : Z;
  return {
    trackedQty,
    cost,
    avgPrice,
    realizedPnl: realized,
    buyCount,
    sellCount,
    depositQty,
    withdrawQty,
  };
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
