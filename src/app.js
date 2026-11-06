import 'dotenv/config';
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seed } from './db.js';
import { initPush, checkVersionUpdate } from './push.js';
import apiRouter from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Seed the admin + settings (result used by server.js to print the token).
export const seedResult = seed({
  adminName: process.env.ADMIN_NAME,
});

// Configure Web Push (disabled if VAPID keys are missing).
initPush();

// Tell everyone once when this boot is running a different version than
// the last one - see checkVersionUpdate() for why this only ever fires on prod.
const { version: appVersion } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
checkVersionUpdate(appVersion).catch((err) => console.error('[push] version-update notify failed:', err));

const app = express();
// Fly.io terminates TLS and proxies requests, so trust its X-Forwarded-For
// header to get each client's real IP (needed for per-IP rate limiting).
app.set('trust proxy', 1);

// One address per app: other hosts listed in REDIRECT_HOSTS forward to
// CANONICAL_HOST, path and query kept. Only the bare fly.dev address is
// redirected. One domain per app, served directly: lodge.appdoivo.com is the
// real app, lodge-demo.appdoivo.com the demo. Only the listed hosts are redirected - Fly's health
// checks (internal IP) and anything else are left alone.
const CANONICAL_HOST = process.env.CANONICAL_HOST;
const REDIRECT_HOSTS = new Set((process.env.REDIRECT_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
if (CANONICAL_HOST && REDIRECT_HOSTS.size) {
  app.use((req, res, next) => {
    if (!REDIRECT_HOSTS.has(req.hostname.toLowerCase())) return next();
    res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  });
}
// Security headers on every response (no extra dependency). The app loads
// nothing from other sites, so the browser is told to run only this site's own
// scripts: a guest's message that somehow carried <script> could not run, and
// no other site can show the app inside a frame (clickjacking).
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "media-src 'self' blob:", "font-src 'self'", "connect-src 'self'",
  "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  });
  next();
});
app.disable('x-powered-by');

// Default 100kb is too small for a base64-encoded outfit photo (client
// resizes to ~800px JPEG first, but base64 still adds ~33% overhead) - 2mb
// leaves generous headroom while still bounding the request body.
app.use(express.json({ limit: '2mb' }));

// API.
app.use('/api', apiRouter);

// RFC 9116 places security.txt at /.well-known/security.txt (see
// public/.well-known/security.txt) - that's the canonical location and
// already resolves on its own. Some older scanners only ever check the
// legacy bare /security.txt path though, so redirect that one too rather
// than letting the SPA fallback below swallow it into index.html.
app.get('/security.txt', (req, res) => res.redirect(301, '/.well-known/security.txt'));

// Cloudflare sits in front of qa/prod and its own "Browser Cache TTL"
// rewrites the Cache-Control it hands to the client regardless of what the
// origin (us) sends - confirmed directly, curling the live CSS shows
// "max-age=14400" even though the static middleware below sets "no-cache".
// Fixing that is a Cloudflare dashboard setting outside this repo, so
// rather than depend on any layer actually honouring a cache header,
// index.html/settings.html are served here (ahead of express.static) with
// their local <link>/<script> URLs stamped with the app version as a
// query string - a version bump (already required before every QA deploy)
// changes the URL itself, which is a guaranteed cache miss everywhere.
function withCacheBust(html) {
  return html.replace(
    /((?:href|src)=")(\/(?:css|js)\/[^"?]+)(")/g,
    (_match, pre, path, post) => `${pre}${path}?v=${appVersion}${post}`
  );
}

function sendVersionedHtml(res, filename) {
  const html = readFileSync(join(PUBLIC_DIR, filename), 'utf8');
  res.set('Cache-Control', 'no-cache').type('html').send(withCacheBust(html));
}

app.get('/settings.html', (req, res) => sendVersionedHtml(res, 'settings.html'));
app.get('/index.html', (req, res) => sendVersionedHtml(res, 'index.html'));

// Same problem as withCacheBust above, one level deeper: stamping app.js's
// own <script src> only forces a fresh fetch of app.js itself - every ES
// module it (transitively) imports via a plain relative path (e.g. "./
// i18n.js") is still requested with no version in the URL at all, so
// Cloudflare's edge can keep serving a stale one for hours after a deploy
// even though app.js itself updated - exactly what happened with a new
// i18n.js key showing up as literally "chat_title" instead of its real
// translation. Every /js/*.js file is served here (ahead of express.static)
// with its own relative imports stamped the same way, so the fix cascades
// through the whole module graph, not just the entry point.
function withJsCacheBust(js) {
  return js.replace(
    /(from\s+['"])(\.\.?\/[^'"]+\.js)(['"])/g,
    (_match, pre, path, post) => `${pre}${path}?v=${appVersion}${post}`
  );
}

app.get('/js/:name.js', (req, res, next) => {
  const filePath = join(PUBLIC_DIR, 'js', `${req.params.name}.js`);
  if (!existsSync(filePath)) return next();
  const js = readFileSync(filePath, 'utf8');
  res.set('Cache-Control', 'no-cache').type('text/javascript').send(withJsCacheBust(js));
});

// Static files (PWA). "no-cache" (despite the name) still lets the browser
// keep a local copy, but forces a conditional revalidation against the
// server's ETag on every single load rather than trusting a max-age blindly -
// this repo ships several small fixes per session, and a stale JS/CSS bundle
// silently masking an already-shipped fix (mistaken for "still broken") has
// repeatedly cost real debugging time. A 304 on an unchanged file is cheap;
// serving five-year-old JS because a CDN/browser cached it for hours is not.
// index:false so a bare "/" falls through to the SPA catch-all below
// instead of express.static's own default index.html handling, which
// would otherwise serve the raw file and skip the version-stamping above.
app.use(express.static(PUBLIC_DIR, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// SPA fallback: any non-API route returns the index.
//
// The braces are load-bearing. Express 5 rejects a bare '*', and the
// migration guides mostly suggest '/*splat' - which 404s a bare '/', the
// one address every guest actually types. '/{*splat}' makes the wildcard
// optional, so it matches the root as well as every path under it. Checked
// all three against a real server rather than taking the docs' word for it.
app.get('/{*splat}', (req, res) => sendVersionedHtml(res, 'index.html'));

// Catch-all for anything a route handler didn't handle itself (a thrown
// error, a rejected promise in an async handler). Without this, Express's
// own default handler returns an HTML page with the full stack trace -
// NODE_ENV is never set in this deployment, so that page was going out to
// real users, showing up in the app as a raw "Erro 500" (see api.js, which
// falls back to that string when the response body isn't JSON) and leaking
// internals (file paths, line numbers) to anyone who happened to trigger
// an error. Logs the real error server-side, returns a clean, translatable
// message client-side.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // A body the browser sent wrong (broken JSON, too large) is the request's fault,
  // not the server's: say so with a 4xx, and keep the log for real failures only
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'err_bad_request' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'err_too_large' });
  console.error('[error]', err);
  res.status(500).json({ error: 'err_generic' });
});

export default app;
