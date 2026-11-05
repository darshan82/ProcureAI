import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Risk { severity: 'low' | 'medium' | 'high'; description: string }
interface Extraction {
  title: string; parties: string[]; deliveryDays: number | null; paymentTerms: string | null; warranty: string | null;
  slaResponse: string | null; penalties: string[]; terminationNotice: string | null;
  evaluationCriteria: Array<{ criterion: string; weight: number }>; risks: Risk[]; method: string; confidence: number;
}
interface Doc { documentId: string; filename: string; bytes: number; status: string; chunkCount: number; pages?: number; processingMs?: number; uploadedBy: string; createdAt: string; extraction?: Extraction }

export default function Documents() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api<{ documents: Doc[] }>('/documents').then((r) => setDocs(r.documents)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  // Poll while anything is still being processed by the Kafka worker.
  useEffect(() => {
    if (!docs.some((d) => d.status === 'QUEUED' || d.status === 'PROCESSING')) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [docs, load]);

  async function upload(file: File) {
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api<{ jobId: string; documentId: string }>('/documents', { method: 'POST', body: fd });
      setMsg({ kind: 'ok', text: `202 Accepted: ${r.documentId} queued on Kafka (job ${r.jobId.slice(0, 8)}…)` });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div><h1>Documents</h1><p className="muted">Upload contracts, RFPs or proposals. API streams to S3 → Kafka → worker parses, chunks, embeds, indexes.</p></div>
        <button className="btn ghost" onClick={load}>Refresh</button>
      </header>

      <div
        className={`dropzone ${drag ? 'drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) upload(f); }}
        onClick={() => inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept=".pdf,.txt,.md" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <strong>{busy ? 'Uploading…' : 'Drop a PDF / TXT / MD here or click to choose'}</strong>
        <span className="muted small">Try <code>samples/sample-contract.md</code> from the repo, then ask the assistant about penalties or warranty.</span>
      </div>
      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

      <div className="table-wrap">
        <table>
          <thead><tr><th>Document</th><th>File</th><th className="num">Size</th><th>Status</th><th className="num">Pages</th><th className="num">Chunks</th><th className="num">Processing</th><th>Risks</th></tr></thead>
          <tbody>
            {docs.length === 0 && <tr><td colSpan={8} className="muted">No documents yet.</td></tr>}
            {docs.map((d) => (
              <tr key={d.documentId} onClick={() => setSelected(d.documentId === selected ? null : d.documentId)} className={`clickable ${selected === d.documentId ? 'sel' : ''}`}>
                <td><code>{d.documentId}</code></td><td>{d.filename}</td>
                <td className="num">{(d.bytes / 1024).toFixed(1)} KB</td>
                <td><span className={`status s-${d.status.toLowerCase()}`}>{d.status}</span></td>
                <td className="num">{d.pages ?? '–'}</td><td className="num">{d.chunkCount || '–'}</td>
                <td className="num">{d.processingMs != null ? `${d.processingMs} ms` : '–'}</td>
                <td><RiskSummary risks={d.extraction?.risks} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(() => {
        const doc = docs.find((d) => d.documentId === selected);
        return doc?.extraction ? <ExtractionCard doc={doc} x={doc.extraction} /> : selected ? <p className="muted">No structured extraction for this document yet.</p> : (
          docs.some((d) => d.extraction) && <p className="muted small">Click a document to see its structured contract extraction.</p>
        );
      })()}
    </section>
  );
}

function RiskSummary({ risks }: { risks?: Risk[] }) {
  if (!risks) return <span className="muted">–</span>;
  const high = risks.filter((r) => r.severity === 'high').length;
  const med = risks.filter((r) => r.severity === 'medium').length;
  return (
    <span className="row" style={{ gap: 4 }}>
      {high > 0 && <span className="status s-failed">{high} high</span>}
      {med > 0 && <span className="status s-processing">{med} med</span>}
      {!high && !med && <span className="status s-ready">low</span>}
    </span>
  );
}

function ExtractionCard({ doc, x }: { doc: Doc; x: Extraction }) {
  const rows: Array<[string, string | null]> = [
    ['Parties', x.parties.join(' · ') || null],
    ['Delivery', x.deliveryDays != null ? `within ${x.deliveryDays} days` : null],
    ['Payment', x.paymentTerms],
    ['Warranty', x.warranty],
    ['Support SLA', x.slaResponse],
    ['Termination', x.terminationNotice],
  ];
  return (
    <div className="card">
      <div className="page-head">
        <div>
          <h2>{x.title}</h2>
          <p className="muted small"><code>{doc.documentId}</code> · extracted by <code>{x.method}</code> · confidence {Math.round(x.confidence * 100)}% · schema-validated (Zod)</p>
        </div>
      </div>
      <div className="grid-2">
        <dl className="kv">
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v ?? <span className="muted">not found</span>}</dd></div>)}
          <div><dt>Penalties</dt><dd>{x.penalties.length ? <ul className="tight">{x.penalties.map((p) => <li key={p}>{p}</li>)}</ul> : <span className="muted">none</span>}</dd></div>
        </dl>
        <div className="stack">
          <div>
            <h3>Evaluation criteria</h3>
            {x.evaluationCriteria.map((c) => (
              <div key={c.criterion} className="bar-row"><span>{c.criterion}</span><div className="bar"><div style={{ width: `${c.weight}%` }} /></div><span className="num">{c.weight}%</span></div>
            ))}
          </div>
          <div>
            <h3>Risk flags</h3>
            <ul className="plain">{x.risks.map((r) => <li key={r.description}><span className={`status sev-${r.severity}`}>{r.severity}</span> {r.description}</li>)}</ul>
          </div>
        </div>
      </div>
    </div>
  );
}
