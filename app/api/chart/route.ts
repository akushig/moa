import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Decimal } from '@/lib/decimal';

export const dynamic = 'force-dynamic';

// 자산 추이 차트용 API — BalanceSnapshot + FxRate 조합으로 일별 총자산(KRW) 반환.
// Query: ?range=7d|30d|90d|all (default: 30d)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const range = url.searchParams.get('range') ?? '30d';

  const now = Date.now();
  const msPerDay = 86400_000;
  const since =
    range === '7d'
      ? new Date(now - 7 * msPerDay)
      : range === '90d'
        ? new Date(now - 90 * msPerDay)
        : range === 'all'
          ? new Date(0)
          : new Date(now - 30 * msPerDay);

  const [snapshots, fxRates] = await Promise.all([
    prisma.balanceSnapshot.findMany({
      where: { takenAt: { gte: since } },
      orderBy: { takenAt: 'asc' },
      select: {
        takenAt: true,
        exchange: true,
        quoteCurrency: true,
        totalKrw: true,
        cashKrw: true,
        cryptoKrw: true,
      },
    }),
    prisma.fxRate.findMany({
      where: { base: 'USDT', quote: 'KRW' },
      orderBy: { takenAt: 'asc' },
      select: { takenAt: true, rate: true },
    }),
  ]);

  // FxRate sorted array — binary search
  const fxArr = fxRates.map((r) => ({
    ms: r.takenAt.getTime(),
    rate: new Decimal(String(r.rate)),
  }));

  function fxAtTime(ms: number): Decimal | null {
    if (fxArr.length === 0) return null;
    if (ms < fxArr[0].ms) return fxArr[0].rate;
    if (ms >= fxArr[fxArr.length - 1].ms) return fxArr[fxArr.length - 1].rate;
    let lo = 0;
    let hi = fxArr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fxArr[mid].ms <= ms) lo = mid;
      else hi = mid - 1;
    }
    return fxArr[lo].rate;
  }

  // 일별 그룹 → exchange 별 최신 snapshot
  type Entry = {
    takenAt: number;
    totalKrw: Decimal;
    cashKrw: Decimal;
    cryptoKrw: Decimal;
    quoteCurrency: string;
  };
  const days = new Map<string, Map<string, Entry>>();

  for (const s of snapshots) {
    const ms = s.takenAt.getTime();
    const kstDate = new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
    if (!days.has(kstDate)) days.set(kstDate, new Map());
    const bucket = days.get(kstDate)!;
    const prev = bucket.get(s.exchange);
    if (!prev || ms > prev.takenAt) {
      bucket.set(s.exchange, {
        takenAt: ms,
        totalKrw: new Decimal(String(s.totalKrw)),
        cashKrw: new Decimal(String(s.cashKrw)),
        cryptoKrw: new Decimal(String(s.cryptoKrw)),
        quoteCurrency: s.quoteCurrency,
      });
    }
  }

  // carry-forward + 합산
  const allExchanges = [...new Set(snapshots.map((s) => s.exchange))];
  const sortedDates = [...days.keys()].sort();
  const lastKnown = new Map<string, Entry>();

  const points: { date: string; totalKrw: number; crypto: number; cash: number }[] = [];

  for (const date of sortedDates) {
    const bucket = days.get(date)!;
    for (const [ex, v] of bucket) lastKnown.set(ex, v);

    let totalKrw = new Decimal(0);
    let crypto = new Decimal(0);
    let cash = new Decimal(0);

    for (const ex of allExchanges) {
      const v = lastKnown.get(ex);
      if (!v) continue;
      if (v.quoteCurrency === 'KRW') {
        totalKrw = totalKrw.plus(v.totalKrw);
        crypto = crypto.plus(v.cryptoKrw);
        cash = cash.plus(v.cashKrw);
      } else {
        const fx = fxAtTime(v.takenAt);
        if (fx) {
          totalKrw = totalKrw.plus(v.totalKrw.times(fx));
          crypto = crypto.plus(v.cryptoKrw.times(fx));
          cash = cash.plus(v.cashKrw.times(fx));
        }
      }
    }

    points.push({
      date,
      totalKrw: totalKrw.toDecimalPlaces(0).toNumber(),
      crypto: crypto.toDecimalPlaces(0).toNumber(),
      cash: cash.toDecimalPlaces(0).toNumber(),
    });
  }

  return NextResponse.json({ points });
}
