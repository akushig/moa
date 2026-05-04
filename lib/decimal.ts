import Decimal from 'decimal.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

export function toKrwInt(d: Decimal | string | number): number {
  return new Decimal(d).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toNumber();
}

export function formatKrw(d: Decimal | string | number): string {
  return toKrwInt(d).toLocaleString('ko-KR') + '원';
}

// 통화별 포맷. KRW = 원화 정수. 그 외 (USDT, USDC, ...) = 소수 2자리 + suffix.
export function formatQuote(d: Decimal | string | number, quote: string): string {
  if (quote === 'KRW') return formatKrw(d);
  const decimals = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'TUSD'].includes(quote) ? 2 : 4;
  const v = new Decimal(d).toDecimalPlaces(decimals, Decimal.ROUND_HALF_EVEN);
  return `${v.toNumber().toLocaleString('ko-KR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} ${quote}`;
}
