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

// Moving-average 평균단가. 거래소 (업비트/빗썸) 표시값과 정합:
//
//   buy:      cost      += qty × price            (fee 제외)
//             trackedQty += qty
//   sell:     realized  += qty × price - sellQty × avg - sellFee
//             cost      *= (trackedQty - sellQty) / trackedQty
//             trackedQty -= sellQty
//   withdraw: cost      *= (trackedQty - wQty) / trackedQty
//             trackedQty -= wQty                              (실현 X)
//   deposit (price > 0, fair-value): buy 와 동일 처리
//             cost      += qty × price            (deposit 시점 시장가)
//             trackedQty += qty
//             depositQty += qty                   (참고용)
//   deposit (price = 0, historical 시세 못 가져온 경우): trackedQty/cost 변경 X
//             depositQty 만 증가
//
// → 빗썸/업비트 같은 거래소들은 staking 보상도 fair-value 로 cost 부여 →
//   moa 도 deposit 시점 일봉 종가로 cost 가산해서 정의 통일.
// → 실제 보유 qty 는 BalanceSnapshot 에서 가져옴. trackedQty 는 cost basis 분모.
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
      if (p.gt(0)) {
        // 시점 시장가가 있으면 fair-value 로 cost 가산 (= 거래소 알고리즘 매치)
        cost = cost.plus(q.times(p));
        trackedQty = trackedQty.plus(q);
      }
      // price=0 이면 cost-basis 영향 X (historical price 미보유 = airdrop 등 KRW 마켓 없는 케이스)
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
