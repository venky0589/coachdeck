// Local Postgres API server — mimics the PostgREST interface used by sync.ts.
// Plain JS (no TypeScript). Run: node server/index.js  (or `npm run dev:all` from the repo root)
import { config as loadEnv } from 'dotenv';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import cron from 'node-cron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

// Resolve .env relative to this file, not the caller's cwd — `dotenv/config`'s
// default (cwd-relative) silently found nothing when launched as `npm run
// server`/`npm run dev:all` from the repo root (cwd = repo root, no .env
// there — server/.env only loaded by accident when someone happened to `cd
// server` first). That would've broken the same way under systemd.
loadEnv({ path: path.join(__dirname, '.env') });

// ─── config ─────────────────────────────────────────────────────────────────
// Copy .env.example to .env and fill it in — see that file for what each
// variable does. Nothing here has a hardcoded credential fallback: a missing
// DB_PASSWORD refuses to start rather than silently defaulting to something
// guessable.

if (!process.env.DB_PASSWORD) {
    console.error('\n✗ DB_PASSWORD is not set — refusing to start with no DB credential.');
    console.error('  Copy server/.env.example to server/.env and fill in DB_PASSWORD.\n');
    process.exit(1);
}

const pool = new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'badminton_coach',
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD,
});

// Bind to localhost unless the coach explicitly opts into LAN exposure (needed
// so a phone can reach the server for sync). This is a safer default than
// listening on every interface out of the box.
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3001);
const exposedToLan = HOST !== '127.0.0.1' && HOST !== 'localhost';

// ─── API key ────────────────────────────────────────────────────────────────
// Every /rest/v1/* and /api/* request must carry this as a Bearer token — it's
// exactly the header @supabase/supabase-js already sends as the "anon key",
// so the client needs no code change, only a real value in .env.local's
// VITE_SUPABASE_ANON_KEY instead of the placeholder "local-dev-key".
//
// Honest caveat: this key ships inside the built client bundle, so it stops
// casual/opportunistic access from other devices on the network — it is not
// a cryptographic secret against someone who inspects the page source. If
// this ever needs to resist a motivated attacker on the same network (not
// just deter one), the real fix is deploying to actual Supabase with Row
// Level Security and per-user auth, not a shared static key.
const KEY_FILE = path.join(__dirname, '.generated-api-key');

function resolveApiKey() {
    if (process.env.API_KEY) return process.env.API_KEY;
    if (fs.existsSync(KEY_FILE)) {
        const existing = fs.readFileSync(KEY_FILE, 'utf8').trim();
        if (existing) return existing;
    }
    const generated = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(KEY_FILE, generated, { mode: 0o600 });
    return generated;
}

const API_KEY = resolveApiKey();

if (!process.env.API_KEY) {
    console.log('\n⚠ No API_KEY set in server/.env — generated one for local dev and saved it to');
    console.log(`  server/.generated-api-key (gitignored) so it survives restarts:\n`);
    console.log(`   ${API_KEY}\n`);
    console.log('  Put this exact value in .env.local as VITE_SUPABASE_ANON_KEY, or set API_KEY');
    console.log('  in server/.env yourself to pin it permanently.\n');
}

