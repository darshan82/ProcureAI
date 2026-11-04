import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Doc { documentId: string; filename: string; bytes: number; status: string; chunkCount: number; pages?: number; processingMs?: number; uploadedBy: string; createdAt: string }

export default function Documents() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [drag, setDrag] = useState(false);
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
          <thead><tr><th>Document</th><th>File</th><th className="num">Size</th><th>Status</th><th className="num">Pages</th><th className="num">Chunks</th><th className="num">Processing</th></tr></thead>
          <tbody>
            {docs.length === 0 && <tr><td colSpan={7} className="muted">No documents yet.</td></tr>}
            {docs.map((d) => (
              <tr key={d.documentId}>
                <td><code>{d.documentId}</code></td><td>{d.filename}</td>
                <td className="num">{(d.bytes / 1024).toFixed(1)} KB</td>
                <td><span className={`status s-${d.status.toLowerCase()}`}>{d.status}</span></td>
                <td className="num">{d.pages ?? '–'}</td><td className="num">{d.chunkCount || '–'}</td>
                <td className="num">{d.processingMs != null ? `${d.processingMs} ms` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
