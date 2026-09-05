// Types mirror sql/01-schema.sql exactly. If you change the schema, change these.
// (Once your Supabase project is live you can also generate these with the Supabase
//  CLI: `supabase gen types typescript` — this file is the hand-written stand-in.)

export type PlayerStatus = 'TRIAL' | 'ACTIVE' | 'PAUSED' | 'DROPPED' | 'ALUMNI';
export type BillingType = 'MONTHLY' | 'PACKAGE' | 'DROP_IN';
export type DominantHand = 'LEFT' | 'RIGHT';
export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED';
export type DueStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'WAIVED';
export type PaymentMode = 'CASH' | 'UPI' | 'BANK_TRANSFER';
export type LedgerType = 'ADVANCE' | 'OVERPAYMENT' | 'REFUND' | 'ADJUSTMENT' | 'CONSUMED';
export type HoldPolicy = 'FREE_FREEZE' | 'RETAINER';
export type StringingStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE';

// Every synced row carries these two. `id` is a client-minted UUID so records can
// be created offline; `updated_at` is the last-write-wins tiebreaker.
export interface Synced {
  id: string;
  updated_at: string; // ISO timestamp
}

export interface Player extends Synced {
  full_name: string;
  phone: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  date_of_birth: string | null; // YYYY-MM-DD
  dominant_hand: DominantHand | null;
  joining_date: string; // YYYY-MM-DD
  status: PlayerStatus;
  billing_type: BillingType;
  monthly_fee: number;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  medical_notes: string | null;
  drop_reason: string | null;
  dropped_date: string | null;
  created_at: string;
}

export interface Coach extends Synced {
  name: string;
  active: boolean;
  created_at: string;
}

export interface Batch extends Synced {
  batch_name: string;
  start_time: string; // HH:MM
  end_time: string;
  days_of_week: string[]; // ['MON','WED','FRI']
  court_number: string | null;
  max_capacity: number | null;
  // Who runs this batch. Nullable. Still not a login — just a roster entry
  // managed under Settings; see the comment on the coaches table in
  // sql/01-schema.sql. If per-coach accounts/permissions are needed later,
  // that's a bigger feature (new auth model) than this field.
  coach_id: string | null;
  created_at: string;
}

export interface PlayerBatch extends Synced {
  player_id: string;
  batch_id: string;
  assigned_date: string;
  is_active: boolean;
  created_at: string;
}

export interface AttendanceLog extends Synced {
  player_id: string;
  batch_id: string;
  date: string; // YYYY-MM-DD
  status: AttendanceStatus;
  created_at: string;
}

export interface SessionCancellation extends Synced {
  batch_id: string;
  date: string;
  reason: string | null;
  created_at: string;
}

export interface MonthlyDue extends Synced {
  player_id: string;
  billing_month: string; // YYYY-MM
  base_fee: number;
  discount: number;
  amount_paid: number;
  balance_due: number;
  status: DueStatus;
  generated_date: string;
  last_payment_date: string | null;
  created_at: string;
}

export interface PaymentTransaction {
  id: string; // client UUID (no updated_at — append-only, never edited)
  receipt_no: number | null; // assigned server-side on sync
  player_id: string;
  monthly_due_id: string | null;
  amount: number;
  payment_mode: PaymentMode;
  payment_date: string;
  receipt_note: string | null;
  created_at: string;
}

export interface CreditLedger {
  id: string; // append-only
  player_id: string;
  entry_date: string;
  amount: number; // +add / -consume
  balance_after: number;
  type: LedgerType;
  reference_note: string | null;
  related_transaction_id: string | null;
  related_due_id: string | null;
  created_at: string;
}

export interface SessionPackage extends Synced {
  player_id: string;
  package_name: string;
  total_sessions: number;
  sessions_remaining: number;
  amount_paid: number;
  purchase_date: string;
  expiry_date: string | null;
  is_active: boolean;
  created_at: string;
}

export interface SessionPackageUsage {
  id: string;
  package_id: string;
  attendance_id: string | null;
  used_date: string;
  created_at: string;
}

export interface Hold extends Synced {
  player_id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  billing_policy: HoldPolicy;
  retainer_amount: number | null;
  created_at: string;
}

export interface AppSettings extends Synced {
  academy_name: string | null;
  default_monthly_fee: number | null;
  proration_mode: 'DAILY_PRORATE' | 'HALF_MONTH' | 'FULL_MONTH';
  grace_day: number;
  // PIN lock: salted PBKDF2 hash + salt (see src/lib/pin.ts), the PIN's
  // digit length (so the lock screen knows when a full PIN has been
  // entered), and a persisted failed-attempt counter + lockout timestamp so
  // brute-force lockout survives an app reload.
  coach_pin_hash: string | null;
  coach_pin_salt: string | null;
  coach_pin_length: number | null;
  pin_fail_count: number;
  pin_lock_until: string | null; // ISO timestamp; null when not locked
}

export interface StringingJob extends Synced {
  player_name: string;
  racquet: string | null;
  tension: string | null;
  gut: string | null;
  job_date: string; // YYYY-MM-DD
  status: StringingStatus;
  notes: string | null;
  created_at: string;
}

// Table name -> row type. Used by the generic data + sync layer.
export interface Tables {
  players: Player;
  coaches: Coach;
  batches: Batch;
  player_batches: PlayerBatch;
  attendance_logs: AttendanceLog;
  session_cancellations: SessionCancellation;
  monthly_dues: MonthlyDue;
  payment_transactions: PaymentTransaction;
  credit_ledger: CreditLedger;
  session_packages: SessionPackage;
  session_package_usage: SessionPackageUsage;
  holds: Hold;
  app_settings: AppSettings;
  stringing_jobs: StringingJob;
}

export type TableName = keyof Tables;

export const TABLE_NAMES: TableName[] = [
  'players',
  'coaches',
  'batches',
  'player_batches',
  'attendance_logs',
  'session_cancellations',
  'monthly_dues',
  'payment_transactions',
  'credit_ledger',
  'session_packages',
  'session_package_usage',
  'holds',
  'app_settings',
  'stringing_jobs',
];
