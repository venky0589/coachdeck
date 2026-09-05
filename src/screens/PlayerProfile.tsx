import { useState } from 'react';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getAll, where } from '../lib/data';
import { whatsappReceiptLink, walletBalance, applyCreditToDues } from '../lib/payments';
import { toast } from '../lib/toast';
import type { Hold, MonthlyDue, Player, SessionPackage } from '../types/db';
import HoldForm from './HoldForm';
import PackageForm from './PackageForm';

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

const STATUS_LABEL: Record<string, string> = {
    TRIAL: 'Trial', ACTIVE: 'Active', PAUSED: 'Paused', DROPPED: 'Dropped', ALUMNI: 'Alumni',
};

function computeAge(dob: string | null): string {
    if (!dob) return '';
    const diff = Date.now() - new Date(dob).getTime();
    const age = Math.floor(diff / (365.25 * 24 * 3600 * 1000));
    return `${age}y`;
}

export default function PlayerProfile({
    playerId,
    onEdit,
    onBack,
}: {
    playerId: string;
    onEdit: () => void;
    onBack: () => void;
}) {
    const [showHoldForm, setShowHoldForm] = useState(false);
    const [showPkgForm, setShowPkgForm] = useState(false);
    const [applyingCredit, setApplyingCredit] = useState(false);

    const player = useLiveQuery(async () => {
        const all = await getAll('players');
        return all.find((p) => p.id === playerId) as Player | undefined;
    }, [playerId]);

    const dues = useLiveQuery(
        () => where('monthly_dues', (d) => d.player_id === playerId),
        [playerId],
    );

    const wallet = useLiveQuery(() => walletBalance(playerId), [playerId]);

    const holds = useLiveQuery(
        () => where('holds', (h) => h.player_id === playerId),
        [playerId],
    );

    const packages = useLiveQuery(
        () => where('session_packages', (pk) => pk.player_id === playerId && pk.is_active),
        [playerId],
    );

    if (!player) return <p className="muted" style={{ marginTop: 32 }}>Loading…</p>;

    const totalOwed = (dues ?? []).filter((d) => d.status !== 'PAID' && d.status !== 'WAIVED')
        .reduce((s, d) => s + Number(d.balance_due), 0);

    const sortedDues = (dues ?? []).sort((a, b) => b.billing_month.localeCompare(a.billing_month));

    return (
        <section>
            <button className="back" onClick={onBack}>‹ Players</button>

            {/* Header */}
            <div className="profile-head">
                <div className="info">
                    <h2>{player.full_name}</h2>
                    <div className="meta">
                        <span className={`badge badge-${player.status.toLowerCase()}`}>
                            {STATUS_LABEL[player.status]}
                        </span>
                        {' '}
                        <span className="chip">{player.billing_type}</span>
                        {player.date_of_birth && (
                            <> · {computeAge(player.date_of_birth)}</>
                        )}
                        {player.dominant_hand && (
                            <> · {player.dominant_hand[0].toUpperCase()}-hand</>
                        )}
                    </div>
                </div>
                <button className="profile-edit-btn" onClick={onEdit}>Edit</button>
            </div>

            {/* Contact quick row */}
            {player.guardian_phone && (
                <p className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>
                    Guardian: {player.guardian_name ? `${player.guardian_name} · ` : ''}{player.guardian_phone}
                </p>
            )}
            {player.medical_notes && (
                <p style={{ fontSize: 13, color: '#e5484d', marginTop: 4 }}>⚠ {player.medical_notes}</p>
            )}

            {/* Outstanding balance */}
            {totalOwed > 0 && (
                <div style={{
                    background: 'rgba(229,72,77,0.08)', border: '1px solid rgba(229,72,77,0.2)',
                    borderRadius: 'var(--radius)', padding: '10px 14px', marginTop: 14,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--absent)' }}>Outstanding</span>
                    <span style={{ fontWeight: 700, color: 'var(--absent)' }}>{rupees(totalOwed)}</span>
                </div>
            )}

            {/* Credit wallet */}
            {(wallet ?? 0) !== 0 && (
                <>
                    <p className="section-title">Wallet Credit</p>
                    <div className="wallet-card">
                        <span className="wallet-label">Available credit</span>
                        <span className={`wallet-amount ${(wallet ?? 0) < 0 ? 'negative' : ''}`}>
                            {rupees(wallet ?? 0)}
                        </span>
                        {(wallet ?? 0) > 0 && totalOwed > 0 && (
                            <button
                                className="ghost"
                                style={{ marginTop: 0, marginLeft: 8 }}
                                disabled={applyingCredit}
                                onClick={async () => {
                                    setApplyingCredit(true);
                                    const result = await applyCreditToDues(playerId);
                                    setApplyingCredit(false);
                                    if (result.applied > 0) toast(`Applied ${rupees(result.applied)} credit`, 'success');
                                }}
                            >
                                {applyingCredit ? 'Applying…' : 'Apply to balance'}
                            </button>
                        )}
                    </div>
                </>
            )}

            {/* Dues history */}
            <p className="section-title">Dues History</p>
            {sortedDues.length === 0 ? (
                <div className="empty-card"><p>No invoices yet.</p></div>
            ) : (
                sortedDues.map((d) => <DueRow key={d.id} due={d} />)
            )}

            {/* Active holds */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '24px 0 10px' }}>
                <p className="section-title" style={{ margin: 0 }}>Holds / Pauses</p>
                <button className="add-link" onClick={() => setShowHoldForm(true)}>+ Add hold</button>
            </div>
            {(holds ?? []).length === 0 ? (
                <div className="empty-card"><p>No holds recorded.</p></div>
            ) : (
                (holds ?? [])
                    .sort((a, b) => b.start_date.localeCompare(a.start_date))
                    .map((h) => <HoldCard key={h.id} hold={h} />)
            )}

            {/* Session packages (only for PACKAGE players or if they have active packages) */}
            {(player.billing_type === 'PACKAGE' || (packages ?? []).length > 0) && (
                <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '24px 0 10px' }}>
                        <p className="section-title" style={{ margin: 0 }}>Session Packages</p>
                        <button className="add-link" onClick={() => setShowPkgForm(true)}>+ New package</button>
                    </div>
                    {(packages ?? []).length === 0 ? (
                        <div className="empty-card"><p>No active packages.</p></div>
                    ) : (
                        (packages ?? []).map((pk) => <PackageCard key={pk.id} pkg={pk} />)
                    )}
                </>
            )}

            {/* WhatsApp reminder */}
            {player.guardian_phone && totalOwed > 0 && (
                <>
                    <p className="section-title">Reminder</p>
                    <a
                        className="primary wide"
                        href={whatsappReceiptLink(
                            player.guardian_phone,
                            `Hi, ${player.full_name} has an outstanding balance of ${rupees(totalOwed)} for badminton coaching. Please make the payment at your earliest convenience. Thank you!`,
                        )}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: 'flex', marginTop: 0 }}
                    >
                        Send WhatsApp reminder
                    </a>
                </>
            )}

            {showHoldForm && (
                <HoldForm
                    playerId={playerId}
                    onSave={() => setShowHoldForm(false)}
                    onCancel={() => setShowHoldForm(false)}
                />
            )}
            {showPkgForm && (
                <PackageForm
                    playerId={playerId}
                    onSave={() => setShowPkgForm(false)}
                    onCancel={() => setShowPkgForm(false)}
                />
            )}
        </section>
    );
}

