import { describe, it, expect } from 'vitest';
import { Decimal } from '@/lib/decimal';
import { computeTotalAssets } from '@/lib/calc/total-assets';
import { summarizeManual, type ManualAssets } from '@/lib/manual-assets';

describe('computeTotalAssets', () => {
  it('sums positive and subtracts negative liabilities', () => {
    const upbit = {
      totalKrw: new Decimal(15_000_000),
      cashKrw: new Decimal(5_000_000),
      cryptoKrw: new Decimal(10_000_000),
      unpriced: [],
    };
    const manual = summarizeManual({
      cash: [{ bank: 'KB', balance_krw: 8_000_000, as_of: '2026-05-01' }],
      realestate: [
        { name: '전세', deposit_krw: 500_000_000, loan_krw: 300_000_000, as_of: '2026-05-01' },
      ],
      negative_account: [
        { bank: '토스', limit_krw: 50_000_000, used_krw: 12_000_000, as_of: '2026-05-01' },
      ],
      loan: [
        {
          name: '주택담보',
          principal_krw: 250_000_000,
          balance_krw: 230_000_000,
          interest_rate: 0.045,
          as_of: '2026-05-01',
        },
      ],
    });
    const r = computeTotalAssets([upbit], manual);
    // crypto 1000만 + cashExchange 500만 + cashManual 800만 + 부동산순(2억) - 마통(1200만) - 대출(2.3억) = -2300만
    expect(r.totalKrw.toString()).toBe(
      new Decimal(10_000_000)
        .plus(5_000_000)
        .plus(8_000_000)
        .plus(200_000_000)
        .minus(12_000_000)
        .minus(230_000_000)
        .toString(),
    );
    expect(r.totalKrw.toNumber()).toBe(-19_000_000);
  });

  it('handles empty manual assets', () => {
    const upbit = {
      totalKrw: new Decimal(0),
      cashKrw: new Decimal(0),
      cryptoKrw: new Decimal(0),
      unpriced: [],
    };
    const manual = summarizeManual({});
    const r = computeTotalAssets([upbit], manual);
    expect(r.totalKrw.toNumber()).toBe(0);
  });

  it('preserves BTC-precision summation (8 decimal places × KRW price)', () => {
    // 0.00012345 BTC × 100,000,000 KRW = 12,345 KRW
    const upbit = {
      totalKrw: new Decimal('12345'),
      cashKrw: new Decimal(0),
      cryptoKrw: new Decimal('0.00012345').times('100000000'),
      unpriced: [],
    };
    const manual = summarizeManual({});
    const r = computeTotalAssets([upbit], manual);
    expect(r.totalKrw.toString()).toBe('12345');
  });

  it('sums across multiple exchanges (upbit + bithumb)', () => {
    const upbit = {
      totalKrw: new Decimal(15_000_000),
      cashKrw: new Decimal(5_000_000),
      cryptoKrw: new Decimal(10_000_000),
      unpriced: [],
    };
    const bithumb = {
      totalKrw: new Decimal(7_500_000),
      cashKrw: new Decimal(500_000),
      cryptoKrw: new Decimal(7_000_000),
      unpriced: [],
    };
    const manual = summarizeManual({});
    const r = computeTotalAssets([upbit, bithumb], manual);
    expect(r.parts.crypto.toNumber()).toBe(17_000_000);
    expect(r.parts.cashExchange.toNumber()).toBe(5_500_000);
    expect(r.totalKrw.toNumber()).toBe(22_500_000);
  });

  it('treats missing fields in manual assets as 0', () => {
    const m: ManualAssets = {
      cash: [{ bank: 'KB', balance_krw: 1_000_000, as_of: '2026-05-01' }],
    };
    const summary = summarizeManual(m);
    expect(summary.cashKrw.toNumber()).toBe(1_000_000);
    expect(summary.realestateNetKrw.toNumber()).toBe(0);
    expect(summary.negativeAccountKrw.toNumber()).toBe(0);
    expect(summary.loanKrw.toNumber()).toBe(0);
  });
});
