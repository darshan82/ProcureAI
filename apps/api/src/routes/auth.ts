import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { DEMO_USERS, signToken } from '../auth/jwt.js';
import { HttpError } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post('/login', (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'email and password are required', 'bad_request');
  const email = parsed.data.email.toLowerCase();
  const u = DEMO_USERS[email];
  if (!u || parsed.data.password !== config.demoPassword) throw new HttpError(401, 'Invalid credentials', 'unauthorized');
  const user = { sub: email, name: u.name, role: u.role, tenantId: u.tenantId };
  res.json({ token: signToken(user), user: { ...user, org: u.org } });
});

authRouter.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

authRouter.get('/demo-users', (_req, res) => {
  res.json({ users: Object.entries(DEMO_USERS).map(([email, u]) => ({ email, ...u })) });
});
