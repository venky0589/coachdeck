import { getAll } from '../lib/data';
import type { TableName } from '../types/db';

// CSV helpers
const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCSV<T extends Record<string, unknown>>(rows: T[]): string {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const header = cols.join(',');
    const body = rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n');
    return `${header}\n${body}`;
}

function download(filename: string, csv: string) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

const DATE = () => new Date().toISOString().slice(0, 10);

export async function exportPlayers() {
    const rows = await getAll('players');
    download(`players-${DATE()}.csv`, toCSV(rows as unknown as Record<string, unknown>[]));
}

export async function exportDues() {
    const rows = await getAll('monthly_dues');
    download(`monthly-dues-${DATE()}.csv`, toCSV(rows as unknown as Record<string, unknown>[]));
}

export async function exportTransactions() {
    const rows = await getAll('payment_transactions');
    download(`transactions-${DATE()}.csv`, toCSV(rows as unknown as Record<string, unknown>[]));
}

export async function exportLedger() {
    const rows = await getAll('credit_ledger');
    download(`credit-ledger-${DATE()}.csv`, toCSV(rows as unknown as Record<string, unknown>[]));
}

export async function exportAll() {
    const tables: TableName[] = [
        'players', 'batches', 'attendance_logs', 'monthly_dues',
        'payment_transactions', 'credit_ledger', 'session_packages', 'holds',
        'stringing_jobs',
    ];
    const parts: string[] = [];
    for (const t of tables) {
        const rows = await getAll(t);
        parts.push(`### ${t}\n${toCSV(rows as unknown as Record<string, unknown>[])}`);
    }
    download(`badminton-full-export-${DATE()}.csv`, parts.join('\n\n'));
}
