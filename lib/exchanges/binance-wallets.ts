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

// Crypto Loan (Flexible rate) — stable rate 는 Binance 가 retire (-10112).
// collateral 은 spot 에서 빠진 상태이므로 더해줘야 보유량 일치. 빌린 코인은
// spot 에 들어오므로 별도 처리 X.
export async function getLoanCollateral(): Promise<WalletPosition[]> {
  const out: WalletPosition[] = [];
  const flex = (await safeFetch('/sapi/v1/loan/flexible/ongoing/orders', {
    current: '1',
    limit: '100',
  })) as { rows?: { collateralCoin: string; collateralAmount: string }[] } | null;
  if (flex?.rows) {
    for (const r of flex.rows) {
      const qty = new Decimal(r.collateralAmount);
      if (qty.gt(0)) {
        out.push({ asset: r.collateralCoin, qty, source: 'loan-flex-collateral' });
      }
    }
  }
  return out;
}

// 모든 wallet 병렬 fetch. 개별 endpoint 실패는 errors[] 에 모으고 진행.
export async function getAllWalletPositions(): Promise<{
  positions: WalletPosition[];
  errors: string[];
}> {
  const errors: string[] = [];
  const collect = async <T>(label: string, fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  };
  const [flex, locked, funding, loan] = await Promise.all([
    collect('earn-flex', getEarnFlexible),
    collect('earn-locked', getEarnLocked),
    collect('funding', getFundingAssets),
    collect('loan-collateral', getLoanCollateral),
  ]);
  return { positions: [...flex, ...locked, ...funding, ...loan], errors };
}
