// Attack-style tests: what someone would try against a public app whose code they can read.
//  1. access: every route, with no key, with a guest's key, with a non-owner admin's key
//  2. fuzzing: every route gets malformed, oversized and hostile input; the server must
//     answer with a clear 4xx, never crash (5xx), hang, or show its insides
//  3. injection: messages carrying HTML/script are shown as plain text in the app
//  4. monkey: a seeded random walk of taps, typing and keys through the app as a guest,
//     with no page errors and no server errors
// Routes are read from the router itself, so a new route is covered without editing this.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const DB = join(tmpdir(), `appdoivo-sec-${process.pid}-${Date.now()}.sqlite`);
process.env.ANTHROPIC_API_KEY = '';                       // never reach the real API
process.env.TOKEN_SECRET ||= 'test-secret-not-used-anywhere-real';
process.env.DB_FILE = DB;
process.env.ADMIN_NAME = 'Sec Owner';
process.env.ENABLE_ADMIN_PROMOTION = 'true';
process.env.ENABLE_PLAZA = 'true';
process.env.ENABLE_MEMO = 'true';

const { default: app, seedResult } = await import('../src/app.js');
const { default: router } = await import('../src/routes.js');
const { resetAuthAttempts } = await import('../src/rateLimit.js');
const OWNER = seedResult.token;
let server, origin, base, guest, admin;

