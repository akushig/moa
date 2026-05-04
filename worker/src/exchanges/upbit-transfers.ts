import { signUpbitJWT, buildUpbitQs } from './upbit.js';

const UPBIT_API = 'https://api.upbit.com';

// /v1/deposits 와 /v1/withdraws 응답 공통 스키마.
// type: "deposit" | "withdraw"
// state: "DONE" / "ACCEPTED" / "WAITING" 등 (대문자)
// currency: BTC, KRW, USDT, ...
// amount: 수량 (string)
// fee: 수수료 (string, withdraw 의 경우 코인 단위 network fee, deposit 은 거의 0)
// txid: blockchain tx id
// net_type: 네트워크 (BTC, ERC20, ...)
export type UpbitTransfer = {
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

async function authFetch(path: string, query: Record<string, string>): Promise<Response> {
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error('UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY not set');
  const jwt = await signUpbitJWT(accessKey, secretKey, query);
  const qs = buildUpbitQs(query);
  return fetch(`${UPBIT_API}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
}

const PER_PAGE = 100;
const MAX_PAGES = 100;
const SAFETY_OVERLAP_MS = 60 * 60 * 1000;

// 업비트:
//   - /v1/deposits 는 state 파라미터 거부 (validation_error). 모두 가져온 후
//     transferToTransaction 측 state 화이트리스트로 필터.
//   - /v1/withdraws 는 state=DONE accept.
// state 값:
//   - deposit: "ACCEPTED" (KRW, crypto 둘 다), "WAITING" 등
//   - withdraw: "DONE" 등
async function fetchPaged(
  path: '/v1/deposits' | '/v1/withdraws',
  since?: number,
): Promise<UpbitTransfer[]> {
  const out: UpbitTransfer[] = [];
  const cutoff = since !== undefined && since !== null ? since - SAFETY_OVERLAP_MS : null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query: Record<string, string> = {
      limit: String(PER_PAGE),
      page: String(page),
      order_by: 'desc',
    };
    if (path === '/v1/withdraws') query.state = 'DONE';
    const res = await authFetch(path, query);
    if (!res.ok) {
      throw new Error(`업비트 ${path} (page ${page}) ${res.status}: ${await res.text()}`);
    }
    const j = (await res.json()) as unknown;
    if (!Array.isArray(j)) {
      throw new Error(`업비트 ${path} non-array: ${JSON.stringify(j).slice(0, 200)}`);
    }
    const batch = j as UpbitTransfer[];

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

export function getUpbitDeposits(since?: number): Promise<UpbitTransfer[]> {
  return fetchPaged('/v1/deposits', since);
}

export function getUpbitWithdraws(since?: number): Promise<UpbitTransfer[]> {
  return fetchPaged('/v1/withdraws', since);
}
