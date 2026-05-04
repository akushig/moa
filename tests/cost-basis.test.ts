import { describe, it, expect } from 'vitest';
import { computeCostBasis, groupCostBasis } from '@/lib/calc/cost-basis';

const t = (
  ts: number,
  side: 'buy' | 'sell' | 'deposit' | 'withdraw',
  qty: string,
  price: string,
  fee = '0',
) => ({ timestamp: ts, side, qty, price, fee });

describe('computeCostBasis (moving average, exchange-style)', () => {
  it('single buy → avg = price (fee NOT included in cost)', () => {
    const r = computeCostBasis([t(1, 'buy', '0.5', '50000000', '12500')]);
    expect(r.trackedQty.toString()).toBe('0.5');
    expect(r.cost.toString()).toBe('25000000');
    expect(r.avgPrice.toString()).toBe('50000000');
    expect(r.realizedPnl.toString()).toBe('0');
  });

  it('two buys at different prices → weighted average', () => {
    const r = computeCostBasis([
      t(1, 'buy', '0.5', '50000000'),
      t(2, 'buy', '0.5', '70000000'),
    ]);
    expect(r.trackedQty.toString()).toBe('1');
    expect(r.avgPrice.toString()).toBe('60000000');
  });

  it('buy then sell → avg unchanged on remaining qty, realized pnl computed', () => {
    const r = computeCostBasis([
      t(1, 'buy', '1', '50000000'),
      t(2, 'sell', '0.5', '70000000'),
    ]);
    expect(r.trackedQty.toString()).toBe('0.5');
    expect(r.avgPrice.toString()).toBe('50000000');
    // realized = (70M - 50M) × 0.5 = 10M
    expect(r.realizedPnl.toString()).toBe('10000000');
  });

  it('sell more than tracked → caps at tracked qty', () => {
    const r = computeCostBasis([
      t(1, 'buy', '0.5', '50000000'),
      t(2, 'sell', '1', '60000000'),
    ]);
    expect(r.trackedQty.toString()).toBe('0');
    expect(r.realizedPnl.toString()).toBe('5000000');
  });

  it('orders out of timestamp order → sorted ascending before processing', () => {
    const r = computeCostBasis([
      t(2, 'sell', '0.5', '70000000'),
      t(1, 'buy', '1', '50000000'),
    ]);
    expect(r.trackedQty.toString()).toBe('0.5');
    expect(r.realizedPnl.toString()).toBe('10000000');
  });

  it('deposit with price=0 does NOT affect avg (no historical price)', () => {
    const r = computeCostBasis([
      t(1, 'buy', '1', '50000000'),
      t(2, 'deposit', '1', '0'),
    ]);
    expect(r.trackedQty.toString()).toBe('1');
    expect(r.avgPrice.toString()).toBe('50000000');
    expect(r.depositQty.toString()).toBe('1');
  });

  it('deposit with price>0 (fair-value) treated like buy → avg dilutes', () => {
    // buy 1 BTC @ 50M, deposit 1 BTC @ 60M (시점 시장가). avg = 55M
    const r = computeCostBasis([
      t(1, 'buy', '1', '50000000'),
      t(2, 'deposit', '1', '60000000'),
    ]);
    expect(r.trackedQty.toString()).toBe('2');
    expect(r.cost.toString()).toBe('110000000');
    expect(r.avgPrice.toString()).toBe('55000000');
    expect(r.depositQty.toString()).toBe('1');
  });

  it('withdraw reduces cost proportionally + trackedQty (no realized event)', () => {
    // buy 1 BTC @ 50M (cost=50M), withdraw 0.5 BTC → trackedQty=0.5, cost=25M, avg=50M
    const r = computeCostBasis([
      t(1, 'buy', '1', '50000000'),
      t(2, 'withdraw', '0.5', '0'),
    ]);
    expect(r.trackedQty.toString()).toBe('0.5');
    expect(r.avgPrice.toString()).toBe('50000000'); // proportional → avg unchanged
    expect(r.cost.toString()).toBe('25000000');
    expect(r.withdrawQty.toString()).toBe('0.5');
    expect(r.realizedPnl.toString()).toBe('0'); // withdrawal is not a realization
  });

  it('zero-qty rows ignored', () => {
    const r = computeCostBasis([t(1, 'buy', '0', '50000000')]);
    expect(r.trackedQty.toString()).toBe('0');
    expect(r.avgPrice.toString()).toBe('0');
  });
});

describe('groupCostBasis', () => {
  it('groups by (exchange, assetSymbol)', () => {
    const txs = [
      { ...t(1, 'buy', '1', '50000000'), exchange: 'upbit', assetSymbol: 'BTC' },
      { ...t(2, 'buy', '1', '60000000'), exchange: 'bithumb', assetSymbol: 'BTC' },
      { ...t(3, 'buy', '10', '4000000'), exchange: 'upbit', assetSymbol: 'ETH' },
    ];
    const g = groupCostBasis(txs);
    expect(g.size).toBe(3);
    expect(g.get('upbit::BTC')!.avgPrice.toString()).toBe('50000000');
    expect(g.get('bithumb::BTC')!.avgPrice.toString()).toBe('60000000');
    expect(g.get('upbit::ETH')!.avgPrice.toString()).toBe('4000000');
  });
});
