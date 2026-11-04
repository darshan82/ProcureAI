import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { Role, UserContext } from '../agent/state.js';

/** Demo identities. In production this is replaced by your IdP (Cognito / Entra ID / Okta) via OIDC. */
export const DEMO_USERS: Record<string, { name: string; role: Role; org: string }> = {
  'buyer@acme.test': { name: 'Bella Buyer', role: 'BUYER', org: 'ACME Corp' },
  'supplier@globex.test': { name: 'Sam Supplier', role: 'SUPPLIER', org: 'Globex Ltd' },
  'supplier@initech.test': { name: 'Ivy Initech', role: 'SUPPLIER', org: 'Initech' },
};

export function signToken(user: UserContext): string {
  return jwt.sign({ name: user.name, role: user.role }, config.jwtSecret, {
    subject: user.sub,
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
    issuer: 'procurement-api',
  });
}

export function verifyToken(token: string): UserContext {
  const p = jwt.verify(token, config.jwtSecret, { issuer: 'procurement-api' }) as jwt.JwtPayload;
  if (!p.sub || (p.role !== 'BUYER' && p.role !== 'SUPPLIER')) throw new Error('Invalid token claims');
  return { sub: p.sub, name: String(p.name ?? p.sub), role: p.role };
}
