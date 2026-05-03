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

export const prisma = globalThis.__prisma ?? buildClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}
