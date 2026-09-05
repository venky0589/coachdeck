import { useState } from 'react';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getAll, where } from '../lib/data';
import type { AttendanceStatus, Batch, Player } from '../types/db';

const STATUS_ORDER: AttendanceStatus[] = ['PRESENT', 'LATE', 'EXCUSED', 'ABSENT'];
const STATUS_COLOR: Record<AttendanceStatus, string> = {
    PRESENT: 'var(--accent)',
    LATE: 'var(--warn)',
    EXCUSED: 'var(--muted)',
    ABSENT: 'var(--absent)',
};

// Last N days helper
function daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
}
const today = () => new Date().toISOString().slice(0, 10);

interface PlayerStat {
    player: Player;
    total: number;
    counts: Record<AttendanceStatus, number>;
    pct: number; // (present + late) / total
}

export default function AttendanceReport() {
    const [from, setFrom] = useState(daysAgo(30));
    const [to, setTo] = useState(today());
    const [batchId, setBatchId] = useState<string>('ALL');
    const [sort, setSort] = useState<'name' | 'pct'>('pct');

    const batches = useLiveQuery<Batch[]>(() => getAll('batches'), []);
    const players = useLiveQuery<Player[]>(() => getAll('players'), []);

    const stats = useLiveQuery<PlayerStat[]>(async () => {
        const logs = await where(
            'attendance_logs',
            (l) =>
                l.date >= from &&
                l.date <= to &&
                (batchId === 'ALL' || l.batch_id === batchId),
        );

        // Group by player
        const byPlayer = new Map<string, Record<AttendanceStatus, number>>();
        for (const l of logs) {
            if (!byPlayer.has(l.player_id)) {
                byPlayer.set(l.player_id, { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 });
            }
            byPlayer.get(l.player_id)![l.status]++;
        }

        const playerMap = new Map((players ?? []).map((p) => [p.id, p]));
        const result: PlayerStat[] = [];

        for (const [pid, counts] of byPlayer.entries()) {
            const player = playerMap.get(pid);
            if (!player || player.status === 'DROPPED') continue;
            const total = Object.values(counts).reduce((s, n) => s + n, 0);
            const pct = total > 0 ? Math.round(((counts.PRESENT + counts.LATE) / total) * 100) : 0;
            result.push({ player, total, counts, pct });
        }

        return result.sort((a, b) =>
            sort === 'pct' ? b.pct - a.pct : a.player.full_name.localeCompare(b.player.full_name),
        );
    }, [from, to, batchId, players, sort]);

    function exportCSV() {
        if (!stats?.length) return;
        const rows = [
            'Name,Total Sessions,Present,Late,Excused,Absent,Attendance %',
            ...stats.map((s) =>
                [
                    s.player.full_name,
                    s.total,
                    s.counts.PRESENT,
                    s.counts.LATE,
                    s.counts.EXCUSED,
                    s.counts.ABSENT,
                    `${s.pct}%`,
                ].join(','),
            ),
        ].join('\n');
        const blob = new Blob([rows], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `attendance-${from}-to-${to}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    const avg = stats?.length
        ? Math.round(stats.reduce((s, r) => s + r.pct, 0) / stats.length)
        : 0;

    return (
        <section>
            <header className="screen-head">
                <div>
                    <h2>Attendance Report</h2>
                    <p className="muted">
                        {stats?.length ?? 0} players · avg {avg}%
                    </p>
                </div>
                <button
                    onClick={exportCSV}
                    style={{
                        background: 'none', border: '1px solid var(--line)', borderRadius: 8,
                        padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--ink)',
                    }}
                >
                    CSV ↓
                </button>
            </header>

            {/* Filters */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                <div className="form-row" style={{ marginBottom: 0 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                        <label>From</label>
                        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                        <label>To</label>
                        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
                    </div>
                </div>

                {/* Quick range chips */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {[
                        { label: '7d', days: 7 },
                        { label: '30d', days: 30 },
                        { label: '90d', days: 90 },
                    ].map(({ label, days }) => (
                        <button
                            key={label}
                            onClick={() => { setFrom(daysAgo(days)); setTo(today()); }}
                            style={{
                                border: '1px solid var(--line)', borderRadius: 20,
                                padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                                background: from === daysAgo(days) ? 'var(--accent)' : 'var(--card)',
                                color: from === daysAgo(days) ? '#fff' : 'var(--ink)',
                            }}
                        >
                            Last {label}
                        </button>
                    ))}
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                    <label>Batch</label>
                    <select
                        value={batchId}
                        onChange={(e) => setBatchId(e.target.value)}
                        style={{
                            height: 44, padding: '0 12px', border: '1px solid var(--line)',
                            borderRadius: 'var(--radius)', font: 'inherit', background: 'var(--card)', color: 'var(--ink)',
                        }}
                    >
                        <option value="ALL">All batches</option>
                        {(batches ?? []).map((b) => (
                            <option key={b.id} value={b.id}>{b.batch_name}</option>
                        ))}
                    </select>
                </div>

                <div className="segmented">
                    <button className={sort === 'pct' ? 'seg on' : 'seg'} onClick={() => setSort('pct')}>
                        By attendance %
                    </button>
                    <button className={sort === 'name' ? 'seg on' : 'seg'} onClick={() => setSort('name')}>
                        By name
                    </button>
                </div>
            </div>

            {/* Results */}
            {(stats ?? []).length === 0 ? (
                <div className="empty-card"><p>No attendance data for this period.</p></div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {(stats ?? []).map((s) => (
                        <PlayerStatCard key={s.player.id} stat={s} />
                    ))}
                </div>
            )}
        </section>
    );
}

function PlayerStatCard({ stat: s }: { stat: PlayerStat }) {
    const barColor =
        s.pct >= 80 ? 'var(--accent)' : s.pct >= 60 ? 'var(--warn)' : 'var(--absent)';

    return (
        <div style={{
            background: 'var(--card)', border: '1px solid var(--line)',
            borderRadius: 'var(--radius)', padding: '12px 14px',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ flex: 1, fontWeight: 700, fontSize: 15 }}>{s.player.full_name}</span>
                <span style={{ fontWeight: 800, fontSize: 18, color: barColor }}>{s.pct}%</span>
            </div>

            {/* Progress bar */}
            <div style={{
                height: 6, borderRadius: 3, background: 'var(--line)', marginBottom: 8, overflow: 'hidden',
            }}>
                <div style={{ width: `${s.pct}%`, height: '100%', background: barColor, borderRadius: 3, transition: 'width 300ms' }} />
            </div>

            {/* Breakdown chips */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {STATUS_ORDER.map((st) => (
                    s.counts[st] > 0 && (
                        <span key={st} style={{
                            fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                            background: `${STATUS_COLOR[st]}22`, color: STATUS_COLOR[st], border: `1px solid ${STATUS_COLOR[st]}44`,
                        }}>
                            {s.counts[st]} {st.charAt(0) + st.slice(1).toLowerCase()}
                        </span>
                    )
                ))}
                <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
                    {s.total} session{s.total !== 1 ? 's' : ''}
                </span>
            </div>
        </div>
    );
}
