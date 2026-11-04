export type Role = 'BUYER' | 'SUPPLIER';
export interface User { sub: string; name: string; role: Role; org?: string }

export interface TraceStep { node: string; ms: number; detail?: string }
export interface PendingApproval { type: string; toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }> }
export interface ChatResponse {
  status: 'completed' | 'awaiting_approval';
  threadId: string;
  answer?: string;
  pending?: PendingApproval[];
  intent?: string;
  toolsUsed: string[];
  piiRedactions?: number;
  pii?: Array<{ type: string; count: number }>;
  cache: { hit: boolean; eligible: boolean; similarity?: number; matchedQuery?: string; lookupMs?: number; bestSimilarity?: number | null; stored?: boolean };
  latencyMs: number;
  trace: TraceStep[];
  llmMode: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

const TOKEN_KEY = 'procureai.token';
const USER_KEY = 'procureai.user';

export const session = {
  get token() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  get user(): User | null { try { return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null'); } catch { return null; } },
  save(token: string, user: User) { try { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* ignore */ } },
};

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (session.token) headers.set('Authorization', `Bearer ${session.token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const res = await fetch(`/api${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && session.token) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data.message ?? res.statusText, data.error);
  return data as T;
}

export const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
