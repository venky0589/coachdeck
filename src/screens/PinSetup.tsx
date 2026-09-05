import { useState } from 'react';
import { randomSaltHex, derivePinHash } from '../lib/pin';
import { patchSettings } from '../lib/settings';

// Mandatory first-run screen: this is a single-coach app, so "login" means
// one PIN, created once, required every time the app opens after that —
// no separate username, no account system. App.tsx renders this instead of
// the main app whenever settings load with no coach_pin_hash yet, and there
// is deliberately no "skip for now" way out of it (contrast with
// PinLock.tsx, which unlocks an *existing* PIN and is shown on every
// later reload).

const MIN_LEN = 4;
const MAX_LEN = 6;

export default function PinSetup({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState<'create' | 'confirm'>('create');
  const [firstPin, setFirstPin] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function handleDigit(d: string) {
    if (saving || pin.length >= MAX_LEN) return;
    setPin((p) => p + d);
    setError('');
  }

  function handleDelete() {
    if (saving) return;
    setPin((p) => p.slice(0, -1));
    setError('');
  }

  function restart() {
    setStage('create');
    setFirstPin('');
    setPin('');
    setError('');
  }

  async function handleContinue() {
    if (pin.length < MIN_LEN) {
      setError(`PIN must be at least ${MIN_LEN} digits.`);
      return;
    }
    if (stage === 'create') {
      setFirstPin(pin);
      setPin('');
      setStage('confirm');
      return;
    }
    // confirm stage
    if (pin !== firstPin) {
      setError('PINs did not match — try again.');
      restart();
      return;
    }
    setSaving(true);
    const salt = randomSaltHex();
    const hash = await derivePinHash(firstPin, salt);
    await patchSettings({
      coach_pin_hash: hash,
      coach_pin_salt: salt,
      coach_pin_length: firstPin.length,
      pin_fail_count: 0,
      pin_lock_until: null,
    });
    setSaving(false);
    onDone();
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
      <p className="muted" style={{ marginBottom: 4, textAlign: 'center' }}>
        {stage === 'create' ? 'Create a PIN to protect this app' : 'Enter the same PIN again to confirm'}
      </p>
      <p className="muted" style={{ fontSize: 12, marginBottom: 32, textAlign: 'center' }}>
        4–6 digits · set once, then required every time this app opens
      </p>

      {/* PIN dots — up to MAX_LEN, since the coach's chosen length isn't
          fixed until they tap Continue on the create step. */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 20 }}>
        {Array.from({ length: MAX_LEN }).map((_, i) => (
          <div key={i} style={{
            width: 14, height: 14, borderRadius: '50%',
            background: i < pin.length ? 'var(--accent)' : 'var(--line)',
            transition: 'background 120ms',
          }} />
        ))}
      </div>

      {error && (
        <p style={{ color: 'var(--absent)', fontSize: 14, fontWeight: 600, marginBottom: 16, textAlign: 'center' }}>
          {error}
        </p>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 80px)',
        gap: 12, maxWidth: 280,
      }}>
        {KEYS.map((k, i) => {
          if (k === '') return <div key={i} />;
          return (
            <button
              key={i}
              onClick={() => k === '⌫' ? handleDelete() : handleDigit(k)}
              disabled={saving}
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

      <button
        className="primary wide"
        style={{ marginTop: 24, maxWidth: 280 }}
        onClick={handleContinue}
        disabled={pin.length < MIN_LEN || saving}
      >
        {saving ? 'Saving…' : stage === 'create' ? 'Continue' : 'Confirm PIN'}
      </button>

      {stage === 'confirm' && (
        <button className="ghost" style={{ marginTop: 8, maxWidth: 280 }} onClick={restart} disabled={saving}>
          Start over
        </button>
      )}
    </div>
  );
}
