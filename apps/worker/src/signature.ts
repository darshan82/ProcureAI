import { createHmac } from 'node:crypto';

/** `t=<unix>,v1=<HMAC_SHA256(secret, "<t>.<body>")>` (same scheme the API's receiver verifies). */
export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}