function timingSafeEqualStr(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function requireApiKey(req, res, next) {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.get('apikey');
    if (!token || !timingSafeEqualStr(token, API_KEY)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── CORS ───────────────────────────────────────────────────────────────────
// Explicit allow-list rather than wildcard. Private-network origins on the
// Vite dev port are allowed automatically (a coach's phone gets a different
// DHCP-assigned IP over time), everything else must be listed in
// ALLOWED_ORIGINS explicitly.
const PRIVATE_LAN_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(:\d+)?$/;
const extraOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

function originAllowed(origin) {
    if (!origin) return true; // non-browser clients (curl, the pg cron job) send no Origin header
    if (extraOrigins.includes(origin)) return true;
    return PRIVATE_LAN_ORIGIN.test(origin);
}

const ALLOWED_TABLES = new Set([
    'players', 'coaches', 'batches', 'player_batches', 'attendance_logs',
    'session_cancellations', 'monthly_dues', 'payment_transactions',
    'credit_ledger', 'session_packages', 'session_package_usage',
    'holds', 'app_settings', 'stringing_jobs',
]);

const ALLOWED_RPC = new Set(['generate_monthly_invoices', 'mark_overdue_invoices']);

const app = express();
app.use(cors({
    origin(origin, cb) {
        if (originAllowed(origin)) return cb(null, true);
        cb(new Error('Origin not allowed'));
    },
}));
app.use(express.json({ limit: '256kb' }));

// ─── static app ─────────────────────────────────────────────────────────────
// Serves the built PWA (npm run build → dist/) from this same process, so
// production is one process/one origin — no CORS needed between app and API,
// and (paired with a single `tailscale serve` HTTPS front, see README) no
// mixed-content issue either. Only kicks in when dist/ exists, so `npm run
// dev` (Vite's own dev server) is unaffected.
const DIST_DIR = path.join(__dirname, '..', 'dist');
const SERVE_STATIC = fs.existsSync(DIST_DIR);
if (SERVE_STATIC) {
    app.use(express.static(DIST_DIR));
}

app.get('/health', (_req, res) => res.json({ ok: true, db: pool.options.database }));

// Everything else needs the API key.
app.use(['/rest', '/api'], requireApiKey);

// ─── billing ─────────────────────────────────────────────────────────────────

async function runBilling() {
    const month = new Date();
    // First day of current month
    const firstDay = new Date(month.getFullYear(), month.getMonth(), 1)
        .toISOString().slice(0, 10);
    try {
        await pool.query('SELECT generate_monthly_invoices($1::date)', [firstDay]);
        console.log(`[billing] ✓ Invoices generated for ${firstDay.slice(0, 7)}`);
    } catch (err) {
        console.error('[billing] ✗ Failed:', err.message);
    }
}

// Run at 06:00 on the 1st of every month
cron.schedule('0 6 1 * *', () => {
    console.log('[billing] Monthly cron triggered');
    void runBilling();
});

// Manual trigger endpoint (call from Settings → Billing section)
app.post('/api/billing/run-now', async (_req, res) => {
    await runBilling();
    res.json({ ok: true, message: 'Billing run complete' });
});

// Run on server start to catch up if server was down on the 1st
if (new Date().getDate() === 1) {
    console.log('[billing] Server started on 1st — running catch-up billing');
    void runBilling();
}

// ─── RPC (mirrors PostgREST's POST /rest/v1/rpc/:fn convention) ───────────────
// Whitelisted to the two billing functions the client actually calls
// (src/lib/billing.ts) — this is not a general SQL-execution endpoint.
app.post('/rest/v1/rpc/:fn', async (req, res) => {
    const fn = req.params.fn;
    if (!ALLOWED_RPC.has(fn)) return res.status(404).json({ error: 'Unknown function' });

    try {
        let result;
        if (fn === 'generate_monthly_invoices') {
            const month = req.body?.p_month;
            result = month
                ? await pool.query('SELECT generate_monthly_invoices($1::date) AS result', [month])
                : await pool.query('SELECT generate_monthly_invoices() AS result');
        } else {
            const asOf = req.body?.p_today;
            result = asOf
                ? await pool.query('SELECT mark_overdue_invoices($1::date) AS result', [asOf])
                : await pool.query('SELECT mark_overdue_invoices() AS result');
        }
        res.json(result.rows[0]?.result ?? null);
    } catch (err) {
        console.error(`RPC ${fn}`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /rest/v1/:table?updated_at=gt.2024-01-01T00:00:00Z
app.get('/rest/v1/:table', async (req, res) => {
    const table = req.params.table;
    if (!ALLOWED_TABLES.has(table)) return res.status(400).json({ error: 'Unknown table' });

    try {
        const raw = req.query['updated_at'] || req.query['created_at'];
        const since = extractGt(raw);
        const col = req.query['created_at'] ? 'created_at' : 'updated_at';

        let query = `SELECT * FROM ${table}`;
        const params = [];
        if (since) {
            query += ` WHERE ${col} > $1`;
            params.push(since);
        }

        const { rows } = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        console.error(`GET /${table}`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /rest/v1/:table  — upsert (Prefer: resolution=merge-duplicates)
app.post('/rest/v1/:table', async (req, res) => {
    const table = req.params.table;
    if (!ALLOWED_TABLES.has(table)) return res.status(400).json({ error: 'Unknown table' });

    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    if (!payload || !payload.id) return res.status(400).json({ error: 'Missing id' });

    try {
        const keys = Object.keys(payload);
        const cols = keys.join(', ');
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const updates = keys.filter((k) => k !== 'id')
            .map((k) => `${k} = EXCLUDED.${k}`).join(', ');
        const values = keys.map((k) => payload[k]);

        const query = `INSERT INTO ${table} (${cols}) VALUES (${placeholders})
                   ON CONFLICT (id) DO UPDATE SET ${updates}
                   RETURNING *`;

        const { rows } = await pool.query(query, values);
        res.status(201).json(rows);
    } catch (err) {
        console.error(`POST /${table}`, err.message);
        // A payload carrying a column the table doesn't have (e.g. a stray local-only
        // field) fails loudly here instead of jamming the client's outbox — the sync
        // layer leaves it queued and keeps going, so surfacing this clearly matters.
        res.status(400).json({ error: err.message });
    }
});

// DELETE /rest/v1/:table?id=eq.<uuid>
app.delete('/rest/v1/:table', async (req, res) => {
    const table = req.params.table;
    if (!ALLOWED_TABLES.has(table)) return res.status(400).json({ error: 'Unknown table' });

    const id = extractEq(req.query['id']);
    if (!id) return res.status(400).json({ error: 'Missing id=eq.<uuid>' });

    try {
        await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        res.status(204).send();
    } catch (err) {
        console.error(`DELETE /${table}`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// SPA fallback — must stay last, after every /rest and /api route above, so
// it never shadows them; only handles whatever's left (client-side routes).
if (SERVE_STATIC) {
    app.get('*', (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
}

function extractGt(param) {
    if (!param) return null;
    const m = String(param).match(/^gt\.(.+)$/);
    return m ? m[1] : null;
}

function extractEq(param) {
    if (!param) return null;
    const m = String(param).match(/^eq\.(.+)$/);
    return m ? m[1] : null;
}

app.listen(PORT, HOST, () => {
    console.log(`\n🏸 Coach API server → http://${HOST}:${PORT}`);
    console.log(`   DB: ${pool.options.database} @ ${pool.options.host}:${pool.options.port}`);
    console.log(SERVE_STATIC ? '   Serving built app from dist/' : '   No dist/ found — run `npm run build` to serve the app from here too.');
    if (exposedToLan) {
        console.log(`   ⚠ Listening on ${HOST} — reachable from other devices on this network.`);
        console.log(`     Requests need the API key above; keep it out of anywhere public.`);
    } else {
        console.log('   Bound to localhost only. Set HOST=0.0.0.0 in server/.env to allow phone access on your Wi-Fi.');
    }
    console.log('');
});