async function call(method, path, { token, body, raw, timeout = 10000 } = {}) {
  const res = await fetch(base + path, {
    method, signal: AbortSignal.timeout(timeout),
    headers: { ...(raw === undefined ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' || method === 'HEAD' ? undefined : raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// Every route the router knows, in order, with whether it sits behind login
const routes = [];
{
  let behindAuth = false;
  for (const layer of router.stack) {
    if (!layer.route && layer.name === 'authenticate') behindAuth = true;
    if (!layer.route) continue;
    const guards = layer.route.stack.map((l) => l.name);
    for (const m of Object.keys(layer.route.methods)) {
      routes.push({ method: m.toUpperCase(), path: layer.route.path, behindAuth, owner: guards.includes('requireOwner') || layer.route.path.startsWith('/admin/users') });
    }
  }
}
const fill = (path, v = '1') => path.replace(/:night\b/g, '1').replace(/:day\b/g, '2026-09-18').replace(/:[a-zA-Z]+/g, v);
// Expensive or slow by design (video, AI backfill, demo seeding): their access is tested, not fuzzed
const SLOW = /recap\/generate|translations\/backfill|seed-demo|seed-guests|\.zip$|\.pdf$/;

before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  base = `${origin}/api`;
  const g = await call('POST', '/admin/users', { token: OWNER, body: { name: 'Guest Probe' } });
  guest = JSON.parse(g.text).token;
  const a = await call('POST', '/admin/users', { token: OWNER, body: { name: 'Admin Probe' } });
  const aj = JSON.parse(a.text);
  admin = aj.token;
  await call('PATCH', `/admin/users/${aj.id}/admin`, { token: OWNER, body: { isAdmin: true } });
  for (const t of [guest, admin]) await call('POST', '/me/tutorial-seen', { token: t });
});

after(() => {
  server?.close();
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch { /* ignore */ } }
});

test('the router was read: there are routes behind login, admin routes and owner-only routes', () => {
  assert.ok(routes.filter((r) => r.behindAuth).length > 60);
  assert.ok(routes.some((r) => r.path.startsWith('/admin/')));
  assert.ok(routes.some((r) => r.owner));
});

test('access: with no key, every route behind login says 401 and nothing else', async () => {
  const leaks = [];
  for (const r of routes.filter((x) => x.behindAuth)) {
    const res = await call(r.method, fill(r.path));
    if (res.status !== 401) leaks.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.deepEqual(leaks, []);
});

test('access: a guest gets 403 on every admin route', async () => {
  const leaks = [];
  for (const r of routes.filter((x) => x.path.startsWith('/admin'))) {
    const res = await call(r.method, fill(r.path), { token: guest, body: {} });
    if (res.status !== 403) leaks.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.deepEqual(leaks, []);
});

test('access: an admin who is not the owner gets 403 on every owner-only route', async () => {
  const leaks = [];
  // By design: a non-owner admin may open the users list, which shows only their own row
  const ALLOWED = new Set(['GET /admin/users']);
  for (const r of routes.filter((x) => x.owner && !ALLOWED.has(`${x.method} ${x.path}`))) {
    const res = await call(r.method, fill(r.path), { token: admin, body: {} });
    if (res.status !== 403) leaks.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  assert.deepEqual(leaks, []);
});

test('access: forged, empty and look-alike keys are refused, and guessing hits the rate limit', async () => {
  resetAuthAttempts();
  const tries = [`${guest}x`, guest.toUpperCase() + '0', "' OR '1'='1", 'null', 'undefined', '0', ' ', 'Bearer', '*'];
  for (const t of tries) {
    const res = await call('GET', '/me', { token: t });
    assert.ok([401, 429].includes(res.status), `${JSON.stringify(t)} -> ${res.status}`);
  }
  let last;
  for (let i = 0; i < 12; i++) last = await call('POST', '/auth/login', { body: { token: `nobody${i}` } });
  assert.equal(last.status, 429);
  resetAuthAttempts();
});

// Hostile values, each in every field the route might read
const HOSTILE = [
  null, true, -1, 1e308, 'NaN', '', ' ', 'a'.repeat(100_000), '\u0000', '\ud800', '😀'.repeat(500),
  "' OR 1=1 --", '"; DROP TABLE users; --', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>',
  '../../../../etc/passwd', '%00', '${7*7}', '{{7*7}}', [], [[[]]], {}, { $gt: '' }, { __proto__: { admin: true } },
];
const FIELDS = ['token', 'name', 'text', 'message', 'body', 'title', 'lang', 'id', 'userId', 'contestantId', 'night', 'option', 'options',
  'currentToken', 'newToken', 'isAdmin', 'emoji', 'subscription', 'endpoint', 'photo', 'note', 'description', 'pseudonym', 'settings', 'value'];
const RAW = ['{', '{"a":', 'null', '[]', '"just a string"', '{"__proto__":{"isAdmin":true}}', 'x'.repeat(10)];
const badId = ['0', '-1', '99999999999999999999', '1 OR 1=1', '..%2F..%2Fetc', 'abc', '%00', '1e3'];

function insides(text) {
  return /\n\s+at\s|SQLITE_|TypeError|ReferenceError|node_modules|\/src\//.test(text);
}

for (const who of ['guest', 'owner']) {
  test(`fuzzing as ${who}: hostile input never crashes a route or shows its insides`, { timeout: 600_000 }, async () => {
    const token = who === 'guest' ? guest : OWNER;
    const bad = [];
    const list = routes.filter((r) => !SLOW.test(r.path) && (who === 'owner' || !r.path.startsWith('/admin')));
    for (const r of list) {
      const attempts = [];
      for (const v of HOSTILE) attempts.push({ body: Object.fromEntries(FIELDS.map((f) => [f, v])) });
      for (const raw of RAW) attempts.push({ raw });
      for (const id of badId) attempts.push({ path: fill(r.path, id), body: {} });
      for (const a of attempts) {
        let res;
        if (!r.behindAuth) resetAuthAttempts();                       // public routes: the login limit is tested on its own
        try { res = await call(r.method, a.path || fill(r.path), { token, body: a.body, raw: a.raw }); }
        catch (e) { bad.push(`${r.method} ${r.path} hung or failed: ${e.message}`); continue; }
        if (res.status >= 500 || insides(res.text)) bad.push(`${r.method} ${a.path || r.path} ${JSON.stringify(a.raw ?? a.body)?.slice(0, 60)} -> ${res.status} ${res.text.slice(0, 80)}`);
      }
    }
    // Still alive and still the same people afterwards
    assert.equal((await call('GET', '/me', { token: guest })).status, 200);
    assert.deepEqual([...new Set(bad)].slice(0, 60), []);
  });
}

test('the server never shows its insides, even on a broken request body', async () => {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"token":' });
  const text = await res.text();
  assert.ok(res.status < 500, `broken JSON should be a 4xx, got ${res.status}`);
  assert.ok(!insides(text), text.slice(0, 200));
});

async function guestPage(browser, token) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.route((url) => !url.href.startsWith(origin), (r) => r.abort());           // nothing leaves the test
  const page = await ctx.newPage();
  const errors = [], serverErrors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`); });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(origin + '/');
  await page.evaluate((t) => localStorage.setItem('appivo_token', t), token);
  await page.goto(origin + '/');
  await page.waitForSelector('#app:not(.hidden)', { timeout: 20000 });
  return { ctx, page, errors, serverErrors };
}

test('injection: HTML and script in messages show as plain text, never as page elements', { timeout: 120_000 }, async () => {
  const PAYLOAD = '<img src=x id=pwned onerror="window.__pwned=1"><script>window.__pwned=2</script><b id=bold>bold</b>';
  await call('POST', '/chat/messages', { token: guest, body: { text: PAYLOAD } });
  await call('POST', '/admin/plaza-posts', { token: OWNER, body: { type: 'announcement', text: PAYLOAD, title: PAYLOAD } });
  await call('PUT', '/dedications/mine', { token: guest, body: { text: PAYLOAD } });
  await call('PATCH', `/admin/users/1/name`, { token: OWNER, body: { name: '<b id=bold>x</b>' } });
  const browser = await chromium.launch();
  try {
    const { page, errors } = await guestPage(browser, guest);
    for (const tab of ['plaza', 'chat', 'rata', 'outfit', 'memo']) {
      await page.click(`[data-tab="${tab}"]`, { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(600);
      const found = await page.evaluate(() => ({ el: !!document.querySelector('#pwned, #bold, img[src="x"]'), ran: window.__pwned }));
      assert.deepEqual(found, { el: false, ran: undefined }, `tab ${tab}`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('monkey: 300 random taps, keys and typing as a guest break nothing', { timeout: 300_000 }, async () => {
  let seed = 20260915;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const TEXT = ['hello', 'olá 😀', '<b>x</b>', "'; --", ' ', 'a'.repeat(300), '1e9', '\n\n'];
  const browser = await chromium.launch();
  try {
    const { page, errors, serverErrors } = await guestPage(browser, guest);
    for (let i = 0; i < 300; i++) {
      const roll = rnd();
      if (page.url() !== origin + '/' && !page.url().startsWith(origin + '/#') && !page.url().startsWith(origin + '/?')) await page.goto(origin + '/');
      try {
        if (roll < 0.6) {
          const els = await page.locator('button:visible, a[href^="#"]:visible, [role=tab]:visible, [data-tab]:visible, label:visible, summary:visible').all();
          if (els.length) await pick(els).click({ timeout: 1000, noWaitAfter: true });
        } else if (roll < 0.85) {
          const fields = await page.locator('input:visible:not([type=file]), textarea:visible').all();
          if (fields.length) await pick(fields).fill(pick(TEXT), { timeout: 1000 });
        } else {
          await page.keyboard.press(pick(['Enter', 'Escape', 'Tab', 'ArrowDown', 'Space', 'Backspace']));
        }
      } catch { /* an element that moved away is normal; only errors count */ }
      if (i % 50 === 0) await page.waitForTimeout(200);
    }
    assert.deepEqual(errors, [], 'page errors');
    assert.deepEqual(serverErrors, [], 'server errors');
  } finally { await browser.close(); }
});
