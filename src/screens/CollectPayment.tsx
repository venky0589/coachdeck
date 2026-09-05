import { useEffect, useState } from 'react';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getAll } from '../lib/data';
import { collectPayment, outstandingBalance, walletBalance, applyCreditToDues, whatsappReceiptLink } from '../lib/payments';
import { toast } from '../lib/toast';
import type { PaymentMode, Player } from '../types/db';

const MODES: PaymentMode[] = ['CASH', 'UPI', 'BANK_TRANSFER'];
const MODE_LABEL: Record<PaymentMode, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  BANK_TRANSFER: 'Bank',
};

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

// Reference pattern for the 3-tap collection flow: pick player → amount is prefilled
// with the balance → pick mode → save. Then offer a one-tap WhatsApp receipt.
export default function CollectPayment() {
  const players = useLiveQuery(async () => {
    const all = await getAll('players');
    return all
      .filter((p) => p.status === 'ACTIVE' || p.status === 'PAUSED')
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, []);

  const [selected, setSelected] = useState<Player | null>(null);
  const [balance, setBalance] = useState(0);
  const [credit, setCredit] = useState(0);
  const [applyingCredit, setApplyingCredit] = useState(false);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PaymentMode>('CASH');
  const [done, setDone] = useState<{ amount: number; excess: number } | null>(null);

  async function refreshBalances(playerId: string) {
    const [b, c] = await Promise.all([outstandingBalance(playerId), walletBalance(playerId)]);
    setBalance(b);
    setCredit(c);
    return b;
  }

  useEffect(() => {
    if (!selected) return;
    refreshBalances(selected.id).then((b) => setAmount(b > 0 ? String(b) : ''));
  }, [selected]);

  async function submit() {
    if (!selected) return;
    const amt = Number(amount);
    if (!amt || amt <= 0) return;
    const result = await collectPayment({ playerId: selected.id, amount: amt, mode });
    setDone({ amount: amt, excess: result.excess });
    await refreshBalances(selected.id);
  }

  async function useCredit() {
    if (!selected || credit <= 0) return;
    setApplyingCredit(true);
    const result = await applyCreditToDues(selected.id);
    setApplyingCredit(false);
    if (result.applied > 0) {
      toast(`Applied ${rupees(result.applied)} credit`, 'success');
      const b = await refreshBalances(selected.id);
      setAmount(b > 0 ? String(b) : '');
    }
  }

  function reset() {
    setSelected(null);
    setBalance(0);
    setCredit(0);
    setAmount('');
    setMode('CASH');
    setDone(null);
  }

  // Step 1 — pick a player.
  if (!selected) {
    return (
      <section>
        <h2>Collect payment</h2>
        <p className="muted">Pick a player to see their balance.</p>
        <ul className="rows">
          {players?.map((p) => (
            <li key={p.id}>
              <button className="row" onClick={() => setSelected(p)}>
                <span className="name">{p.full_name}</span>
                <span className="chev">›</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  // Step 3 — confirmation + WhatsApp receipt.
  if (done) {
    const msg = done.excess > 0.005
      ? `Hi, received ${rupees(done.amount)} towards badminton coaching for ${selected.full_name}. ${rupees(done.excess)} of that is credited to their account for next month. Thank you!`
      : `Hi, received ${rupees(done.amount)} towards badminton coaching for ${selected.full_name}. Balance: ${rupees(balance)}. Thank you!`;
    return (
      <section>
        <div className="confirm">
          <div className="tick">✓</div>
          <h2>{rupees(done.amount)} received</h2>
          <p className="muted">
            {selected.full_name} · balance now {rupees(balance)}
          </p>
          {done.excess > 0.005 && (
            <p className="muted" style={{ color: 'var(--accent)', fontWeight: 600, marginTop: 6 }}>
              {rupees(done.excess)} credited to their wallet
            </p>
          )}
        </div>
        {selected.guardian_phone && (
          <a
            className="primary wide"
            href={whatsappReceiptLink(selected.guardian_phone, msg)}
            target="_blank"
            rel="noreferrer"
          >
            Send WhatsApp receipt
          </a>
        )}
        <button className="ghost wide" onClick={reset}>
          Done
        </button>
      </section>
    );
  }

  // Step 2 — amount + mode.
  return (
    <section>
      <button className="back" onClick={reset}>
        ‹ Players
      </button>
      <h2>{selected.full_name}</h2>
      <p className="muted">Outstanding {rupees(balance)}</p>

      {credit > 0 && (
        <div className="credit-row">
          <div>
            <div className="credit-label">Wallet credit available</div>
            <div className="credit-amount">{rupees(credit)}</div>
          </div>
          {balance > 0 && (
            <button
              className="ghost"
              style={{ marginTop: 0 }}
              disabled={applyingCredit}
              onClick={useCredit}
            >
              {applyingCredit ? 'Applying…' : 'Apply to balance'}
            </button>
          )}
        </div>
      )}

      <label className="field">
        <span>Amount</span>
        <input
          type="number"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
        />
      </label>

      <div className="segmented">
        {MODES.map((m) => (
          <button
            key={m}
            className={m === mode ? 'seg on' : 'seg'}
            onClick={() => setMode(m)}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {Number(amount) > balance && balance >= 0 && (
        <p className="muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 14 }}>
          {balance > 0 ? `${rupees(Number(amount) - balance)} beyond the balance` : 'No balance due'} will be
          credited to {selected.full_name}'s wallet for next month.
        </p>
      )}

      <button className="primary wide" onClick={submit} disabled={!Number(amount)}>
        Save {Number(amount) ? rupees(Number(amount)) : 'payment'}
      </button>
    </section>
  );
}
