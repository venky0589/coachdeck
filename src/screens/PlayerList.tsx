import { useState } from 'react';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getAll } from '../lib/data';
import Skeleton from '../components/Skeleton';
import type { Player, PlayerStatus } from '../types/db';

const STATUS_ORDER: PlayerStatus[] = ['ACTIVE', 'TRIAL', 'PAUSED', 'DROPPED', 'ALUMNI'];

const STATUS_LABEL: Record<PlayerStatus, string> = {
    ACTIVE: 'Active', TRIAL: 'Trial', PAUSED: 'Paused', DROPPED: 'Dropped', ALUMNI: 'Alumni',
};

export default function PlayerList({
    onAdd,
    onSelect,
}: {
    onAdd: () => void;
    onSelect: (id: string) => void;
}) {
    const [search, setSearch] = useState('');
    const [filterStatus, setFilterStatus] = useState<PlayerStatus | 'ALL'>('ALL');

    const players = useLiveQuery(() => getAll('players'), []);

    const filtered = (players ?? [])
        .filter((p) => filterStatus === 'ALL' || p.status === filterStatus)
        .filter((p) => !search || p.full_name.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => {
            const so = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
            return so !== 0 ? so : a.full_name.localeCompare(b.full_name);
        });

    const counts = (players ?? []).reduce<Record<string, number>>((acc, p) => {
        acc[p.status] = (acc[p.status] ?? 0) + 1;
        return acc;
    }, {});

    return (
        <section>
            <header className="screen-head">
                <div>
                    <h2>Players</h2>
                    <p className="muted">{counts['ACTIVE'] ?? 0} active · {players?.length ?? 0} total</p>
                </div>
            </header>

            {/* Search */}
            <div className="search-wrap">
                <span className="search-icon">🔍</span>
                <input
                    type="search"
                    placeholder="Search players…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
            </div>

            {/* Status filter pills */}
            <div className="segmented" style={{ marginBottom: 14 }}>
                {(['ALL', ...STATUS_ORDER] as const).map((s) => (
                    <button
                        key={s}
                        className={s === filterStatus ? 'seg on' : 'seg'}
                        style={{ fontSize: 12, minHeight: 36, flex: s === 'ALL' ? 1.2 : 1 }}
                        onClick={() => setFilterStatus(s)}
                    >
                        {s === 'ALL' ? 'All' : STATUS_LABEL[s]}
                        {s !== 'ALL' && counts[s] ? ` (${counts[s]})` : ''}
                    </button>
                ))}
            </div>

            {players === undefined ? (
                <ul className="rows">
                    {[0, 1, 2].map((i) => (
                        <li key={i}><Skeleton height={60} radius={12} /></li>
                    ))}
                </ul>
            ) : filtered.length === 0 ? (
                <div className="empty-card">
                    <p>{search ? 'No matches.' : 'No players in this category.'}</p>
                </div>
            ) : (
                <ul className="rows">
                    {filtered.map((p) => (
                        <PlayerRow key={p.id} player={p} onClick={() => onSelect(p.id)} />
                    ))}
                </ul>
            )}

            <button className="fab" onClick={onAdd} aria-label="Add player">＋</button>
        </section>
    );
}

function PlayerRow({ player: p, onClick }: { player: Player; onClick: () => void }) {
    return (
        <li>
            <button className={`row status-${p.status.toLowerCase()}`} onClick={onClick}>
                <span className="name">{p.full_name}</span>
                <span className={`badge badge-${p.status.toLowerCase()}`}>
                    {STATUS_LABEL[p.status]}
                </span>
            </button>
        </li>
    );
}
