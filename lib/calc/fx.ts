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
