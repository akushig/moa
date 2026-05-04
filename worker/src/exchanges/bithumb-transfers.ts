import { signBithumbJWT } from './bithumb.js';

const BITHUMB_API = 'https://api.bithumb.com';

// 빗썸 v2 = 업비트 호환. /v1/deposits, /v1/withdraws.
// state 종류: "DEPOSIT_ACCEPTED" / "DONE" / 등. DONE 만 적재 (실제 이체 완료).
// 단 "DEPOSIT_ACCEPTED" 도 최근 staking 보상의 경우 사용됨 — 둘 다 포함.
export type BithumbTransfer = {
  type: 'deposit' | 'withdraw';
  uuid: string;
  currency: string;
  net_type: string | null;
  txid: string | null;
  state: string;
  created_at: string;
  done_at: string | null;
  amount: string;
  fee: string;
  transaction_type?: string | null;
};

function rawQs(q: Record<string, string>): string {
  return new URLSearchParams(q).toString().replace(/%3A/g, ':').replace(/%2B/g, '+');
}

async function authFetch(path: string, query: Record<string, string>): Promise<Response> {
  const accessKey = process.env.BITHUMB_ACCESS_KEY;
  const secretKey = process.env.BITHUMB_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error('BITHUMB_ACCESS_KEY / BITHUMB_SECRET_KEY not set');
  const jwt = await signBithumbJWT(accessKey, secretKey, query);
  const qs = rawQs(query);
  return fetch(`${BITHUMB_API}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
}

const PER_PAGE = 100;
const MAX_PAGES = 100;
const SAFETY_OVERLAP_MS = 60 * 60 * 1000;

// 입금/출금 둘 다 done 외에 ACCEPTED 상태가 있어 (특히 staking 보상 입금) — 모두 포함.
// 상태 무관 모두 fetch 후 caller 가 필터링.
async function fetchPaged(
  path: '/v1/deposits' | '/v1/withdraws',
  since?: number,
): Promise<BithumbTransfer[]> {
  const out: BithumbTransfer[] = [];
  const cutoff = since !== undefined && since !== null ? since - SAFETY_OVERLAP_MS : null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await authFetch(path, {
      limit: String(PER_PAGE),
      page: String(page),
    });
    if (!res.ok) {
      throw new Error(`빗썸 ${path} (page ${page}) ${res.status}: ${await res.text()}`);
    }
    const j = (await res.json()) as unknown;
    if (!Array.isArray(j)) {
      throw new Error(`빗썸 ${path} non-array: ${JSON.stringify(j).slice(0, 200)}`);
    }
    const batch = j as BithumbTransfer[];

    if (cutoff !== null) {
      let stopped = false;
      for (const o of batch) {
        const ts = new Date(o.created_at).getTime();
        if (ts < cutoff) {
          stopped = true;
          break;
        }
        out.push(o);
      }
      if (stopped) break;
    } else {
      out.push(...batch);
    }

    if (batch.length < PER_PAGE) break;
  }
  return out;
}

export function getBithumbDeposits(since?: number): Promise<BithumbTransfer[]> {
  return fetchPaged('/v1/deposits', since);
}

export function getBithumbWithdraws(since?: number): Promise<BithumbTransfer[]> {
  return fetchPaged('/v1/withdraws', since);
}
