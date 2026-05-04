// 모든 보유 코인 (exchange × symbol) 의 moa 평균단가 vs 거래소 응답 avg_buy_price 비교.
import fs from 'node:fs';
import { createClient } from '@libsql/client';
import { Decimal } from 'decimal.js';

const env = fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).reduce((acc, l) => { const i = l.indexOf('='); acc[l.slice(0,i)] = l.slice(i+1).replace(/^"|"$/g,''); return acc; }, {});
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

// 1) 최신 BalanceSnapshot.rawJson → exchange holdings (실제 qty + 거래소 avg)
const snap = await db.execute(`SELECT exchange, rawJson FROM BalanceSnapshot WHERE id IN (SELECT MAX(id) FROM BalanceSnapshot GROUP BY exchange)`);
const exHoldings = new Map(); // (exchange, currency) → { qty, exchangeAvg }
for (const row of snap.rows) {
  const j = JSON.parse(row.rawJson);
  for (const h of j.holdings ?? []) {
    exHoldings.set(`${row.exchange}::${h.currency}`, {
      qty: new Decimal(h.qty),
      exchangeAvg: h.avgBuyPrice ? new Decimal(h.avgBuyPrice) : null,
    });
  }
}

// 2) Transactions per (exchange, symbol) → moving-avg 시뮬 (deposit 제외, withdraw 비례차감)
const txs = await db.execute(`SELECT exchange, assetSymbol, timestamp, side, qty, price, fee FROM "Transaction" WHERE source='exchange' ORDER BY exchange, assetSymbol, timestamp`);
const groups = new Map();
for (const t of txs.rows) {
  const key = `${t.exchange}::${t.assetSymbol}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(t);
}

console.log(`${'ex'.padEnd(8)} ${'coin'.padEnd(8)} ${'tx수'.padStart(5)} ${'trackedQty'.padStart(15)} ${'moa avg'.padStart(15)} ${'거래소 avg'.padStart(15)} ${'차이%'.padStart(8)}  ${'실제 qty'.padStart(15)}`);
console.log('-'.repeat(110));

const sorted = [...groups.entries()].sort();
for (const [key, rows] of sorted) {
  const [ex, sym] = key.split('::');
  let trackedQty = new Decimal(0), cost = new Decimal(0);
  for (const t of rows) {
    const q = new Decimal(t.qty), p = new Decimal(t.price), f = new Decimal(t.fee);
    if (q.lte(0)) continue;
    if (t.side === 'buy') {
      cost = cost.plus(q.times(p));
      trackedQty = trackedQty.plus(q);
    } else if (t.side === 'sell') {
      if (trackedQty.lte(0)) continue;
      const sellQty = Decimal.min(q, trackedQty);
      const remain = trackedQty.minus(sellQty);
      cost = cost.times(remain).div(trackedQty);
      trackedQty = remain;
    } else if (t.side === 'withdraw') {
      if (trackedQty.lte(0)) continue;
      const wQty = Decimal.min(q, trackedQty);
      const remain = trackedQty.minus(wQty);
      cost = cost.times(remain).div(trackedQty);
      trackedQty = remain;
    }
    // deposit: 변경 없음
  }
  const moaAvg = trackedQty.gt(0) ? cost.div(trackedQty) : null;
  const ex2 = exHoldings.get(key);
  const exAvg = ex2?.exchangeAvg;
  const realQty = ex2?.qty ?? null;
  const diff = moaAvg && exAvg && exAvg.gt(0) ? moaAvg.minus(exAvg).div(exAvg).times(100) : null;
  console.log(
    `${ex.padEnd(8)} ${sym.padEnd(8)} ${String(rows.length).padStart(5)} ${trackedQty.toFixed(4).padStart(15)} ${(moaAvg ? moaAvg.toFixed(0) : '-').padStart(15)} ${(exAvg ? exAvg.toFixed(0) : '-').padStart(15)} ${(diff ? (diff.gte(0) ? '+' : '') + diff.toFixed(2) : '-').padStart(8)}  ${(realQty ? realQty.toFixed(4) : '-').padStart(15)}`,
  );
}
