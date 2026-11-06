// Public demo mode (DEMO_MODE=true, see fly.demo.toml): the app running with
// mock data for anyone to try, e.g. a recruiter following the README link.
//
// Two things make that safe to leave open:
// - The login screen offers two shared keys (a guest and an admin), so
//   nobody needs an account - and nothing a visitor does may lock the next
//   one out of them, which is why changing a key is off.
// - Anything that publishes something a stranger could abuse (photos, links,
//   the anonymous chat) or that wipes the demo for everyone is refused.
//   Photos are swapped for a placeholder instead of refused, so registering
//   an outfit still works end to end. Memo works the same way: the server
//   keeps the placeholder, and the visitor sees their own photo from their
//   own browser for as long as the page is open.
// The database has no volume in the demo, so every restart - the machine
// stops when idle - brings back the seeded data.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDemoUserToken } from './db.js';
import { DEMO_GUEST_NAME, PRESET_ADMIN_NAME } from './seedDemo.js';

export const DEMO_MODE = process.env.DEMO_MODE === 'true';

const PLACEHOLDER_PHOTO = DEMO_MODE
  ? `data:image/jpeg;base64,${readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'images', 'demo-photo.jpg')).toString('base64')}`
  : null;

/** Demo only: replace an uploaded memo file on disk with the placeholder photo. */
export function demoMemoFile(file) {
  if (!DEMO_MODE || !file?.path) return;
  writeFileSync(file.path, Buffer.from(PLACEHOLDER_PHOTO.split(',')[1], 'base64'));
  file.mimetype = 'image/jpeg';
  file.size = statSync(file.path).size;
}

/** The shared logins the demo's login screen shows. */
export function demoKeys() {
  if (!DEMO_MODE) return [];
  return [
    { role: 'guest', name: DEMO_GUEST_NAME, key: generateDemoUserToken(DEMO_GUEST_NAME) },
    { role: 'admin', name: PRESET_ADMIN_NAME, key: generateDemoUserToken(PRESET_ADMIN_NAME) },
  ];
}

const REFUSED = [
  ['POST', /^\/me\/change-token$/],
  ['POST', /^\/chat\/messages$/],
  ['POST', /^\/push\/subscribe$/],
  ['POST', /\/wipe$/],
  ['POST', /^\/admin\/voting\/[^/]+\/reset-all$/],
  ['POST', /\/seed-(demo|guests)$/],
  ['DELETE', /^\/admin\//],
  ['PUT', /^\/admin\/settings$/],
  ['POST', /^\/admin\/translations\/backfill$/],
];

export function demoGuard(req, res, next) {
  if (!DEMO_MODE) return next();
  if (REFUSED.some(([method, path]) => req.method === method && path.test(req.path))) {
    return res.status(403).json({ error: 'err_demo_disabled' });
  }
  if (req.method === 'POST' && req.path === '/admin/plaza-posts' && req.body?.type === 'links') {
    return res.status(403).json({ error: 'err_demo_disabled' });
  }
  if (req.body?.photoBase64) req.body.photoBase64 = PLACEHOLDER_PHOTO;
  next();
}
