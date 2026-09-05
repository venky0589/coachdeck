# Project Status — Badminton Coach App

Last updated: September 4, 2026

This is a plain-language status summary for you to check at a glance. For
the detailed technical version (what changed, why, and how it was
verified), see `CLAUDE.md`.

## ⚠️ Action needed from you

1. **Run the database migration again.** This round of work changed the
   database schema again and can't be applied from here (your Postgres
   database is on your own machine/network, not reachable from this
   session):
   ```
   psql -h <your-db-host> -U <your-db-user> -d <your-db-name> -f sql/03-migrations.sql
   ```
   This is safe to run even if you've run it before — it only makes
   changes that aren't already there. It does:
   - The app_settings PIN-loop fix from last time (if you haven't run it
     yet).
   - Creates a real `coaches` table and converts any existing "Coach"
     text on your batches into real coach entries automatically.
   - Adds stringing jobs to the set of tables that actually sync to your
     server — they were quietly not syncing before (local-only bug, not
     data loss, just never reached Postgres).

2. **Set your PIN, if you haven't already landed on a working one.** Open
   the app — it'll either ask you to unlock with your existing PIN, or (if
   none is on record) walk you through creating one. Either way, you pick
   the digits; nothing is pre-set for you.

3. **Add your coaches under Settings → Coaches**, if you want more than
   the two demo names. Batches now pick a coach from that list instead of
   typing a name each time.

## What's working now

**Security**
- The app requires a PIN to open — mandatory, not optional, since this is
  a single-coach app.
- The API server requires a real database password and an API key on
  every request.
- Known limitation: the API key is a deterrent, not unbreakable — it ships
  inside the app, so it won't stop someone determined who inspects the
  code. Real protection would mean switching to real Supabase with
  row-level security, which is a bigger project if you ever want it.

**Attendance**
- Create and edit batches (schedule, court, capacity, and a coach picked
  from your Coaches list) under Attendance → Batches.
- Assign or remove players from a batch's roster from that same screen.
- Manage your coach roster under Settings → Coaches: add a coach by name,
  deactivate one you no longer use (kept, not deleted, so past batch
  assignments still show correctly).
- Take roll call, switch between batches with the picker when you have
  more than one, and see attendance reports.
- Session packages (pay-per-block-of-sessions players) correctly draw down
  when marked present, and warn you when they're running low.

**Billing & payments**
- Monthly dues, partial payments, and full payments all work correctly.
- Overpayments are tracked as wallet credit instead of disappearing, and
  can be applied to a future balance.
- Holds (pausing a player temporarily) automatically resume them once the
  hold period ends.

**Other**
- Stringing job board (pending / in progress / done).
- CSV exports for players, dues, transactions, and the credit ledger.
- Works offline — data lives on your device first and syncs when your
  server is reachable.
- The layout now adapts properly between phone and a laptop/desktop
  screen — previously it looked identical (and cramped) on both.

## What's deliberately not built

- **Multiple coach logins/accounts.** You can now keep a real list of
  coaches and assign one to each batch, but there's still only one PIN
  for the whole app — no separate login, permissions, or password per
  coach. If you need real multi-coach accounts later, that's a bigger
  feature to plan out (it changes how login and data access work), not a
  quick addition on top of the coaches list.
- Assigning a player to a batch from the player's own screen — right now
  that only works from the Batches screen's roster editor.

## Known follow-up, not urgent

Your `.env.local` points the app at a plain `http://` address for the
backend, while the app itself runs over `https://`. On `localhost` this
generally isn't an issue, but if you ever open the app from another
device on your network, browsers may block that connection (a "mixed
content" restriction). Not fixed yet, at your request — flag it again
when you're ready to tackle it.
