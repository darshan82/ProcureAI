export type Role = 'BUYER' | 'SUPPLIER' | 'ADMIN';
export interface User { sub: string; name: string; role: Role; tenantId: string; org?: string }

export interface TraceStep { node: string; ms: number; detail?: string }
export interface PendingApproval { type: string; toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown>; reason?: string | null }> }
export interface Usage { inputTokens: number; outputTokens: number; costUsd: number; llmCalls: number; models: string[]; fallbacks: string[] }
export interface ChatResponse {
  status: 'completed' | 'awaiting_approval';
  threadId: string;
  answer?: string;
  pending?: PendingApproval[];
  intent?: string;
  toolsUsed: string[];
  piiRedactions?: number;
  pii?: Array<{ type: string; count: number }>;
  usage?: Usage;
  cache: { hit: boolean; eligible: boolean; similarity?: number; matchedQuery?: string; lookupMs?: number; bestSimilarity?: number | null; stored?: boolean; threshold?: number };
  latencyMs: number;
  trace: TraceStep[];
  llmMode: string;
  tenantId?: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

const TOKEN_KEY = 'procureai.token';
const USER_KEY = 'procureai.user';

export const session = {
  get token() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  get user(): User | null {
    try {
      const u = JSON.parse(localStorage.getItem(USER_KEY) ?? 'null');
      return u?.tenantId ? u : null; // ignore sessions from before multi-tenancy
    } catch { return null; }
  },
  save(token: string, user: User) { try { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch { /* ignore */ } },
};

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

function headers(init: RequestInit) {
  const h = new Headers(init.headers);
  if (session.token) h.set('Authorization', `Bearer ${session.token}`);
  if (init.body && !(init.body instanceof FormData)) h.set('Content-Type', 'application/json');
  return h;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: headers(init) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && session.token) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data.message ?? res.statusText, data.error);
  return data as T;
}

export const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

/** POST + Server-Sent Events over fetch (EventSource can't send a body or auth header). */
export async function streamChat(
  body: { message: string; threadId?: string },
  on: { step?: (s: TraceStep) => void; token?: (t: string) => void },
): Promise<ChatResponse> {
  const init: RequestInit = { method: 'POST', body: JSON.stringify(body) };
  const res = await fetch('/api/chat/stream', { ...init, headers: headers(init) });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && session.token) onUnauthorized();
    throw new ApiError(res.status, data.message ?? res.statusText, data.error);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = frame.match(/^event: (.*)$/m)?.[1];
      const dataLine = frame.match(/^data: (.*)$/m)?.[1];
      if (!event || !dataLine) continue;
      const data = JSON.parse(dataLine);
      if (event === 'step') on.step?.(data);
      else if (event === 'token') on.token?.(data.text);
      else if (event === 'result') return data as ChatResponse;
      else if (event === 'error') throw new ApiError(data.status, data.message, data.error);
    }
  }
  throw new ApiError(502, 'Stream ended without a result');
}
