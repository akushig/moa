// Binance 의 spot 외 wallet 들. 사용자가 스테이킹/Funding/대출 collateral 등으로
// 자산을 옮겨놓아도 총 보유량 을 정확히 반영하기 위함.
//
// 권한 부족 / endpoint 미지원 / product 미사용은 모두 silent skip — 응답 빈 배열.
// (예: 대출 안 쓰면 ongoing/orders 가 빈 rows. 권한 없으면 401/403 → skip.)
import { Decimal } from '@/lib/decimal';
import { binanceAuthFetch } from './binance-auth';

export type WalletPosition = {
  asset: string;
  qty: Decimal;
  source: 'earn-flex' | 'earn-locked' | 'funding' | 'loan-collateral' | 'loan-flex-collateral';
};

async function safeFetch(
  path: string,
  query: Record<string, string>,
  method: 'GET' | 'POST' = 'GET',
): Promise<unknown | null> {
  const res = await binanceAuthFetch(path, query, method);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403 || res.status === 404) return null;
    throw new Error(`${path} ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}

// Simple Earn 플렉시블. totalAmount = 원금 + 누적 이자 (자동 compound).
export async function getEarnFlexible(): Promise<WalletPosition[]> {
  const j = (await safeFetch('/sapi/v1/simple-earn/flexible/position', {
    size: '100',
    current: '1',
  })) as { rows?: { asset: string; totalAmount: string }[] } | null;
  if (!j?.rows) return [];
  return j.rows
    .map((r) => ({ asset: r.asset, qty: new Decimal(r.totalAmount), source: 'earn-flex' as const }))
    .filter((p) => p.qty.gt(0));
}

// Simple Earn 락드. amount = 원금 (이자는 별도 distribution → assetDividend).
export async function getEarnLocked(): Promise<WalletPosition[]> {
  const j = (await safeFetch('/sapi/v1/simple-earn/locked/position', {
    size: '100',
    current: '1',
  })) as { rows?: { asset: string; amount: string }[] } | null;
  if (!j?.rows) return [];
  return j.rows
    .map((r) => ({ asset: r.asset, qty: new Decimal(r.amount), source: 'earn-locked' as const }))
    .filter((p) => p.qty.gt(0));
}

// Funding wallet (Binance Pay / P2P / Card 충전 등에 쓰이는 별도 잔고).
// POST 호출. 응답: [{asset, free, locked, freeze, withdrawing, btcValuation}]
export async function getFundingAssets(): Promise<WalletPosition[]> {
  const j = (await safeFetch('/sapi/v1/asset/get-funding-asset', {}, 'POST')) as
    | { asset: string; free: string; locked: string; freeze?: string; withdrawing?: string }[]
    | null;
  if (!Array.isArray(j)) return [];
  return j
    .map((r) => {
      const qty = new Decimal(r.free)
        .plus(r.locked)
        .plus(r.freeze ?? '0')
        .plus(r.withdrawing ?? '0');
      return { asset: r.asset, qty, source: 'funding' as const };
    })
    .filter((p) => p.qty.gt(0));
}

export type LoanDebt = {
  loanCoin: string; // 빌린 코인
  totalDebt: string; // 갚아야 할 양 (원금 + 누적 이자, loanCoin 단위)
  collateralCoin: string;
  currentLTV: string;
};

// Crypto Loan (Flexible rate) — stable rate 는 Binance 가 retire (-10112).
// 두 측면 모두 반환:
//   - collateral: 자산 측. spot 에서 빠진 상태이므로 더해줘야 보유량 일치.
//   - debts: 부채 측. 빌린 코인은 spot 에 들어와 자산처럼 잡히므로 동일 금액 차감 필요
//            (안 하면 net worth 가 빌린 양 만큼 과대 평가됨).
export async function getLoanInfo(): Promise<{
  collateral: WalletPosition[];
  debts: LoanDebt[];
}> {
  const collateral: WalletPosition[] = [];
  const debts: LoanDebt[] = [];
  const flex = (await safeFetch('/sapi/v1/loan/flexible/ongoing/orders', {
    current: '1',
    limit: '100',
  })) as
    | {
        rows?: {
          loanCoin: string;
          totalDebt: string;
          collateralCoin: string;
          collateralAmount: string;
          currentLTV: string;
        }[];
      }
    | null;
  if (flex?.rows) {
    for (const r of flex.rows) {
      const colQty = new Decimal(r.collateralAmount);
      if (colQty.gt(0)) {
        collateral.push({
          asset: r.collateralCoin,
          qty: colQty,
          source: 'loan-flex-collateral',
        });
      }
      const debt = new Decimal(r.totalDebt);
      if (debt.gt(0)) {
        debts.push({
          loanCoin: r.loanCoin,
          totalDebt: r.totalDebt,
          collateralCoin: r.collateralCoin,
          currentLTV: r.currentLTV,
        });
      }
    }
  }
  return { collateral, debts };
}

// 모든 wallet 병렬 fetch. 개별 endpoint 실패는 errors[] 에 모으고 진행.
export async function getAllWalletPositions(): Promise<{
  positions: WalletPosition[];
  loanDebts: LoanDebt[];
  errors: string[];
}> {
  const errors: string[] = [];
  const collect = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };
  const [flex, locked, funding, loan] = await Promise.all([
    collect('earn-flex', getEarnFlexible, [] as WalletPosition[]),
    collect('earn-locked', getEarnLocked, [] as WalletPosition[]),
    collect('funding', getFundingAssets, [] as WalletPosition[]),
    collect('loan-info', getLoanInfo, { collateral: [] as WalletPosition[], debts: [] as LoanDebt[] }),
  ]);
  return {
    positions: [...flex, ...locked, ...funding, ...loan.collateral],
    loanDebts: loan.debts,
    errors,
  };
}
