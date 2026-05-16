import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseStockCsv } from '@/lib/parsers/stock-csv';

export const dynamic = 'force-dynamic';

// POST: CSV 텍스트 받아서 파싱 → Transaction 테이블에 insert (idempotent).
export async function POST(req: Request) {
  const formData = await req.formData();
  const file = formData.get('csv');

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ ok: false, error: 'csv 파일이 필요합니다' }, { status: 400 });
  }

  const text = await file.text();
  const result = parseStockCsv(text);

  if (result.transactions.length === 0) {
    return NextResponse.json({
      ok: false,
      error: '파싱된 거래가 0건입니다',
      parseErrors: result.errors,
      format: result.format,
    });
  }

  // Transaction 테이블에 insert. externalId = "csv-{symbol}-{timestamp}" 로 idempotent.
  let inserted = 0;
  let skipped = 0;
  const insertErrors: string[] = [];

  for (const tx of result.transactions) {
    const externalId = `csv-${tx.assetSymbol}-${tx.timestamp.getTime()}-${tx.side}-${tx.qty}`;
    try {
      await prisma.transaction.create({
        data: {
          timestamp: tx.timestamp,
          source: 'csv',
          exchange: null,
          externalId,
          assetClass: 'stock',
          assetSymbol: tx.assetSymbol,
          side: tx.side,
          qty: tx.qty.toString(),
          price: tx.price.toString(),
          fee: tx.fee.toString(),
          currency: tx.currency,
          note: tx.name,
        },
      });
      inserted++;
    } catch (err) {
      // UNIQUE constraint = 이미 존재
      if (String(err).includes('UNIQUE')) {
        skipped++;
      } else {
        insertErrors.push(`${tx.assetSymbol} ${tx.timestamp.toISOString()}: ${String(err)}`);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    format: result.format,
    parsed: result.transactions.length,
    inserted,
    skipped,
    parseErrors: result.errors,
    insertErrors,
  });
}

// GET: 현재 저장된 주식 거래 요약
export async function GET() {
  const stocks = await prisma.transaction.findMany({
    where: { assetClass: 'stock' },
    orderBy: { timestamp: 'desc' },
    take: 200,
  });

  // 종목별 그룹핑
  const bySymbol = new Map<string, { name: string; buys: number; sells: number; totalQty: number }>();
  for (const tx of stocks) {
    const entry = bySymbol.get(tx.assetSymbol) ?? { name: tx.note ?? tx.assetSymbol, buys: 0, sells: 0, totalQty: 0 };
    if (tx.side === 'buy') {
      entry.buys++;
      entry.totalQty += Number(tx.qty);
    } else if (tx.side === 'sell') {
      entry.sells++;
      entry.totalQty -= Number(tx.qty);
    }
    bySymbol.set(tx.assetSymbol, entry);
  }

  return NextResponse.json({
    ok: true,
    totalTransactions: stocks.length,
    symbols: [...bySymbol.entries()].map(([symbol, v]) => ({
      symbol,
      name: v.name,
      buys: v.buys,
      sells: v.sells,
      remainingQty: Math.max(0, v.totalQty),
    })),
  });
}
