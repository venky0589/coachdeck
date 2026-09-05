import { test, expect, type Page } from '@playwright/test';

// Nav clicks are scoped to nav.tabbar specifically — a bare `text=Players`
// (or `text=Attendance`) is ambiguous on the Today screen, which also shows
// "active players" in a stat label and, once there's an overdue balance,
// "N players" in the collection bar; `page.click('text=Players')` matches
// whichever of those comes first in the DOM and silently does nothing,
// rather than throwing, since it isn't going through the strict Locator API.
function tab(page: Page, label: string) {
  return page.locator('nav.tabbar button', { hasText: label });
}

const DEMO_PIN = '1234';

async function ensurePinSetup(page: Page) {
  // PIN is mandatory now (see App.tsx / PinSetup.tsx) — a brand-new profile
  // always lands on the setup screen before anything else, on every test,
  // since each test gets its own fresh browser context. Every test needs
  // this out of the way first.
  //
  // waitFor(), not isVisible(): right after page.goto(), App.tsx still
  // renders null (it's awaiting its own async getSettings() call), so an
  // instantaneous check here can run before React has mounted anything at
  // all and wrongly conclude the setup screen isn't there.
  const continueBtn = page.locator('button:has-text("Continue")');
  try {
    await continueBtn.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    return; // already past setup — shouldn't normally happen on a fresh context
  }
  for (const digit of DEMO_PIN) {
    await page.click(`button:text-is("${digit}")`);
  }
  await continueBtn.click();
  for (const digit of DEMO_PIN) {
    await page.click(`button:text-is("${digit}")`);
  }
  await page.click('button:has-text("Confirm PIN")');
  await expect(page.locator('h2', { hasText: 'Today' })).toBeVisible();
}

async function ensureDemoData(page: Page) {
  // Scoped to the empty-state panel specifically, and waits for it to
  // disappear rather than for its label — the button's own text flips to
  // "Loading…" while seedDemoDataIfEmpty() is still writing the batches,
  // players, batch links, invoices and everything else in src/lib/seed.ts,
  // and the panel doesn't unmount until that finishes (see
  // src/screens/Home.tsx) — that's the reliable signal.
  //
  // waitFor(), not isVisible()/count(): those are non-retrying instantaneous
  // checks, and calling one immediately after ensurePinSetup's last
  // assertion can still race the next render.
  const seedBtn = page.locator('.empty button');
  try {
    await seedBtn.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    return;
  }
  await seedBtn.click();
  await expect(seedBtn).toBeHidden({ timeout: 15000 });
}

