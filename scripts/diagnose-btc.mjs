import fs from 'node:fs';
import { createClient } from '@libsql/client';
import { Decimal } from 'decimal.js';

const env = fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).reduce((acc, l) => { const i = l.indexOf('='); acc[l.slice(0,i)] = l.slice(i+1).replace(/^"|"$/g,''); return acc; }, {});
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

for (const ex of ['upbit', 'bithumb']) {
  const r = await db.execute({
    sql: `SELECT timestamp, side, qty, price, fee FROM "Transaction"
          WHERE source='exchange' AND exchange=? AND assetSymbol='BTC'
          ORDER BY timestamp ASC`,
    args: [ex],
  });
  // 실제 cost-basis.ts 와 동일 로직: buy fee 제외, sell fee 만 실현손익 차감.
  let qty = new Decimal(0), cost = new Decimal(0), realized = new Decimal(0);
  let buyQty = new Decimal(0), buyCostNoFee = new Decimal(0);
  let sellQty = new Decimal(0), sellGross = new Decimal(0);
  let totalFee = new Decimal(0);
  for (const t of r.rows) {
    const q = new Decimal(t.qty), p = new Decimal(t.price), f = new Decimal(t.fee);
    if (q.lte(0)) continue;
    totalFee = totalFee.plus(f);
    if (t.side === 'buy') {
      buyQty = buyQty.plus(q);
      buyCostNoFee = buyCostNoFee.plus(q.times(p));
      cost = cost.plus(q.times(p));    // ← fee 제외
      qty = qty.plus(q);
    } else if (t.side === 'sell') {
      sellQty = sellQty.plus(q);
      sellGross = sellGross.plus(q.times(p));
      const sellQ = Decimal.min(q, qty);
      const avg = qty.gt(0) ? cost.div(qty) : new Decimal(0);
      realized = realized.plus(sellQ.times(p)).minus(sellQ.times(avg)).minus(f);
      const remain = qty.minus(sellQ);
      cost = qty.gt(0) ? cost.times(remain).div(qty) : new Decimal(0);
      qty = remain;
    }
  }
  console.log(`\n=== ${ex} BTC ===`);
  console.log('  rows=', r.rows.length, ' buys=', buyQty.toString(), ' sells=', sellQty.toString());
  console.log('  net qty (buys - sells) =', buyQty.minus(sellQty).toFixed(8));
  console.log('  current qty (orders 기준)=', qty.toFixed(8));
  console.log('  total fee paid =', totalFee.toFixed(2), 'KRW');
  console.log('  buy avg (no fee)        =', buyQty.gt(0) ? buyCostNoFee.div(buyQty).toFixed(0) : '-');
  console.log('  moving-avg cost remaining =', cost.toFixed(0));
  console.log('  moving-avg avg (no fee) = ', qty.gt(0) ? cost.div(qty).toFixed(0) : '-');
  console.log('  realized PnL =', realized.toFixed(0));
}

// 현재 잔고 (BalanceSnapshot 최신 rawJson 에서 BTC qty)
const snap = await db.execute(`SELECT exchange, rawJson FROM BalanceSnapshot WHERE id IN (SELECT MAX(id) FROM BalanceSnapshot GROUP BY exchange)`);
console.log('\n=== current holdings BTC ===');
for (const row of snap.rows) {
  const j = JSON.parse(row.rawJson);
  const btc = j.holdings.find(h => h.currency === 'BTC');
  if (btc) console.log(' ', row.exchange, 'qty=', btc.qty, 'avg(거래소 응답)=', btc.avgBuyPrice);
}
