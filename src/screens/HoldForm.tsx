import { useState } from 'react';
import { save, getAll, newId, today } from '../lib/data';
import type { HoldPolicy } from '../types/db';

interface Props {
    playerId: string;
    onSave: () => void;
    onCancel: () => void;
}

export default function HoldForm({ playerId, onSave, onCancel }: Props) {
    const t = today();
    const [form, setForm] = useState({
        start_date: t,
        end_date: t,
        reason: '',
        billing_policy: 'FREE_FREEZE' as HoldPolicy,
        retainer_amount: '',
    });
    const [saving, setSaving] = useState(false);

    const set = (k: keyof typeof form) =>
        (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
            setForm((f) => ({ ...f, [k]: e.target.value }));

    async function handleSave() {
        if (!form.start_date || !form.end_date) return;
        setSaving(true);
        await save('holds', {
            id: newId(),
            player_id: playerId,
            start_date: form.start_date,
            end_date: form.end_date,
            reason: form.reason || null,
            billing_policy: form.billing_policy,
            retainer_amount:
                form.billing_policy === 'RETAINER' && form.retainer_amount
                    ? Number(form.retainer_amount)
                    : null,
            created_at: new Date().toISOString(),
        });

        // If hold covers today, mark player as PAUSED
        const start = new Date(form.start_date);
        const end = new Date(form.end_date);
        const now = new Date(t);
        if (now >= start && now <= end) {
            const players = await getAll('players');
            const p = players.find((pl) => pl.id === playerId);
            if (p && p.status === 'ACTIVE') {
                await save('players', { ...p, status: 'PAUSED' });
            }
        }

        setSaving(false);
        onSave();
    }

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
            <div className="modal">
                <div className="modal-handle" />
                <h3>Add Hold / Pause</h3>

                <div className="form-row">
                    <div className="form-group">
                        <label>Start date</label>
                        <input type="date" value={form.start_date} onChange={set('start_date')} />
                    </div>
                    <div className="form-group">
                        <label>End date</label>
                        <input type="date" value={form.end_date} min={form.start_date} onChange={set('end_date')} />
                    </div>
                </div>

                <div className="form-group">
                    <label>Reason</label>
                    <input value={form.reason} onChange={set('reason')} placeholder="Exam leave, vacation…" />
                </div>

                <div className="form-group">
                    <label>Billing during hold</label>
                    <div className="segmented" style={{ margin: '4px 0 0' }}>
                        {(['FREE_FREEZE', 'RETAINER'] as HoldPolicy[]).map((p) => (
                            <button
                                key={p}
                                className={form.billing_policy === p ? 'seg on' : 'seg'}
                                onClick={() => setForm((f) => ({ ...f, billing_policy: p }))}
                            >
                                {p === 'FREE_FREEZE' ? 'Free freeze' : 'Retainer'}
                            </button>
                        ))}
                    </div>
                </div>

                {form.billing_policy === 'RETAINER' && (
                    <div className="form-group">
                        <label>Retainer amount (₹ / month)</label>
                        <input
                            type="number"
                            inputMode="numeric"
                            value={form.retainer_amount}
                            onChange={set('retainer_amount')}
                            placeholder="0"
                        />
                    </div>
                )}

                <button
                    className="primary wide"
                    style={{ marginTop: 8 }}
                    disabled={saving || !form.start_date || !form.end_date}
                    onClick={handleSave}
                >
                    {saving ? 'Saving…' : 'Save hold'}
                </button>
                <button className="ghost wide" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}
