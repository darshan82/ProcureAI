import { useEffect, useState } from 'react';
import { session, setUnauthorizedHandler, type User } from './api';
import Login from './components/Login';
import Chat from './components/Chat';
import Tenders from './components/Tenders';
import Documents from './components/Documents';
import Ops from './components/Ops';
import Admin from './components/Admin';

type Tab = 'assistant' | 'tenders' | 'documents' | 'ops' | 'tenants' | 'integrations' | 'llm' | 'onboard';
const USER_TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'assistant', label: 'AI Assistant', icon: '✦' },
  { id: 'tenders', label: 'Tenders', icon: '▤' },
  { id: 'documents', label: 'Documents', icon: '⎙' },
  { id: 'ops', label: 'Workspace', icon: '◎' },
];
const ADMIN_TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'tenants', label: 'Tenants & usage', icon: '▦' },
  { id: 'integrations', label: 'Integrations', icon: '⇄' },
  { id: 'llm', label: 'LLM gateway', icon: '◈' },
  { id: 'onboard', label: 'Onboard customer', icon: '+' },
];

export default function App() {
  const [user, setUser] = useState<User | null>(session.user);
  const [tab, setTab] = useState<Tab>(session.user?.role === 'ADMIN' ? 'tenants' : 'assistant');

  useEffect(() => {
    setUnauthorizedHandler(() => { session.clear(); setUser(null); });
  }, []);

  if (!user) return <Login onLogin={(u) => { setUser(u); setTab(u.role === 'ADMIN' ? 'tenants' : 'assistant'); }} />;
  const isAdmin = user.role === 'ADMIN';
  const tabs = isAdmin ? ADMIN_TABS : USER_TABS;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="logo">✓</span> ProcureAI</div>
        <div className="tenant-chip" title="Tenant">{isAdmin ? 'Platform console' : `Tenant · ${user.tenantId}`}</div>
        <nav>
          {tabs.map((t) => (
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
        {isAdmin ? (
          <Admin tab={tab as 'tenants' | 'integrations' | 'llm' | 'onboard'} />
        ) : (
          <>
            {/* Chat stays mounted so the conversation survives tab switches. */}
            <div hidden={tab !== 'assistant'} className="fill"><Chat user={user} /></div>
            {tab === 'tenders' && <Tenders user={user} />}
            {tab === 'documents' && <Documents />}
            {tab === 'ops' && <Ops user={user} />}
          </>
        )}
      </main>
    </div>
  );
}
