# Project memory — badminton-coach-helper

Read this first in any new session on this project. It captures where things
stand after the September 2026 review + hardening pass, so we don't have to
re-derive it from scratch.

## What this project is

A coach-only, offline-first PWA for running a badminton academy: attendance,
billing/dues, payments, session packages, holds, and stringing jobs. Built
with React + Vite + TypeScript, IndexedDB as the local source of truth, and a
lightweight custom server (`server/index.js`, Express) that mimics enough of
the PostgREST/Supabase REST surface for the client's `@supabase/supabase-js`
calls to work against a plain Postgres database — it is *not* real Supabase.
`badminton-coach-v1-spec.md` is the original spec; `README.md` has setup
instructions.

## Where things stand

Seven passes have happened:

1. **Review pass** — read the full spec and codebase, found 13 issues
   ranked by severity (security, data loss, financial-integrity, then minor
   items). Full writeup: `REVIEW_FINDINGS.md`.
2. **Hardening pass** — fixed all 13, plus a few more bugs found only by
   actually running the Playwright suite rather than trusting
   typecheck/build alone.
3. **Follow-up pass** (this one) — the user looked at the shipped app and
   pushed back that auth and batch handling "didn't seem addressed." They
   were looking at the Today screen, which by design shows neither the PIN
   lock nor the batch picker — both were real, just not visible from that
   one screenshot. Rather than assume, I asked what they actually wanted;
   the answers (mandatory PIN, single user, confirmed no PIN had been set
   yet) turned "opt-in PIN under Settings" into "PIN is required, full
   stop." Also fixed in this pass: the app had zero responsive design
   (everything capped at 480px and centered, phone or 27" monitor alike —
   confirmed via screenshots at 390px and 1440px), and the demo seed data
   was too thin to exercise most of the app's features. See below for all
   three.
4. **Bug-hunt pass** (this one) — the user came back with "always showing
   pin page, not going forward on correct pin also" right after setting up
   their real PIN for the first time. Root cause was a genuine data-model
   bug, not a UI bug — see "The app_settings singleton bug" below. It only
   showed up on the user's real machine, with a real backend configured and
   reachable, because that's exactly the condition my sandbox testing never
   exercised (no reachable Postgres from the cloud sandbox during earlier
   passes) — worth remembering next time something "works in testing" but
   not for the user: ask what's different about their environment before
   assuming the report is wrong.
5. **Missing-feature pass** (this one) — the user asked how they were
   supposed to take attendance for a batch they had no way to create, and
   asked about registering/assigning coaches. `src/screens/Batches.tsx`
   turned out to already be a fully built, working screen — create/edit a
   batch, add or remove players from its roster — that was simply never
   wired into any tab or button anywhere in the app. Dead code with no way
   in, not a missing feature. Fixed by adding it as a third segment inside
   the Attendance tab, next to Roll call/Reports (see below). On coaches:
   this app has no multi-coach concept anywhere in the schema or spec —
   "coach" just means whoever holds the PIN, not a database entity — so I
   asked rather than guessed at building a multi-user system, which would
   cut against the mandatory single-PIN design from pass 3.
