// Minimal in-memory rate limiter, keyed by IP. No extra dependency, matching
// this project's minimal-stack style. Good enough for a single-process,
// ~50-user deployment; resets on restart.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

// Shared across /auth/login AND every other endpoint's failed-token check
// (see checkAuthAttempt / auth.js) - a single per-IP budget for "guess a
// token", not a separate one per code path. Otherwise an attacker could
// dodge /auth/login's limit entirely by guessing tokens against any other
// authenticated endpoint instead, which accepts the same Bearer token.
const attempts = new Map(); // ip -> { count, resetAt }

function checkAndCount(ip) {
  const now = Date.now();
  let entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(ip, entry);
  }
  if (entry.count >= MAX_ATTEMPTS) {
    return { blocked: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { blocked: false };
}

/** Blocks an IP after too many requests within the time window (login brute-force guard). */
export function loginRateLimit(req, res, next) {
  const result = checkAndCount(req.ip);
  if (result.blocked) {
    res.set('Retry-After', String(result.retryAfter));
    return res.status(429).json({ error: 'err_rate_limited' });
  }
  next();
}

/**
 * Same budget, for a single failed-token attempt against any endpoint
 * (not just /auth/login). Only call this when a token actually fails to
 * resolve to a user - never on successful/authenticated requests, or
 * normal API usage by real users would get throttled.
 */
export function checkAuthAttempt(ip) {
  return checkAndCount(ip);
}

/** Tests only: a clean budget, so earlier failures in the same file cannot tip a test into 429. */
export function resetAuthAttempts() {
  attempts.clear();
}
