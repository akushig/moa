// /sapi/v1/capital/deposit/hisrec + /sapi/v1/capital/withdraw/history.
// 양쪽 모두 startTime/endTime 90일 max window 라 multi-window walk.
import { binanceAuthFetch } from './binance-auth';

export type BinanceDeposit = {
  id: string;
  amount: string;
  coin: string;
  network: string;
  status: number; // 0=pending, 1=success, 6=credited (잔고 반영)
  address: string;
  txId: string;
  insertTime: number; // epoch ms
  transferType: number; // 0=external, 1=internal
};

export type BinanceWithdraw = {
  id: string;
  amount: string;
  transactionFee: string;
  coin: string;
  status: number; // 6=success
  address: string;
  txId: string;
  applyTime: string; // 'YYYY-MM-DD HH:MM:SS' UTC
  completeTime?: string;
  network: string;
  transferType: number;
};

const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const SAFETY_OVERLAP_MS = 60 * 60 * 1000;
const MAX_BACKWARD_WINDOWS = 24; // 약 6년치 backfill

async function walkWindows<T>(
  fetchWindow: (start: number, end: number) => Promise<T[]>,
  since?: number,
): Promise<T[]> {
  const out: T[] = [];
  const now = Date.now();
  if (since !== undefined && since !== null) {
    let start = Math.max(0, since - SAFETY_OVERLAP_MS);
    while (start < now) {
      const end = Math.min(start + WINDOW_MS, now);
      out.push(...(await fetchWindow(start, end)));
      start = end;
    }
    return out;
  }
  let end = now;
  for (let i = 0; i < MAX_BACKWARD_WINDOWS; i += 1) {
    const start = Math.max(0, end - WINDOW_MS);
    out.push(...(await fetchWindow(start, end)));
    if (start === 0) break;
    end = start;
  }
  return out;
}

export async function getBinanceDeposits(since?: number): Promise<BinanceDeposit[]> {
  return walkWindows(async (start, end) => {
    const res = await binanceAuthFetch('/sapi/v1/capital/deposit/hisrec', {
      startTime: String(start),
      endTime: String(end),
    });
    if (!res.ok) {
      throw new Error(`Binance deposit/hisrec ${res.status}: ${await res.text()}`);
    }
    const arr = (await res.json()) as BinanceDeposit[];
    return Array.isArray(arr) ? arr.filter((d) => d.status === 1 || d.status === 6) : [];
  }, since);
}

export async function getBinanceWithdraws(since?: number): Promise<BinanceWithdraw[]> {
  return walkWindows(async (start, end) => {
    const res = await binanceAuthFetch('/sapi/v1/capital/withdraw/history', {
      startTime: String(start),
      endTime: String(end),
    });
    if (!res.ok) {
      throw new Error(`Binance withdraw/history ${res.status}: ${await res.text()}`);
    }
    const arr = (await res.json()) as BinanceWithdraw[];
    return Array.isArray(arr) ? arr.filter((w) => w.status === 6) : [];
  }, since);
}
