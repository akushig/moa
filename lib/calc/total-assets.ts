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
    exchangeDebt: Decimal; // 거래소 측 부채 (binance Crypto Loan totalDebt 등). KRW 환산.
  };
};

// 총자산 = Σ(crypto KRW) + Σ(cash) + Σ(realestate.deposit - realestate.loan)
//        - Σ(negative_account.used) - Σ(manual loan.balance) - Σ(exchange debt KRW)
//
// exchangeDebtKrw 는 caller 가 환산 (binance 빌린 USDT × FxRate 등) 후 전달.
export function computeTotalAssets(
  exchanges: ExchangeBreakdown[],
  manual: ManualBreakdown,
  exchangeDebtKrw: Decimal = new Decimal(0),
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
    exchangeDebt: exchangeDebtKrw,
  };
  const totalKrw = parts.crypto
    .plus(parts.cashExchange)
    .plus(parts.cashManual)
    .plus(parts.realestateNet)
    .minus(parts.negativeAccount)
    .minus(parts.loan)
    .minus(parts.exchangeDebt);
  return { totalKrw, parts };
}
