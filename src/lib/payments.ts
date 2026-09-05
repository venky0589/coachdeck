import { save, where, newId, nowISO, today } from './data';
import type { MonthlyDue, PaymentMode, LedgerType } from '../types/db';

/** Total a player still owes across all unpaid/partial invoices. */
export async function outstandingBalance(playerId: string): Promise<number> {
  const dues = await where(
    'monthly_dues',
    (d) => d.player_id === playerId && d.status !== 'PAID' && d.status !== 'WAIVED',
  );
  return dues.reduce((sum, d) => sum + Number(d.balance_due), 0);
}

/** Current wallet credit balance — the running total the ledger's `balance_after` tracks. */
export async function walletBalance(playerId: string): Promise<number> {
  const ledger = await where('credit_ledger', (l) => l.player_id === playerId);
  if (!ledger.length) return 0;
  const latest = ledger.sort(
    (a, b) => b.entry_date.localeCompare(a.entry_date) || b.created_at.localeCompare(a.created_at),
  )[0];
  return Number(latest.balance_after);
}

async function addLedgerEntry(opts: {
  playerId: string;
  amount: number; // signed: +credit added, -credit consumed/refunded out
  type: LedgerType;
  note?: string;
  relatedTransactionId?: string | null;
  relatedDueId?: string | null;
}): Promise<number> {
  const prior = await walletBalance(opts.playerId);
  const balanceAfter = prior + opts.amount;
  await save('credit_ledger', {
    id: newId(),
    player_id: opts.playerId,
    entry_date: nowISO(),
    amount: opts.amount,
    balance_after: balanceAfter,
    type: opts.type,
    reference_note: opts.note ?? null,
    related_transaction_id: opts.relatedTransactionId ?? null,
    related_due_id: opts.relatedDueId ?? null,
    created_at: nowISO(),
  });
  return balanceAfter;
}

/**
 * Record a payment and settle it against the player's oldest open invoices first.
 * Writes a payment_transaction (append-only) and updates each due it touches.
 *
 * Anything paid beyond what's currently owed is recorded as wallet credit —
 * an `OVERPAYMENT` entry if it's the tail end of clearing a real due, an
 * `ADVANCE` entry if nothing was owed at all (e.g. paying a few months
 * up front) — instead of just vanishing from the record. See credit_ledger
 * in the spec: this is the "player wallet" the auto-apply-on-invoice logic
 * in sql/02-billing.sql already expects to find populated.
 */
export async function collectPayment(opts: {
  playerId: string;
  amount: number;
  mode: PaymentMode;
  note?: string;
}): Promise<{ appliedToDues: number; excess: number; walletBalance: number }> {
  const { playerId, amount, mode, note } = opts;

  const txn = await save('payment_transactions', {
    id: newId(),
    receipt_no: null,
    player_id: playerId,
    monthly_due_id: null,
    amount,
    payment_mode: mode,
    payment_date: nowISO(),
    receipt_note: note ?? null,
    created_at: nowISO(),
  });

  // Apply oldest-first.
  const open = (
    await where(
      'monthly_dues',
      (d) => d.player_id === playerId && d.status !== 'PAID' && d.status !== 'WAIVED',
    )
  ).sort((a, b) => a.billing_month.localeCompare(b.billing_month));

  let remaining = amount;
  let applied = 0;

  for (const due of open) {
    if (remaining <= 0) break;
    const pay = Math.min(remaining, Number(due.balance_due));
    if (pay <= 0) continue;

    const amount_paid = Number(due.amount_paid) + pay;
    const balance_due = Number(due.balance_due) - pay;
    const status: MonthlyDue['status'] = balance_due <= 0 ? 'PAID' : 'PARTIAL';

    await save('monthly_dues', {
      ...due,
      amount_paid,
      balance_due,
      status,
      last_payment_date: nowISO(),
    });

    remaining -= pay;
    applied += pay;
  }

  let wallet = await walletBalance(playerId);
  if (remaining > 0.005) {
    // Snap out float dust so a ₹0.001 remainder doesn't create a phantom credit row.
    const type: LedgerType = applied > 0 ? 'OVERPAYMENT' : 'ADVANCE';
    wallet = await addLedgerEntry({
      playerId,
      amount: remaining,
      type,
      note:
        applied > 0
          ? 'Overpayment beyond dues owed — credited to wallet'
          : 'Advance payment — no due outstanding',
      relatedTransactionId: txn.id,
    });
  }

  return { appliedToDues: applied, excess: remaining, walletBalance: wallet };
}

/**
 * Apply existing wallet credit to a player's outstanding dues, oldest first.
 * Mirrors what generate_monthly_invoices() auto-applies to a brand-new
 * invoice, but callable on demand (e.g. a coach clearing an older due once
 * they notice a player is sitting on unused credit).
 */
export async function applyCreditToDues(
  playerId: string,
): Promise<{ applied: number; walletBalance: number }> {
  let credit = await walletBalance(playerId);
  if (credit <= 0) return { applied: 0, walletBalance: credit };

  const open = (
    await where(
      'monthly_dues',
      (d) => d.player_id === playerId && d.status !== 'PAID' && d.status !== 'WAIVED',
    )
  ).sort((a, b) => a.billing_month.localeCompare(b.billing_month));

  let applied = 0;
  for (const due of open) {
    if (credit <= 0) break;
    const pay = Math.min(credit, Number(due.balance_due));
    if (pay <= 0) continue;

    const amount_paid = Number(due.amount_paid) + pay;
    const balance_due = Number(due.balance_due) - pay;
    const status: MonthlyDue['status'] = balance_due <= 0 ? 'PAID' : 'PARTIAL';

    await save('monthly_dues', { ...due, amount_paid, balance_due, status, last_payment_date: nowISO() });

    credit = await addLedgerEntry({
      playerId,
      amount: -pay,
      type: 'CONSUMED',
      note: `Applied to ${due.billing_month}`,
      relatedDueId: due.id,
    });
    applied += pay;
  }

  return { applied, walletBalance: credit };
}

/** WhatsApp click-to-chat receipt (manual send — coach taps once). */
export function whatsappReceiptLink(phone: string, text: string): string {
  const clean = phone.replace(/[^\d]/g, '');
  return `https://wa.me/${clean}?text=${encodeURIComponent(text)}`;
}

export function todayStr() {
  return today();
}
