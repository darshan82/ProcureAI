/**
 * Stripe-style webhook signatures: header `X-ProcureAI-Signature: t=<unix>,v1=<hex hmac>`
 * where v1 = HMAC_SHA256(secret, `${t}.${rawBody}`). Receivers reject stale timestamps (replay attacks)
 * and compare in constant time. Customers get this snippet in docs/INTEGRATIONS.md.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export function verify(secret: string, body: string, header: string | undefined, toleranceSec = 300): { ok: boolean; reason?: string } {
  if (!header) return { ok: false, reason: 'missing signature' };
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) return { ok: false, reason: 'malformed signature' };
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return { ok: false, reason: 'timestamp outside tolerance' };
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  const given = Buffer.from(parts.v1);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}
