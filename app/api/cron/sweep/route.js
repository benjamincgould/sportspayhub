// Daily clean-up (3am NZ), called by Vercel Cron (see vercel.json). Vercel sends CRON_SECRET as a bearer
// token, so nobody else can trigger it.
import crypto from 'node:crypto';
import { getApp } from '../../../../lib/server/instance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const same = (a, b) => {
  const A = crypto.createHash('sha256').update(String(a)).digest();
  const B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
};

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !same(request.headers.get('authorization') || '', `Bearer ${secret}`)) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  return Response.json(await getApp().sweep());
}
