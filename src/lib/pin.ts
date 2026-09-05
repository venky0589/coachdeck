// PIN hashing + lockout policy for the coach's app-level lock.
//
// Previously this was a raw, unsalted SHA-256 digest of the PIN — fast to
// compute, which is exactly the wrong property for a secret with only
// 10,000–1,000,000 possible values (4–6 digits). A leaked hash (e.g. someone
// with network access to the unauthenticated old server, or just opening
// IndexedDB in devtools) could be brute-forced in well under a second.
//
// This replaces it with salted PBKDF2-HMAC-SHA256 at a high iteration count
// (deliberately slow — hundreds of thousands of times slower than SHA-256 to
// verify a single guess) plus a persisted, progressively-increasing lockout
// after repeated failures. Both run entirely client-side via the Web Crypto
// API, so the PIN lock keeps working with no backend configured, matching
// the app's offline-first design.
//
// This raises the cost of guessing meaningfully but a 4–6 digit PIN has an
// inherently small keyspace — treat this as "slows down someone with the
// device in hand," not as strong as a real password would be.

const ITERATIONS = 210_000; // OWASP-recommended floor for PBKDF2-HMAC-SHA256 (2023+)
const KEY_LENGTH_BITS = 256;

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function randomSaltHex(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function derivePinHash(pin: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex) as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH_BITS,
  );
  return toHex(bits);
}

export async function verifyPin(pin: string, saltHex: string, expectedHash: string): Promise<boolean> {
  const computed = await derivePinHash(pin, saltHex);
  // Constant-time-ish compare — not that it matters much for a value that
  // never leaves this device, but costs nothing to do properly.
  if (computed.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return diff === 0;
}

// ---- lockout policy ---------------------------------------------------------
// Failures accumulate in app_settings (pin_fail_count / pin_lock_until) so the
// lockout survives an app reload. Backoff: no lock until 5 fails, then it
// doubles each additional fail, capped at 30 minutes.

const FREE_ATTEMPTS = 5;
const BASE_LOCK_SECONDS = 30;
const MAX_LOCK_SECONDS = 30 * 60;

export function lockDurationSeconds(failCount: number): number {
  if (failCount < FREE_ATTEMPTS) return 0;
  const doublings = failCount - FREE_ATTEMPTS;
  return Math.min(BASE_LOCK_SECONDS * 2 ** doublings, MAX_LOCK_SECONDS);
}

export function lockUntilFor(failCount: number, now: Date = new Date()): string | null {
  const seconds = lockDurationSeconds(failCount);
  if (seconds <= 0) return null;
  return new Date(now.getTime() + seconds * 1000).toISOString();
}
