/** Platform operator console: the forward-deployed engineer's view across all customer tenants. */
import { useEffect, useState } from 'react';
import { api, patch, post } from '../api';
import { Tile } from './Ops';

const ALL_TOOLS = ['search_tenders', 'get_tender', 'search_documents', 'get_contract_terms', 'create_tender_db', 'list_bids', 'award_tender', 'submit_bid'];

interface Settings {
  models: string[]; cache: { enabled: boolean; threshold: number }; piiPolicy: 'redact' | 'block'; enabledTools: string[];
  approvals: { awardTender: boolean; createTenderAbove: number | null }; limits: { rateLimitPerMinute: number; monthlyBudgetUsd: number };
  webhooks: Array<{ id: string; url: string; secret: string; events: string[] }>;
}
interface TenantRow {
  tenantId: string; name: string; region: string; plan: string; settings: Settings;
  usage: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; models: Record<string, number> };
}
interface Delivery { deliveryId: string; tenantId: string; webhookId: string; url: string; type: string; status: string; attempts: number; lastStatusCode: number; lastError: string | null; updatedAt: string }
interface Receipt { tenantId: string; type: string; verified: boolean; reason?: string; receivedAt: string }
interface Llm { mode: string; circuits: Array<{ model: string; failures: number; open: boolean }>; pricingPerMillionTokens: Record<string, [number, number]> }

type Tab = 'tenants' | 'integrations' | 'llm' | 'onboard';

const TEMPLATE = JSON.stringify({
  tenantId: 'wayne', name: 'Wayne Enterprises', region: 'us-east-1', plan: 'pilot',
  settings: {
    models: ['gpt-4o-mini'], cache: { enabled: true, threshold: 0.93 }, piiPolicy: 'redact',
    enabledTools: ['search_tenders', 'get_tender', 'search_documents', 'get_contract_terms'],
    approvals: { awardTender: true, createTenderAbove: 50000 }, limits: { rateLimitPerMinute: 20, monthlyBudgetUsd: 25 }, webhooks: [],
  },
}, null, 2);