function DueRow({ due: d }: { due: MonthlyDue }) {
    const balClass = d.status === 'PAID' ? 'paid' : d.status === 'PARTIAL' ? 'partial' : 'unpaid';
    const pillClass = `due-pill due-pill-${d.status.toLowerCase()}`;
    return (
        <div className="due-row">
            <span className="month">{d.billing_month}</span>
            <span className={`due-bal ${balClass}`}>
                {d.status === 'PAID' ? '✓ Paid' : `₹${Number(d.balance_due).toLocaleString('en-IN')}`}
            </span>
            <span className={pillClass}>{d.status}</span>
        </div>
    );
}

function HoldCard({ hold: h }: { hold: Hold }) {
    return (
        <div className="hold-card">
            <div className="hold-dates">
                {h.start_date} → {h.end_date}
                <span className="hold-policy-chip">{h.billing_policy === 'FREE_FREEZE' ? 'Free freeze' : 'Retainer'}</span>
            </div>
            <div className="hold-meta">
                {h.reason || 'No reason given'}
                {h.billing_policy === 'RETAINER' && h.retainer_amount
                    ? ` · ₹${Number(h.retainer_amount)}/mo retainer`
                    : ''}
            </div>
        </div>
    );
}

function PackageCard({ pkg: pk }: { pkg: SessionPackage }) {
    const pct = pk.total_sessions > 0 ? (pk.sessions_remaining / pk.total_sessions) * 100 : 0;
    const lowStock = pk.sessions_remaining <= 2;
    return (
        <div className="pkg-card">
            <div className="pkg-name">{pk.package_name}</div>
            <div className="pkg-progress">
                <div
                    className={`pkg-progress-fill${lowStock ? ' warn' : ''}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <div className="pkg-meta">
                {pk.sessions_remaining} of {pk.total_sessions} sessions remaining
                {pk.expiry_date ? ` · expires ${pk.expiry_date}` : ''}
                {lowStock && ' · ⚠ Low'}
            </div>
        </div>
    );
}
