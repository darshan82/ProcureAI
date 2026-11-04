import { useEffect, useState } from 'react';
import { api, type User } from '../api';

interface Stats { entries: number; hits: number; misses: number; threshold: number; index: string; guardrailBlocked: number; llmMode: string }
interface Ready { status: string; checks: Record<string, string>; llm: { mode: string; model: string; embeddings: string }; langsmith: string }
interface AuditEvent { event: string; actor: string; role: string; data: Record<string, unknown>; at: string }

export default function Ops({ user }: { user: User }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);

  const load = () => {
    api<Stats>('/chat/cache/stats').then(setStats).catch(() => {});
    api<Ready>('/ready').then(setReady).catch(() => {});
    if (user.role === 'BUYER') api<{ events: AuditEvent[] }>('/audit').then((r) => setAudit(r.events)).catch(() => {});
  };
  useEffect(() => { load(); }, [user.role]); // eslint-disable-line react-hooks/exhaustive-deps

  const hitRate = stats && stats.hits + stats.misses > 0 ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100) : 0;

  return (
    <section className="page">
      <header className="page-head">
        <div><h1>Platform</h1><p className="muted">Health, semantic cache, guardrails and audit trail.</p></div>
        <div className="row">
          {user.role === 'BUYER' && <button className="btn ghost" onClick={() => api('/chat/cache', { method: 'DELETE' }).then(load)}>Flush cache</button>}
          <button className="btn ghost" onClick={load}>Refresh</button>
        </div>
      </header>

      <div className="tiles">
        <Tile label="LLM" value={ready?.llm.mode === 'openai' ? ready.llm.model : 'Mock (no key)'} sub={ready?.llm.embeddings} />
        <Tile label="Cache hit rate" value={`${hitRate}%`} sub={`${stats?.hits ?? 0} hits · ${stats?.misses ?? 0} misses`} />
        <Tile label="Cached answers" value={String(stats?.entries ?? 0)} sub={`threshold ≥ ${stats?.threshold ?? '–'}`} />
        <Tile label="Guardrail blocks" value={String(stats?.guardrailBlocked ?? 0)} sub="prompt-injection attempts" />
      </div>

      <div className="card">
        <h2>Dependencies</h2>
        <ul className="plain">
          {ready && Object.entries(ready.checks).map(([k, v]) => <li key={k}><span className={`dot ${v === 'ok' ? 'ok' : 'bad'}`} /> {k}: {v}</li>)}
          <li><span className={`dot ${ready?.langsmith === 'enabled' ? 'ok' : 'off'}`} /> LangSmith tracing: {ready?.langsmith ?? '–'}</li>
        </ul>
      </div>

      {user.role === 'BUYER' && (
        <div className="card">
          <h2>Audit log</h2>
          {audit.length === 0 ? <p className="muted">No events yet.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Details</th></tr></thead>
              <tbody>{audit.map((a, i) => (
                <tr key={i}><td className="small">{new Date(a.at).toLocaleString()}</td><td><code>{a.event}</code></td><td>{a.actor}</td><td className="small mono">{JSON.stringify(a.data)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      )}
    </section>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="tile"><div className="muted small">{label}</div><div className="tile-value">{value}</div>{sub && <div className="muted small">{sub}</div>}</div>;
}
