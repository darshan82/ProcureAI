import { useEffect, useState } from 'react';
import { api, type User } from '../api';

interface Stats { entries: number; hits: number; misses: number; threshold: number; guardrailBlocked: number; llmMode: string }
interface Ready { status: string; checks: Record<string, string>; llm: { mode: string; model: string; embeddings: string }; langsmith: string; checkpointer: string }
interface AuditEvent { event: string; actor: string; role: string; data: Record<string, unknown>; at: string }
interface TenantInfo {
  tenant: { tenantId: string; name: string; region: string; plan: string; settings: { models: string[]; piiPolicy: string; cache: { enabled: boolean; threshold: number }; approvals: { awardTender: boolean; createTenderAbove: number | null }; limits: { rateLimitPerMinute: number; monthlyBudgetUsd: number }; enabledTools: string[]; webhooks: Array<{ id: string; url: string; events: string[] }> } };
  usage: { month: string; requests: number; inputTokens: number; outputTokens: number; costUsd: number; models: Record<string, number> };
}

export default function Ops({ user }: { user: User }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [info, setInfo] = useState<TenantInfo | null>(null);

  const load = () => {
    api<Stats>('/chat/cache/stats').then(setStats).catch(() => {});
    api<Ready>('/ready').then(setReady).catch(() => {});
    api<TenantInfo>('/tenant').then(setInfo).catch(() => {});
    if (user.role === 'BUYER') api<{ events: AuditEvent[] }>('/audit').then((r) => setAudit(r.events)).catch(() => {});
  };
  useEffect(() => { load(); }, [user.role]); // eslint-disable-line react-hooks/exhaustive-deps

  const hitRate = stats && stats.hits + stats.misses > 0 ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100) : 0;
  const s = info?.tenant.settings;
  const budgetPct = s && s.limits.monthlyBudgetUsd > 0 ? Math.min(100, ((info?.usage.costUsd ?? 0) / s.limits.monthlyBudgetUsd) * 100) : 0;

  return (
    <section className="page">
      <header className="page-head">
        <div><h1>{info?.tenant.name ?? 'Workspace'}</h1><p className="muted">Tenant <code>{user.tenantId}</code> · {info?.tenant.region} · {info?.tenant.plan} plan</p></div>
        <div className="row">
          {user.role === 'BUYER' && <button className="btn ghost" onClick={() => api('/chat/cache', { method: 'DELETE' }).then(load)}>Flush cache</button>}
          <button className="btn ghost" onClick={load}>Refresh</button>
        </div>
      </header>

      <div className="tiles">
        <Tile label="LLM" value={ready?.llm.mode === 'openai' ? s?.models[0] ?? ready.llm.model : 'Mock (no key)'} sub={s ? `fallback chain: ${s.models.join(' → ')}` : undefined} />
        <Tile label={`AI spend · ${info?.usage.month ?? ''}`} value={`$${(info?.usage.costUsd ?? 0).toFixed(4)}`} sub={`${(info?.usage.inputTokens ?? 0) + (info?.usage.outputTokens ?? 0)} tokens · ${info?.usage.requests ?? 0} calls`}>
          <div className="bar"><div style={{ width: `${budgetPct}%` }} /></div>
          <div className="muted small">budget ${s?.limits.monthlyBudgetUsd}</div>
        </Tile>
        <Tile label="Cache hit rate" value={`${hitRate}%`} sub={`${stats?.entries ?? 0} cached · threshold ≥ ${stats?.threshold ?? '–'}`} />
        <Tile label="Guardrail blocks" value={String(stats?.guardrailBlocked ?? 0)} sub="injection + PII policy" />
      </div>

      {s && (
        <div className="card">
          <h2>Tenant policies</h2>
          <dl className="kv">
            <div><dt>PII policy</dt><dd><span className={`status ${s.piiPolicy === 'block' ? 's-failed' : 's-processing'}`}>{s.piiPolicy}</span> {s.piiPolicy === 'block' ? 'messages containing personal data are rejected' : 'personal data is redacted before reaching the model'}</dd></div>
            <div><dt>Approvals</dt><dd>{s.approvals.awardTender ? 'Awards need approval' : 'Awards run directly'}{s.approvals.createTenderAbove !== null ? ` · tenders above $${s.approvals.createTenderAbove.toLocaleString()} need approval` : ''}</dd></div>
            <div><dt>Rate limit</dt><dd>{s.limits.rateLimitPerMinute} requests / user / minute</dd></div>
            <div><dt>Enabled tools</dt><dd>{s.enabledTools.map((t) => <code key={t} style={{ marginRight: 4 }}>{t}</code>)}</dd></div>
            {s.webhooks.length > 0 && <div><dt>Integrations</dt><dd>{s.webhooks.map((w) => <div key={w.id}><code>{w.id}</code> → {w.url} <span className="muted small">({w.events.join(', ')})</span></div>)}</dd></div>}
          </dl>
        </div>
      )}

      <div className="card">
        <h2>Dependencies</h2>
        <ul className="plain">
          {ready && Object.entries(ready.checks).map(([k, v]) => <li key={k}><span className={`dot ${v === 'ok' ? 'ok' : 'bad'}`} /> {k}: {v}</li>)}
          <li><span className="dot ok" /> agent checkpointer: {ready?.checkpointer ?? '–'}</li>
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

export function Tile({ label, value, sub, children }: { label: string; value: string; sub?: string; children?: React.ReactNode }) {
  return <div className="tile"><div className="muted small">{label}</div><div className="tile-value">{value}</div>{sub && <div className="muted small">{sub}</div>}{children}</div>;
}