export default function Admin({ tab }: { tab: Tab }) {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [llm, setLlm] = useState<Llm | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [json, setJson] = useState(TEMPLATE);

  const load = () => {
    api<{ tenants: TenantRow[] }>('/admin/tenants').then((r) => setTenants(r.tenants)).catch(() => {});
    api<{ deliveries: Delivery[] }>('/admin/deliveries').then((r) => setDeliveries(r.deliveries)).catch(() => {});
    api<{ receipts: Receipt[] }>('/admin/receipts').then((r) => setReceipts(r.receipts)).catch(() => {});
    api<Llm>('/admin/llm').then(setLlm).catch(() => {});
  };
  useEffect(() => { load(); }, [tab]);

  const totalCost = tenants.reduce((n, t) => n + t.usage.costUsd, 0);
  const totalTokens = tenants.reduce((n, t) => n + t.usage.inputTokens + t.usage.outputTokens, 0);
  const dlq = deliveries.filter((d) => d.status === 'DEAD_LETTERED').length;

  async function replay(id: string) {
    try {
      await post(`/admin/deliveries/${encodeURIComponent(id)}/replay`, {});
      setMsg({ kind: 'ok', text: 'Replay queued on Kafka. Refresh in a few seconds.' });
      setTimeout(load, 2500);
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  }

  async function onboard() {
    try {
      const body = JSON.parse(json);
      await post('/admin/tenants', body);
      setMsg({ kind: 'ok', text: `Tenant ${body.tenantId} onboarded. Users with tenant claim "${body.tenantId}" can now sign in.` });
      load();
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div><h1>{{ tenants: 'Tenants', integrations: 'Integrations', llm: 'LLM gateway', onboard: 'Onboard a customer' }[tab]}</h1><p className="muted">Platform admin console</p></div>
        <button className="btn ghost" onClick={load}>Refresh</button>
      </header>
      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

      {tab === 'tenants' && (
        <>
          <div className="tiles">
            <Tile label="Tenants" value={String(tenants.length)} sub={tenants.map((t) => t.tenantId).join(', ')} />
            <Tile label="AI spend this month" value={`$${totalCost.toFixed(4)}`} sub={`${totalTokens.toLocaleString()} tokens`} />
            <Tile label="LLM mode" value={llm?.mode === 'openai' ? 'OpenAI' : 'Mock'} sub={llm?.circuits.some((c) => c.open) ? '⚠ a circuit is open' : 'all circuits closed'} />
            <Tile label="Dead-lettered webhooks" value={String(dlq)} sub="see Integrations" />
          </div>
          {tenants.map((t) => (
            <div className="card" key={t.tenantId}>
              <div className="page-head">
                <div>
                  <h2>{t.name} <code>{t.tenantId}</code></h2>
                  <p className="muted small">{t.region} · {t.plan} · {t.usage.requests} LLM calls · {(t.usage.inputTokens + t.usage.outputTokens).toLocaleString()} tokens · ${t.usage.costUsd.toFixed(4)} of ${t.settings.limits.monthlyBudgetUsd}</p>
                </div>
                <button className="btn ghost" onClick={() => setEditing(editing === t.tenantId ? null : t.tenantId)}>{editing === t.tenantId ? 'Close' : 'Edit policies'}</button>
              </div>
              <div className="bar"><div style={{ width: `${Math.min(100, (t.usage.costUsd / Math.max(t.settings.limits.monthlyBudgetUsd, 0.0001)) * 100)}%` }} /></div>
              {editing === t.tenantId && <SettingsForm t={t} onSaved={(text) => { setMsg({ kind: 'ok', text }); setEditing(null); load(); }} onError={(text) => setMsg({ kind: 'error', text })} />}
            </div>
          ))}
        </>
      )}

      {tab === 'integrations' && (
        <>
          <div className="card">
            <h2>Webhook deliveries</h2>
            <p className="muted small">Domain events → Kafka → integration dispatcher → customer endpoints (HMAC-signed, retried with backoff, dead-lettered on failure).</p>
            <div className="table-wrap"><table>
              <thead><tr><th>Updated</th><th>Tenant</th><th>Event</th><th>Webhook</th><th>Status</th><th className="num">Attempts</th><th>Last error</th><th /></tr></thead>
              <tbody>
                {deliveries.length === 0 && <tr><td colSpan={8} className="muted">No deliveries yet. Create a tender or award one to emit events.</td></tr>}
                {deliveries.map((d) => (
                  <tr key={d.deliveryId}>
                    <td className="small">{new Date(d.updatedAt).toLocaleTimeString()}</td><td>{d.tenantId}</td><td><code>{d.type}</code></td>
                    <td className="small" title={d.url}>{d.webhookId}</td>
                    <td><span className={`status ${d.status === 'DELIVERED' ? 's-ready' : 's-failed'}`}>{d.status}</span></td>
                    <td className="num">{d.attempts}</td><td className="small">{d.lastError ?? '–'}</td>
                    <td>{d.status !== 'DELIVERED' && <button className="link small" onClick={() => replay(d.deliveryId)}>Replay</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
          <div className="card">
            <h2>Mock customer ERP: received events</h2>
            <p className="muted small">The receiving side verifies <code>X-ProcureAI-Signature</code> exactly as a customer would.</p>
            <ul className="plain">{receipts.slice(0, 15).map((r, i) => (
              <li key={i}><span className={`status ${r.verified ? 's-ready' : 's-failed'}`}>{r.verified ? 'signature ok' : r.reason}</span> <code>{r.type}</code> <span className="muted small">{r.tenantId} · {new Date(r.receivedAt).toLocaleTimeString()}</span></li>
            ))}</ul>
          </div>
        </>
      )}

      {tab === 'llm' && llm && (
        <>
          <div className="card">
            <h2>Circuit breakers</h2>
            {llm.circuits.length === 0 ? <p className="muted">No provider calls yet{llm.mode === 'mock' ? ' (running offline with the mock model; add OPENAI_API_KEY to enable OpenAI)' : ''}.</p> : (
              <ul className="plain">{llm.circuits.map((c) => <li key={c.model}><span className={`dot ${c.open ? 'bad' : 'ok'}`} /> <code>{c.model}</code> {c.open ? 'OPEN: traffic falls back to the next model' : 'closed'} · {c.failures} consecutive failures</li>)}</ul>
            )}
          </div>
          <div className="card">
            <h2>Pricing used for metering (USD per 1M tokens)</h2>
            <div className="table-wrap"><table>
              <thead><tr><th>Model</th><th className="num">Input</th><th className="num">Output</th></tr></thead>
              <tbody>{Object.entries(llm.pricingPerMillionTokens).map(([m, [i, o]]) => <tr key={m}><td><code>{m}</code></td><td className="num">${i}</td><td className="num">${o}</td></tr>)}</tbody>
            </table></div>
          </div>
        </>
      )}

      {tab === 'onboard' && (
        <div className="card stack">
          <p className="muted small">Tenants are config-as-code: commit a file to <code>apps/api/tenants/</code> for a reviewed rollout, or onboard instantly here. The body is validated against the same Zod schema.</p>
          <textarea className="mono" rows={22} value={json} onChange={(e) => setJson(e.target.value)} />
          <div className="row"><button className="btn primary" onClick={onboard}>Create tenant</button><button className="btn ghost" onClick={() => setJson(TEMPLATE)}>Reset template</button></div>
        </div>
      )}
    </section>
  );
}

function SettingsForm({ t, onSaved, onError }: { t: TenantRow; onSaved: (m: string) => void; onError: (m: string) => void }) {
  const [s, setS] = useState<Settings>(t.settings);
  const [models, setModels] = useState(t.settings.models.join(', '));

  async function save() {
    try {
      const { webhooks: _w, ...rest } = s; // webhook secrets are redacted client-side; never round-trip them
      await patch(`/admin/tenants/${t.tenantId}/settings`, { ...rest, models: models.split(',').map((m) => m.trim()).filter(Boolean) });
      onSaved(`Saved ${t.tenantId}. Changes apply to new requests within 15s.`);
    } catch (e) { onError((e as Error).message); }
  }

  return (
    <div className="settings-form">
      <label>Model fallback chain<input value={models} onChange={(e) => setModels(e.target.value)} /></label>
      <label>Cache threshold<input type="number" step="0.01" min="0.5" max="1" value={s.cache.threshold} onChange={(e) => setS({ ...s, cache: { ...s.cache, threshold: Number(e.target.value) } })} /></label>
      <label>PII policy
        <select value={s.piiPolicy} onChange={(e) => setS({ ...s, piiPolicy: e.target.value as Settings['piiPolicy'] })}><option value="redact">redact</option><option value="block">block</option></select>
      </label>
      <label>Approve tenders above ($, blank = never)<input type="number" value={s.approvals.createTenderAbove ?? ''} onChange={(e) => setS({ ...s, approvals: { ...s.approvals, createTenderAbove: e.target.value === '' ? null : Number(e.target.value) } })} /></label>
      <label>Rate limit / user / min<input type="number" min="1" value={s.limits.rateLimitPerMinute} onChange={(e) => setS({ ...s, limits: { ...s.limits, rateLimitPerMinute: Number(e.target.value) } })} /></label>
      <label>Monthly budget (USD)<input type="number" min="0" value={s.limits.monthlyBudgetUsd} onChange={(e) => setS({ ...s, limits: { ...s.limits, monthlyBudgetUsd: Number(e.target.value) } })} /></label>
      <fieldset>
        <legend>Enabled tools</legend>
        {ALL_TOOLS.map((tool) => (
          <label key={tool} className="check"><input type="checkbox" checked={s.enabledTools.includes(tool)} onChange={(e) => setS({ ...s, enabledTools: e.target.checked ? [...s.enabledTools, tool] : s.enabledTools.filter((x) => x !== tool) })} /> <code>{tool}</code></label>
        ))}
        <label className="check"><input type="checkbox" checked={s.approvals.awardTender} onChange={(e) => setS({ ...s, approvals: { ...s.approvals, awardTender: e.target.checked } })} /> Require approval for awards</label>
        <label className="check"><input type="checkbox" checked={s.cache.enabled} onChange={(e) => setS({ ...s, cache: { ...s.cache, enabled: e.target.checked } })} /> Semantic cache enabled</label>
      </fieldset>
      <div className="row"><button className="btn primary" onClick={save}>Save policies</button></div>
    </div>
  );
}
