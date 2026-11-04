import { useEffect, useState } from 'react';
import { session, setUnauthorizedHandler, type User } from './api';
import Login from './components/Login';
import Chat from './components/Chat';
import Tenders from './components/Tenders';
import Documents from './components/Documents';
import Ops from './components/Ops';

type Tab = 'assistant' | 'tenders' | 'documents' | 'ops';
const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'assistant', label: 'AI Assistant', icon: '✦' },
  { id: 'tenders', label: 'Tenders', icon: '▤' },
  { id: 'documents', label: 'Documents', icon: '⎙' },
  { id: 'ops', label: 'Platform', icon: '◎' },
];

export default function App() {
  const [user, setUser] = useState<User | null>(session.user);
  const [tab, setTab] = useState<Tab>('assistant');

  useEffect(() => {
    setUnauthorizedHandler(() => { session.clear(); setUser(null); });
  }, []);

  if (!user) return <Login onLogin={setUser} />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="logo">✓</span> ProcureAI</div>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <span className="nav-icon">{t.icon}</span>{t.label}
            </button>
          ))}
        </nav>
        <div className="me">
          <div className="me-name">{user.name}</div>
          <div className="me-sub">{user.sub}</div>
          <span className={`role role-${user.role.toLowerCase()}`}>{user.role}</span>
          <button className="link" onClick={() => { session.clear(); setUser(null); }}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        {/* Chat stays mounted so the conversation survives tab switches. */}
        <div hidden={tab !== 'assistant'} className="fill"><Chat user={user} /></div>
        {tab === 'tenders' && <Tenders user={user} />}
        {tab === 'documents' && <Documents />}
        {tab === 'ops' && <Ops user={user} />}
      </main>
    </div>
  );
}
