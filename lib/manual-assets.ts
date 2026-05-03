import fs from 'node:fs/promises';
import path from 'node:path';
import { Decimal } from '@/lib/decimal';

export type ManualAssets = {
  realestate?: { name: string; deposit_krw: number; loan_krw: number; as_of: string }[];
  negative_account?: { bank: string; limit_krw: number; used_krw: number; as_of: string }[];
  loan?: { name: string; principal_krw: number; balance_krw: number; interest_rate: number; as_of: string }[];
  cash?: { bank: string; balance_krw: number; as_of: string }[];
};

export async function loadManualAssets(): Promise<ManualAssets> {
  const file = path.join(process.cwd(), 'manual_assets.json');
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (err instanceof SyntaxError) {
      throw new Error(`manual_assets.json JSON parse error: ${err.message}`);
    }
    throw err;
  }
}

export type ManualBreakdown = {
  cashKrw: Decimal;
  realestateNetKrw: Decimal;
  negativeAccountKrw: Decimal;
  loanKrw: Decimal;
};

export function summarizeManual(m: ManualAssets): ManualBreakdown {
  const cashKrw = (m.cash ?? []).reduce(
    (acc, c) => acc.plus(c.balance_krw ?? 0),
    new Decimal(0),
  );
  const realestateNetKrw = (m.realestate ?? []).reduce(
    (acc, r) => acc.plus((r.deposit_krw ?? 0) - (r.loan_krw ?? 0)),
    new Decimal(0),
  );
  const negativeAccountKrw = (m.negative_account ?? []).reduce(
    (acc, n) => acc.plus(n.used_krw ?? 0),
    new Decimal(0),
  );
  const loanKrw = (m.loan ?? []).reduce(
    (acc, l) => acc.plus(l.balance_krw ?? 0),
    new Decimal(0),
  );
  return { cashKrw, realestateNetKrw, negativeAccountKrw, loanKrw };
}
