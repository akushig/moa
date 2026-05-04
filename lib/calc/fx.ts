// USDT/KRW 환율 — 한국 시장 KRW-USDT 페어 (Upbit) 사용. 김치 프리미엄 반영.
// Frankfurter USD/KRW 는 USDT 프리미엄 못 잡아서 후순위.
import { prisma } from '@/lib/db';
import { Decimal } from '@/lib/decimal';

export async function fetchUsdtKrw(): Promise<{ rate: Decimal; source: string } | null> {
  try {
    const res = await fetch('https://api.upbit.com/v1/ticker?markets=KRW-USDT', {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { trade_price?: number }[];
    if (!Array.isArray(j) || j.length === 0) return null;
    const price = j[0].trade_price;
    if (typeof price !== 'number' || !Number.isFinite(price)) return null;
    return { rate: new Decimal(price), source: 'upbit-krw-usdt' };
  } catch {
    return null;
  }
}

export async function persistFxRate(
  takenAt: Date,
  base: string,
  quote: string,
  rate: Decimal,
  source: string,
): Promise<void> {
  await prisma.fxRate.create({
    data: { takenAt, base, quote, rate: rate.toString(), source },
  });
}

export async function getLatestFxRate(
  base: string,
  quote: string,
): Promise<{ rate: Decimal; takenAt: Date } | null> {
  const r = await prisma.fxRate.findFirst({
    where: { base, quote },
    orderBy: { takenAt: 'desc' },
  });
  if (!r) return null;
  return { rate: new Decimal(String(r.rate)), takenAt: r.takenAt };
}

// 그 시점 이전 가장 최근 FxRate. 없으면 이후 가장 빠른 것 (FX 적재 시작 이전 시점
// 조회 시 fallback). 둘 다 없으면 null. v0.5+ 에서 USD/KRW historical 도 지원.
export async function getFxAtOrNearest(
  base: string,
  quote: string,
  asOfMs: number,
): Promise<{ rate: Decimal; takenAt: Date } | null> {
  const before = await prisma.fxRate.findFirst({
    where: { base, quote, takenAt: { lte: new Date(asOfMs) } },
    orderBy: { takenAt: 'desc' },
  });
  if (before) return { rate: new Decimal(String(before.rate)), takenAt: before.takenAt };
  const after = await prisma.fxRate.findFirst({
    where: { base, quote },
    orderBy: { takenAt: 'asc' },
  });
  if (after) return { rate: new Decimal(String(after.rate)), takenAt: after.takenAt };
  return null;
}
