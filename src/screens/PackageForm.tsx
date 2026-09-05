import { useState } from 'react';
import { save, newId, today } from '../lib/data';

interface Props {
    playerId: string;
    onSave: () => void;
    onCancel: () => void;
}

export default function PackageForm({ playerId, onSave, onCancel }: Props) {
    const [form, setForm] = useState({
        package_name: '12-Session Card',
        total_sessions: '12',
        amount_paid: '',
        purchase_date: today(),
        expiry_date: '',
    });
    const [saving, setSaving] = useState(false);

    const set = (k: keyof typeof form) =>
        (e: React.ChangeEvent<HTMLInputElement>) =>
            setForm((f) => ({ ...f, [k]: e.target.value }));

    async function handleSave() {
        const total = Number(form.total_sessions);
        if (!form.package_name.trim() || !total) return;
        setSaving(true);
        await save('session_packages', {
            id: newId(),
            player_id: playerId,
            package_name: form.package_name.trim(),
            total_sessions: total,
            sessions_remaining: total,
            amount_paid: Number(form.amount_paid) || 0,
            purchase_date: form.purchase_date || today(),
            expiry_date: form.expiry_date || null,
            is_active: true,
            created_at: new Date().toISOString(),
        });
        setSaving(false);
        onSave();
    }

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
            <div className="modal">
                <div className="modal-handle" />
                <h3>New Session Package</h3>

                <div className="form-group">
                    <label>Package name</label>
                    <input value={form.package_name} onChange={set('package_name')} placeholder="12-Session Card" />
                </div>

                <div className="form-row">
                    <div className="form-group">
                        <label>Total sessions</label>
                        <input type="number" inputMode="numeric" value={form.total_sessions} onChange={set('total_sessions')} />
                    </div>
                    <div className="form-group">
                        <label>Amount paid (₹)</label>
                        <input type="number" inputMode="numeric" value={form.amount_paid} onChange={set('amount_paid')} placeholder="0" />
                    </div>
                </div>

                <div className="form-row">
                    <div className="form-group">
                        <label>Purchase date</label>
                        <input type="date" value={form.purchase_date} onChange={set('purchase_date')} />
                    </div>
                    <div className="form-group">
                        <label>Expiry date (optional)</label>
                        <input type="date" value={form.expiry_date} onChange={set('expiry_date')} />
                    </div>
                </div>

                <button
                    className="primary wide"
                    style={{ marginTop: 8 }}
                    disabled={saving || !form.package_name.trim() || !Number(form.total_sessions)}
                    onClick={handleSave}
                >
                    {saving ? 'Saving…' : 'Create package'}
                </button>
                <button className="ghost wide" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}
