import { useState } from 'react';
import { save, newId, today } from '../lib/data';
import type { Player, PlayerStatus, BillingType, DominantHand } from '../types/db';

interface Props {
    initial?: Player;
    onSave: (player: Player) => void;
    onCancel: () => void;
}

const STATUS_OPTS: PlayerStatus[] = ['TRIAL', 'ACTIVE', 'PAUSED', 'DROPPED', 'ALUMNI'];
const BILLING_OPTS: BillingType[] = ['MONTHLY', 'PACKAGE', 'DROP_IN'];
const HAND_OPTS: DominantHand[] = ['RIGHT', 'LEFT'];

export default function PlayerForm({ initial, onSave, onCancel }: Props) {
    const now = today();
    const [form, setForm] = useState({
        full_name: initial?.full_name ?? '',
        joining_date: initial?.joining_date ?? now,
        status: initial?.status ?? ('TRIAL' as PlayerStatus),
        billing_type: initial?.billing_type ?? ('MONTHLY' as BillingType),
        monthly_fee: String(initial?.monthly_fee ?? ''),
        phone: initial?.phone ?? '',
        guardian_name: initial?.guardian_name ?? '',
        guardian_phone: initial?.guardian_phone ?? '',
        date_of_birth: initial?.date_of_birth ?? '',
        dominant_hand: initial?.dominant_hand ?? ('' as DominantHand | ''),
        emergency_contact_name: initial?.emergency_contact_name ?? '',
        emergency_contact_phone: initial?.emergency_contact_phone ?? '',
        medical_notes: initial?.medical_notes ?? '',
        drop_reason: initial?.drop_reason ?? '',
        dropped_date: initial?.dropped_date ?? '',
    });
    const [saving, setSaving] = useState(false);

    const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setForm((f) => ({ ...f, [k]: e.target.value }));

    async function handleSave() {
        if (!form.full_name.trim() || !form.joining_date) return;
        setSaving(true);
        const record = await save('players', {
            id: initial?.id ?? newId(),
            full_name: form.full_name.trim(),
            joining_date: form.joining_date,
            status: form.status,
            billing_type: form.billing_type,
            monthly_fee: form.monthly_fee ? Number(form.monthly_fee) : 0,
            phone: form.phone || null,
            guardian_name: form.guardian_name || null,
            guardian_phone: form.guardian_phone || null,
            date_of_birth: form.date_of_birth || null,
            dominant_hand: (form.dominant_hand as DominantHand) || null,
            emergency_contact_name: form.emergency_contact_name || null,
            emergency_contact_phone: form.emergency_contact_phone || null,
            medical_notes: form.medical_notes || null,
            drop_reason: form.status === 'DROPPED' ? (form.drop_reason || null) : null,
            dropped_date: form.status === 'DROPPED' ? (form.dropped_date || null) : null,
            created_at: initial?.created_at ?? new Date().toISOString(),
        });
        setSaving(false);
        onSave(record);
    }

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
            <div className="modal">
                <div className="modal-handle" />
                <h3>{initial ? 'Edit Player' : 'Add Player'}</h3>

                <div className="form-section-title">Identity</div>
                <div className="form-group">
                    <label>Full name *</label>
                    <input value={form.full_name} onChange={set('full_name')} placeholder="Name on register" />
                </div>
                <div className="form-row">
                    <div className="form-group">
                        <label>Joining date *</label>
                        <input type="date" value={form.joining_date} onChange={set('joining_date')} />
                    </div>
                    <div className="form-group">
                        <label>Date of birth</label>
                        <input type="date" value={form.date_of_birth} onChange={set('date_of_birth')} />
                    </div>
                </div>
                <div className="form-row">
                    <div className="form-group">
                        <label>Status</label>
                        <select value={form.status} onChange={set('status')}>
                            {STATUS_OPTS.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </div>
                    <div className="form-group">
                        <label>Dominant hand</label>
                        <select value={form.dominant_hand} onChange={set('dominant_hand')}>
                            <option value="">—</option>
                            {HAND_OPTS.map((h) => <option key={h} value={h}>{h}</option>)}
                        </select>
                    </div>
                </div>

                {form.status === 'DROPPED' && (
                    <>
                        <div className="form-group">
                            <label>Drop reason</label>
                            <textarea value={form.drop_reason} onChange={set('drop_reason')} placeholder="Why did they leave?" />
                        </div>
                        <div className="form-group">
                            <label>Dropped date</label>
                            <input type="date" value={form.dropped_date} onChange={set('dropped_date')} />
                        </div>
                    </>
                )}

                <div className="form-section-title">Billing</div>
                <div className="form-row">
                    <div className="form-group">
                        <label>Billing type</label>
                        <select value={form.billing_type} onChange={set('billing_type')}>
                            {BILLING_OPTS.map((b) => <option key={b} value={b}>{b}</option>)}
                        </select>
                    </div>
                    {form.billing_type === 'MONTHLY' && (
                        <div className="form-group">
                            <label>Monthly fee (₹)</label>
                            <input type="number" inputMode="numeric" value={form.monthly_fee} onChange={set('monthly_fee')} placeholder="0" />
                        </div>
                    )}
                </div>

                <div className="form-section-title">Contact</div>
                <div className="form-group">
                    <label>Player phone</label>
                    <input type="tel" value={form.phone} onChange={set('phone')} placeholder="+91 …" />
                </div>
                <div className="form-row">
                    <div className="form-group">
                        <label>Guardian name</label>
                        <input value={form.guardian_name} onChange={set('guardian_name')} />
                    </div>
                    <div className="form-group">
                        <label>Guardian phone</label>
                        <input type="tel" value={form.guardian_phone} onChange={set('guardian_phone')} placeholder="+91 …" />
                    </div>
                </div>

                <div className="form-section-title">Emergency & Medical</div>
                <div className="form-row">
                    <div className="form-group">
                        <label>Emergency contact</label>
                        <input value={form.emergency_contact_name} onChange={set('emergency_contact_name')} />
                    </div>
                    <div className="form-group">
                        <label>Emergency phone</label>
                        <input type="tel" value={form.emergency_contact_phone} onChange={set('emergency_contact_phone')} />
                    </div>
                </div>
                <div className="form-group">
                    <label>Medical notes</label>
                    <textarea value={form.medical_notes} onChange={set('medical_notes')} placeholder="Allergies, injuries, conditions…" />
                </div>

                <button
                    className="primary wide"
                    onClick={handleSave}
                    disabled={saving || !form.full_name.trim()}
                    style={{ marginTop: 8 }}
                >
                    {saving ? 'Saving…' : initial ? 'Save changes' : 'Add player'}
                </button>
                <button className="ghost wide" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}
