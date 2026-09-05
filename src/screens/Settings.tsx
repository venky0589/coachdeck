import { useEffect, useState } from 'react';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getSettings, patchSettings } from '../lib/settings';
import { getAll, save, newId, nowISO } from '../lib/data';
import { randomSaltHex, derivePinHash } from '../lib/pin';
import { apiUrl, apiHeaders, isBackendConfigured } from '../lib/supabase';
import { toast } from '../lib/toast';
import type { AppSettings, Coach } from '../types/db';
import { exportPlayers, exportDues, exportTransactions, exportLedger, exportAll } from '../lib/export';

const PRORATION_OPTS = ['DAILY_PRORATE', 'HALF_MONTH', 'FULL_MONTH'] as const;
type ProrateMode = typeof PRORATION_OPTS[number];

export default function Settings() {
    const settings = useLiveQuery<AppSettings>(getSettings, []);

    const [academyName, setAcademyName] = useState('');
    const [defaultFee, setDefaultFee] = useState('');
    const [proration, setProration] = useState<ProrateMode>('DAILY_PRORATE');
    const [graceDay, setGraceDay] = useState('7');
    const [pin, setPin] = useState('');
    const [pinConfirm, setPinConfirm] = useState('');
    const [pinMsg, setPinMsg] = useState('');
    const [pinSaving, setPinSaving] = useState(false);
    const [billingRunning, setBillingRunning] = useState(false);

    const coaches = useLiveQuery<Coach[]>(() => getAll('coaches'), []);
    const [newCoachName, setNewCoachName] = useState('');
    const [addingCoach, setAddingCoach] = useState(false);

    useEffect(() => {
        if (settings) {
            setAcademyName(settings.academy_name ?? '');
            setDefaultFee(String(settings.default_monthly_fee ?? ''));
            setProration((settings.proration_mode ?? 'DAILY_PRORATE') as ProrateMode);
            setGraceDay(String(settings.grace_day ?? 7));
        }
    }, [settings?.id]);

    // Every write here goes through patchSettings(), which reads the current row
    // first and merges — never a hand-built literal that could silently drop a
    // field (like coach_pin_hash, or pin_fail_count) it didn't mean to touch.
    async function saveSettings() {
        await patchSettings({
            academy_name: academyName || null,
            default_monthly_fee: defaultFee ? Number(defaultFee) : null,
            proration_mode: proration,
            grace_day: Number(graceDay) || 7,
        });
    }

    async function setPinHash() {
        if (!pin || pin !== pinConfirm) {
            setPinMsg(pin !== pinConfirm ? 'PINs do not match.' : 'Enter a PIN.');
            return;
        }
        if (pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
            setPinMsg('PIN must be 4–6 digits.');
            return;
        }
        setPinSaving(true);
        const salt = randomSaltHex();
        const hash = await derivePinHash(pin, salt);
        await patchSettings({
            coach_pin_hash: hash,
            coach_pin_salt: salt,
            coach_pin_length: pin.length,
            pin_fail_count: 0,
            pin_lock_until: null,
        });
        setPin('');
        setPinConfirm('');
        setPinMsg('PIN set ✓');
        setPinSaving(false);
        toast('Coach PIN updated', 'success');
    }

    async function addCoach() {
        const name = newCoachName.trim();
        if (!name) return;
        setAddingCoach(true);
        await save('coaches', { id: newId(), name, active: true, created_at: nowISO() });
        setNewCoachName('');
        setAddingCoach(false);
    }

    async function toggleCoachActive(c: Coach) {
        await save('coaches', { ...c, active: !c.active });
    }

    async function runBillingNow() {
        if (!isBackendConfigured()) {
            toast('No backend configured — the app is running local-only.', 'error');
            return;
        }
        setBillingRunning(true);
        try {
            const r = await fetch(apiUrl('/api/billing/run-now'), {
                method: 'POST',
                headers: apiHeaders(),
            });
            if (!r.ok) throw new Error(`Server responded ${r.status}`);
            const j = await r.json();
            toast(j.message ?? 'Billing run complete', 'success');
        } catch {
            toast('Server not reachable — start it with npm run dev:all', 'error');
        } finally {
            setBillingRunning(false);
        }
    }

    return (
        <section>
            <header className="screen-head">
                <div>
                    <h2>Settings</h2>
                    <p className="muted">Academy preferences</p>
                </div>
            </header>

            <p className="section-title">Academy</p>

            <div className="settings-row">
                <span className="srow-label">Academy name</span>
                <input
                    type="text"
                    value={academyName}
                    onChange={(e) => setAcademyName(e.target.value)}
                    placeholder="My Academy"
                    onBlur={saveSettings}
                />
            </div>

            <div className="settings-row">
                <span className="srow-label">Default monthly fee (₹)</span>
                <input
                    type="number"
                    inputMode="numeric"
                    value={defaultFee}
                    onChange={(e) => setDefaultFee(e.target.value)}
                    placeholder="0"
                    onBlur={saveSettings}
                />
            </div>

            <p className="section-title">Coaches</p>
            <p className="muted" style={{ fontSize: 12, margin: '-4px 0 10px' }}>
                Who can be assigned to run a batch (Attendance → Batches). Just a
                roster label — no separate login per coach. Deactivate instead of
                deleting so past batch assignments stay intact.
            </p>
            {(coaches ?? []).length === 0 && (
                <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>No coaches yet.</p>
            )}
            {(coaches ?? []).map((c) => (
                <div className="assign-row" key={c.id}>
                    <span className="aname">{c.name}{!c.active && <span className="muted"> (inactive)</span>}</span>
                    <button className={c.active ? 'remove-btn' : 'add-btn'} onClick={() => toggleCoachActive(c)}>
                        {c.active ? 'Deactivate' : 'Activate'}
                    </button>
                </div>
            ))}
            <div className="form-row" style={{ marginTop: 8 }}>
                <div className="form-group" style={{ margin: 0, flex: 1 }}>
                    <input
                        value={newCoachName}
                        onChange={(e) => setNewCoachName(e.target.value)}
                        placeholder="New coach name"
                        onKeyDown={(e) => e.key === 'Enter' && addCoach()}
                    />
                </div>
                <button className="ghost" disabled={addingCoach || !newCoachName.trim()} onClick={addCoach}>
                    Add
                </button>
            </div>

            <p className="section-title">Billing</p>

            <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
                <span className="srow-label">Proration mode</span>
                <div className="segmented">
                    {PRORATION_OPTS.map((opt) => (
                        <button
                            key={opt}
                            className={proration === opt ? 'seg on' : 'seg'}
                            style={{ fontSize: 12 }}
                            onClick={() => { setProration(opt); setTimeout(saveSettings, 50); }}
                        >
                            {opt === 'DAILY_PRORATE' ? 'Daily' : opt === 'HALF_MONTH' ? 'Half-month' : 'Full month'}
                        </button>
                    ))}
                </div>
            </div>

            <div className="settings-row">
                <span className="srow-label">Grace day (day-of-month)</span>
                <input
                    type="number"
                    inputMode="numeric"
                    value={graceDay}
                    onChange={(e) => setGraceDay(e.target.value)}
                    min={1}
                    max={28}
                    onBlur={saveSettings}
                />
            </div>

            <div className="settings-row">
                <span className="srow-label">
                    Monthly invoices
                    <br />
                    <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>
                        Auto-runs at 06:00 on the 1st, and defensively on app-open
                    </span>
                </span>
                <button
                    id="run-billing-btn"
                    onClick={runBillingNow}
                    disabled={billingRunning}
                    style={{
                        background: 'none', border: '1px solid var(--accent)', borderRadius: 8,
                        padding: '5px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--accent)',
                        opacity: billingRunning ? 0.6 : 1,
                    }}
                >
                    {billingRunning ? 'Running…' : 'Run now'}
                </button>
            </div>

            <p className="section-title">Security</p>

            <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
                <span className="srow-label">Coach PIN (required)</span>
                <p className="muted" style={{ fontSize: 12, margin: '-4px 0 2px' }}>
                    Required to open this app — set once during first launch, this is where
                    you change it. Locks out after 5 wrong attempts, with a wait that grows
                    the more it's retried.
                </p>
                <div className="form-row">
                    <div className="form-group" style={{ margin: 0 }}>
                        <input
                            type="password"
                            inputMode="numeric"
                            maxLength={6}
                            placeholder="New PIN"
                            value={pin}
                            onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setPinMsg(''); }}
                            style={{ minHeight: 44, fontSize: 18, letterSpacing: '0.2em' }}
                        />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                        <input
                            type="password"
                            inputMode="numeric"
                            maxLength={6}
                            placeholder="Confirm"
                            value={pinConfirm}
                            onChange={(e) => { setPinConfirm(e.target.value.replace(/\D/g, '')); setPinMsg(''); }}
                            style={{ minHeight: 44, fontSize: 18, letterSpacing: '0.2em' }}
                        />
                    </div>
                </div>
                <button className="ghost wide" style={{ marginTop: 0 }} onClick={setPinHash} disabled={pinSaving}>
                    {pinSaving ? 'Saving…' : 'Change PIN'}
                </button>
                {pinMsg && <p className="muted" style={{ fontSize: 13 }}>{pinMsg}</p>}
            </div>

            <p className="section-title">Export / Backup</p>
            <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
                Downloads CSV files from local data — works offline. Keep weekly backups.
            </p>
            {[
                { label: 'Export players', fn: exportPlayers },
                { label: 'Export monthly dues', fn: exportDues },
                { label: 'Export transactions', fn: exportTransactions },
                { label: 'Export credit ledger', fn: exportLedger },
            ].map(({ label, fn }) => (
                <div className="settings-row" key={label}>
                    <span className="srow-label">{label}</span>
                    <button
                        onClick={fn}
                        style={{
                            background: 'none', border: '1px solid var(--line)', borderRadius: 8,
                            padding: '5px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--ink)',
                        }}
                    >
                        CSV ↓
                    </button>
                </div>
            ))}
            <button className="ghost wide" onClick={exportAll} style={{ marginTop: 4 }}>
                Export everything (full backup)
            </button>

            <p className="section-title">About</p>
            <div className="settings-row">
                <span className="srow-label">Data storage</span>
                <span className="srow-value">IndexedDB (offline-first)</span>
            </div>
            <div className="settings-row">
                <span className="srow-label">Sync backend</span>
                <span className="srow-value">{isBackendConfigured() ? apiUrl('') : 'Not configured (local only)'}</span>
            </div>
            <div className="settings-row">
                <span className="srow-label">Version</span>
                <span className="srow-value">V1</span>
            </div>

            <p className="hint" style={{ marginTop: 24 }}>
                Settings auto-save on blur. Run <code>npm run dev:all</code> to start app + API server together.
            </p>
        </section>
    );
}
