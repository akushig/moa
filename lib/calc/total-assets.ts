import { Decimal } from '@/lib/decimal';
import type { ManualBreakdown } from '@/lib/manual-assets';

export type ExchangeBreakdown = {
  totalKrw: Decimal;
  cashKrw: Decimal;
  cryptoKrw: Decimal;
  unpriced: { currency: string; balance: string }[];
};

export type TotalAssets = {
  totalKrw: Decimal;
  parts: {
    crypto: Decimal;
    cashExchange: Decimal;
    cashManual: Decimal;
    realestateNet: Decimal;
    negativeAccount: Decimal;
    loan: Decimal;
  };
};

// 총자산 = Σ(crypto KRW) + Σ(cash) + Σ(realestate.deposit - realestate.loan)
//        - Σ(negative_account.used) - Σ(loan.balance)
export function computeTotalAssets(
  exchanges: ExchangeBreakdown[],
  manual: ManualBreakdown,
): TotalAssets {
  const zero = new Decimal(0);
  const crypto = exchanges.reduce((a, e) => a.plus(e.cryptoKrw), zero);
  const cashExchange = exchanges.reduce((a, e) => a.plus(e.cashKrw), zero);

  const parts = {
    crypto,
    cashExchange,
    cashManual: manual.cashKrw,
    realestateNet: manual.realestateNetKrw,
    negativeAccount: manual.negativeAccountKrw,
    loan: manual.loanKrw,
  };
  const totalKrw = parts.crypto
    .plus(parts.cashExchange)
    .plus(parts.cashManual)
    .plus(parts.realestateNet)
    .minus(parts.negativeAccount)
    .minus(parts.loan);
  return { totalKrw, parts };
}
