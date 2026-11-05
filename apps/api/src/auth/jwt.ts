import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { Role, UserContext } from '../agent/state.js';

/**
 * Demo identities across two customer tenants plus a platform operator (ADMIN).
 * In production this is replaced by the customer's IdP (Entra ID / Okta / Cognito) via OIDC,
 * mapping an IdP group claim to role and the issuer/org claim to tenantId.
 */
export const DEMO_USERS: Record<string, { name: string; role: Role; tenantId: string; org: string }> = {
  'buyer@acme.test': { name: 'Bella Buyer', role: 'BUYER', tenantId: 'acme', org: 'ACME Corp' },
  'supplier@globex.test': { name: 'Sam Supplier', role: 'SUPPLIER', tenantId: 'acme', org: 'Globex Ltd (ACME supplier)' },
  'supplier@initech.test': { name: 'Ivy Initech', role: 'SUPPLIER', tenantId: 'acme', org: 'Initech (ACME supplier)' },
  'buyer@umbrella.test': { name: 'Uma Umbrella', role: 'BUYER', tenantId: 'umbrella', org: 'Umbrella Health' },
  'supplier@stark.test': { name: 'Tony Stark', role: 'SUPPLIER', tenantId: 'umbrella', org: 'Stark Medical (Umbrella supplier)' },
  'admin@procureai.test': { name: 'Fran FDE', role: 'ADMIN', tenantId: 'platform', org: 'ProcureAI platform team' },
};

export function signToken(user: UserContext): string {
  return jwt.sign({ name: user.name, role: user.role, tid: user.tenantId }, config.jwtSecret, {
    subject: user.sub,
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
    issuer: 'procurement-api',
  });
}

export function verifyToken(token: string): UserContext {
  const p = jwt.verify(token, config.jwtSecret, { issuer: 'procurement-api' }) as jwt.JwtPayload;
  if (!p.sub || !['BUYER', 'SUPPLIER', 'ADMIN'].includes(p.role) || typeof p.tid !== 'string') throw new Error('Invalid token claims');
  return { sub: p.sub, name: String(p.name ?? p.sub), role: p.role, tenantId: p.tid };
}
