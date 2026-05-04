import fs from 'node:fs';
import { createClient } from '@libsql/client';
import { Decimal } from 'decimal.js';

const env = fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).reduce((acc, l) => { const i = l.indexOf('='); acc[l.slice(0,i)] = l.slice(i+1).replace(/^"|"$/g,''); return acc; }, {});
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

const r = await db.execute(`
  SELECT timestamp, side, qty, price, fee FROM "Transaction"
  WHERE source='exchange' AND exchange='bithumb' AND assetSymbol='BTC'
  ORDER BY timestamp ASC
`);
console.log('=== bithumb BTC orders chronological ===');
let buyQty = new Decimal(0), sellQty = new Decimal(0);
for (const t of r.rows) {
  const date = new Date(Number(t.timestamp)).toISOString().slice(0,10);
  const q = new Decimal(t.qty), p = new Decimal(t.price);
  console.log(`  ${date} ${t.side.padEnd(4)} ${q.toFixed(8)} @ ${p.toFixed(0).padStart(12)} = ${q.times(p).toFixed(0).padStart(12)}`);
  if (t.side === 'buy') buyQty = buyQty.plus(q);
  else if (t.side === 'sell') sellQty = sellQty.plus(q);
}
console.log(`\n  total buys ${buyQty.toFixed(8)}  total sells ${sellQty.toFixed(8)}`);

// FIFO simulation
console.log('\n=== FIFO simulation (no fee) ===');
const lots = []; // {qty, price}
for (const t of r.rows) {
  const q = new Decimal(t.qty), p = new Decimal(t.price);
  if (q.lte(0)) continue;
  if (t.side === 'buy') {
    lots.push({ qty: q, price: p });
  } else if (t.side === 'sell') {
    let remaining = q;
    while (remaining.gt(0) && lots.length > 0) {
      const lot = lots[0];
      const take = Decimal.min(remaining, lot.qty);
      lot.qty = lot.qty.minus(take);
      remaining = remaining.minus(take);
      if (lot.qty.lte(0)) lots.shift();
    }
  }
}
let fifoCost = new Decimal(0), fifoQty = new Decimal(0);
for (const lot of lots) {
  fifoCost = fifoCost.plus(lot.qty.times(lot.price));
  fifoQty = fifoQty.plus(lot.qty);
}
console.log('  FIFO remaining qty=', fifoQty.toFixed(8));
console.log('  FIFO cost =', fifoCost.toFixed(0));
console.log('  FIFO avg = ', fifoQty.gt(0) ? fifoCost.div(fifoQty).toFixed(0) : '-');

// LIFO simulation
console.log('\n=== LIFO simulation (no fee) ===');
const lots2 = [];
for (const t of r.rows) {
  const q = new Decimal(t.qty), p = new Decimal(t.price);
  if (q.lte(0)) continue;
  if (t.side === 'buy') {
    lots2.push({ qty: q, price: p });
  } else if (t.side === 'sell') {
    let remaining = q;
    while (remaining.gt(0) && lots2.length > 0) {
      const lot = lots2[lots2.length - 1];
      const take = Decimal.min(remaining, lot.qty);
      lot.qty = lot.qty.minus(take);
      remaining = remaining.minus(take);
      if (lot.qty.lte(0)) lots2.pop();
    }
  }
}
let lifoCost = new Decimal(0), lifoQty = new Decimal(0);
for (const lot of lots2) {
  lifoCost = lifoCost.plus(lot.qty.times(lot.price));
  lifoQty = lifoQty.plus(lot.qty);
}
console.log('  LIFO remaining qty=', lifoQty.toFixed(8));
console.log('  LIFO cost =', lifoCost.toFixed(0));
console.log('  LIFO avg = ', lifoQty.gt(0) ? lifoCost.div(lifoQty).toFixed(0) : '-');

// Cost-recovery: total buy cost - total sell gross / remaining qty
console.log('\n=== Cost-recovery (총매수금액 - 총매도금액) / 보유수량 ===');
let totalBuy = new Decimal(0), totalSell = new Decimal(0);
let remainQty = new Decimal(0);
for (const t of r.rows) {
  const q = new Decimal(t.qty), p = new Decimal(t.price);
  if (t.side === 'buy') { totalBuy = totalBuy.plus(q.times(p)); remainQty = remainQty.plus(q); }
  else if (t.side === 'sell') { totalSell = totalSell.plus(q.times(p)); remainQty = remainQty.minus(q); }
}
const cr = totalBuy.minus(totalSell);
console.log('  total buy=', totalBuy.toFixed(0), '  total sell=', totalSell.toFixed(0));
console.log('  cost-recovery cost=', cr.toFixed(0), '  remain qty=', remainQty.toFixed(8));
console.log('  cost-recovery avg = ', remainQty.gt(0) ? cr.div(remainQty).toFixed(0) : '-');

console.log('\n=== for comparison ===');
console.log('  bithumb display avg = 125,557,124');
console.log('  bithumb actual qty  = 0.5930238');
console.log('  → bithumb implied cost = 0.5930238 × 125,557,124 =', new Decimal('0.5930238').times('125557124').toFixed(0));
