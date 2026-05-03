import Decimal from 'decimal.js';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

export function toKrwInt(d: Decimal | string | number): number {
  return new Decimal(d).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toNumber();
}

export function formatKrw(d: Decimal | string | number): string {
  return toKrwInt(d).toLocaleString('ko-KR') + '원';
}
