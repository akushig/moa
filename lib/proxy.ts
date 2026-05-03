import { setGlobalDispatcher, ProxyAgent } from 'undici';

// Vercel + Fixie integration: HTTPS_PROXY (또는 FIXIE_URL) 가 set 되면
// 모든 outbound HTTP fetch 가 Fixie 의 static IP 통해 나감.
// 거래소 API key 화이트리스트 = Fixie 의 IP.
let configured = false;

export function ensureProxyConfigured(): { applied: boolean; host?: string } {
  if (configured) return { applied: true };
  configured = true;

  const url = process.env.FIXIE_URL ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (!url) return { applied: false };

  setGlobalDispatcher(new ProxyAgent(url));
  let host: string | undefined;
  try {
    host = new URL(url).host;
  } catch {
    host = '<unparseable>';
  }
  return { applied: true, host };
}
