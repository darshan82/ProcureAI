import { useEffect, useState } from 'react';
import { api, type User } from '../api';

interface Tender { tenderId: string; title: string; category: string; description: string; budget: number; currency: string; deadline: string; status: string; criteria: string[]; awardedBidId?: string }
interface Bid { bidId: string; tenderId: string; supplier: string; amount: number; deliveryDays: number; proposal: string; status: string }

const money = (n: number, c = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);

export default function Tenders({ user }: { user: User }) {
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [selected, setSelected] = useState<Tender | null>(null);
  const [bids, setBids] = useState<Bid[] | null>(null);
  const [myBids, setMyBids] = useState<Bid[]>([]);
  const [error, setError] = useState('');

  const load = () => {
    api<{ tenders: Tender[] }>('/tenders').then((r) => setTenders(r.tenders)).catch((e) => setError(e.message));
    if (user.role === 'SUPPLIER') api<{ bids: Bid[] }>('/tenders/mine/bids').then((r) => setMyBids(r.bids)).catch(() => {});
  };
  useEffect(() => { load(); }, [user.role]); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(t: Tender) {
    setSelected(t);
    setBids(null);
    if (user.role === 'BUYER') setBids((await api<{ bids: Bid[] }>(`/tenders/${t.tenderId}/bids`)).bids);
  }

  return (
    <section className="page">
      <header className="page-head">
        <div><h1>Tenders</h1><p className="muted">Live data from MongoDB. Create, bid and award through the AI Assistant.</p></div>
        <button className="btn ghost" onClick={load}>Refresh</button>
      </header>
      {error && <div className="alert error">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Title</th><th>Category</th><th className="num">Budget</th><th>Deadline</th><th>Status</th></tr></thead>
          <tbody>
            {tenders.map((t) => (
              <tr key={t.tenderId} onClick={() => open(t)} className={selected?.tenderId === t.tenderId ? 'sel' : ''}>
                <td><code>{t.tenderId}</code></td><td>{t.title}</td><td>{t.category}</td>
                <td className="num">{money(t.budget, t.currency)}</td><td>{t.deadline}</td>
                <td><span className={`status s-${t.status.toLowerCase()}`}>{t.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="card">
          <h2>{selected.tenderId} · {selected.title}</h2>
          <p>{selected.description}</p>
          <p className="muted small">Criteria: {selected.criteria.join(' · ')}{selected.awardedBidId ? ` · Awarded to ${selected.awardedBidId}` : ''}</p>
          {user.role === 'BUYER' && (
            bids === null ? <p className="muted">Loading bids…</p> : bids.length === 0 ? <p className="muted">No bids yet.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Bid</th><th>Supplier</th><th className="num">Amount</th><th className="num">Days</th><th>Status</th></tr></thead>
                <tbody>{bids.map((b) => (
                  <tr key={b.bidId}><td><code>{b.bidId}</code></td><td>{b.supplier}</td><td className="num">{money(b.amount)}</td><td className="num">{b.deliveryDays}</td><td><span className={`status s-${b.status.toLowerCase()}`}>{b.status}</span></td></tr>
                ))}</tbody>
              </table></div>
            )
          )}
        </div>
      )}

      {user.role === 'SUPPLIER' && (
        <div className="card">
          <h2>My bids</h2>
          {myBids.length === 0 ? <p className="muted">You haven't submitted any bids yet. Ask the assistant: "Submit a bid on TND-1001 for $165,000".</p> : (
            <ul className="plain">{myBids.map((b) => <li key={b.bidId}><code>{b.bidId}</code> on <code>{b.tenderId}</code> · {money(b.amount)} · <span className={`status s-${b.status.toLowerCase()}`}>{b.status}</span></li>)}</ul>
          )}
        </div>
      )}
    </section>
  );
}
