import { useState } from 'react';
import { post, session, type User } from '../api';

const DEMO = [
  { email: 'buyer@acme.test', title: 'Buyer', org: 'ACME Corp', desc: 'Create tenders, compare bids, award with approval' },
  { email: 'supplier@globex.test', title: 'Supplier', org: 'Globex Ltd', desc: 'Browse tenders and submit bid proposals' },
];

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState(DEMO[0].email);
  const [password, setPassword] = useState('demo123');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e?: React.FormEvent, asEmail = email) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await post<{ token: string; user: User }>('/auth/login', { email: asEmail, password });
      session.save(r.token, r.user);
      onLogin(r.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand big"><span className="logo">✓</span> ProcureAI</div>
        <p className="muted">Enterprise procurement agent: LangGraph, guardrails, RBAC, RAG and semantic caching.</p>
        <div className="persona-grid">
          {DEMO.map((d) => (
            <button key={d.email} className="persona" disabled={busy} onClick={() => submit(undefined, d.email)}>
              <strong>{d.title}</strong>
              <span className="muted small">{d.org}</span>
              <span className="small">{d.desc}</span>
            </button>
          ))}
        </div>
        <div className="divider"><span>or sign in</span></div>
        <form onSubmit={submit} className="stack">
          <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
          {error && <div className="alert error">{error}</div>}
          <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="muted small">Demo password: <code>demo123</code></p>
        </form>
      </div>
    </div>
  );
}
