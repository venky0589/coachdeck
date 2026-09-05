import { useEffect, useState } from 'react';
import { verifyPin, lockDurationSeconds, lockUntilFor } from '../lib/pin';
import { patchSettings } from '../lib/settings';
import type { AppSettings } from '../types/db';

function formatCountdown(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
}

export default function PinLock({
    settings,
    onUnlock,
}: {
    settings: AppSettings;
    onUnlock: () => void;
}) {
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [checking, setChecking] = useState(false);
    const [failCount, setFailCount] = useState(settings.pin_fail_count ?? 0);
    const [lockUntil, setLockUntil] = useState<string | null>(settings.pin_lock_until ?? null);
    const [tick, setTick] = useState(() => Date.now());

    const pinLength = settings.coach_pin_length ?? 6;
    const locked = !!lockUntil && new Date(lockUntil).getTime() > tick;
    const secondsLeft = locked ? Math.ceil((new Date(lockUntil!).getTime() - tick) / 1000) : 0;

    // Tick every second while locked so the countdown updates and the numpad
    // re-enables itself the moment the lock expires, with no reload needed.
    useEffect(() => {
        if (!locked) return;
        const t = setInterval(() => setTick(Date.now()), 1000);
        return () => clearInterval(t);
    }, [locked]);

    async function handleDigit(d: string) {
        if (locked || checking) return;
        if (pin.length >= pinLength) return;
        const next = pin + d;
        setPin(next);
        setError('');
        if (next.length === pinLength) await check(next);
    }

    async function check(code: string) {
        setChecking(true);
        const ok =
            !!settings.coach_pin_salt && !!settings.coach_pin_hash
                ? await verifyPin(code, settings.coach_pin_salt, settings.coach_pin_hash)
                : false;

        if (ok) {
            await patchSettings({ pin_fail_count: 0, pin_lock_until: null });
            onUnlock();
            setChecking(false);
            return;
        }

        const fails = failCount + 1;
        const until = lockUntilFor(fails);
        setFailCount(fails);
        setLockUntil(until);
        setPin('');
        setError(
            until
                ? `Too many attempts. Try again in ${formatCountdown(lockDurationSeconds(fails))}.`
                : 'Incorrect PIN',
        );
        await patchSettings({ pin_fail_count: fails, pin_lock_until: until });
        setChecking(false);
    }

    function handleDelete() {
        if (locked) return;
        setPin((p) => p.slice(0, -1));
        setError('');
    }

    const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

    return (
        <div style={{
            minHeight: '100dvh', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            background: 'var(--paper)', padding: '0 24px',
        }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🏸</div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px', letterSpacing: '-0.02em' }}>
                Coach App
            </h1>
            <p className="muted" style={{ marginBottom: 40 }}>
                {locked ? 'Locked' : 'Enter your PIN to continue'}
            </p>

            {/* PIN dots */}
            <div style={{ display: 'flex', gap: 14, marginBottom: 36 }}>
                {Array.from({ length: pinLength }).map((_, i) => (
                    <div key={i} style={{
                        width: 14, height: 14, borderRadius: '50%',
                        background: i < pin.length ? 'var(--accent)' : 'var(--line)',
                        transition: 'background 120ms',
                        opacity: locked ? 0.4 : 1,
                    }} />
                ))}
            </div>

            {/* Error / lockout countdown */}
            {locked ? (
                <div style={{
                    textAlign: 'center', marginBottom: 20, padding: '10px 16px',
                    background: 'rgba(229,72,77,0.08)', border: '1px solid rgba(229,72,77,0.2)',
                    borderRadius: 'var(--radius)',
                }}>
                    <p style={{ color: 'var(--absent)', fontSize: 14, fontWeight: 700, margin: 0 }}>
                        Too many attempts
                    </p>
                    <p className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                        Try again in {formatCountdown(secondsLeft)}
                    </p>
                </div>
            ) : error ? (
                <p style={{ color: 'var(--absent)', fontSize: 14, fontWeight: 600, marginBottom: 20 }}>
                    {error}
                </p>
            ) : null}

            {/* Numpad */}
            <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(3, 80px)',
                gap: 12, maxWidth: 280, opacity: locked ? 0.35 : 1,
                pointerEvents: locked ? 'none' : 'auto',
            }}>
                {KEYS.map((k, i) => {
                    if (k === '') return <div key={i} />;
                    return (
                        <button
                            key={i}
                            onClick={() => k === '⌫' ? handleDelete() : handleDigit(k)}
                            disabled={checking || locked}
                            style={{
                                height: 70, borderRadius: 16,
                                border: '1px solid var(--line)',
                                background: k === '⌫' ? 'transparent' : 'var(--card)',
                                fontSize: k === '⌫' ? 22 : 24, fontWeight: 600,
                                cursor: 'pointer', color: 'var(--ink)',
                                transition: 'background 80ms',
                            }}
                        >
                            {k}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
