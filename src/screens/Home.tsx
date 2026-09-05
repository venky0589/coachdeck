import { useState } from 'react';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { getAll } from '../lib/data';
import { seedDemoDataIfEmpty } from '../lib/seed';
import { isBackendConfigured } from '../lib/supabase';
import { whatsappReceiptLink } from '../lib/payments';
import Skeleton from '../components/Skeleton';
import type { Player } from '../types/db';

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

type Tab = 'roll' | 'pay' | 'players' | 'settings';

export default function Home({ go }: { go: (tab: Tab) => void }) {
  const online = useOnlineStatus();
  const players = useLiveQuery(() => getAll('players'), []);
  const dues = useLiveQuery(() => getAll('monthly_dues'), []);
  const loading = players === undefined || dues === undefined;
  const [seeding, setSeeding] = useState(false);

  // seedDemoDataIfEmpty() writes a batch, 4 players, their batch links and
  // invoices across several sequential awaits. The button used to fire this
  // without awaiting it and relied on the reactive player count to hide
  // itself — which happens the instant the *first* player commits, while
  // the rest of the seed is still in flight. That let a fast double-tap
  // (or anything reacting to "seeding must be done now") race an
  // incomplete write. Tracking it as real pending state fixes both.
  async function loadDemoData() {
    if (seeding) return;
    setSeeding(true);
    await seedDemoDataIfEmpty();
    setSeeding(false);
  }

  const outstanding = dues?.reduce((s, d) => s + Number(d.balance_due), 0) ?? 0;
  const active = players?.filter((p) => p.status === 'ACTIVE').length ?? 0;

  // Build overdue list: players with balance > 0, sorted by highest balance
  const playerMap = new Map((players ?? []).map((p) => [p.id, p]));
  const overduePlayers = (dues ?? [])
    .filter((d) => d.status !== 'PAID' && d.status !== 'WAIVED' && Number(d.balance_due) > 0)
    .reduce<Map<string, number>>((acc, d) => {
      acc.set(d.player_id, (acc.get(d.player_id) ?? 0) + Number(d.balance_due));
      return acc;
    }, new Map());

  const overdueList = [...overduePlayers.entries()]
    .filter(([id]) => {
      const p = playerMap.get(id);
      return p && p.status !== 'DROPPED';
    })
    .map(([id, bal]) => ({ player: playerMap.get(id)!, balance: bal }))
    .sort((a, b) => b.balance - a.balance);

  return (
    <section>
      <header className="screen-head">
        <div>
          <h2>Today</h2>
          <p className="muted">
            {isBackendConfigured() ? (online ? 'Synced' : 'Offline — will sync') : 'Local only'}
          </p>
        </div>
        <span className={online ? 'dot on' : 'dot'} aria-hidden />
      </header>

      <div className="stats">
        {loading ? (
          <>
            <div className="stat">
              <Skeleton height={24} width={40} />
              <div style={{ marginTop: 6 }}><Skeleton height={13} width={70} radius={4} /></div>
            </div>
            <div className="stat">
              <Skeleton height={24} width={60} />
              <div style={{ marginTop: 6 }}><Skeleton height={13} width={70} radius={4} /></div>
            </div>
          </>
        ) : (
          <>
            <div className="stat">
              <strong>{active}</strong>
              <span>active players</span>
            </div>
            <div className="stat">
              <strong>{rupees(outstanding)}</strong>
              <span>outstanding</span>
            </div>
          </>
        )}
      </div>

      {/* Overdue collection bar */}
      {overdueList.length > 0 && (
        <div className="overdue-bar">
          <div className="overdue-bar-head">
            <span>⚠ Outstanding fees</span>
            <span className="count">{overdueList.length} player{overdueList.length !== 1 ? 's' : ''}</span>
          </div>
          {overdueList.map(({ player: p, balance }) => (
            <OverdueRow key={p.id} player={p} balance={balance} onTap={() => go('players')} />
          ))}
        </div>
      )}

      <div className="actions">
        <button className="primary wide" onClick={() => go('roll')}>
          Take attendance
        </button>
        <button className="ghost wide" onClick={() => go('pay')}>
          Collect payment
        </button>
      </div>

      {((players?.length ?? 0) === 0 || seeding) && (
        <div className="empty">
          <p>No players yet.</p>
          <button className="ghost" onClick={loadDemoData} disabled={seeding}>
            {seeding ? 'Loading…' : 'Load demo data'}
          </button>
        </div>
      )}
    </section>
  );
}

function OverdueRow({
  player: p,
  balance,
  onTap,
}: {
  player: Player;
  balance: number;
  onTap: () => void;
}) {
  const phone = p.guardian_phone ?? p.phone;
  const msg = `Hi, ${p.full_name} has an outstanding balance of ${rupees(balance)} for badminton coaching. Kindly make the payment at your earliest convenience. Thank you!`;
  return (
    <div className="overdue-row">
      <button
        className="oname"
        style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer' }}
        onClick={onTap}
      >
        {p.full_name}
      </button>
      <span className="obal">{rupees(balance)}</span>
      {phone && (
        <a
          className="wa-btn"
          href={whatsappReceiptLink(phone, msg)}
          target="_blank"
          rel="noreferrer"
          title="WhatsApp reminder"
        >
          💬
        </a>
      )}
    </div>
  );
}
