import { randomBytes } from 'node:crypto';

export const shortId = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
