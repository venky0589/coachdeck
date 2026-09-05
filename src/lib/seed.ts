import { getAll, save, newId, nowISO, today, thisMonth } from './data';
import type { Player } from '../types/db';

// Populates enough demo data to exercise every screen and billing path in
// one seed, not just the happy-path "everyone owes this month's fee" case:
// two batches (so the Attendance batch picker has something to pick
// between), a package-billed player with a low session count (so the
// low-balance toast in RollCall fires the next time they're marked
// present), a paused player under an active hold, a player who overpaid
// (so CollectPayment's wallet-credit UI has a real balance to show), and
// stringing jobs across all three statuses. Idempotent-ish: only seeds
// when there are no players yet.
export async function seedDemoDataIfEmpty(): Promise<boolean> {
  const existing = await getAll('players');
  if (existing.length > 0) return false;

  const coachRavi = await save('coaches', { id: newId(), name: 'Coach Ravi', active: true, created_at: nowISO() });
  const coachPriya = await save('coaches', { id: newId(), name: 'Coach Priya', active: true, created_at: nowISO() });

  const morning = await save('batches', {
    id: newId(),
    batch_name: 'Morning Advanced',
    start_time: '06:00',
    end_time: '07:30',
    days_of_week: ['MON', 'WED', 'FRI'],
    court_number: 'Court 1',
    max_capacity: 12,
    coach_id: coachRavi.id,
    created_at: nowISO(),
  });

  const evening = await save('batches', {
    id: newId(),
    batch_name: 'Evening Beginners',
    start_time: '17:00',
    end_time: '18:30',
    days_of_week: ['TUE', 'THU', 'SAT'],
    court_number: 'Court 2',
    max_capacity: 16,
    coach_id: coachPriya.id,
    created_at: nowISO(),
  });

  async function addPlayer(
    batchId: string,
    p: Partial<Player> & { full_name: string },
  ) {
    const player = await save('players', {
      id: newId(),
      phone: null,
      guardian_name: null,
      guardian_phone: null,
      date_of_birth: null,
      dominant_hand: null,
      joining_date: today(),
      status: 'ACTIVE',
      billing_type: 'MONTHLY',
      monthly_fee: 0,
      emergency_contact_name: null,
      emergency_contact_phone: null,
      medical_notes: null,
      drop_reason: null,
      dropped_date: null,
      created_at: nowISO(),
      ...p,
    });

    await save('player_batches', {
      id: newId(),
      player_id: player.id,
      batch_id: batchId,
      assigned_date: today(),
      is_active: true,
      created_at: nowISO(),
    });

    return player;
  }

  // ---- Morning Advanced: monthly-billed players, a spread of due states ----

  // Unpaid — shows up in Home's overdue collection bar.
  const aarav = await addPlayer(morning.id, {
    full_name: 'Aarav Mehta',
    guardian_phone: '919000000001',
    monthly_fee: 2500,
  });
  await save('monthly_dues', {
    id: newId(),
    player_id: aarav.id,
    billing_month: thisMonth(),
    base_fee: 2500,
    discount: 0,
    amount_paid: 0,
    balance_due: 2500,
    status: 'UNPAID',
    generated_date: today(),
    last_payment_date: null,
    created_at: nowISO(),
  });

  // Partially paid — exercises the PARTIAL due-status pill and balance math
  // in CollectPayment/PlayerProfile.
  const diya = await addPlayer(morning.id, {
    full_name: 'Diya Sharma',
    guardian_phone: '919000000002',
    monthly_fee: 2500,
  });
  const diyaTxn = await save('payment_transactions', {
    id: newId(),
    receipt_no: null,
    player_id: diya.id,
    monthly_due_id: null,
    amount: 1000,
    payment_mode: 'UPI',
    payment_date: nowISO(),
    receipt_note: 'Part payment',
    created_at: nowISO(),
  });
  await save('monthly_dues', {
    id: newId(),
    player_id: diya.id,
    billing_month: thisMonth(),
    base_fee: 2500,
    discount: 0,
    amount_paid: 1000,
    balance_due: 1500,
    status: 'PARTIAL',
    generated_date: today(),
    last_payment_date: diyaTxn.payment_date,
    created_at: nowISO(),
  });

  // Fully paid, with an extra ₹200 that overshot the fee — sits as wallet
  // credit (credit_ledger) rather than vanishing, so CollectPayment's
  // "apply to balance" row and PlayerProfile's wallet card have something
  // real to show.
  const kabir = await addPlayer(morning.id, {
    full_name: 'Kabir Rao',
    guardian_phone: '919000000003',
    monthly_fee: 2000,
  });
  const kabirTxn = await save('payment_transactions', {
    id: newId(),
    receipt_no: null,
    player_id: kabir.id,
    monthly_due_id: null,
    amount: 2200,
    payment_mode: 'CASH',
    payment_date: nowISO(),
    receipt_note: 'Full month + extra',
    created_at: nowISO(),
  });
  await save('monthly_dues', {
    id: newId(),
    player_id: kabir.id,
    billing_month: thisMonth(),
    base_fee: 2000,
    discount: 0,
    amount_paid: 2000,
    balance_due: 0,
    status: 'PAID',
    generated_date: today(),
    last_payment_date: kabirTxn.payment_date,
    created_at: nowISO(),
  });
  await save('credit_ledger', {
    id: newId(),
    player_id: kabir.id,
    entry_date: nowISO(),
    amount: 200,
    balance_after: 200,
    type: 'OVERPAYMENT',
    reference_note: 'Overpayment beyond dues owed — credited to wallet',
    related_transaction_id: kabirTxn.id,
    related_due_id: null,
    created_at: nowISO(),
  });

  // Paused, under an active hold — exercises Hold cards + the ACTIVE/PAUSED
  // sweep on load (src/lib/holds.ts), which should leave her PAUSED since
  // today falls inside the hold window.
  const meera = await addPlayer(morning.id, {
    full_name: 'Meera Iyer',
    guardian_phone: '919000000005',
    monthly_fee: 2500,
    status: 'PAUSED',
  });
  const holdStart = new Date();
  holdStart.setDate(holdStart.getDate() - 3);
  const holdEnd = new Date();
  holdEnd.setDate(holdEnd.getDate() + 11);
  await save('holds', {
    id: newId(),
    player_id: meera.id,
    start_date: holdStart.toISOString().slice(0, 10),
    end_date: holdEnd.toISOString().slice(0, 10),
    reason: 'Travelling',
    billing_policy: 'FREE_FREEZE',
    retainer_amount: null,
    created_at: nowISO(),
  });

  // ---- Evening Beginners: an unpaid monthly player + a package player ----

  const ishita = await addPlayer(evening.id, {
    full_name: 'Ishita Nair',
    guardian_phone: '919000000004',
    monthly_fee: 2500,
  });
  await save('monthly_dues', {
    id: newId(),
    player_id: ishita.id,
    billing_month: thisMonth(),
    base_fee: 2500,
    discount: 0,
    amount_paid: 0,
    balance_due: 2500,
    status: 'UNPAID',
    generated_date: today(),
    last_payment_date: null,
    created_at: nowISO(),
  });

  // Package-billed with only 3 sessions left — marking her present in
  // RollCall will draw it down to 2 and trip the low-balance toast there.
  const rohan = await addPlayer(evening.id, {
    full_name: 'Rohan Verma',
    guardian_phone: '919000000006',
    monthly_fee: 0,
    billing_type: 'PACKAGE',
  });
  await save('session_packages', {
    id: newId(),
    player_id: rohan.id,
    package_name: '10-session card',
    total_sessions: 10,
    sessions_remaining: 3,
    amount_paid: 4500,
    purchase_date: today(),
    expiry_date: null,
    is_active: true,
    created_at: nowISO(),
  });

  // ---- Stringing jobs across all three board statuses ----
  const jobs: { player_name: string; racquet: string; tension: string; gut: string; status: 'PENDING' | 'IN_PROGRESS' | 'DONE' }[] = [
    { player_name: 'Aarav Mehta', racquet: 'Yonex Astrox 88D', tension: '27', gut: 'BG65', status: 'PENDING' },
    { player_name: 'Diya Sharma', racquet: 'Yonex Nanoflare 800', tension: '24', gut: 'BG66 Ultimax', status: 'IN_PROGRESS' },
    { player_name: 'Kabir Rao', racquet: 'Li-Ning Aeronaut 9000', tension: '26', gut: 'Aerosonic', status: 'DONE' },
  ];
  for (const j of jobs) {
    await save('stringing_jobs', {
      id: newId(),
      player_name: j.player_name,
      racquet: j.racquet,
      tension: j.tension,
      gut: j.gut,
      job_date: today(),
      status: j.status,
      notes: null,
      created_at: nowISO(),
    });
  }

  return true;
}
