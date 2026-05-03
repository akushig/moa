import { Decimal } from '@/lib/decimal';
import type { UpbitKrwBreakdown } from '@/lib/exchanges/upbit';
import type { ManualBreakdown } from '@/lib/manual-assets';

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

// 총자산 = Σ(crypto 평가가 KRW) + Σ(cash) + Σ(realestate.deposit - realestate.loan)
//        - Σ(negative_account.used) - Σ(loan.balance)
export function computeTotalAssets(
  upbit: UpbitKrwBreakdown,
  manual: ManualBreakdown,
): TotalAssets {
  const parts = {
    crypto: upbit.cryptoKrw,
    cashExchange: upbit.cashKrw,
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