test.describe('Badminton Coach App', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await ensurePinSetup(page);
    });

    test('Loads the Today screen with the nav visible', async ({ page }) => {
        await expect(page.locator('h2', { hasText: 'Today' })).toBeVisible();
        await expect(page.locator('nav.tabbar')).toBeVisible();
    });

    test('Can load demo data from an empty state', async ({ page }) => {
        await ensureDemoData(page);

        await tab(page, 'Players').click();
        await expect(page.locator('h2', { hasText: 'Players' })).toBeVisible();
        // seedDemoDataIfEmpty() (src/lib/seed.ts) adds exactly 6 players
        // spanning both batches, both monthly and package billing, and a
        // paused/on-hold player — see that file for what each one covers.
        await expect(page.locator('ul.rows li')).toHaveCount(6);
    });

    test('Navigates through all 6 tabs', async ({ page }) => {
        await tab(page, 'Attendance').click();
        await expect(page.locator('.segmented').first()).toBeVisible();

        await tab(page, 'Fees').click();
        await expect(page.locator('h2', { hasText: 'Collect payment' })).toBeVisible();

        await tab(page, 'Players').click();
        await expect(page.locator('h2', { hasText: 'Players' })).toBeVisible();

        await tab(page, 'Stringing').click();
        await expect(page.locator('h2', { hasText: 'Stringing Board' })).toBeVisible();

        await tab(page, 'Settings').click();
        await expect(page.locator('h2', { hasText: 'Settings' })).toBeVisible();
    });

    test('Can add a Stringing Job', async ({ page }) => {
        await tab(page, 'Stringing').click();
        await page.click('button[aria-label="New stringing job"]');

        await page.fill('input[placeholder="Name"]', 'Test Player P1');
        await page.fill('input[placeholder="Yonex ArcSaber 11"]', 'Astrox 88D');
        await page.fill('input[placeholder="26"]', '28');

        await page.click('button:has-text("Add job")');
        await expect(page.locator('text=Test Player P1')).toBeVisible();
        await expect(page.locator('text=Pending').first()).toBeVisible();
    });

    test('Roll call takes attendance, and the multi-batch picker works', async ({ page }) => {
        await ensureDemoData(page);

        await tab(page, 'Attendance').click();
        // Demo data now seeds two batches (Morning Advanced, Evening
        // Beginners) specifically so this picker has something real to show.
        await expect(page.locator('.batch-picker')).toHaveCount(1);
        await expect(page.locator('.batch-chip')).toHaveCount(2);

        // Morning Advanced sorts first (earlier start_time) and is the
        // default selection; its roster's first player alphabetically is
        // Aarav Mehta, with no attendance mark yet (shown as PRESENT).
        const firstRow = page.locator('ul.rows li button.row').first();
        await expect(firstRow).toBeVisible();
        await firstRow.click(); // PRESENT -> ABSENT
        await expect(firstRow).toHaveClass(/status-absent/);

        // Switching to the other batch swaps the roster in.
        await page.locator('.batch-chip', { hasText: 'Evening Beginners' }).click();
        await expect(page.locator('text=Ishita Nair')).toBeVisible();
        await expect(page.locator('text=Rohan Verma')).toBeVisible();
    });

    test('Can create a batch and assign a player to it', async ({ page }) => {
        // Batches.tsx (create/edit a batch, add or remove players from its
        // roster) was fully built but unreachable from any tab or button —
        // there was no way for a real coach to create their first batch at
        // all. It's now a third segment inside Attendance, next to Roll
        // call/Reports, since batches are what Attendance operates on.
        await ensureDemoData(page);

        await tab(page, 'Attendance').click();
        await page.locator('.segmented button', { hasText: 'Batches' }).click();
        await expect(page.locator('h2', { hasText: 'Batches' })).toBeVisible();

        await page.click('button[aria-label="New batch"]');
        await page.fill('input[placeholder="Morning Advanced"]', 'Weekend Juniors');
        // Coach is picked from the coaches roster (Settings manages the list),
        // not typed free-text — seedDemoDataIfEmpty() creates "Coach Ravi".
        await page.selectOption('.modal select', { label: 'Coach Ravi' });
        await page.click('button:has-text("Create batch")');
        await expect(page.locator('text=Weekend Juniors')).toBeVisible();
        // Scoped to this row — Coach Ravi is also seeded onto Morning Advanced.
        await expect(
            page.locator('button.row', { hasText: 'Weekend Juniors' }).locator('text=Coach: Coach Ravi'),
        ).toBeVisible();

        // Re-open it to assign a player. Batch membership isn't exclusive,
        // so a player already in a seeded batch still shows up here.
        await page.locator('button.row', { hasText: 'Weekend Juniors' }).click();
        await page.fill('input[placeholder="Search players…"]', 'Aarav');
        await page.locator('.assign-row', { hasText: 'Aarav Mehta' }).locator('button', { hasText: 'Add' }).click();

        // Assigned players move into the roster section, which shows a
        // "Remove" button instead of "Add".
        const rosterRow = page.locator('.assign-row', { hasText: 'Aarav Mehta' });
        await expect(rosterRow.locator('button', { hasText: 'Remove' })).toBeVisible();
    });

    test('PIN set during setup locks the app on reload', async ({ page }) => {
        await page.reload();
        await expect(page.locator('text=Enter your PIN to continue')).toBeVisible();

        for (const digit of DEMO_PIN) {
            await page.click(`button:text-is("${digit}")`);
        }
        await expect(page.locator('h2', { hasText: 'Today' })).toBeVisible();
    });
});