6. **Multi-coach pass (this one)** — the user asked to add multiple coaches,
   but with login staying admin-only for now ("later we will give other
   coaches too"). Rather than guess how far to take that, I asked two
   scoping questions: how much to build now, and whether a coach's login
   should eventually be restricted to their own batches. Answers: build a
   real `coaches` table (not per-coach login) now, and no visibility
   restriction is planned even later — "coach" stays purely an assignment
   label, just backed by a real roster instead of free text. See "Coaches
   — a real roster entity, still not a login" below. Also folded in a
   pre-existing bug found while touching this code: `stringing_jobs` was
   never added to the server's `ALLOWED_TABLES` allow-list despite being
   documented (pass 4) as "its own real, synced table" — it was silently
   never syncing to Postgres. Fixed alongside this pass's `coaches`
   addition since both are one-line entries in the same `Set`.
7. **Deployment-prep pass (this one)** — the user asked to move toward
   actually deploying this. Checked `README.md`, the spec, `.gitignore`,
   `server/index.js`, and `vite.config.ts` first rather than assuming; found
   the repo had no git history at all, `README.md` still described the old
   real-Supabase setup (contradicting CLAUDE.md's custom-server design),
   and two real bugs surfaced only by actually starting the server (see
   below). Asked the user where this should run before writing anything —
   answer: self-hosted on their own machine, fronted by Tailscale (already
   installed) rather than a public VPS, keeping the API server off the
   open internet given its "shared key, not real auth" security model (see
   "Security / auth" below). See "Deployment setup" below for what changed
   and what's still a manual (sudo/crontab) step for the user.

Everything below was verified working (typecheck, build, Playwright, and
for the responsive change, actual screenshots at two widths — and for the
singleton bug, a reproduction against a real Postgres database plus a
browser test that injects the exact broken IndexedDB state and confirms
the self-heal), not just written.

### The app_settings singleton bug (critical — read this one)
`app_settings` is a "single row" table by design (every screen assumes
`getAll('app_settings')[0]` is *the* settings), but nothing ever enforced
that. `sql/01-schema.sql`'s seed insert let Postgres assign a random id
(`gen_random_uuid()` default), and the client (`src/lib/settings.ts`)
independently minted its *own* random id the first time `getSettings()`
ran locally before sync had connected. Once sync ran, the client ended up
with two `app_settings` rows — the server's original blank one and the
client's with the coach PIN on it — and `getAll('app_settings')[0]` on the
client follows IndexedDB's primary-key sort order, not recency, so it
could return either one unpredictably from one reload to the next.
Symptom: PIN setup looked like it silently didn't take, and a correct PIN
typed into PinLock could get rejected — because the app was sometimes
validating against the *other* row's (null) hash/salt.

Fixed by giving the row a fixed, well-known id instead of a random one,
shared by both sides:
- `src/lib/settings.ts` exports `SETTINGS_ID` (a constant UUID) and both
  `getSettings()`/`patchSettings()` now target it explicitly rather than
  "whatever `getAll()[0]` returns."
- `getSettings()` also **self-heals** an already-broken install: if the
  canonical row isn't there yet but other rows are, it picks the best one
  (preferring a row with a PIN set over a blank default), saves it under
  `SETTINGS_ID`, and deletes the stray rows — automatically, on the very
  next load, no manual IndexedDB clearing needed. Verified with a Playwright
  script that injects two rows directly into IndexedDB (bypassing the app)
  to reproduce the exact broken state, then confirms a reload lands on
  PinLock (not PinSetup) with exactly one row left afterward.
- `sql/01-schema.sql`'s seed insert now specifies that same fixed id.
- `sql/03-migrations.sql` got a new idempotent block that does the same
  consolidation server-side for a database that already ran the old
  version of `01-schema.sql` — **the user needs to re-run
  `sql/03-migrations.sql` against their real Postgres database** for the
  server-side row to converge too (the client self-heals on its own, but
  the server won't until this runs). Verified against a real Postgres
  instance: seeded two rows the old broken way (one blank, one with a
  fake PIN), ran the migration, confirmed exactly one row remained under
  the fixed id with the PIN-bearing data kept, and confirmed running it
  twice is a no-op the second time.
- **Lesson for any future singleton-row table**: never let the row's id be
  generated independently by two sides that are going to sync with each
  other. Either give it a fixed, hardcoded id from the start (what we did
  here), or use a natural key / uniqueness constraint the two sides can't
  diverge on.

### Deployment setup (self-hosted + Tailscale)
Full runbook: `DEPLOY.md`. Summary of what changed and why, plus two real
bugs that only showed up by actually starting the server rather than just
reading it — the same lesson as the app_settings bug above, worth
repeating: **run it, don't just read it.**

- **`server/index.js` now serves the built app itself.** Added
  `express.static(dist/)` + a SPA fallback (`app.get('*', ...)`, must stay
  registered *last*, after every `/rest`/`/api` route, or it'd shadow
  them), gated behind `fs.existsSync(dist/)` so `npm run dev` (Vite's own
  dev server) is untouched. Production is now one process/one origin —
  no CORS between app and API, and paired with a single `tailscale serve`
  HTTPS front, no mixed-content issue either (the thing flagged and
  deferred back in pass 3).
- **Found by smoke-testing, not by reading the code**: `import
  'dotenv/config'` resolves `.env` relative to the *caller's* working
  directory, not the script's own location. `npm run server` / `npm run
  dev:all` run `node server/index.js` from the repo root — where there's
  no `.env` — so `server/.env` was never actually loading that way; it
  only appeared to work in earlier passes when someone happened to `cd
  server` first. Would have broken the same way under systemd
  (`WorkingDirectory` there is the repo root). Fixed by switching to
  `dotenv`'s `config({ path: ... })` resolved against `__dirname`
  (`path.join(__dirname, '.env')`), which works regardless of cwd.
  Verified by starting the server from the repo root and confirming
  `/health`, an unauthed request (401), and a correctly-authed request
  (200, against a real reachable Postgres) all behaved correctly — this
  was *not* caught by typecheck/build, only by actually running it.
- **`server/.env` had no `API_KEY` set**, while `.env.local` hardcoded
  `VITE_SUPABASE_ANON_KEY=local-dev-key` — these would not have matched
  the key the server auto-generates on next start (see the "API key"
  section under Security/auth), meaning sync would have started failing
  with 401s the next time the server restarted fresh. Generated a real
  key, set it explicitly in both places so it's pinned rather than
  regenerated.
- **`VITE_SUPABASE_URL`** now points at this machine's Tailscale HTTPS
  name (`https://venky-hp-zbook-firefly-14-inch-g8-mobile-workstation-pc.tail21ff79.ts.net`)
  instead of a bare LAN IP over `http://`. `tailscale serve` terminates
  real TLS (via Tailscale's own cert, `tailscale cert` needs root or
  `tailscale set --operator=$USER` once — that step is on the user, not
  run here) and reverse-proxies to the plain-HTTP Node server — this is
  the actual fix for the deferred mixed-content issue, not a workaround.
- **`vite.config.ts`'s `basicSsl()` plugin is untouched and stays
  dev-only** — it only affects `npm run dev`'s local HTTPS; the
  production build is plain static files with no protocol of their own,
  served over whatever `tailscale serve` terminates.
- **This repo had no git history at all until this pass.** Initialized
  one, made a first commit. Cleaned up before committing: deleted
  `billing-engine.sql` (a root-level duplicate of `sql/02-billing.sql`
  that already said "safe to delete" in its own header), and gitignored
  `playwright-report/`, `Claude outputs/` (scratch screenshots/notes),
  and `badminton-coach.zip` (a stale early-scaffold export superseded by
  the real `src/`/`sql/` — left on disk, just not tracked). No remote
  configured — pushing anywhere is the user's call, not done here.
- **`deploy/coach-api.service`** (systemd unit) and **`deploy/backup-db.sh`**
  (nightly `pg_dump`, prunes anything older than 30 days) are written and
  ready but **not installed/enabled** — both need `sudo` or a crontab
  edit, which the user runs themselves (see DEPLOY.md for exact
  commands). The systemd unit matters specifically because monthly
  billing (`generate_monthly_invoices`) runs off an in-process
  `node-cron` schedule inside this same process — if it isn't running at
  06:00 on the 1st, that month waits for the app-open catch-up instead.
- **`server/.env`'s `DB_PASSWORD=123456`** is placeholder-strength.
  Flagged, deliberately **not** changed automatically — the user chose
  "flag only, fix later" since changing it needs a coordinated `ALTER
  USER` on the live Postgres role at the same time the server's `.env` is
  updated, and doing that from here risked locking out anything already
  connected with the old password with no way to verify the fix landed.
  Revisit when the user is at the machine.
- **`README.md` was rewritten** — it still described creating a real
  Supabase project and enabling RLS, which hasn't been true since the
  custom Express server replaced that design (predates this project
  memory file). Now matches the actual setup + points at `DEPLOY.md`.
  Also added the missing root **`.env.example`** it referenced (never
  existed before, in *any* pass — the setup instructions were
  unfollowable as written).

### Batches was unreachable
`src/screens/Batches.tsx` (create/edit a batch, add or remove players from
its roster via `player_batches`) was complete and working — it just wasn't
routed from anywhere. No tab, no button, nothing linked to it. A real coach
had no way to create a batch at all outside the demo seed, which meant no
way to take attendance for anything of their own — RollCall's own empty
state even said "Create one under Batches" pointing at a screen with no
door into it. Fixed in `App.tsx`: it's now a third segment inside the
Attendance tab (`rollView: 'roll' | 'report' | 'batches'`), next to Roll
call/Reports, since batches are what Attendance operates on. If you add
another screen like this — genuinely finished but easy to forget to wire
up — grep for the component's import across `src/` before assuming it's
reachable; `Batches` had zero imports outside its own file until this fix.
There is still no way to assign a batch or add a session package to a
player from the *player's* side (PlayerProfile/PlayerForm) — batch
assignment only exists inside Batches.tsx's roster editor. Worth wiring up
if it comes up again, but wasn't reported as broken so left alone here.

### Coaches — a real roster entity, still not a login
Pass 5 answered "registering coaches, assigning coaches" with a plain text
label (`batches.coach_name`). Pass 6 replaced that with a real `coaches`
table (`id`, `name`, `active`, `created_at`/`updated_at` — a normal synced
table like any other) once the user confirmed they want multiple coaches
addable now, with per-coach *login* deferred to later. What changed:
- `sql/01-schema.sql` — new `coaches` table; `batches.coach_name` (text)
  replaced by `batches.coach_id` (nullable FK, `on delete set null`).
- `sql/03-migrations.sql` — idempotent block: creates `coaches` if
  missing, adds `batches.coach_id`, backfills it by creating one `coaches`
  row per distinct existing `coach_name` value and pointing matching
  batches at it, then drops `coach_name`. **The user needs to re-run
  `sql/03-migrations.sql` against their real Postgres database** for
  their server-side data to pick up the new table/column and for any
  existing `coach_name` text to convert into real coach rows.
- `src/types/db.ts` — new `Coach` interface, added to `Tables`/
  `TABLE_NAMES`; `Batch.coach_name` → `Batch.coach_id: string | null`.
- `src/lib/idb.ts` — `DB_VERSION` bumped 2 → 3 for the new `coaches`
  object store (`TABLE_NAMES`-driven, so no other idb.ts change needed).
- `server/index.js` — `coaches` added to `ALLOWED_TABLES` (and
  `stringing_jobs`, the pre-existing gap noted above).
- `src/screens/Settings.tsx` — new "Coaches" section: add a coach by name,
  toggle each one active/inactive. **No delete** — deactivating instead of
  deleting is deliberate, so a batch that already points at a coach never
  loses that history; see the roster's "(inactive)" tag.
- `src/screens/Batches.tsx` — the free-text "Coach" field is now a
  `<select>` populated from active coaches, plus the batch's currently
  assigned coach even if it's since been deactivated (so opening an
  existing batch never silently blanks its coach). Empty state points the
  user at Settings when no coaches exist yet.
- `src/screens/RollCall.tsx` — header resolves `batch.coach_id` through
  the coaches list the same way.
- `src/lib/seed.ts` — demo data seeds two `coaches` rows (Coach Ravi,
  Coach Priya) and links batches to them by id instead of by text.

**Still deliberately not built**: per-coach login/PIN, roles, or
permissions — "coach" on a batch is an assignment, not an account. The
single mandatory PIN from pass 3 still gates the whole app for whoever
holds it. If/when the user is ready for actual per-coach logins, that is
new architecture (auth model, schema, and the "single-user" framing the
offline-sync design leans on — see "Because there's exactly one user..."
in the spec), not an extension of the `coaches` table above — the table
is a fine base to add a `pin_hash`/`pin_salt` column to later, but the
login/session/permission logic itself doesn't exist yet and shouldn't be
assumed from this table's presence.

### Security / auth
- Server now requires a real `DB_PASSWORD` (refuses to start without one),
  gates every request behind a bearer API key compared with
  `crypto.timingSafeEqual`, and uses a CORS allow-list instead of `*`. See
  `server/.env.example` for the env vars.
- **Known, deliberate limitation**: the API key is a deterrent, not a real
  secret — it ships in the client bundle, so anyone who can inspect the app
  can read it. Real protection needs actual Supabase + Postgres row-level
  security. Don't "fix" this by trying to hide the key harder; the fix is
  swapping the backend, and that's a bigger decision to make deliberately,
  not something to do as a drive-by.
- Coach PIN moved from raw unsalted SHA-256 to PBKDF2-HMAC-SHA256 (210k
  iterations, salted) with progressive lockout. See `src/lib/pin.ts`.
- **PIN is mandatory, not opt-in.** This is a single-coach app — "login"
  means one PIN, created once, required every time the app opens, no
  separate account system. `src/screens/PinSetup.tsx` is a first-run screen
  App.tsx renders instead of the main app whenever `settings.coach_pin_hash`
  is empty, with no "skip for now" escape hatch. `PinLock.tsx` is unchanged
  and still handles unlocking an *existing* PIN on every later reload.
  Settings no longer has a "Remove PIN" button — only "Change PIN" — since
  turning auth off entirely isn't a supported state anymore. If a future
  request wants multiple coaches/accounts, that's a different, bigger
  feature than this PIN — don't try to bolt usernames onto it.

### Data integrity fixes
- `Settings.tsx` used to overwrite the whole `app_settings` row on every
  save, silently dropping fields another screen had just written. Fixed via
  a read-merge-write pattern in `src/lib/settings.ts`
  (`getSettings`/`patchSettings`) — **use this pattern for any new
  `app_settings` field**, never write the row directly.
- Stringing jobs used to live as a JSON blob inside that same row (part of
  the same bug class). They're now their own real, synced table
  (`stringing_jobs` — `src/screens/StringingBoard.tsx`, `src/lib/idb.ts`
  `DB_VERSION` bumped to 2 for it, `sql/03-migrations.sql` for existing
  Postgres databases).
- Credit ledger (overpayments/advances) existed in the schema but nothing
  wrote to it — wired into `src/lib/payments.ts` (`collectPayment`,
  `applyCreditToDues`, `walletBalance`).
- Session-package consumption was dead code — wired into attendance marking
  in `src/screens/RollCall.tsx` via `src/lib/packages.ts`.
- Multi-batch roll call was unreachable (silently always used the first
  batch) — added a batch picker.
- Holds never resolved back to ACTIVE automatically — `src/lib/holds.ts`
  (`sweepHolds`).
- Client's billing RPC call had no matching server route — added
  `/rest/v1/rpc/:fn` (whitelisted to `generate_monthly_invoices` and
  `mark_overdue_invoices` only) in `server/index.js`.

### A real bug the test suite caught (not in the original review)
`RollCall.tsx`'s `cycle()` function compared the *raw* attendance status
(`undefined` for an unmarked player) against the cycle order, so tapping a
never-marked player — which the UI *shows* as PRESENT by default — wrote
PRESENT again instead of advancing to ABSENT. Fixed by cycling from the
*displayed* default (`current ?? 'PRESENT'`) while still keying the
package-session release logic off the *raw* status, since only an actual
existing PRESENT log means a session was really consumed. See the comment
in `cycle()` for the reasoning — don't collapse those two back into one
variable, that's what caused the bug.

### Known follow-up, not yet addressed
`vite.config.ts` always enables `@vitejs/plugin-basic-ssl`, so the dev
server (and the PWA in general) is HTTPS-only. `.env.local`'s
`VITE_SUPABASE_URL` currently points at a plain `http://` address. On
localhost this generally doesn't trip mixed-content blocking, but it likely
will the moment the app is accessed cross-origin (e.g. from another device
on the LAN) with the backend still on HTTP. Not fixed yet — flagged and
deferred at the user's request ("for now we are working from local host,
later we will see"). When it comes up: either put the backend behind HTTPS
too, or document it as a permanent known limitation.

### Responsive layout
The app used to have exactly one width — `.app`, the tab bar, modals, and
toasts were all hardcoded `max-width: 480px` and centered, so a laptop got
the same narrow phone-width card floating in empty background. Fixed in
`src/styles.css`:
- A `--content-max` CSS variable replaces every hardcoded `480px`, so the
  breakpoints below and the base rules stay in sync. If you add a new
  full-width container, use `var(--content-max)`, not a literal `480px`.
- `@media (min-width: 700px)`: wider content column (640px), same
  mobile-style layout otherwise (bottom tab bar, single column).
- `@media (min-width: 960px)`: the bottom tab bar becomes a left sidebar
  (pure CSS — `order: -1` + `flex-direction: row` on `.app`, no JSX
  changes), content widens to 820px, modals become centered dialogs instead
  of edge-to-edge bottom sheets, and `.rows` (player list, roll call) goes
  2-column.
- This is *not* a full desktop redesign — it's a CSS-only pass so the app
  stops looking broken at desktop widths. Mobile (<700px) is pixel-identical
  to before. If someone wants a real desktop-specific UI later (e.g.
  multi-pane views), treat that as new work, not an extension of this.

### Sample data
`src/lib/seed.ts` (wired to the "Load demo data" button on an empty Today
screen) now seeds enough to exercise most of the app in one go, not just
"everyone owes this month": two batches (so the batch picker has something
to pick between), players spanning UNPAID / PARTIAL / PAID due states, one
player who overpaid (wallet credit via `credit_ledger`, visible in
CollectPayment's "apply to balance" row), one PACKAGE-billed player with
only 3 sessions left (marking them present trips the low-balance toast),
one PAUSED player under an active hold, and stringing jobs in all three
statuses. If you add a new feature that needs its own demo state, extend
this file rather than leaving it undemoable — that's exactly the gap that
prompted this pass.

### Testing
`tests/app.spec.ts` — 6 Playwright tests, all passing. Every test now goes
through `ensurePinSetup()` in `beforeEach` first (mandatory PIN means a
fresh browser context always lands on the setup screen before anything
else). `playwright.config.ts`
is the clean version meant for a normal dev machine (uses whatever Chromium
Playwright has installed). **Do not add a sandbox-specific
`launchOptions.executablePath` override to this file** — that was a
cloud-sandbox-only workaround needed because that environment couldn't run
`playwright install`; it does not belong in the shipped config and was
deliberately reverted before delivery.

Two test-writing traps worth remembering for this codebase specifically:
- `page.click('text=...')` (legacy non-strict API) can silently match the
  wrong element when a label appears more than once on a screen (e.g.
  "Players" shows up both in the nav and in a stat label). Use
  `page.locator(sel, { hasText })` scoped to a specific container instead.
- `Locator.isVisible()` / `.count()` are non-retrying, instantaneous checks.
  Called right after `page.goto()`, they can run before React has even
  mounted (this app renders `null` until an async `getSettings()` call
  resolves in `App.tsx`) and wrongly conclude an element isn't there. Use
  `waitFor({ state: 'visible', timeout })` (or `expect(...).toBeVisible()`)
  for anything checked early in a test.

## Conventions to keep following

- Any new `app_settings` field goes through `getSettings`/`patchSettings`
  in `src/lib/settings.ts`, never a direct save.
- Anything financial (payments, credit ledger, invoices) should stay
  append-only where the schema already is — don't start mutating historical
  rows to "fix" a balance; add a correcting entry instead.
- IndexedDB `DB_VERSION` in `src/lib/idb.ts` must be bumped any time a new
  object store is added — the `upgrade()` callback only fires on a version
  increase, so existing installs won't get a new store otherwise.
- Toasts (`src/lib/toast.ts` + `src/components/Toaster.tsx`) replace
  `alert()` for all user feedback now — don't reintroduce `alert()`.
