import { defineConfig, devices } from '@playwright/test';

// No backend is required for these tests — the app is offline-first and
// runs entirely against IndexedDB with no Supabase/API server configured.
//
// vite.config.ts always enables @vitejs/plugin-basic-ssl, so the dev server
// is HTTPS-only with a self-signed cert (that's also why the app is
// reachable at a plain http:// URL on the coach's own machine — it isn't:
// it's https://, same as the PWA in production needs to be for a service
// worker to register at all). `ignoreHTTPSErrors` accepts that self-signed
// cert instead of every test failing on it.
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: 'https://localhost:5173',
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev -- --port 5173',
    url: 'https://localhost:5173',
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
