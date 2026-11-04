import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../auth/jwt.js';
import { HttpError } from '../lib/errors.js';
import type { Role, UserContext } from '../agent/state.js';

declare global {
  namespace Express {
    interface Request {
      user?: UserContext;
      requestId?: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return next(new HttpError(401, 'Missing bearer token', 'unauthorized'));
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token', 'unauthorized'));
  }
}

/** RBAC gate for routes. Tools additionally enforce roles internally. */
export const requireRole = (...roles: Role[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(new HttpError(401, 'Unauthenticated', 'unauthorized'));
  if (!roles.includes(req.user.role)) {
    return next(new HttpError(403, `Role ${req.user.role} is not allowed; requires ${roles.join(' or ')}`, 'forbidden'));
  }
  next();
};
