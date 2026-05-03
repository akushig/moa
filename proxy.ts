import { NextRequest, NextResponse } from 'next/server';

export function proxy(req: NextRequest) {
  const expected = process.env.BASIC_AUTH_PASSWORD;
  if (!expected) {
    return new NextResponse('BASIC_AUTH_PASSWORD not set', { status: 500 });
  }
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Basic ')) {
    const decoded = atob(auth.slice('Basic '.length));
    const [, pw] = decoded.split(':');
    if (pw === expected) return NextResponse.next();
  }
  return new NextResponse('Auth required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="moa"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
