import { PrismaClient } from '@prisma/client';
import { PrismaLibSQL } from '@prisma/adapter-libsql';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function buildClient(): PrismaClient {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    throw new Error('TURSO_DATABASE_URL not set (Vercel env or .env.local)');
  }
  const adapter = new PrismaLibSQL({ url, authToken });
  return new PrismaClient({ adapter });
}

// Lazy proxy: 빌드 시 page data collection 등 prisma method 를 부르지 않는
// 코드 경로에서는 인스턴스를 만들지 않는다. (Vercel build 시점에 secrets 가
// 없는 환경에서도 build 자체는 통과시키기 위함.)
export const prisma = new Proxy({} as PrismaClient, {
  get(_t, prop, receiver) {
    const client = globalThis.__prisma ?? buildClient();
    if (process.env.NODE_ENV !== 'production') globalThis.__prisma = client;
    return Reflect.get(client, prop, receiver);
  },
}) as PrismaClient;
