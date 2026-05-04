import { describe, it, expect } from 'vitest';
import { computeCostBasis, groupCostBasis } from '@/lib/calc/cost-basis';

const t = (
  ts: number,
  side: 'buy' | 'sell' | 'deposit' | 'withdraw',
  qty: string,
  price: string,
  fee = '0',
) => ({ timestamp: ts, side, qty, price, fee });

describe('computeCostBasis (moving average)', () => {
  it('single buy → avg = price (with fee added to cost)', () => {
    const r = computeCostBasis([t(1, 'buy', '0.5', '50000000', '12500')]);
    expect(r.qty.toString()).toBe('0.5');
    expect(r.cost.toString()).toBe('25012500');
    expect(r.avgPrice.toString()).toBe('50025000');
    expect(r.realizedPnl.toString()).toBe('0');
  });

  it('two buys at different prices → weighted average', () => {
    // 0.5 BTC @ 50M + 0.5 BTC @ 70M, fee 0 → avg = 60M
    const r = computeCostBasis([
      t(1, 'buy', '0.5', '50000000'),
      t(2, 'buy', '0.5', '70000000'),
    ]);
    expect(r.qty.toString()).toBe('1');
    expect(r.avgPrice.toString()).toBe('60000000');
  });

  it('buy then sell → avg unchanged on remaining qty, realized pnl computed', () => {
    // buy 1 @ 50M, sell 0.5 @ 70M
    const r = computeCostBasis([
      t(1, 'buy', '1', '50000000'),
      t(2, 'sell', '0.5', '70000000'),
    ]);
    expect(r.qty.toString()).toBe('0.5');
    expect(r.avgPrice.toString()).toBe('50000000'); // 평균단가 유지
    // realized = (70M - 50M) × 0.5 = 10M
    expect(r.realizedPnl.toString()).toBe('10000000');
  });

  it('sell more than held → caps at held qty (data inconsistency fallback)', () => {
    const r = computeCostBasis([
      t(1, 'buy', '0.5', '50000000'),
      t(2, 'sell', '1', '60000000'),
    ]);
    expect(r.qty.toString()).toBe('0');
    // realized = (60M - 50M) × 0.5 = 5M
    expect(r.realizedPnl.toString()).toBe('5000000');
  });

  it('orders out of timestamp order → sorted ascending before processing', () => {
    const r = computeCostBasis([
      t(2, 'sell', '0.5', '70000000'),
      t(1, 'buy', '1', '50000000'),
    ]);
    expect(r.qty.toString()).toBe('0.5');
    expect(r.realizedPnl.toString()).toBe('10000000');
  });

  it('deposit increases qty without affecting cost (treated as 0-cost)', () => {
    const r = computeCostBasis([
      t(1, 'buy', '1', '50000000'),
      t(2, 'deposit', '1', '0'),
    ]);
    expect(r.qty.toString()).toBe('2');
    // cost stays 50M → avg = 25M (희석)
    expect(r.avgPrice.toString()).toBe('25000000');
  });

  it('zero-qty rows ignored', () => {
    const r = computeCostBasis([t(1, 'buy', '0', '50000000')]);
    expect(r.qty.toString()).toBe('0');
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
