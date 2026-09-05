import { useState } from 'react';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getAll, where, save, newId } from '../lib/data';
import type { Batch, Coach, Player } from '../types/db';

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export default function Batches() {
    const [editing, setEditing] = useState<Batch | null | 'new'>(null);

    const batches = useLiveQuery(() => getAll('batches'), []);
    const coaches = useLiveQuery<Coach[]>(() => getAll('coaches'), []);
    const coachName = (id: string | null) => (coaches ?? []).find((c) => c.id === id)?.name ?? null;

    return (
        <section>
            <header className="screen-head">
                <div>
                    <h2>Batches</h2>
                    <p className="muted">{batches?.length ?? 0} batch{batches?.length !== 1 ? 'es' : ''}</p>
                </div>
            </header>

            {(batches ?? []).length === 0 ? (
                <div className="empty-card"><p>No batches yet.</p></div>
            ) : (
                <ul className="rows">
                    {(batches ?? []).map((b) => (
                        <li key={b.id}>
                            <button className="row" onClick={() => setEditing(b)}>
                                <span>
                                    <span className="name">{b.batch_name}</span>
                                    <br />
                                    <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}>
                                        {b.start_time}–{b.end_time}
                                        {b.court_number ? ` · Court ${b.court_number}` : ''}
                                        {' · '}{(b.days_of_week ?? []).join(', ')}
                                        {coachName(b.coach_id) ? ` · Coach: ${coachName(b.coach_id)}` : ''}
                                    </span>
                                </span>
                                <span className="chev">›</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <button className="fab" onClick={() => setEditing('new')} aria-label="New batch">＋</button>

            {editing !== null && (
                <BatchForm
                    initial={editing === 'new' ? undefined : editing}
                    onSave={() => setEditing(null)}
                    onCancel={() => setEditing(null)}
                />
            )}
        </section>
    );
}

function BatchForm({
    initial,
    onSave,
    onCancel,
}: {
    initial?: Batch;
    onSave: () => void;
    onCancel: () => void;
}) {
    const [form, setForm] = useState({
        batch_name: initial?.batch_name ?? '',
        start_time: initial?.start_time ?? '06:00',
        end_time: initial?.end_time ?? '07:30',
        court_number: initial?.court_number ?? '',
        max_capacity: String(initial?.max_capacity ?? ''),
        days_of_week: initial?.days_of_week ?? ([] as string[]),
        coach_id: initial?.coach_id ?? '',
    });
    const [search, setSearch] = useState('');
    const [saving, setSaving] = useState(false);

    const batchId = initial?.id;

    const allCoaches = useLiveQuery<Coach[]>(() => getAll('coaches'), []);
    // Active coaches, plus the currently-assigned one even if it's since been
    // deactivated — otherwise editing this batch would silently drop it.
    const coachOptions = (allCoaches ?? []).filter(
        (c) => c.active || c.id === form.coach_id,
    );

    const roster = useLiveQuery(async () => {
        if (!batchId) return [];
        const links = await where('player_batches', (pb) => pb.batch_id === batchId && pb.is_active);
        const players = await getAll('players');
        const byId = new Map(players.map((p) => [p.id, p]));
        return links.map((l) => byId.get(l.player_id)).filter(Boolean) as Player[];
    }, [batchId]);

    const unassigned = useLiveQuery(async () => {
        const all = await getAll('players');
        const assigned = new Set((roster ?? []).map((p) => p.id));
        return all
            .filter((p) => !assigned.has(p.id) && (p.status === 'ACTIVE' || p.status === 'TRIAL'))
            .filter((p) => !search || p.full_name.toLowerCase().includes(search.toLowerCase()))
            .sort((a, b) => a.full_name.localeCompare(b.full_name));
    }, [roster, search]);

    function toggleDay(day: string) {
        setForm((f) => ({
            ...f,
            days_of_week: f.days_of_week.includes(day)
                ? f.days_of_week.filter((d) => d !== day)
                : [...f.days_of_week, day],
        }));
    }

    async function handleSave() {
        if (!form.batch_name.trim()) return;
        setSaving(true);
        await save('batches', {
            id: batchId ?? newId(),
            batch_name: form.batch_name.trim(),
            start_time: form.start_time,
            end_time: form.end_time,
            court_number: form.court_number || null,
            max_capacity: form.max_capacity ? Number(form.max_capacity) : null,
            days_of_week: form.days_of_week,
            coach_id: form.coach_id || null,
            created_at: initial?.created_at ?? new Date().toISOString(),
        });
        setSaving(false);
        onSave();
    }

    async function addPlayer(playerId: string) {
        if (!batchId) return;
        const existing = await where(
            'player_batches',
            (pb) => pb.player_id === playerId && pb.batch_id === batchId,
        );
        if (existing.length) {
            await save('player_batches', { ...existing[0], is_active: true });
        } else {
            await save('player_batches', {
                id: newId(),
                player_id: playerId,
                batch_id: batchId,
                assigned_date: new Date().toISOString().slice(0, 10),
                is_active: true,
                created_at: new Date().toISOString(),
            });
        }
    }

    async function removePlayer(playerId: string) {
        if (!batchId) return;
        const existing = await where(
            'player_batches',
            (pb) => pb.player_id === playerId && pb.batch_id === batchId,
        );
        if (existing.length) {
            await save('player_batches', { ...existing[0], is_active: false });
        }
    }

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
            <div className="modal">
                <div className="modal-handle" />
                <h3>{initial ? 'Edit Batch' : 'New Batch'}</h3>

                <div className="form-group">
                    <label>Batch name</label>
                    <input
                        value={form.batch_name}
                        onChange={(e) => setForm((f) => ({ ...f, batch_name: e.target.value }))}
                        placeholder="Morning Advanced"
                    />
                </div>

                <div className="form-row">
                    <div className="form-group">
                        <label>Start time</label>
                        <input type="time" value={form.start_time} onChange={(e) => setForm((f) => ({ ...f, start_time: e.target.value }))} />
                    </div>
                    <div className="form-group">
                        <label>End time</label>
                        <input type="time" value={form.end_time} onChange={(e) => setForm((f) => ({ ...f, end_time: e.target.value }))} />
                    </div>
                </div>

                <div className="form-row">
                    <div className="form-group">
                        <label>Court</label>
                        <input value={form.court_number} onChange={(e) => setForm((f) => ({ ...f, court_number: e.target.value }))} placeholder="1" />
                    </div>
                    <div className="form-group">
                        <label>Max capacity</label>
                        <input type="number" inputMode="numeric" value={form.max_capacity} onChange={(e) => setForm((f) => ({ ...f, max_capacity: e.target.value }))} placeholder="—" />
                    </div>
                </div>

                <div className="form-group">
                    <label>Coach</label>
                    <select
                        value={form.coach_id}
                        onChange={(e) => setForm((f) => ({ ...f, coach_id: e.target.value }))}
                    >
                        <option value="">— No coach —</option>
                        {coachOptions.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name}{!c.active ? ' (inactive)' : ''}
                            </option>
                        ))}
                    </select>
                    {(allCoaches ?? []).length === 0 && (
                        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                            No coaches yet — add one under Settings.
                        </p>
                    )}
                </div>

                <div className="form-group">
                    <label>Days of week</label>
                    <div className="day-toggle" style={{ marginTop: 4 }}>
                        {DAYS.map((d) => (
                            <button
                                key={d}
                                className={form.days_of_week.includes(d) ? 'day-btn on' : 'day-btn'}
                                onClick={() => toggleDay(d)}
                            >
                                {d.slice(0, 2)}
                            </button>
                        ))}
                    </div>
                </div>

                <button
                    className="primary wide"
                    disabled={saving || !form.batch_name.trim()}
                    onClick={handleSave}
                    style={{ marginTop: 8 }}
                >
                    {saving ? 'Saving…' : initial ? 'Save changes' : 'Create batch'}
                </button>

                {/* Roster management — only when editing an existing batch */}
                {batchId && (
                    <>
                        <p className="form-section-title" style={{ marginTop: 20 }}>Roster ({roster?.length ?? 0})</p>
                        {(roster ?? []).map((p) => (
                            <div className="assign-row" key={p.id}>
                                <span className="aname">{p.full_name}</span>
                                <button className="remove-btn" onClick={() => removePlayer(p.id)}>Remove</button>
                            </div>
                        ))}

                        <p className="form-section-title" style={{ marginTop: 16 }}>Add players</p>
                        <div className="search-wrap">
                            <span className="search-icon">🔍</span>
                            <input
                                type="search"
                                placeholder="Search players…"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </div>
                        {(unassigned ?? []).map((p) => (
                            <div className="assign-row" key={p.id}>
                                <span className="aname">{p.full_name}</span>
                                <button className="add-btn" onClick={() => addPlayer(p.id)}>Add</button>
                            </div>
                        ))}
                    </>
                )}

                <button className="ghost wide" onClick={onCancel}>Close</button>
            </div>
        </div>
    );
}
