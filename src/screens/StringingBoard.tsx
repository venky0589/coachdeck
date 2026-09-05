import { useState } from 'react';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getAll, save, remove, newId, today } from '../lib/data';
import type { StringingJob, StringingStatus } from '../types/db';
import { toast } from '../lib/toast';

// Each job is its own row in the stringing_jobs table (synced + last-write-wins
// like every other table) — see sql/01-schema.sql. This used to be a single
// JSON blob squeezed into app_settings; that broke the moment Settings
// autosaved (it would overwrite the blob field entirely) and had no way to
// sync correctly across two devices.

const STATUS_CYCLE: StringingStatus[] = ['PENDING', 'IN_PROGRESS', 'DONE'];
const STATUS_LABEL: Record<StringingStatus, string> = {
    PENDING: 'Pending', IN_PROGRESS: 'Stringing', DONE: 'Done',
};
const STATUS_COLOR: Record<StringingStatus, string> = {
    PENDING: 'var(--warn)', IN_PROGRESS: 'var(--accent)', DONE: 'var(--muted)',
};

export default function StringingBoard() {
    const [showForm, setShowForm] = useState(false);
    const [filter, setFilter] = useState<StringingStatus | 'ALL'>('ALL');

    const jobs = useLiveQuery(() => getAll('stringing_jobs'), []);

    const filtered = (jobs ?? [])
        .filter((j) => filter === 'ALL' || j.status === filter)
        .sort((a, b) => b.job_date.localeCompare(a.job_date));

    const pending = (jobs ?? []).filter((j) => j.status !== 'DONE').length;

    async function cycleStatus(job: StringingJob) {
        const idx = STATUS_CYCLE.indexOf(job.status);
        const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
        await save('stringing_jobs', { ...job, status: next });
    }

    async function deleteJob(job: StringingJob) {
        await remove('stringing_jobs', job.id);
        toast(`Removed ${job.player_name}'s job`);
    }

    return (
        <section>
            <header className="screen-head">
                <div>
                    <h2>Stringing Board</h2>
                    <p className="muted">{pending} active job{pending !== 1 ? 's' : ''}</p>
                </div>
            </header>

            <div className="segmented" style={{ marginBottom: 14 }}>
                {(['ALL', ...STATUS_CYCLE] as const).map((s) => (
                    <button
                        key={s}
                        className={s === filter ? 'seg on' : 'seg'}
                        style={{ fontSize: 12 }}
                        onClick={() => setFilter(s)}
                    >
                        {s === 'ALL' ? 'All' : STATUS_LABEL[s as StringingStatus]}
                    </button>
                ))}
            </div>

            {filtered.length === 0 ? (
                <div className="empty-card"><p>No jobs yet.</p></div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {filtered.map((j) => (
                        <div key={j.id} style={{
                            background: 'var(--card)', border: '1px solid var(--line)',
                            borderLeft: `4px solid ${STATUS_COLOR[j.status]}`,
                            borderRadius: 'var(--radius)', padding: '12px 14px',
                        }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 700, fontSize: 15 }}>{j.player_name}</div>
                                    <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                                        {j.racquet}{j.tension ? ` · ${j.tension} lbs` : ''}
                                        {j.gut ? ` · ${j.gut}` : ''}
                                    </div>
                                    {j.notes && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{j.notes}</div>}
                                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{j.job_date}</div>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                                    <button
                                        onClick={() => cycleStatus(j)}
                                        style={{
                                            background: 'none', border: `1px solid ${STATUS_COLOR[j.status]}`,
                                            color: STATUS_COLOR[j.status], borderRadius: 8,
                                            padding: '4px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {STATUS_LABEL[j.status]}
                                    </button>
                                    <button
                                        onClick={() => deleteJob(j)}
                                        style={{
                                            background: 'none', border: 'none', color: 'var(--muted)',
                                            fontSize: 12, cursor: 'pointer', padding: 0,
                                        }}
                                    >
                                        Remove
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <button className="fab" onClick={() => setShowForm(true)} aria-label="New stringing job">＋</button>

            {showForm && (
                <JobForm
                    onSave={async (job) => {
                        await save('stringing_jobs', { ...job });
                        setShowForm(false);
                        toast('Stringing job added');
                    }}
                    onCancel={() => setShowForm(false)}
                />
            )}
        </section>
    );
}

function JobForm({ onSave, onCancel }: { onSave: (j: StringingJob) => void; onCancel: () => void }) {
    const [form, setForm] = useState({
        player_name: '', racquet: '', tension: '', gut: '', job_date: today(), notes: '',
    });

    const set = (k: keyof typeof form) =>
        (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            setForm((f) => ({ ...f, [k]: e.target.value }));

    function submit() {
        if (!form.player_name.trim()) return;
        onSave({
            id: newId(),
            player_name: form.player_name.trim(),
            racquet: form.racquet || null,
            tension: form.tension || null,
            gut: form.gut || null,
            job_date: form.job_date || today(),
            status: 'PENDING',
            notes: form.notes || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        });
    }

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
            <div className="modal">
                <div className="modal-handle" />
                <h3>New Stringing Job</h3>

                <div className="form-group"><label>Player name</label>
                    <input value={form.player_name} onChange={set('player_name')} placeholder="Name" /></div>

                <div className="form-row">
                    <div className="form-group"><label>Racquet</label>
                        <input value={form.racquet} onChange={set('racquet')} placeholder="Yonex ArcSaber 11" /></div>
                    <div className="form-group"><label>Tension (lbs)</label>
                        <input value={form.tension} onChange={set('tension')} placeholder="26" /></div>
                </div>

                <div className="form-row">
                    <div className="form-group"><label>Gut / string</label>
                        <input value={form.gut} onChange={set('gut')} placeholder="BG65" /></div>
                    <div className="form-group"><label>Date</label>
                        <input type="date" value={form.job_date} onChange={set('job_date')} /></div>
                </div>

                <div className="form-group"><label>Notes</label>
                    <textarea value={form.notes} onChange={set('notes')} placeholder="Anything extra…" /></div>

                <button className="primary wide" style={{ marginTop: 8 }}
                    disabled={!form.player_name.trim()} onClick={submit}>
                    Add job
                </button>
                <button className="ghost wide" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}
