// UI/UX regression suite. Unlike test/api.test.js (server logic only), this
// drives real rendered pages with Playwright's WebKit engine - the same
// engine iOS Safari uses - so layout/rendering issues that only show up on
// an actual iPhone (not Chromium) get caught here before a deploy.
//
// Run with: npm run test:ui (needs `npx playwright install webkit` once).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { webkit, devices } from 'playwright';

const DB = join(tmpdir(), `appdoivo-ui-test-${process.pid}-${Date.now()}.sqlite`);
// Pinned rather than left to the ambient .env: without it the suite falls
// back to a per-initialisation random secret (see tokens.js), so any part of
// a run that re-initialises the module graph gets a secret that cannot read
// the tokens the rest of the run created. Locally a developer's .env hides
// that; CI, which has no .env, does not.
// Pinned empty so the suite can never reach the real API, whatever is in a
// developer's .env. dotenv does not overwrite a variable that is already
// set, so assigning '' here wins over the key loaded when app.js imports
// dotenv/config - and isConfigured() reads it as absent.
//
// Without this the suite silently starts billing an API the moment a key
// exists locally, which is exactly what happened the first time one did.
// Translations are exercised through a fake translator instead; see the
// tests further down.
process.env.ANTHROPIC_API_KEY = '';

process.env.TOKEN_SECRET ||= 'test-secret-not-used-anywhere-real';
process.env.DB_FILE = DB;
process.env.ADMIN_NAME = 'UI Test Admin';
process.env.ENABLE_ADMIN_PROMOTION = 'true';
process.env.ENABLE_PLAZA = 'true';
process.env.ENABLE_MEMO = 'true';

const { default: app, seedResult } = await import('../src/app.js');
const { default: db } = await import('../src/db.js');
const { MEMO_DIR, ensureTodaysSlots, zonedTimeToUtc } = await import('../src/memo.js');
const { today, getTimezone, now, setClockForTests } = await import('../src/time.js');

// The admin's real key is always generated (see seed() in db.js - no more
// ADMIN_TOKEN pinning it, even outside production), so this reads the
// actual generated value off seedResult rather than assuming a fixed
// string.
const ADMIN = seedResult.token;
// GitHub Actions' shared runners occasionally get resource-starved enough
// that a login flow taking well under 5s locally blows past a 5000ms
// waitForSelector everywhere at once (seen firsthand: identical commits
// pass locally every time, then fail in CI with every login-dependent test
// timing out around 5.5-5.7s, and a rerun of the same commit often passes
// clean) - not a real regression, just CI's shared hardware being slower
// on a bad run. `CI` is set by GitHub Actions (and most other CI
// providers) automatically, so this only loosens the timeout there.
// Bumped again (15000 -> 25000): 15000 was itself hit repeatedly on bad
// runs (every login-dependent test failing at ~15.6-15.9s, consistently,
// while the same commit had passed a different CI run minutes earlier) -
// not further evidence of a real bug, just this shared hardware needing
// still more headroom on its worse days.
const WAIT_TIMEOUT = process.env.CI ? 25000 : 5000;
let server;
let base; // e.g. http://127.0.0.1:PORT (no /api - that's for page navigation)
let browser;

// Every request the app answers with an error, kept so a failing test can
// say *why* it failed instead of only that it waited 25s. A login that never
// completes is indistinguishable from a slow one at the Playwright level -
// the answer is always in the status the page got back from /api/me, which
// nothing was recording. Cheap enough to leave on permanently: one push per
// error response, nothing at all on the happy path.
const errorResponses = [];

before(async () => {
  server = createServer((req, res) => {
    // The error code matters as much as the status: a /me answered 401
    // err_token_missing (the browser sent no key) and one answered 401
    // err_token_invalid (it sent a key the server does not know) point at
    // completely different bugs, and the status alone cannot tell them apart.
    let body = '';
    const end = res.end.bind(res);
    res.end = (chunk, ...rest) => {
      if (chunk && res.statusCode >= 400) body = String(chunk).slice(0, 80);
      return end(chunk, ...rest);
    };
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        const sent = req.headers.authorization ? 'with a key' : 'no auth header';
        errorResponses.push(`${new Date().toISOString()} ${req.method} ${req.url} -> ${res.statusCode} ${body} (${sent})`);
      }
    });
    app(req, res);
  });
  server.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await webkit.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  for (const ext of ['', '-wal', '-shm']) {
    try { rmSync(DB + ext); } catch { /* ignore */ }
  }
  try { rmSync(MEMO_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/** New browser context using a real iPhone device profile (viewport, UA, touch, DPR). */
// Every context this hands out is tracked, and afterEach closes whatever is
// still open. The 63 `await context.close()` calls sit at the end of their
// test bodies, which means they only run when the test *passes* - a test
// that times out leaves its WebKit context and pages alive for the rest of
// the run.
//
// That is what turns a slow CI runner into a red one. Locally nothing times
// out, so nothing leaks and the suite is green; on a two-core runner the
// first genuine timeout leaves a live browser behind, which makes the next
// test slower, which leaks another. The published runs show the shape of it
// - 57 of 77 UI tests failing, every one of them at the 25s ceiling inside
// loginPage(), while the whole non-browser suite passes untouched.
//
// Closing twice is a no-op, so the existing explicit calls can stay.
const openContexts = new Set();

async function iphoneContext(deviceName) {
  const context = await browser.newContext({ ...devices[deviceName] });
  openContexts.add(context);
  return context;
}

afterEach(async () => {
  for (const context of openContexts) {
    try { await context.close(); } catch { /* already closed by the test */ }
  }
  openContexts.clear();
});

/** Logs in via localStorage (like the app itself does) and waits for the app shell. */
async function loginPage(context, token, path = '/') {
  // First-session tutorial overlay would otherwise intercept every click in
  // tests that aren't specifically testing it - the tutorial has no skip
  // button by design (see the "no skip" feedback fix), so mark it seen via
  // the API up front instead of clicking through every step.
  await api('POST', '/me/tutorial-seen', { token });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`console: ${msg.text()}`); });
  page.on('requestfailed', (req) => consoleErrors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`));

  // What the browser itself sent and got for the one request the login turns
  // on. The server-side record cannot tell an answered 401 apart from a
  // request that never arrived, and those are different bugs: the first is
  // the token being rejected, the second is the request dying in flight.
  const meExchanges = [];
  page.on('response', (res) => {
    if (!res.url().includes('/api/me')) return;
    const sent = res.request().headers()['authorization'];
    meExchanges.push(`${res.status()} (sent: ${sent ? `${sent.slice(0, 14)}…` : 'no auth header'})`);
  });

  await page.goto(base + '/');
  await page.evaluate((tok) => localStorage.setItem('appivo_token', tok), token);
  const storedBefore = await page.evaluate(() => localStorage.getItem('appivo_token'));
  await page.goto(base + path);
  const selector = path === '/settings.html' ? '#admin-content:not(.hidden)' : '#app:not(.hidden)';
  try {
    await page.waitForSelector(selector, { timeout: WAIT_TIMEOUT });
  } catch (timeout) {
    const detail = [
      `  token written before navigating: ${storedBefore ? `${storedBefore.slice(0, 4)}…(${storedBefore.length} chars)` : '(nothing was written)'}`,
      `  /api/me exchanges the browser actually made: ${meExchanges.length ? meExchanges.join(', ') : '(none - the request never completed)'}`,
    ].join('\n');
    throw new Error(`${timeout.message}\n${detail}\n${await loginDiagnostics(page, consoleErrors)}`);
  }
  return page;
}

/**
 * waitForSelector, but a timeout says what the server was answering and
 * whether the app had put a modal on screen. Anything the app refuses shows
 * up as an alert rather than as a missing element, so "the element never
 * appeared" is almost never the actual failure.
 */
async function waitOrExplain(page, selector, timeout = WAIT_TIMEOUT) {
  try {
    return await page.waitForSelector(selector, { timeout });
  } catch (missing) {
    const modal = await page
      .evaluate(() => document.querySelector('.modal-overlay:not(.hidden) .modal-message')?.textContent.trim() || null)
      .catch(() => null);
    throw new Error([
      missing.message,
      `  modal on screen: ${modal ?? '(none)'}`,
      '  last error responses from the server:',
      ...errorResponses.slice(-10).map((l) => `    ${l}`),
    ].join('\n'));
  }
}

/**
 * Why a login never completed. boot() in app.js hides #app and falls back to
 * the login screen whenever /me does not answer 200, so every one of these
 * timeouts is really an HTTP status nobody was printing - a 401 (the token
 * the suite created is not the one the server has) and a 429 (the shared
 * per-IP brute-force budget in rateLimit.js, spent by an earlier test) look
 * identical from the outside, and they need opposite fixes.
 */
async function loginDiagnostics(page, consoleErrors) {
  const state = await page.evaluate(async () => {
    const token = localStorage.getItem('appivo_token');
    const out = { token: token ? `${token.slice(0, 4)}…(${token.length} chars)` : '(none)' };
    out.loginVisible = !document.getElementById('login')?.classList.contains('hidden');
    out.appVisible = !document.getElementById('app')?.classList.contains('hidden');
    try {
      const res = await fetch('/api/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      out.meStatus = res.status;
      out.meBody = (await res.text()).slice(0, 200);
      out.retryAfter = res.headers.get('Retry-After');
    } catch (e) {
      out.meStatus = `fetch threw: ${e.message}`;
    }
    return out;
  }).catch((e) => ({ meStatus: `could not evaluate in page: ${e.message}` }));

  return [
    `  /api/me from inside the page: ${state.meStatus}${state.retryAfter ? ` (Retry-After: ${state.retryAfter})` : ''}`,
    `  body: ${state.meBody ?? '(none)'}`,
    `  token in localStorage: ${state.token}`,
    `  #login visible: ${state.loginVisible}, #app visible: ${state.appVisible}`,
    `  last error responses from the server:`,
    ...(errorResponses.slice(-15).map((l) => `    ${l}`)),
    ...(consoleErrors.length ? ['  page errors:', ...consoleErrors.slice(-10).map((l) => `    ${l}`)] : []),
  ].join('\n');
}

/** scrollWidth beyond the viewport means something is overflowing horizontally. */
async function horizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/* ------------------------- No horizontal overflow ------------------------ */
// Sweep real iPhone sizes, smallest to largest, on every top-level screen.

const IOS_DEVICES = ['iPhone SE', 'iPhone 13', 'iPhone 16 Pro Max'];

for (const deviceName of IOS_DEVICES) {
  test(`login screen has no horizontal overflow on ${deviceName}`, async () => {
    const context = await iphoneContext(deviceName);
    const page = await context.newPage();
    await page.goto(base + '/');
    await page.waitForSelector('#login:not(.hidden)', { timeout: WAIT_TIMEOUT });
    const overflow = await horizontalOverflow(page);
    assert.ok(overflow <= 1, `login screen overflows by ${overflow}px on ${deviceName}`);
    await context.close();
  });

  // iPhone Safari (iOS 26) paints a solid band over anything pinned to the
  // top or bottom edge, so the login keeps its painting still without
  // position: fixed - the window never scrolls, .cover scrolls over it.
  test(`login painting stays still with nothing pinned, the form scrolling over it, on ${deviceName}`, async () => {
    const context = await iphoneContext(deviceName);
    const page = await context.newPage();
    await page.goto(base + '/');
    await page.waitForSelector('#login:not(.hidden)', { timeout: WAIT_TIMEOUT });
    const state = await page.evaluate(() => {
      const login = document.getElementById('login');
      const cover = login.querySelector('.cover');
      const r = login.getBoundingClientRect();
      return {
        pinned: [...document.querySelectorAll('body *')].filter((el) => el.getClientRects().length && ['fixed', 'sticky'].includes(getComputedStyle(el).position)).map((el) => el.id || el.className),
        windowScroll: getComputedStyle(document.documentElement).overflowY,
        coverScroll: getComputedStyle(cover).overflowY,
        top: r.top, bottom: r.bottom, h: innerHeight,
      };
    });
    assert.deepEqual(state.pinned, [], `pinned elements on the login: ${state.pinned}`);
    assert.equal(state.windowScroll, 'hidden');
    assert.equal(state.coverScroll, 'auto');
    assert.ok(state.top <= 0 && state.bottom >= state.h, `the painting must cover the screen: ${JSON.stringify(state)}`);
    await context.close();
  });

  test(`main app (plaza + rata + best look + chat + memo tabs) has no horizontal overflow on ${deviceName}`, async () => {
    const context = await iphoneContext(deviceName);
    const page = await loginPage(context, ADMIN, '/');
    const plazaOverflow = await horizontalOverflow(page);
    assert.ok(plazaOverflow <= 1, `"plaza" tab overflows by ${plazaOverflow}px on ${deviceName}`);

    await page.click('[data-tab="rata"]');
    await page.waitForTimeout(150);
    const rataOverflow = await horizontalOverflow(page);
    assert.ok(rataOverflow <= 1, `"a rata" tab overflows by ${rataOverflow}px on ${deviceName}`);

    await page.click('[data-tab="outfit"]');
    await page.waitForTimeout(150);
    const outfitOverflow = await horizontalOverflow(page);
    assert.ok(outfitOverflow <= 1, `"best look" tab overflows by ${outfitOverflow}px on ${deviceName}`);

    await page.click('[data-tab="chat"]');
    await page.waitForTimeout(150);
    const chatOverflow = await horizontalOverflow(page);
    assert.ok(chatOverflow <= 1, `"chat" tab overflows by ${chatOverflow}px on ${deviceName}`);

    await page.click('[data-tab="memo"]');
    await page.waitForTimeout(150);
    const memoOverflow = await horizontalOverflow(page);
    assert.ok(memoOverflow <= 1, `"memo" tab overflows by ${memoOverflow}px on ${deviceName}`);
    await context.close();
  });

  test(`admin panel has no horizontal overflow on ${deviceName}`, async () => {
    const context = await iphoneContext(deviceName);
    const page = await loginPage(context, ADMIN, '/settings.html');
    const overflow = await horizontalOverflow(page);
    assert.ok(overflow <= 1, `admin panel overflows by ${overflow}px on ${deviceName}`);
    await context.close();
  });
}

/* ---------------------- Topbar icon alignment (regression) --------------- */
// Bell + hamburger used to be nudged into place with per-icon transform
// hacks that kept drifting out of sync. Guard the actual invariant: their
// boxes must be vertically centered on each other.

test('every topbar icon button stays vertically aligned', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  // Push may be "unsupported" in a headless test browser, which hides the
  // bell via .hidden - force it visible to check its box regardless.
  await page.evaluate(() => document.getElementById('notif-btn').classList.remove('hidden'));

  const centers = await page.$$eval('.topbar-actions .icon-btn', (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    })
  );
  assert.ok(centers.length >= 4, `expected at least 4 topbar icon buttons, found ${centers.length}`);
  const drift = Math.max(...centers) - Math.min(...centers);
  assert.ok(drift < 2, `topbar icon buttons are ${drift.toFixed(1)}px apart vertically`);
  await context.close();
});

/* ------------------- Brand logo fits the viewport (regression) ----------- */
// document-level scrollWidth (the check above) can pass even when the logo
// itself is too wide, because .topbar's flex-wrap just drops topbar-actions
// to its own line below - the page never scrolls horizontally, but the
// logo's own box still overflows past both edges. Check its own
// bounding rect directly, on the narrowest real device, since a fixed
// rem size that looks fine at a wide viewport can still not fit a phone.

for (const deviceName of IOS_DEVICES) {
  test(`brand logo never overflows the viewport on ${deviceName}`, async () => {
    const context = await iphoneContext(deviceName);
    const page = await loginPage(context, ADMIN, '/');
    const { left, right, viewportWidth } = await page.evaluate(() => {
      const r = document.querySelector('.brand-name').getBoundingClientRect();
      return { left: r.left, right: r.right, viewportWidth: window.innerWidth };
    });
    assert.ok(left >= -1, `brand logo starts off the left edge (left=${left.toFixed(1)}) on ${deviceName}`);
    assert.ok(right <= viewportWidth + 1, `brand logo extends off the right edge (right=${right.toFixed(1)}, viewport=${viewportWidth}) on ${deviceName}`);
    await context.close();
  });
}

/* ------------------------ Login flash (regression) ------------------------ */
// #login used to be visible by default, so an authenticated user briefly saw
// the login form before the session check resolved. It must ship hidden.

// Regression: settings.html declared no apple-touch-icon, so adding it to
// an iPhone home screen - which Ivo does, to keep the admin page beside the
// app - produced a grey square with the first letter of the title in it
// rather than the app icon. index.html had the tags all along; nobody had
// looked at the other page. Reads the served HTML rather than the file, so
// it also covers the version stamping in between.
test('both pages give iOS an icon to use on the home screen', async () => {
  for (const path of ['/', '/settings.html']) {
    const res = await fetch(base + path);
    const html = await res.text();
    assert.match(html, /rel="apple-touch-icon"[^>]*icon-180\.png/, `${path} has no apple-touch-icon`);
    assert.match(html, /apple-mobile-web-app-capable/, `${path} does not declare itself installable`);

    const title = html.match(/apple-mobile-web-app-title" content="([^"]*)"/)?.[1];
    assert.ok(title, `${path} has no home screen name`);
    // The OS draws that label itself, so text-transform cannot reach it -
    // same reason the push copy is checked for capitals.
    assert.equal(title, title.toLowerCase(), `the home screen name for ${path} carries a capital: "${title}"`);
  }
});

test('#login ships hidden in the raw HTML (no flash before auth check resolves)', async () => {
  const html = await (await fetch(base + '/')).text();
  const match = html.match(/<section id="login" class="([^"]*)"/);
  assert.ok(match, 'could not find #login in the served HTML');
  assert.ok(match[1].split(/\s+/).includes('hidden'), '#login is not hidden by default - it will flash before auth resolves');
});

// Regression: body used to get theme-rata applied unconditionally on boot,
// before the login/auth check resolved - #login's own white background
// couldn't fully mask it, since iOS Safari's rubber-band overscroll paints
// straight from body's background, a region no child element can cover.
test('body carries no night-theme class while the login screen is showing', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.waitForSelector('#login:not(.hidden)');

  const bodyClasses = await page.evaluate(() => document.body.className);
  assert.doesNotMatch(bodyClasses, /theme-(rata|furnished|swamp|mural|plaza)/, `body should carry no night-theme class pre-login, got: "${bodyClasses}"`);

  await context.close();
});

// Regression: visiting /settings.html with no session used to strand the
// visitor on a dead-end admin page with just an error message - no way
// back to login short of manually navigating to "/" themselves.
test('visiting /settings.html with no session redirects to the login page', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/settings.html');
  await page.waitForSelector('#login:not(.hidden)', { timeout: WAIT_TIMEOUT });
  assert.equal(new URL(page.url()).pathname, '/', 'should have redirected to the login page');
  await context.close();
});

/* ------------------- Startup survives a bad worker/network --------------- */
// Both of these are what turned CI red for weeks. boot() awaited service
// worker registration before it did anything else, so a registration that
// never settled left the app on a blank screen - no login form, no app, a
// perfectly valid session behind it. The instrumented runs caught it exactly
// that way: #app never appeared while /me answered 200 and the key was still
// stored. And boot()'s catch treated any failure as "session over", so one
// dropped request threw the key away and the screen fell back to login for
// good. Neither needs a slow runner to happen - a phone moving between rooms
// does the same thing.

// Android will only mint a proper, Google-signed wrapper for a site whose
// service worker handles fetch; without one, some browsers fall back to a
// legacy wrapper and Play Protect refuses it as "built for an older version
// of Android". Ivo hit exactly that installing on his phone.
//
// The risk in adding one is undoing the app's deliberate no-cache: a stale
// bundle hiding an already-shipped fix has cost real debugging time here.
// So this asserts both halves - the handler exists, and it does not serve
// anything stale while the network is there.
test('the service worker handles fetch, without serving anything stale', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN);

  const hasFetchHandler = await page.evaluate(async () => {
    const res = await fetch('/sw.js', { cache: 'no-store' });
    const src = await res.text();
    return /addEventListener\(\s*['"]fetch['"]/.test(src);
  });
  assert.ok(hasFetchHandler, 'no fetch handler - Android will not build a proper app wrapper');

  // Assets must still come from the network, not a cache. Change something
  // server-side and the next load has to see it.
  const posted = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'announcement', text: 'freshness check' },
  });
  await page.reload();
  await page.waitForSelector('.plaza-post', { timeout: WAIT_TIMEOUT });
  const seen = await page.$$eval('.plaza-post-text', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(seen.some((t) => t.includes('freshness check')),
    'a reload served stale content - the fetch handler must stay network-first');

  await api('DELETE', `/admin/plaza-posts/${posted.id}`, { token: ADMIN });
  await context.close();
});

test('the app still opens when service worker registration never settles', async () => {
  const context = await iphoneContext('iPhone 13');
  await context.addInitScript(() => {
    if (navigator.serviceWorker) navigator.serviceWorker.register = () => new Promise(() => {});
  });

  // loginPage() waits for #app itself - the app shell has to be up and
  // usable, not merely un-hidden, so check the tab bar came with it.
  const page = await loginPage(context, ADMIN, '/');
  assert.ok(
    await page.isVisible('[data-tab="rata"]'),
    'push registration is not something the app should wait on before it can be used',
  );

  // Settings has its own boot() with its own copy of this, and it was the
  // half that stayed broken after the main app's was fixed.
  const settings = await loginPage(context, ADMIN, '/settings.html');
  assert.ok(
    await settings.isVisible('#admin-tabs'),
    'the admin page waits on push registration the same way the main app did',
  );
  await context.close();
});

test('a request dropped at startup does not throw away the stored key', async () => {
  const context = await iphoneContext('iPhone 13');
  // Exactly one dropped /me per page load, then the network behaves - the
  // phone-changing-rooms case, not a server refusing the key. Done by
  // replacing fetch rather than with context.route(): once a service worker
  // controls the page, WebKit routes its requests around Playwright's
  // interception entirely and the handler never fires.
  await context.addInitScript(() => {
    const realFetch = window.fetch;
    let dropped = false;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!dropped && url.includes('/api/me')) {
        dropped = true;
        return Promise.reject(new TypeError('Load failed'));
      }
      return realFetch(input, init);
    };
  });

  const page = await loginPage(context, ADMIN, '/');
  assert.equal(
    await page.evaluate(() => localStorage.getItem('appivo_token')),
    ADMIN,
    'a dropped request says nothing about the key being valid - losing it costs the only way back in',
  );

  // Settings threw the key away on any failure too, and bounced to the
  // login page - so the same dropped request logged an admin out for good.
  const settings = await loginPage(context, ADMIN, '/settings.html');
  assert.equal(
    await settings.evaluate(() => localStorage.getItem('appivo_token')),
    ADMIN,
    'the admin page must not throw the key away over a request that never arrived',
  );
  await context.close();
});

/* --------------------- First-time key retrieval (register) --------------- */

test('a first-time user can find their name, claim their key, and get logged straight in', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Playwright Newcomer' } });

  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.waitForSelector('#login:not(.hidden)');

  await page.click('#find-key-link');
  await page.fill('#token-input', 'playwright newcomer');
  await page.waitForSelector('.find-key-result', { timeout: WAIT_TIMEOUT });
  await page.click('.find-key-result');

  const modal = page.locator('.modal-overlay:not(.hidden)');
  await modal.waitFor({ timeout: WAIT_TIMEOUT });
  const revealed = await page.locator('.modal-message').textContent();
  assert.match(revealed, /copiada|copied/i, 'the modal should confirm the key was copied');
  await page.locator('.modal-actions button').first().click();

  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const me = await page.evaluate(async () => {
    const token = localStorage.getItem('appivo_token');
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    return res.json();
  });
  assert.equal(me.name, 'Playwright Newcomer', 'the auto-login after claiming should be the claimed account');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

/* ------------------------- Wall (admin posts/polls) ------------------------ */
// Internal id/routes/CSS classes stay "plaza" (see tab_plaza in i18n.js for
// the displayed-vs-internal mapping) - only the label changed to "Wall".

// The highlight is the night's motif tiled behind the words, not a rail
// beside them and not a tinted box. Three things have to hold together or
// it stops being that: the motif covers the whole block, nothing paints a
// ground behind it, and it stays faint enough to read over.
test('a highlight carries the night motif once, as an emblem, with no tinted box', async () => {
  const post = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'a rata abre às 22h' } });
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.waitForSelector('.plaza-post-text.highlight', { timeout: WAIT_TIMEOUT });

  const style = await page.evaluate(() => {
    const el = document.querySelector('.plaza-post-text.highlight');
    const before = getComputedStyle(el, '::before');
    const own = getComputedStyle(el);
    return {
      maskImage: before.maskImage || before.webkitMaskImage,
      maskRepeat: before.maskRepeat || before.webkitMaskRepeat,
      maskPosition: before.maskPosition || before.webkitMaskPosition,
      opacity: Number(before.opacity),
      width: before.width,
      background: own.backgroundColor,
      borderLeft: own.borderLeftWidth,
      paddingLeft: own.paddingLeft,
      paddingRight: own.paddingRight,
    };
  });

  assert.match(style.maskImage, /svg/, 'the motif should be the mask on the ::before');
  // Every one of these motifs is a 16px-wide vertical drawing - a reed, a
  // tail, a string of bunting. Tiled as a watermark they read as noise
  // (the swamp's reeds became a picket fence), so the emblem is drawn once
  // at its own proportions and bled off the right edge, where it closes the
  // block rather than competing with the first word of every line.
  assert.equal(style.maskRepeat, 'no-repeat', 'the motif is an emblem now, not a tiled watermark');
  assert.ok(/right|100%/.test(style.maskPosition), `and it sits on the right edge, got ${style.maskPosition}`);
  assert.ok(parseFloat(style.width) > 50, `drawn large, not as a 26px tile - got ${style.width}`);
  assert.ok(style.opacity > 0.15 && style.opacity <= 0.4, `faint but visible, got ${style.opacity}`);
  assert.ok(/rgba\(0, 0, 0, 0\)|transparent/.test(style.background), `no tinted ground behind it, got ${style.background}`);
  assert.equal(style.borderLeft, '0px', 'and no accent bar down the side');

  // The emblem is decoration, so it never takes width from the words. A
  // gutter held clear of it narrowed every consequence - worst on the
  // smallest phone, where a long one became a ladder of three-word lines.
  // The text runs over it instead.
  assert.equal(
    style.paddingRight, style.paddingLeft,
    `the text column should not be squeezed for the emblem: ${style.paddingLeft} left vs ${style.paddingRight} right`,
  );

  // Which only holds up if the words stay readable where they cross it.
  // Measured as the real blend: the emblem's colour at its own opacity
  // over the card, and the text on top of that.
  const contrast = await page.evaluate(() => {
    const el = document.querySelector('.plaza-post-text.highlight');
    const before = getComputedStyle(el, '::before');
    const rgb = (css) => css.match(/[\d.]+/g).slice(0, 3).map(Number);
    const over = (fg, bg, a) => fg.map((c, i) => c * a + bg[i] * (1 - a));
    const relLum = ([r, g, b]) => {
      const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    // The card behind it, walked up until something actually paints.
    let node = el, ground = null;
    while (node && !ground) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) ground = rgb(bg);
      node = node.parentElement;
    }
    const emblem = over(rgb(before.backgroundColor), ground, Number(before.opacity));
    const [hi, lo] = [relLum(rgb(getComputedStyle(el).color)), relLum(emblem)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });
  assert.ok(contrast >= 4.5, `text over the emblem reads at ${contrast.toFixed(2)}:1 - it has to clear 4.5`);

  await context.close();
  await api('DELETE', `/admin/plaza-posts/${post.id}`, { token: ADMIN });
});

test('a long message is set to be read, and Plaza\'s village never cuts a house in half', async () => {
  // Two decisions in one place. A highlight is set at headline size for a
  // sentence; a dedication can be a paragraph, and at that size a paragraph
  // is a wall of type to be scrolled past rather than read - so whatever
  // renders one drops it to reading size past a certain length.
  // And Plaza's emblem is a village: one house repeated down the margin,
  // with the number of houses decided by how much somebody wrote. Plaza
  // went without an emblem for a long time because a free-standing drawing
  // competes with the writing this page exists for - a repeat does not.
  // What makes the repeat safe is mask-repeat: space, which lays down only
  // whole tiles, so a house is never sliced off at the top or bottom of the
  // block. That is the property worth guarding here: repeat-y would render
  // perfectly well and quietly clip, which is exactly the bug this replaced.
  const writer = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'longdedication' } });
  const long = 'ivo, obrigada por teres feito isto tudo - a app, a casa, as noites com nome, '
    + 'e as consequencias que ninguem queria cumprir e cumpriu na mesma. foi a melhor festa '
    + 'em que estive e ainda me rio a lembrar. parabens, e obrigada por nos juntares a todos.';
  await api('PUT', '/dedications/mine', { token: writer.token, body: { text: long } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, writer.token, '/');
  await page.click('[data-tab="chat"]');
  await page.waitForSelector('.dedication-written', { timeout: WAIT_TIMEOUT });

  const written = await page.$eval('.dedication-written', (el) => {
    const cs = getComputedStyle(el);
    const before = getComputedStyle(el, '::before');
    return {
      isLong: el.classList.contains('is-long'),
      size: parseFloat(cs.fontSize),
      leading: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize),
      motif: before.maskImage || before.webkitMaskImage || 'none',
      repeat: before.maskRepeat || before.webkitMaskRepeat || '',
      // The strip's own height and the tile height, so "how many whole
      // houses fit" is measured rather than assumed from the CSS numbers.
      strip: parseFloat(before.height),
      tile: parseFloat((before.maskSize || before.webkitMaskSize || '0 0').split(' ').pop()),
      wrap: cs.overflowWrap,
    };
  });
  assert.ok(written.isLong, 'a paragraph-length dedication should be marked as long');
  assert.ok(written.size < 22, `and set smaller than a headline, got ${written.size}px`);
  assert.ok(written.leading > 1.4, `with leading opened up for reading, got ${written.leading.toFixed(2)}`);
  assert.equal(written.wrap, 'anywhere', 'an unbroken word must not push the card open');
  assert.notEqual(written.motif, 'none', 'Plaza carries a village down the margin - see the note by theme-plaza in styles.css');
  assert.match(written.repeat, /space/, 'the houses must repeat with `space`, the only value that refuses to clip a tile');
  assert.ok(written.tile > 0, `the tile height has to be a real number, got ${written.tile}`);
  const longHouses = Math.floor(written.strip / written.tile);
  assert.ok(longHouses >= 2, `a paragraph should earn more than one house, got ${longHouses}`);

  // A one-liner keeps the headline size it was designed for - and still has
  // room for one entire house. This is the assertion min-height exists for:
  // drop it and the shortest dedication silently loses its emblem, because
  // `space` would rather draw nothing than draw a house with its roof cut
  // off. Nothing else in the suite would notice.
  await api('PUT', '/dedications/mine', { token: writer.token, body: { text: 'parabens!' } });
  await page.reload();
  await page.click('[data-tab="chat"]');
  await page.waitForSelector('.dedication-written', { timeout: WAIT_TIMEOUT });
  const shortest = await page.$eval('.dedication-written', (el) => {
    const before = getComputedStyle(el, '::before');
    return {
      size: parseFloat(getComputedStyle(el).fontSize),
      strip: parseFloat(before.height),
      tile: parseFloat((before.maskSize || before.webkitMaskSize || '0 0').split(' ').pop()),
    };
  });
  assert.ok(shortest.size > 22, `a short dedication should stay at headline size, got ${shortest.size}px`);
  assert.ok(
    shortest.strip >= shortest.tile,
    `a one-line dedication must still fit a whole house: strip is ${shortest.strip}px against a ${shortest.tile}px tile`,
  );
  assert.ok(longHouses > Math.floor(shortest.strip / shortest.tile), 'the village has to grow with the writing');

  await context.close();
  await api('DELETE', `/admin/users/${writer.id}`, { token: ADMIN });
});

test('Wall opens by default and shows a posted announcement in the feed', async () => {
  const post = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'wifi: mossycottage' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');

  const plazaActive = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active'));
  assert.ok(plazaActive, 'Wall should be the tab shown right after logging in');

  await page.waitForSelector('.plaza-post-announcement', { timeout: WAIT_TIMEOUT });
  const announcementText = await page.$eval('.plaza-post-announcement .plaza-post-text', (el) => el.textContent);
  assert.equal(announcementText, 'wifi: mossycottage');

  await context.close();
  await api('DELETE', `/admin/plaza-posts/${post.id}`, { token: ADMIN });
});

test('Wall admin can pin an announcement (owner-only), and it floats to the top with a pinned badge', async () => {
  const older = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'older announcement' } });
  const newer = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'newer announcement' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="plaza"]');
  await page.waitForSelector('#plaza-posts-list .user-row', { timeout: WAIT_TIMEOUT });

  const olderRow = page.locator('#plaza-posts-list .user-row', { hasText: 'older announcement' });
  await olderRow.locator('[data-pin-post]').click();
  await page.waitForFunction(() => document.querySelectorAll('.plaza-pinned-badge').length === 1);

  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForSelector('.plaza-post-announcement.pinned', { timeout: WAIT_TIMEOUT });

  const firstPostText = await page.$eval('.plaza-post-announcement .plaza-post-text', (el) => el.textContent);
  assert.equal(firstPostText, 'older announcement', 'the pinned announcement should be first, even though it is older');

  await context.close();
  await api('DELETE', `/admin/plaza-posts/${older.id}`, { token: ADMIN });
  await api('DELETE', `/admin/plaza-posts/${newer.id}`, { token: ADMIN });
});

test('Wall admin can publish a list of links from Settings, and they open out of the app from the feed', async () => {
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Links Reader' } });

  const context = await iphoneContext('iPhone 13');
  const adminPage = await loginPage(context, ADMIN, '/settings.html');
  await adminPage.click('[data-atab="plaza"]');
  await adminPage.waitForSelector('#plaza-post-form', { timeout: WAIT_TIMEOUT });

  // Picking "links" swaps the builder over: the poll fields go away and the
  // label+URL rows appear.
  await adminPage.click('#plaza-post-type [data-post-type="links"]');
  await adminPage.waitForSelector('#plaza-link-items:not(.hidden)', { timeout: WAIT_TIMEOUT });
  assert.equal(await adminPage.isVisible('#plaza-poll-options'), false, 'poll fields belong to polls');

  await adminPage.fill('#plaza-post-text', 'useful links 🔗');
  await adminPage.fill('.plaza-link-row .plaza-link-emoji-input', '📃');
  await adminPage.fill('.plaza-link-row .plaza-link-label-input', 'Form');
  await adminPage.fill('.plaza-link-row .plaza-link-url-input', 'example.com/form');

  // "Add link" grows the list the way "add option" grows a poll.
  await adminPage.click('#plaza-add-link-btn');
  const rows = adminPage.locator('.plaza-link-row');
  await rows.nth(1).locator('.plaza-link-emoji-input').fill('🎹');
  await rows.nth(1).locator('.plaza-link-label-input').fill('Playlist');
  await rows.nth(1).locator('.plaza-link-url-input').fill('https://open.spotify.com/playlist/x');

  // Regression: this used to be type="url", and a scheme-less address like
  // the one above failed native validation - the form silently never
  // submitted, so nothing reached the server that would have added https://.
  await adminPage.click('#plaza-post-form button[type="submit"]');
  await adminPage.waitForFunction(
    () => document.getElementById('plaza-post-msg')?.textContent.trim().length > 0,
    undefined,
    { timeout: WAIT_TIMEOUT },
  );

  // The admin's own history has to show what was published, not just that
  // something was. A links post rendered its intro line and stopped, so the
  // one thing worth checking before the party - are these the right
  // addresses - was the one thing the page would not tell you. A poll has
  // listed its options here all along.
  await adminPage.waitForSelector('#plaza-posts-list .admin-post-options', { timeout: WAIT_TIMEOUT });
  const historyText = await adminPage.textContent('#plaza-posts-list');
  assert.match(historyText, /Form/, 'the history should name each link');
  assert.match(historyText, /example\.com\/form/, 'and show the address it actually points at');

  const guestPage = await loginPage(context, guest.token);
  await guestPage.waitForSelector('.plaza-post-links', { timeout: WAIT_TIMEOUT });
  // The emoji sits beside the link, not inside it: inside, the underline
  // ran under the picture too and it read as part of the address. Only the
  // words are the link.
  const links = await guestPage.$$eval('.plaza-post-links li', (els) =>
    els.map((li) => {
      const a = li.querySelector('.plaza-link');
      return {
        emoji: li.querySelector('.plaza-link-emoji')?.textContent.trim() || '',
        emojiInsideLink: !!a.querySelector('.plaza-link-emoji'),
        label: a.textContent.trim(),
        href: a.getAttribute('href'),
        target: a.getAttribute('target'),
        rel: a.getAttribute('rel') || '',
        hasArrow: !!li.querySelector('.plaza-link-arrow'),
      };
    }));
  assert.ok(links.every((l) => !l.emojiInsideLink), 'the emoji must sit outside the link, or it gets underlined too');
  assert.deepEqual(links.map((l) => l.label), ['Form', 'Playlist']);
  assert.deepEqual(links.map((l) => l.emoji), ['📃', '🎹'], 'the emoji is its own field beside the name');
  assert.ok(links.every((l) => !l.hasArrow), 'the name is what you tap, not an arrow parked at the far edge');
  assert.equal(links[0].href, 'https://example.com/form', 'the missing scheme is filled in before it is stored');
  assert.equal(links[1].href, 'https://open.spotify.com/playlist/x');
  for (const l of links) {
    assert.equal(l.target, '_blank', 'these leave the app, so they open in their own tab');
    assert.ok(l.rel.includes('noopener'), 'a new tab without noopener keeps a handle on this one');
  }

  await context.close();
});

// What is already on the Wall can be fixed. It could only be pinned or
// deleted before, so a typo in an announcement everyone had seen meant
// deleting it and publishing again - which loses the votes on a poll, and
// looks to a guest like the host changing their mind twice.
// The three Wall post types have to be tellable apart at a glance in the
// history. "links" had no colour of its own, so it fell back to the
// announcement chip and the two read as the same kind of post.
test('post, poll and link chips are three different colours, in both modes', async () => {
  const made = [];
  made.push(await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'um aviso' } }));
  made.push(await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'poll', text: 'uma pergunta?', options: ['sim', 'não'] } }));
  made.push(await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'links', text: 'uns links', links: [{ emoji: '📃', label: 'form', url: 'https://a.test/x' }] } }));

  for (const mode of ['light', 'dark']) {
    const context = await iphoneContext('iPhone 13');
    const page = await loginPage(context, ADMIN, '/settings.html');
    await page.evaluate((m) => localStorage.setItem('appivo_mode', m), mode);
    await page.reload();
    await page.waitForSelector('#admin-content:not(.hidden)', { timeout: WAIT_TIMEOUT });
    await page.click('[data-atab="plaza"]');
    await page.waitForSelector('#plaza-posts-list .badge', { timeout: WAIT_TIMEOUT });

    const colours = await page.evaluate(() => {
      const of = (cls) => {
        const el = document.querySelector(`#plaza-posts-list .badge.${cls}`);
        return el ? getComputedStyle(el).color : null;
      };
      return { post: of('type-announcement'), poll: of('type-poll'), link: of('type-links') };
    });

    for (const [kind, value] of Object.entries(colours)) {
      assert.ok(value, `no ${kind} chip on screen in ${mode} mode`);
    }
    assert.equal(
      new Set(Object.values(colours)).size,
      3,
      `the three chips should be three colours in ${mode} mode, got ${JSON.stringify(colours)}`,
    );
    await context.close();
  }

  for (const m of made) await api('DELETE', `/admin/plaza-posts/${m.id}`, { token: ADMIN });
});

test('an admin can edit a post that is already published', async () => {
  const post = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'o jantar é às 19h' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="plaza"]');
  await page.waitForSelector(`[data-edit-post="${post.id}"]`, { timeout: WAIT_TIMEOUT });

  await page.click(`[data-edit-post="${post.id}"]`);
  // The composer becomes the editor - same form, so the same rules apply.
  await page.waitForFunction(
    () => document.getElementById('plaza-post-text')?.value.includes('19h'),
    undefined,
    { timeout: WAIT_TIMEOUT },
  );
  assert.equal(await page.isVisible('#plaza-edit-cancel'), true, 'there has to be a way out of editing');

  // Editing happens at the post, not at the top of the page: the form node
  // itself is moved into the row and back (see placePlazaForm()). One form
  // doing both jobs is the point - a second, inline copy would mean a
  // second poll builder and a second validation path to keep in step.
  assert.equal(
    await page.evaluate((id) => !!document.querySelector(`[data-edit-host="${id}"] #plaza-post-form`), post.id),
    true,
    'the form should be inside the post being edited',
  );
  assert.equal(
    await page.isVisible('#plaza-compose-card'),
    false,
    'and the composer card should stand down rather than sit there empty',
  );
  assert.equal(
    await page.evaluate((id) => {
      const row = document.querySelector(`[data-edit-host="${id}"]`).closest('.user-row');
      return getComputedStyle(row.querySelector('.row-actions')).display;
    }, post.id),
    'none',
    "the row's own actions should step aside - the form has its own cancel and save",
  );

  await page.fill('#plaza-post-text', 'o jantar é às 20h');
  await page.click('#plaza-post-submit');
  await page.waitForFunction(
    () => document.getElementById('plaza-posts-list')?.textContent.includes('20h'),
    undefined,
    { timeout: WAIT_TIMEOUT },
  );

  // And the form is back to composing, not still holding the edited post.
  assert.equal(await page.inputValue('#plaza-post-text'), '', 'the form should be empty again after saving');
  assert.equal(await page.isVisible('#plaza-edit-cancel'), false, 'and out of edit mode');
  assert.equal(
    await page.evaluate(() => !!document.querySelector('#plaza-compose-card > #plaza-post-form')),
    true,
    'and back in the composer, which is where a new post is written',
  );
  assert.equal(await page.isVisible('#plaza-compose-card'), true, 'with its card back');

  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Edit Reader' } });
  const guestPage = await loginPage(context, guest.token);
  await guestPage.waitForSelector('.plaza-post-announcement', { timeout: WAIT_TIMEOUT });
  const feed = await guestPage.textContent('#plaza-feed');
  assert.match(feed, /20h/, 'the guest sees the corrected text');
  assert.doesNotMatch(feed, /19h/, 'and not the old one');

  await context.close();
  await api('DELETE', `/admin/plaza-posts/${post.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${guest.id}`, { token: ADMIN });
});

test('Wall admin can publish a poll from Settings, and a user can vote on it from the main feed', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="plaza"]');
  await page.waitForSelector('#plaza-post-form', { timeout: WAIT_TIMEOUT });

  await page.click('[data-post-type="poll"]');
  await page.fill('#plaza-poll-question', 'Where for dinner?');
  const optionInputs = page.locator('.plaza-poll-option-input');
  await optionInputs.nth(0).fill('Pizza');
  await optionInputs.nth(1).fill('Sushi');
  await page.click('#plaza-post-form button[type="submit"]');
  await page.waitForSelector('#plaza-posts-list .user-row', { timeout: WAIT_TIMEOUT });

  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForSelector('.plaza-post-poll', { timeout: WAIT_TIMEOUT });

  const questionText = await page.$eval('.plaza-post-poll .plaza-post-text', (el) => el.textContent);
  assert.equal(questionText, 'Where for dinner?');

  // There is no separate "votar" button any more: tapping an option asks for
  // confirmation, and declining must leave the poll untouched.
  assert.equal(await page.locator('.plaza-poll-submit').count(), 0, 'the separate vote button should be gone');

  await page.click('.plaza-poll-option:has-text("Pizza")');
  await page.waitForSelector('.modal-actions', { timeout: WAIT_TIMEOUT });
  await page.click('.modal-actions button.ghost');
  await page.waitForSelector('.modal-actions', { state: 'hidden', timeout: WAIT_TIMEOUT });
  assert.equal(await page.locator('.plaza-poll-option.voted').count(), 0, 'declining the confirm must not cast a vote');

  await page.click('.plaza-poll-option:has-text("Pizza")');
  await page.waitForSelector('.modal-actions', { timeout: WAIT_TIMEOUT });
  await page.click('.modal-actions button:not(.ghost)');
  await page.waitForFunction(() => document.querySelector('.plaza-poll-option.voted')?.textContent.includes('Pizza'));
  const pizzaPct = await page.$eval('.plaza-poll-option.voted .plaza-poll-option-pct', (el) => el.textContent);
  assert.equal(pizzaPct, '100%');

  await context.close();
  const { posts } = await api('GET', '/plaza-posts', { token: ADMIN });
  const created = posts.find((p) => p.text === 'Where for dinner?');
  await api('DELETE', `/admin/plaza-posts/${created.id}`, { token: ADMIN });
});

/* --------------------- Role badge colors (regression) --------------------- */
// owner / admin / user must each render in a visually distinct color.

test('owner, admin and user role badges each render in a distinct color', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'plainuser' } });
  const toPromote = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'futureadmin' } });
  await api('PATCH', `/admin/users/${toPromote.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  const colorOf = (sel) => page.$eval(sel, (el) => getComputedStyle(el).borderColor);
  const ownerColor = await colorOf('.badge.role-owner');
  const adminColor = await colorOf('.badge.role-admin');
  const userColor = await colorOf('.badge.role-user');

  assert.notEqual(ownerColor, adminColor, 'owner and admin badges have the same color');
  assert.notEqual(ownerColor, userColor, 'owner and user badges have the same color');
  assert.notEqual(adminColor, userColor, 'admin and user badges have the same color');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
  await api('PATCH', `/admin/users/${toPromote.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${toPromote.id}`, { token: ADMIN });
});

// The role button used to draw what the person already WAS - a shield on
// someone who was already an admin - while its label said what pressing it
// would do ("make guest"). So the shield sat on exactly the rows where
// pressing it took admin away, and every other action in that row (the key
// regenerates, the cross removes) reads as its own outcome. Icon and label
// now agree: whatever the row shows is what you get.
test('the role button draws the role it hands out, not the one the person already has', async () => {
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Icon Guest' } });
  const admin = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Icon Admin' } });
  await api('PATCH', `/admin/users/${admin.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  // The two drawings are told apart by shape rather than by any class:
  // roleUser is a head-and-shoulders (it has a <circle>), roleAdmin is a
  // single shield path. Reading the rendered SVG is the point - a test that
  // only checked the label would have passed happily all along.
  const roleButton = (id) => page.$eval(`[data-toggle-admin="${id}"]`, (el) => ({
    label: el.getAttribute('aria-label'),
    next: el.getAttribute('data-next'),
    hasCircle: !!el.querySelector('circle'),
  }));

  const onGuest = await roleButton(guest.id);
  assert.equal(onGuest.next, '1', 'the button on a guest should promote');
  assert.equal(onGuest.hasCircle, false,
    `a guest's row should offer the shield, since pressing it hands out admin (label: "${onGuest.label}")`);

  const onAdmin = await roleButton(admin.id);
  assert.equal(onAdmin.next, '0', 'the button on an admin should demote');
  assert.equal(onAdmin.hasCircle, true,
    `an admin's row should offer the plain person, since pressing it takes admin away (label: "${onAdmin.label}")`);

  // The labels were always right; this pins them to the drawing beside them
  // so the two cannot drift apart again.
  assert.notEqual(onGuest.label, onAdmin.label, 'the two buttons should not read the same');

  await context.close();
  await api('PATCH', `/admin/users/${admin.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${admin.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${guest.id}`, { token: ADMIN });
});

test('Manage Users: a freshly created user floats to the top of this session\'s list, even though the base order is alphabetical', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  await page.fill('#people-search', 'Zzz Session Tester');
  await page.click('#user-create-btn');
  const alertOk = page.locator('.modal-actions button');
  await alertOk.first().waitFor({ timeout: WAIT_TIMEOUT });
  await alertOk.first().click();
  await page.waitForTimeout(300);

  const names = await page.$$eval('.user-row-name-text', (els) => els.map((e) => e.textContent.trim()));
  // "Zzz Session Tester" sorts last alphabetically, so finding it right
  // after the owner (index 1) proves the session-local recency float is
  // actually happening, not just alphabetical order.
  assert.equal(names[1], 'Zzz Session Tester', 'the just-created user should be pinned near the top this session');

  await context.close();
  const created = await api('GET', '/admin/users', { token: ADMIN });
  const tester = created.find((u) => u.name === 'Zzz Session Tester');
  await api('DELETE', `/admin/users/${tester.id}`, { token: ADMIN });
});

test('clicking a user\'s name renames it in place - no separate rename button', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Original Name' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  // Anchor on the token div, not the name span - the span itself gets
  // replaced by an <input> once editing starts, so a locator keyed off
  // its text would stop matching the row mid-interaction.
  const row = page.locator('.user-row', { has: page.locator(`[data-token="${created.token}"]`) });
  await row.locator('.user-row-name-text').click();
  await row.locator('input.user-row-name-text').fill('Renamed Via Click');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  const names = await page.$$eval('.user-row-name-text', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(names.includes('Renamed Via Click'), 'clicking the name should have opened an editable field that saved on Enter');
  assert.ok(!names.includes('Original Name'), 'the old name should be gone once renamed');

  const renameButtons = await page.locator('.row-actions button', { hasText: /renom|rename/i }).count();
  assert.equal(renameButtons, 0, 'rename should no longer be a separate button in the row actions');

  await context.close();
  const updated = await api('GET', '/admin/users', { token: ADMIN });
  const renamed = updated.find((u) => u.name === 'Renamed Via Click');
  await api('DELETE', `/admin/users/${renamed.id}`, { token: ADMIN });
});

test('user search ignores accents - "cesar" finds "César"', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'César Session Search' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  await page.fill('#people-search', 'cesar session');
  await page.waitForTimeout(200);
  const names = await page.$$eval('.user-row-name-text', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(names.includes('César Session Search'), 'plain-ASCII "cesar" should match the accented name');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

// "Pending" once chased contrast on its own - a bright yellow ground under
// dark ink while its three neighbours were dark grounds under paper ink -
// which read as one chip inverted rather than one chip yellow. None of the
// four clears AA against paper ink (3.70-4.38:1), so contrast was never what
// told them apart; matching construction is the whole job.
test('the four rata status pills are built the same way - filled in their own colour, one shared ink', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  // Wait on the panel, not the pills: the pills are in the raw HTML from the
  // first byte, so waiting on them races the tab actually being switched to
  // and only shows up as flakiness under a loaded suite.
  await page.waitForSelector('[data-atab="rata"]', { timeout: WAIT_TIMEOUT });
  await page.click('[data-atab="rata"]');
  await page.waitForSelector('#rata-status-filter:visible', { timeout: WAIT_TIMEOUT });

  const pills = await page.$$eval('#rata-status-filter .role-pill[data-status].active', (els) => els.map((el) => {
    const cs = getComputedStyle(el);
    return { status: el.dataset.status, bg: cs.backgroundColor, ink: cs.color };
  }));
  assert.equal(pills.length, 4, 'fila / atribuir / pendente / feita');

  const inks = new Set(pills.map((p) => p.ink));
  assert.equal(inks.size, 1, `every filled status pill takes the same ink, got ${[...inks].join(', ')}`);

  // Each is filled with something of its own, and none of them is the
  // transparent ground an outline pill would report.
  const grounds = new Set(pills.map((p) => p.bg));
  assert.equal(grounds.size, 4, 'four states, four distinguishable grounds');
  for (const p of pills) {
    assert.ok(!/rgba\(0, 0, 0, 0\)/.test(p.bg), `"${p.status}" should be a filled pill, not an outline`);
  }

  await context.close();
});

test('Manage Users role filter: owner/admin/user pills are cumulative (OR), not exclusive', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Role Filter Test User' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  // All three start lit, matching the full list shown underneath them.
  const startAllLit = await page.$$eval('#user-role-filter .role-pill',
    (els) => els.every((e) => e.classList.contains('active')));
  assert.ok(startAllLit, 'every pill should start selected, since the list starts unfiltered');

  // Turning two off leaves just the owner - deselecting narrows.
  await page.click('#user-role-filter [data-role="admin"]');
  await page.click('#user-role-filter [data-role="user"]');
  await page.waitForTimeout(200);
  const owners = await page.$$eval('#users-list .badge', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(owners, ['owner'], 'leaving only "owner" lit should show only the owner row');

  // Adding "user" back on top of "owner" should widen the view (OR), not
  // replace it - both pills stay active, and both roles show up.
  await page.click('#user-role-filter [data-role="user"]');
  await page.waitForTimeout(200);
  const ownerStillActive = await page.$eval('#user-role-filter [data-role="owner"]', (el) => el.classList.contains('active'));
  const userNowActive = await page.$eval('#user-role-filter [data-role="user"]', (el) => el.classList.contains('active'));
  assert.ok(ownerStillActive && userNowActive, 'picking a second role should add to the filter, not replace it');
  const userRows = await page.$$eval('#users-list .user-row-name-text', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(userRows.includes('Role Filter Test User'), 'owner+user filter should include the plain user just created');
  assert.ok(userRows.includes('UI Test Admin'), 'owner+user filter should still include the owner');
  const badgesOwnerUser = await page.$$eval('#users-list .badge', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(!badgesOwnerUser.includes('admin'), 'owner+user filter should exclude admins');

  // All three selected shows everyone - not an empty/narrow result from
  // ANDing three mutually-exclusive roles together.
  await page.click('#user-role-filter [data-role="admin"]');
  await page.waitForTimeout(200);
  const allThreeRows = await page.$$('#users-list .user-row');
  const unfiltered = await api('GET', '/admin/users', { token: ADMIN });
  assert.equal(allThreeRows.length, unfiltered.length, 'owner+admin+user selected together should match the unfiltered count');

  // Turning every pill off would leave nothing to show, so it snaps back to
  // all-on rather than an empty list.
  for (const r of ['owner', 'admin', 'user']) await page.click(`#user-role-filter [data-role="${r}"]`);
  await page.waitForTimeout(200);
  const backToAll = await page.$$eval('#user-role-filter .role-pill',
    (els) => els.every((e) => e.classList.contains('active')));
  assert.ok(backToAll, 'deselecting the last pill should relight them all');
  assert.equal((await page.$$('#users-list .user-row')).length, unfiltered.length, 'and show everyone again');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

/* --------------- Manage Users key layout (regression) --------------- */

// Regression: which rows were open lived only in the DOM, so every render
// of the list - a poll tick, a role change, a keystroke in the search box -
// collapsed all of them. On screen that is the key you were copying
// vanishing on its own. It was also the suite's flakiest test by a distance
// (this one, below): the click landed, a reload rebuilt the list, and the
// row it had just opened was shut again before anything could read it.
test('an expanded user row stays open when the list re-renders under it', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  // The chevron, for the same reason as the test below: a click landing on
  // the name starts a rename instead of expanding.
  await page.locator('#users-list .user-row-chevron').first().click();
  await page.waitForSelector('#users-list .user-row-details:not(.hidden)', { timeout: WAIT_TIMEOUT });

  // Exactly what a poll tick does - rebuild the list from the same data.
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.locator('#people-search').fill('');
  await page.waitForTimeout(400);

  assert.equal(
    await page.isVisible('#users-list .user-row-details:not(.hidden)'),
    true,
    'the row you opened has to still be open after the list redraws',
  );
  assert.equal(
    await page.getAttribute('#users-list [data-row-toggle]', 'aria-expanded'),
    'true',
    'and it has to say so, for anyone not looking at the screen',
  );
  await context.close();
});

test('Manage Users row keeps the access key visible with no overflow, once expanded', async () => {
  const context = await iphoneContext('iPhone SE');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  // Rows are collapsed to just name+role by default (see renderUsersList()
  // in settings.js) - the key only renders once its row is expanded.
  //
  // The measurement is scoped to the row that is actually open, not to the
  // first .user-row-token in the document. Those are not the same element:
  // the list sorts recently-touched accounts to the top, so a reload landing
  // between the click and the read could put a different, collapsed row
  // first - and a collapsed row's key measures zero wide. That is what made
  // this the suite's most frequent intermittent failure. Rows staying open
  // across a re-render at all is the separate fix above.
  // The chevron, not the middle of the row: tapping the name is how a
  // rename starts (see the rename test below), so the toggle handler
  // deliberately ignores clicks that land on it. Playwright clicks an
  // element's centre, and whether that centre falls on the name or beside
  // it depends on how long the name happens to be - which is what made
  // this test look flaky for so long. The chevron means one thing only.
  const firstRow = page.locator('#users-list .user-row-chevron').first();
  await firstRow.click();
  const openKey = page.locator('#users-list .user-row-details:not(.hidden) .user-row-token').first();
  await openKey.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT }).catch(async (err) => {
    const state = await page.evaluate(() => ({
      rows: document.querySelectorAll('#users-list .user-row').length,
      toggles: document.querySelectorAll('#users-list [data-row-toggle]').length,
      expanded: document.querySelectorAll('#users-list .user-row-details:not(.hidden)').length,
      ariaOpen: [...document.querySelectorAll('#users-list [data-row-toggle]')]
        .filter((r) => r.getAttribute('aria-expanded') === 'true').length,
      tokenBoxes: [...document.querySelectorAll('#users-list .user-row-details:not(.hidden) .user-row-token')]
        .map((el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }),
    }));
    throw new Error(`${err.message}\n  state: ${JSON.stringify(state)}`);
  });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.user-row-details:not(.hidden) .user-row-token');
      return !!el && el.getBoundingClientRect().width > 0;
    },
    null,
    { timeout: WAIT_TIMEOUT },
  );

  const overflow = await horizontalOverflow(page);
  assert.ok(overflow <= 1, `Manage Users overflows by ${overflow}px with the key inline`);
  await context.close();
});

test('access keys are censored by default, reveal on click, and copy automatically at the same time', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  // Spy on the clipboard instead of relying on real OS clipboard access,
  // which needs permissions that aren't reliably grantable in WebKit.
  await page.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve(); };
  });

  // Rows are collapsed to just name+role by default - expand it first, the
  // key itself lives in the hidden details section until then.
  await page.click('#users-list [data-row-toggle]');
  const tokenEl = await page.$('.user-row-token');
  const realToken = await tokenEl.getAttribute('data-token');
  const shownBefore = await tokenEl.textContent();
  assert.notEqual(shownBefore, realToken, 'access key should be censored by default');
  assert.match(shownBefore, /^•+$/, 'censored key should render as dots');

  await tokenEl.click();
  await page.waitForTimeout(50);
  const shownAfter = await tokenEl.textContent();
  assert.equal(shownAfter, realToken, 'clicking the censored key should reveal the real value');
  const copiedOnReveal = await page.evaluate(() => window.__copied);
  assert.equal(copiedOnReveal, realToken, 'clicking to reveal should also copy the real key automatically');

  await tokenEl.click();
  const shownHiddenAgain = await tokenEl.textContent();
  assert.match(shownHiddenAgain, /^•+$/, 'clicking again should re-censor it');

  await context.close();
});

// Regression: renderAccountCard() only ran once at boot, so the "A tua
// conta" card kept showing/copying the OLD key after a self-service
// change via the change-key form - one that no longer even worked to log
// in - until a full page reload synced it back up.
test('the account card\'s key updates immediately after a self-service key change', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'accountcardtest' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, created.token, '/settings.html');

  const tokenEl = page.locator('#account-token');
  await tokenEl.click();
  await page.waitForTimeout(50);
  const shownOld = await tokenEl.textContent();
  assert.equal(shownOld, created.token, 'account card should reveal the current real key on click');

  const newKey = 'freshkey789';
  await page.fill('#current-key-input', created.token);
  await page.fill('#new-key-input', newKey);
  await page.click('#change-key-form button[type="submit"]');
  await page.waitForSelector('#change-key-msg:not(:empty)', { timeout: WAIT_TIMEOUT });

  await tokenEl.click(); // re-censor
  await page.waitForTimeout(50);
  await tokenEl.click(); // reveal again
  await page.waitForTimeout(50);
  const shownNew = await tokenEl.textContent();
  assert.equal(shownNew, newKey, 'account card should reflect the new key without a page reload');

  await context.close();
  const updated = await api('GET', '/admin/users', { token: ADMIN });
  const tester = updated.find((u) => u.name === 'accountcardtest');
  await api('DELETE', `/admin/users/${tester.id}`, { token: ADMIN });
});

test('changing your own key updates Manage Users too, not just the account card', async () => {
  // The two places that show a key disagreed after a self-service change:
  // the account card was patched in place, the list below it was not asked
  // for again, so it went on listing a key that no longer worked.
  const restoreKey = 'ownerkeyrestored1';
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  const ownerRowKey = async () => page.$eval(
    '#users-list .user-row',
    (row) => row.querySelector('[data-token]')?.dataset.token,
  );
  assert.equal(await ownerRowKey(), ADMIN, 'the owner is the first row, showing their current key');

  try {
    await page.fill('#current-key-input', ADMIN);
    await page.fill('#new-key-input', restoreKey);
    await page.click('#change-key-form button[type="submit"]');
    await page.waitForSelector('#change-key-msg:not(:empty)', { timeout: WAIT_TIMEOUT });

    await page.waitForFunction(
      (expected) => document.querySelector('#users-list .user-row [data-token]')?.dataset.token === expected,
      restoreKey,
      { timeout: WAIT_TIMEOUT },
    );
    assert.equal(
      await page.$eval('#account-token', (el) => el.dataset.token),
      restoreKey,
      'and the account card agrees with it',
    );
  } finally {
    // Every other test in this file authenticates as ADMIN - put it back
    // even if the assertions above never got there.
    await api('POST', '/me/change-token', {
      token: restoreKey,
      body: { currentToken: restoreKey, newToken: ADMIN },
    }).catch(() => {});
    await context.close();
  }
});

test('a row action is an icon, and every one of them still says what it does', async () => {
  // Row actions carried three words each at 0.16em tracking, which wrapped
  // the row onto a second line on an iPhone SE and stopped the actions
  // lining up down a list. They are squares now - which only works if
  // dropping the word did not drop the name with it, so every icon button
  // has to carry an accessible one, and clear the 44px touch minimum.
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'aviso com ações' } });

  const context = await iphoneContext('iPhone SE');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="plaza"]');
  await page.waitForSelector('#plaza-posts-list .icon-action', { timeout: WAIT_TIMEOUT });

  const actions = await page.$$eval('.icon-action', (els) => els.map((el) => ({
    label: el.getAttribute('aria-label'),
    title: el.getAttribute('title'),
    text: el.textContent.trim(),
    hasSvg: !!el.querySelector('svg'),
    w: el.getBoundingClientRect().width,
    h: el.getBoundingClientRect().height,
  })));
  assert.ok(actions.length >= 3, `expected the post's row actions, found ${actions.length}`);

  for (const a of actions) {
    assert.ok(a.hasSvg, 'an icon action with no icon in it');
    assert.equal(a.text, '', `"${a.label}" still has a word in it - it should be icon only`);
    assert.ok(a.label && a.label.length > 0, 'an icon action with no accessible name');
    assert.equal(a.title, a.label, `the tooltip and the accessible name should agree, got "${a.title}" and "${a.label}"`);
  }

  // Size only for the ones actually on screen - a collapsed Manage Users
  // row keeps its actions in the DOM at 0x0 until it is opened.
  const onScreen = actions.filter((a) => a.w > 0);
  assert.ok(onScreen.length >= 3, `expected the post's three actions visible, found ${onScreen.length}`);
  for (const a of onScreen) {
    assert.ok(a.w >= 44 && a.h >= 44, `${a.label} is ${a.w}x${a.h} - under the 44px touch minimum`);
  }

  // The row fits on one line on the smallest phone, which was the point.
  const rowLines = await page.$eval('#plaza-posts-list .row-actions', (row) => {
    const tops = [...row.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top));
    return new Set(tops).size;
  });
  assert.equal(rowLines, 1, 'the actions should sit on one line, not wrap');

  await context.close();
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
});

test('the topbar icons carry no box, and the tab row no rule', async () => {
  // Ivo's call, both of them. Two things the old chrome was doing quietly
  // have to survive it: the touch target (the boxes were 38px, under the
  // minimum, which nobody noticed while there was a border to aim at) and
  // the bell's "off" signal, which was a tinted ground and is now colour.
  const context = await iphoneContext('iPhone SE');
  const page = await loginPage(context, ADMIN, '/');

  const buttons = await page.$$eval('.topbar-actions > *', (els) => els.map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { id: el.id || el.tagName, border: cs.borderBottomStyle, bg: cs.backgroundColor, w: r.width, h: r.height };
  }));
  assert.ok(buttons.length >= 3, `expected the topbar controls, found ${buttons.length}`);
  for (const b of buttons) {
    assert.equal(b.border, 'none', `${b.id} still has a box around it`);
    assert.match(b.bg, /rgba\(0, 0, 0, 0\)|transparent/, `${b.id} still has a filled ground`);
    assert.ok(b.w >= 44 && b.h >= 44, `${b.id} is ${b.w}x${b.h} - under the 44px touch minimum`);
  }

  // The bell says "off" in colour rather than in a tinted box.
  const bell = await page.$eval('#notif-btn', (el) => ({
    active: el.classList.contains('active'),
    color: getComputedStyle(el).color,
  }));
  const plainColour = await page.$eval('#theme-toggle', (el) => getComputedStyle(el).color);
  if (!bell.active) {
    assert.notEqual(bell.color, plainColour, 'a bell that is off has to stand out from the other icons somehow');
  }

  // The tab row: no rule under it, and the selected tab marked by colour
  // and weight rather than by a line.
  assert.equal(
    await page.$eval('.tabs', (el) => getComputedStyle(el).borderBottomStyle),
    'none',
    'the tab row should carry no baseline',
  );
  const tabs = await page.evaluate(() => {
    const on = document.querySelector('.tab.active');
    const off = document.querySelector('.tab:not(.active):not(.hidden)');
    const read = (el) => ({
      colour: getComputedStyle(el).color,
      weight: getComputedStyle(el).fontWeight,
      marker: getComputedStyle(el).borderBottomColor,
    });
    return { on: read(on), off: read(off) };
  });
  assert.notEqual(tabs.on.colour, tabs.off.colour, 'the selected tab has to differ in colour');
  assert.notEqual(tabs.on.weight, tabs.off.weight, 'and in weight');
  assert.match(tabs.on.marker, /rgba\(0, 0, 0, 0\)|transparent/, 'the underline marker should be gone');

  // The header still separates itself from the app below it.
  assert.equal(
    await page.$eval('.topbar', (el) => getComputedStyle(el).borderBottomStyle),
    'solid',
    'the topbar keeps its own rule - that one separates the header, it marks nothing',
  );

  await context.close();
});

test('a consequence waiting to be assigned sits above the whole history', async () => {
  // The list is the running history, but it is also the owner's to-do. A
  // revealed consequence with nobody on it needs them; sorted purely by
  // last-touched it slid under rows that had been dealt with since. It is
  // held at the top until it is assigned, and then rejoins the timeline by
  // its own timestamp - which by then is the assignment.
  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'assignorder' } });
  const holder = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'assignholder' } });

  // One revealed and left unassigned...
  await api('POST', '/consequences', { token: poster.token, body: { text: 'a que precisa de dono' } });
  const first = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  // ...then a second one revealed and assigned, so it is the more recently
  // touched of the two and would otherwise sort above.
  await api('POST', '/consequences', { token: holder.token, body: { text: 'a que ja tem dono' } });
  const second = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  await api('PATCH', `/admin/consequences/${second.revealed.id}/assign`, {
    token: ADMIN, body: { userId: holder.id },
  });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="rata"]');
  await page.waitForSelector('#consequences-table .rata-history-item', { timeout: WAIT_TIMEOUT });

  const firstRowText = await page.$eval('#consequences-table .rata-history-item', (el) => el.textContent);
  assert.match(
    firstRowText,
    /precisa de dono/,
    'the one still needing an assignment has to be the first thing the owner sees',
  );

  await context.close();
  await api('DELETE', `/admin/users/${poster.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${holder.id}`, { token: ADMIN });
});

test('revealing a consequence asks first, and declining leaves the queue alone', async () => {
  // It draws for real, pushes to all fifty guests and cannot be undone -
  // the same bar as the Memo trigger, which has confirmed from the start.
  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'revealconfirm' } });
  await api('POST', '/consequences', { token: poster.token, body: { text: 'uma consequência à espera' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="rata"]');
  await page.waitForSelector('[data-reveal-next]', { timeout: WAIT_TIMEOUT });

  const before = await api('GET', '/admin/consequences', { token: ADMIN });
  const pendingBefore = before.filter((c) => c.status !== 'used').length;

  await page.click('[data-reveal-next]');
  await page.waitForSelector('.modal-overlay:not(.hidden) .modal-actions', { timeout: WAIT_TIMEOUT });
  await page.click('.modal-actions button.ghost');
  await page.waitForTimeout(300);

  const after = await api('GET', '/admin/consequences', { token: ADMIN });
  assert.equal(
    after.filter((c) => c.status !== 'used').length,
    pendingBefore,
    'saying no to the confirmation must not have revealed anything',
  );

  await context.close();
  await api('DELETE', `/admin/users/${poster.id}`, { token: ADMIN });
});

test('the lead action of a card is its own artwork, and still has a name', async () => {
  // The rata's paw and Memo's shutter, in place of a worded button. Same
  // rule as every other icon: dropping the word must not drop the name.
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');

  for (const [tab, selector] of [['rata', '[data-reveal-next]'], ['memo', '#memo-trigger-btn']]) {
    await page.click(`[data-atab="${tab}"]`);
    await page.waitForSelector(selector, { timeout: WAIT_TIMEOUT });
    const lead = await page.$eval(selector, (el) => ({
      text: el.textContent.trim(),
      label: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      hasSvg: !!el.querySelector('svg'),
      w: el.getBoundingClientRect().width,
      border: getComputedStyle(el).borderTopStyle,
      bg: getComputedStyle(el).backgroundColor,
    }));
    assert.ok(lead.hasSvg, `${tab}'s lead button has no artwork in it`);
    assert.equal(lead.text, '', `${tab}'s lead button still carries a word`);
    assert.ok(lead.label, `${tab}'s lead button has no accessible name`);
    assert.equal(lead.title, lead.label, `${tab}: tooltip and accessible name should agree`);
    assert.ok(lead.w >= 44, `${tab}'s lead button is ${lead.w}px wide`);
    // No box around it - Ivo's call. The drawing is the button, which only
    // works while it is drawn big enough to be one.
    assert.equal(lead.border, 'none', `${tab}'s lead button should carry no box`);
    assert.match(lead.bg, /rgba\(0, 0, 0, 0\)|transparent/, `${tab}'s lead button should have no ground`);
  }

  await context.close();
});

test('switching the last Rata tag off brings them all back, never an empty list', async () => {
  // Ivo, from real use: "filter tag from rata always a tag should be
  // selected like history in wall". Turning every tag off left the table
  // blank, which reads as "there are no consequences" rather than "you have
  // hidden them", and with nothing on screen the way back is not obvious.
  // The Wall history filter already refills itself; this now matches.
  await api('POST', '/consequences', { token: ADMIN, body: { text: 'uma consequencia para filtrar' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="rata"]');
  await waitOrExplain(page, '#rata-status-filter .role-pill');

  const activeCount = () => page.$$eval('#rata-status-filter .role-pill.active', (els) => els.length);
  const startedWith = await activeCount();
  assert.ok(startedWith > 0, 'the filter starts with tags on');

  // Turn every one of them off.
  const pills = await page.$$('#rata-status-filter .role-pill');
  for (const pill of pills) await pill.click();

  // The last tap must not leave nothing selected.
  assert.equal(
    await activeCount(), pills.length,
    'switching the last tag off has to bring them all back, not leave the list empty',
  );

  await context.close();
});

test('a filter chip cannot keep its hover look after a tap on a phone', async () => {
  // iOS applies :hover on tap and leaves it applied until you touch
  // something else, so a chip switched off went on wearing the "on" look
  // under your thumb - which is what made deselecting look broken. The
  // hover rules are behind (hover: hover), which a touch device never
  // matches.
  // The chip row only exists once the history holds more than one kind of
  // post - a filter that cannot filter anything is hidden on purpose.
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'aviso' } });
  await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'poll', text: 'que noite?', options: ['furnished', 'swamp'] },
  });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');

  assert.equal(
    await page.evaluate(() => matchMedia('(hover: hover)').matches),
    false,
    'a phone should not report a hovering pointer',
  );

  // Asked of the CSSOM rather than of the stylesheet text: what matters is
  // that the rule ended up inside a hover media block, not how it is typed.
  const guarded = await page.evaluate(() => {
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules) {
          const found = walk(rule.cssRules);
          if (found) return found;
        }
        if (rule.selectorText === 'button:hover, .btn:hover') {
          return { media: rule.parentRule?.conditionText ?? null };
        }
      }
      return null;
    };
    for (const sheet of document.styleSheets) {
      try {
        const hit = walk(sheet.cssRules);
        if (hit) return hit;
      } catch { /* cross-origin sheet (the font CDN) - not ours */ }
    }
    return null;
  });
  assert.ok(guarded, 'the generic button hover rule went missing');
  assert.match(
    guarded.media ?? '',
    /hover:\s*hover/,
    `the generic button hover rule has to sit inside a (hover: hover) block, found ${guarded.media}`,
  );

  await page.click('[data-atab="plaza"]');
  await page.waitForSelector('#plaza-type-filter .role-pill', { timeout: WAIT_TIMEOUT });
  const before = await page.$eval('#plaza-type-filter .role-pill', (el) => getComputedStyle(el).color);
  await page.hover('#plaza-type-filter .role-pill');
  await page.waitForTimeout(150);
  const after = await page.$eval('#plaza-type-filter .role-pill', (el) => getComputedStyle(el).color);
  assert.equal(after, before, 'a chip must look the same whether or not a pointer is over it');

  await context.close();
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
});

test('a long address in the Wall history never spills out of its card', async () => {
  // The seeded links were shortener URLs a few characters long until they
  // were replaced with the real destinations, which run past a hundred
  // characters and ran straight out of the card. Nobody reads a URL in this
  // list - the label identifies the row - so it is held to one line and
  // cut.
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: {
      type: 'links',
      text: 'useful links',
      links: [{
        emoji: '📃',
        label: 'form',
        url: 'https://www.google.com/forms/about/',
      }],
    },
  });

  const context = await iphoneContext('iPhone SE');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="plaza"]');
  await page.waitForSelector('#plaza-posts-list .admin-post-options li', { timeout: WAIT_TIMEOUT });

  const spill = await page.$eval('#plaza-posts-list', (el) => el.scrollWidth - el.clientWidth);
  assert.ok(spill <= 0, `the history overflows its card by ${spill}px`);

  const row = await page.$eval('#plaza-posts-list .admin-post-options li', (li) => {
    const url = li.querySelector('.muted');
    return {
      lines: Math.round(li.getBoundingClientRect().height / parseFloat(getComputedStyle(li).fontSize)),
      clipped: url.scrollWidth > url.clientWidth,
      wrap: getComputedStyle(url).whiteSpace,
    };
  });
  assert.equal(row.wrap, 'nowrap', 'the address should stay on one line');
  assert.ok(row.clipped, 'and be cut when it does not fit, rather than wrapping');

  await context.close();
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
});

test('the Wall history can be filtered down to one kind of post', async () => {
  // By the party this list is the whole Wall in one column. Same pills as
  // Manage Users' roles, and the same rule: cumulative, and switching the
  // last one off means "show everything" rather than showing nothing.
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'aviso da casa' } });
  await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'poll', text: 'que noite preferes?', options: ['furnished', 'swamp'] },
  });
  await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'links', text: 'onde e', links: [{ emoji: '📍', label: 'mapa', url: 'https://maps.example' }] },
  });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="plaza"]');
  await page.waitForSelector('#plaza-posts-list .user-row', { timeout: WAIT_TIMEOUT });

  const rows = () => page.$$eval('#plaza-posts-list .user-row', (els) => els.length);
  const chips = () => page.$$eval('#plaza-type-filter .role-pill', (els) => els.map((e) => e.dataset.postType));
  assert.deepEqual(await chips(), ['announcement', 'poll', 'links'], 'one chip per kind of post on the Wall');
  assert.equal(await rows(), 3, 'everything shows before anything is filtered');

  // Switch two off, leaving polls.
  await page.click('#plaza-type-filter [data-post-type="announcement"]');
  await page.click('#plaza-type-filter [data-post-type="links"]');
  await page.waitForTimeout(200);
  assert.equal(await rows(), 1, 'only the poll should be left');
  assert.equal(
    await page.$eval('#plaza-posts-list .user-row .badge', (el) => el.className.includes('type-poll')),
    true,
    'and the one left is the poll',
  );

  // Switching the last one off would leave an empty list - it means "all".
  await page.click('#plaza-type-filter [data-post-type="poll"]');
  await page.waitForTimeout(200);
  assert.equal(await rows(), 3, 'no chip selected shows everything, never nothing');

  await context.close();
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
});

/* -------------- Golden rule: non-owner admin UI (regression) ------------- */

test('a non-owner admin gets voting control, reveal-consequence, and a self-only Users view', async () => {
  const promoted = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'nonowneradmin' } });
  await api('PATCH', `/admin/users/${promoted.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, promoted.token, '/settings.html');

  // Manage Users is owner-only - a regular admin's own row is all the API
  // would ever return them anyway (see GET /admin/users), with no actions
  // on it either, so it would just be a read-only duplicate of the account
  // card already at the top of this page. Whole section hidden instead.
  await page.waitForSelector('#admin-content:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('[data-atab="settings"]');
  await page.waitForTimeout(300);
  const usersManagementHidden = await page.$eval('#users-management', (el) => el.classList.contains('hidden'));
  assert.ok(usersManagementHidden, 'non-owner admin should not see Manage Users at all - it would just duplicate the account card');

  // The Plaza (pseudonym-unmasking) admin tab - internal id "wall", see
  // tab_chat in i18n.js - isn't a normal tab bar entry for anyone anymore,
  // owner included (see the star trigger below); a non-owner admin
  // shouldn't even get the star that unlocks it.
  const wallTabHidden = await page.$eval('[data-atab="wall"]', (el) => el.classList.contains('hidden'));
  assert.ok(wallTabHidden, 'the Plaza admin tab is never a normal nav entry');
  const secretBtnHiddenForAdmin = await page.$eval('#wall-secret-btn', (el) => el.classList.contains('hidden'));
  assert.ok(secretBtnHiddenForAdmin, 'a non-owner admin should not see the star that unlocks the Plaza admin tab');

  const plazaTabHidden = await page.$eval('[data-atab="plaza"]', (el) => el.classList.contains('hidden'));
  assert.ok(!plazaTabHidden, 'non-owner admin can also post to the Wall now');

  // Voting control (Best Look) and reveal-consequence (A Rata) stay available.
  await page.click('[data-atab="outfit"]');
  const votingControlsVisible = await page.$eval('#voting-advance-btn', (el) => el.getBoundingClientRect().width > 0);
  assert.ok(votingControlsVisible, 'non-owner admin should still see Best Look voting control');

  await page.waitForTimeout(300);
  const voterLogHidden = await page.$eval('#voter-log-card', (el) => el.classList.contains('hidden'));
  assert.ok(voterLogHidden, 'non-owner admin must not see the who-voted-for-whom card');

  await page.click('[data-atab="rata"]');
  // Lives in one of two spots depending on state - the standalone slot
  // (nothing revealed yet) or inside the current card (once something is)
  // - so check whichever one is actually visible right now.
  const revealBtnVisible = await page.$$eval('[data-reveal-next]', (els) => els.some((el) => el.getBoundingClientRect().width > 0));
  assert.ok(revealBtnVisible, 'non-owner admin should still see the reveal-consequence button');

  await context.close();
  await api('PATCH', `/admin/users/${promoted.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${promoted.id}`, { token: ADMIN });
});

test('the owner sees the near-invisible star on the Memo admin tab, and it opens the Plaza admin tab', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');

  await page.click('[data-atab="memo"]');
  await page.waitForSelector('#wall-secret-btn:not(.hidden)', { timeout: WAIT_TIMEOUT });

  await page.click('#wall-secret-btn');
  await page.waitForSelector('#atab-wall:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const wallTabStillHidden = await page.$eval('[data-atab="wall"]', (el) => el.classList.contains('hidden'));
  assert.ok(wallTabStillHidden, 'the nav button stays hidden even once the panel it opens is showing - the star is the only way in');

  await context.close();
});

// Same hidden-entry-point treatment as the star above, for the voter log -
// the one place that shows who voted for whom. Owner-only twice over: the
// diamond only renders for the owner, and the data behind it is owner-gated
// server-side (see GET /admin/votes).
test('the voting logs live behind a diamond on the Snatch tab, owner-only', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');

  await page.click('[data-atab="outfit"]');
  await page.waitForSelector('#votelog-secret-btn:not(.hidden)', { timeout: WAIT_TIMEOUT });

  // Not reachable from the tab bar - the diamond is the only way in.
  const navHidden = await page.$eval('[data-atab="votelog"]', (el) => el.classList.contains('hidden'));
  assert.ok(navHidden, 'the votelog nav button must stay hidden');

  await page.click('#votelog-secret-btn');
  await page.waitForSelector('#atab-votelog:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForSelector('#voter-log-card', { timeout: WAIT_TIMEOUT });
  const stillHidden = await page.$eval('[data-atab="votelog"]', (el) => el.classList.contains('hidden'));
  assert.ok(stillHidden, 'opening the panel must not reveal the nav button');

  await context.close();
});

// A promoted admin is not the owner: neither hidden entry point may appear.
test('a non-owner admin never sees the star or the diamond', async () => {
  const other = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'diamondadmin' } });
  await api('PATCH', `/admin/users/${other.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, other.token, '/settings.html');
  await page.click('[data-atab="outfit"]');
  await page.waitForTimeout(400);

  for (const id of ['wall-secret-btn', 'votelog-secret-btn']) {
    const hidden = await page.$eval(`#${id}`, (el) => el.classList.contains('hidden'));
    assert.ok(hidden, `#${id} must stay hidden for a non-owner admin`);
  }

  await context.close();
  await api('DELETE', `/admin/users/${other.id}`, { token: ADMIN });
});

test('a plain (non-admin) user only sees the Settings tab on /settings.html', async () => {
  const plain = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'plainsettingsuser' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, plain.token, '/settings.html');

  for (const tab of ['plaza', 'outfit', 'rata', 'wall']) {
    const hidden = await page.$eval(`[data-atab="${tab}"]`, (el) => el.classList.contains('hidden'));
    assert.ok(hidden, `plain user should not see the ${tab} tab`);
  }
  const settingsTabHidden = await page.$eval('[data-atab="settings"]', (el) => el.classList.contains('hidden'));
  assert.ok(!settingsTabHidden, 'plain user should see the Settings tab');

  const panelVisible = await page.$eval('#atab-settings', (el) => !el.classList.contains('hidden'));
  assert.ok(panelVisible, 'the Settings panel should be the one shown by default for a plain user');

  const changeKeyCardVisible = await page.$eval('#change-key-card', (el) => !el.classList.contains('hidden'));
  assert.ok(changeKeyCardVisible, 'plain user (no user-management access) should still see the change-key form');

  const usersManagementHidden = await page.$eval('#users-management', (el) => el.classList.contains('hidden'));
  assert.ok(usersManagementHidden, 'plain user should not see the user-management section');

  await context.close();
});

/* --------------------- Live role sync (regression) ------------------------ */

test('a role change made by the owner syncs to an already-open Settings session automatically', async () => {
  // The main app has no role-dependent UI at all (every tab is open to
  // everyone regardless of role - see showApp() in app.js), so this is
  // Settings-only: which admin tabs show does depend on role, synced by
  // its own watcher (see startRoleWatcher() in settings.js).
  const target = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Role Watch Test' } });
  await api('PATCH', `/admin/users/${target.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  await api('POST', '/me/tutorial-seen', { token: target.token });

  const context = await iphoneContext('iPhone 13');

  const settingsPage = await context.newPage();
  await settingsPage.clock.install();
  await settingsPage.goto(base + '/settings.html');
  await settingsPage.evaluate((tok) => localStorage.setItem('appivo_token', tok), target.token);
  await settingsPage.goto(base + '/settings.html');
  await settingsPage.waitForSelector('#admin-content:not(.hidden)', { timeout: WAIT_TIMEOUT });
  // Manage Users is owner-only (this target is admin, not owner) - check a
  // tab a regular admin does see instead, as the "currently admin" signal.
  assert.ok(await settingsPage.$eval('[data-atab="outfit"]', (el) => !el.classList.contains('hidden')), 'should start with admin tabs visible');

  await api('PATCH', `/admin/users/${target.id}/admin`, { token: ADMIN, body: { isAdmin: false } });

  // Losing admin access entirely sends them away from Settings altogether
  // (no reason to stay on a page built for admins) - lands on the main
  // app's Wall tab rather than reloading into a stripped-down admin view.
  await settingsPage.clock.fastForward('00:31');
  await settingsPage.waitForURL(base + '/', { timeout: WAIT_TIMEOUT });
  await settingsPage.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  assert.ok(await settingsPage.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active')), 'demoted user should land on the Wall tab after being redirected away from Settings');

  await context.close();
  await api('DELETE', `/admin/users/${target.id}`, { token: ADMIN });
});

/* ------------------- Notification deep-link (regression) ----------------- */

test('?tab=&night= deep-links land on the right tab/night, then clean the URL', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.goto(`${base}/?tab=outfit&night=swamp`);
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(300);

  const outfitActive = await page.$eval('[data-tab="outfit"]', (el) => el.classList.contains('active'));
  const swampTheme = await page.evaluate(() => document.body.classList.contains('theme-swamp'));
  const cleanedUrl = await page.evaluate(() => location.search);

  assert.ok(outfitActive, 'deep link did not select the outfit tab');
  assert.ok(swampTheme, 'deep link did not apply the swamp night');
  assert.equal(cleanedUrl, '', 'query params were not cleaned up after applying the deep link');
  await context.close();
});

test('a Plaza notification\'s ?tab=chat deep link actually opens the Plaza', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.goto(`${base}/?tab=chat`);
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(300);

  const chatActive = await page.$eval('[data-tab="chat"]', (el) => el.classList.contains('active'));
  assert.ok(chatActive, '?tab=chat should select the Plaza tab, same as rata/outfit already do');
  await context.close();
});

test('a notification click while the app is already open switches tabs via postMessage, not just navigate()', async () => {
  // iOS Safari's service worker Client.navigate() often silently no-ops
  // when the PWA is already in the foreground (a real WebKit limitation) -
  // sw.js also postMessage()s the deep link so the already-open page can
  // apply it itself (see the message listener in app.js). Simulate that
  // message directly, without any navigation, since there's no real
  // service worker controller to trigger it through in this test harness.
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  const plazaActiveBefore = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active'));
  assert.ok(plazaActiveBefore, 'should start on Wall/plaza, same as any fresh login');

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'deep-link', url: '/?tab=rata' } })
    );
  });
  await page.waitForTimeout(200);

  const rataActive = await page.$eval('[data-tab="rata"]', (el) => el.classList.contains('active'));
  assert.ok(rataActive, 'the simulated postMessage should have switched to the Rata tab without a page reload');
  assert.equal(page.url(), `${base}/`, 'this path must not navigate/reload - only the in-page tab should change');
  await context.close();
});

test('a notification tapped from another page takes you to the page it is about', async () => {
  // Two dead ends, both real: sw.js hands the deep link to whichever window
  // is open and lets that page act on it, but only the main app was
  // listening - so a Rata notification tapped while Settings was open did
  // nothing at all. And the app, which was listening, only ever read ?tab=
  // out of the url, so a role-change notification pointing at
  // /settings.html found nothing to apply and also did nothing. Neither tap
  // moved you an inch.
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'deep-link', url: '/?tab=rata' } })
    );
  });
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  assert.ok(
    await page.$eval('[data-tab="rata"]', (el) => el.classList.contains('active')),
    'a Rata notification tapped on Settings should land on the Rata tab',
  );

  // And the other direction: this one carries no ?tab= at all.
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'deep-link', url: '/settings.html' } })
    );
  });
  await page.waitForURL(`${base}/settings.html`, { timeout: WAIT_TIMEOUT });

  await context.close();
});

test('opening the app always lands on Wall, whatever tab was last used', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.click('[data-tab="chat"]');
  await page.waitForTimeout(200);

  await page.reload();
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(300);

  const plazaActive = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active'));
  assert.ok(plazaActive, 'opening the app should land on Wall, like an app opening on its home tab');
  // The tab isn't remembered at all any more, so nothing should be left
  // behind to resume from either.
  const stored = await page.evaluate(() => localStorage.getItem('appivo_tab'));
  assert.equal(stored, null, 'the last-used tab should no longer be persisted');
  await context.close();
});

test('a first login lands on Wall by default', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  const plazaActive = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('active'));
  assert.ok(plazaActive, 'the default landing tab should be Wall');
  await context.close();
});

test('with ENABLE_PLAZA disabled, Wall is hidden in both the main app and Settings, and Rata is the landing tab instead', async () => {
  process.env.ENABLE_PLAZA = 'false';
  try {
    const context = await iphoneContext('iPhone 13');
    const page = await loginPage(context, ADMIN, '/');

    const plazaTabHidden = await page.$eval('[data-tab="plaza"]', (el) => el.classList.contains('hidden'));
    assert.ok(plazaTabHidden, 'Wall tab should be hidden in the main app when the flag is off');
    const rataActive = await page.$eval('[data-tab="rata"]', (el) => el.classList.contains('active'));
    assert.ok(rataActive, 'A Rata should be the landing tab instead of Wall when the Plaza feature is disabled');

    await page.goto(`${base}/settings.html`);
    await page.waitForSelector('#admin-content:not(.hidden)', { timeout: WAIT_TIMEOUT });
    const plazaAdminTabHidden = await page.$eval('[data-atab="plaza"]', (el) => el.classList.contains('hidden'));
    assert.ok(plazaAdminTabHidden, 'Wall admin tab should be hidden even for the owner when the flag is off');

    await context.close();
  } finally {
    process.env.ENABLE_PLAZA = 'true';
  }
});

/* --------------------- Font loading (regression) -------------------- */
// A render-blocking CSS @import caused a visible reflow on font swap; fonts
// must load via a <link> in <head> instead, in parallel with styles.css.

test('a dropped connection says so, instead of the screen quietly going still', async () => {
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Offline Tester' } });
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, guest.token);
  await page.click('[data-tab="chat"]');

  assert.equal(await page.isVisible('#offline-banner'), false, 'nothing to say while it is working');

  // Every poller swallows its own failures, so before this a real outage and
  // a quiet party looked identical - the screen simply stopped changing.
  await context.setOffline(true);
  // Two consecutive failures before it speaks up (see api.js), and the chat
  // poller runs every 3s - so this legitimately needs longer than the
  // suite's default wait, which is shorter than one round trip of that.
  await page.waitForSelector('#offline-banner:not(.hidden)', { timeout: Math.max(WAIT_TIMEOUT, 12000) });
  const text = (await page.textContent('#offline-banner')).trim();
  assert.ok(text.length > 0, 'the banner has to actually say something');
  assert.equal(text, text.toLowerCase(), 'lowercase, like the rest of the app');

  // And it clears itself when the connection returns - no tap required.
  await context.setOffline(false);
  // state:'hidden', not a '.hidden' selector - the default waits for the
  // element to become *visible*, which a hidden one never does.
  await page.waitForSelector('#offline-banner', { state: 'hidden', timeout: Math.max(WAIT_TIMEOUT, 12000) });

  await context.close();
});

// The tab row sits at its minimum gap on a 320px screen, so it has almost
// no slack: when the faces were linked from Google, a slow CDN meant the
// wide fallback serif rendered instead and the overflow test below went red
// for reasons that had nothing to do with this repo (seen on CI, 12 Aug
// 2026, passing on a re-run of the same commit). The faces are self-hosted
// now. This guards that: nothing may reach for a third-party font host, and
// the faces the layout is measured against must actually be the ones that
// loaded.
test('the fonts are served by this app, not by a font CDN', async () => {
  const context = await iphoneContext('iPhone SE');
  const offsite = [];
  context.on('request', (req) => {
    const host = new URL(req.url()).host;
    if (/fonts\.(googleapis|gstatic)\.com$/.test(host)) offsite.push(req.url());
  });

  for (const path of ['/', '/settings.html']) {
    const page = await loginPage(context, ADMIN, path);

    // Deliberately not document.fonts.check(): its text argument defaults
    // to a single space, which the fallback serif satisfies too, so it
    // answers true even with /fonts entirely missing. The FontFace entries
    // carry the real outcome - a woff2 that 404s lands as status 'error'
    // while the page still renders happily in the fallback, which is
    // exactly the silent failure worth catching.
    await page.evaluate(() => document.fonts.ready.catch(() => {}));
    const faces = await page.evaluate(() =>
      [...document.fonts].map((f) => ({ family: f.family.replace(/['"]/g, ''), status: f.status })));

    for (const family of ['Cormorant Garamond', 'EB Garamond', 'Italianno']) {
      const mine = faces.filter((f) => f.family === family);
      assert.ok(mine.length, `${family} has no @font-face at all on ${path}`);
      const bad = mine.filter((f) => f.status === 'error');
      assert.deepEqual(bad, [], `${family} failed to load on ${path} - check /fonts and fonts.css`);
    }

    // The families above can all sit unused at 'unloaded' if nothing on the
    // page asks for them, so pin the one the layout is actually measured
    // against: the tab labels must be rendering in the real body face.
    const tabFace = await page.evaluate(() => {
      const tab = document.querySelector('.tab');
      return tab ? getComputedStyle(tab).fontFamily : null;
    });
    if (tabFace) {
      const used = faces.find((f) => tabFace.includes(f.family) && f.status === 'loaded');
      assert.ok(used, `the tab row fell back to a system serif on ${path} (wanted ${tabFace})`);
    }
  }

  assert.deepEqual(offsite, [], `these went off to a font CDN: ${offsite.join(', ')}`);
});

// Regression: the tab row was a few pixels wider than the viewport, so it
// slid sideways under a thumb - on the admin page worst of all, where the
// labels are longest. A navigation bar that moves when you touch it reads
// as broken. Both rows are checked, because the public one overflowed too;
// Ivo only happened to notice it on the admin side.
test('neither tab row can be dragged sideways, on any phone', async () => {
  for (const device of IOS_DEVICES) {
    const context = await iphoneContext(device);
    const page = await loginPage(context, ADMIN, '/');
    const guest = await page.$eval('.tabs', (el) => el.scrollWidth - el.clientWidth);
    assert.ok(guest <= 0, `the guest tab row overflows by ${guest}px on ${device}`);

    const admin = await loginPage(context, ADMIN, '/settings.html');
    const settings = await admin.$eval('#admin-tabs', (el) => el.scrollWidth - el.clientWidth);
    assert.ok(settings <= 0, `the admin tab row overflows by ${settings}px on ${device}`);
    await context.close();
  }
});

test('every tab clears the 44px minimum, and no two of their hit areas overlap', async () => {
  const context = await iphoneContext('iPhone SE');
  const page = await loginPage(context, ADMIN);

  // Tabs only. The topbar icons sit at 38px on purpose - see the note by
  // .icon-btn in styles.css for why widening them was reverted.
  const targets = await page.$$eval('.tab', (els) => els.map((e) => {
    const b = e.getBoundingClientRect();
    const a = getComputedStyle(e, '::after');
    const grow = (v) => Math.abs(parseFloat(v) || 0);
    return {
      name: (e.textContent || e.getAttribute('aria-label') || e.title || '?').trim().slice(0, 14),
      w: b.width + grow(a.left) + grow(a.right),
      h: b.height + grow(a.top) + grow(a.bottom),
      left: b.left - grow(a.left),
      right: b.right + grow(a.right),
    };
  }));
  assert.ok(targets.length >= 5, 'expected the whole tab row');
  for (const t of targets) {
    assert.ok(t.w >= 44, `"${t.name}" is only ${Math.round(t.w)}px wide`);
    assert.ok(t.h >= 44, `"${t.name}" is only ${Math.round(t.h)}px tall`);
  }

  // A hit area that reaches into its neighbour is worse than a small one:
  // the tap lands on the wrong control instead of on nothing.
  const tabs = await page.$$eval('.tab', (els) => els.map((e) => {
    const b = e.getBoundingClientRect();
    const a = getComputedStyle(e, '::after');
    const grow = (v) => Math.abs(parseFloat(v) || 0);
    return { left: b.left - grow(a.left), right: b.right + grow(a.right) };
  }));
  for (let i = 1; i < tabs.length; i += 1) {
    assert.ok(tabs[i].left >= tabs[i - 1].right - 0.5,
      `tab ${i} starts at ${tabs[i].left} but the one before it ends at ${tabs[i - 1].right}`);
  }

  await context.close();
});

test('fonts load via a <link> in <head>, not a render-blocking @import', async () => {
  // fonts.css has to be linked ahead of styles.css rather than @imported
  // from inside it: an @import cannot start downloading until the importing
  // stylesheet has been fetched and parsed, so the faces would queue behind
  // 150KB of CSS instead of travelling alongside it.
  for (const path of ['/', '/settings.html']) {
    const html = await (await fetch(base + path)).text();
    const fonts = html.indexOf('/css/fonts.css');
    const styles = html.indexOf('/css/styles.css');
    assert.ok(fonts !== -1, `no font <link> found in <head> on ${path}`);
    assert.ok(fonts < styles, `fonts.css should be linked before styles.css on ${path}`);
    assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/,
      `${path} still reaches for Google Fonts - the faces are self-hosted now`);
  }

  const css = await (await fetch(base + '/css/styles.css')).text();
  // Anchored to the line start so the word "@import" inside the comment at
  // the top of styles.css - which explains why there isn't one - does not
  // read as one.
  assert.doesNotMatch(css, /^\s*@import\b/m, 'styles.css render-blocks on an @import');

  // The generated file is the thing actually serving the faces, so it is
  // worth knowing it is present and pointing at real files rather than
  // silently empty.
  const fontCss = await (await fetch(base + '/css/fonts.css')).text();
  const srcs = [...fontCss.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 3, `fonts.css declares only ${srcs.length} faces`);
  for (const src of srcs) {
    const res = await fetch(base + src);
    assert.equal(res.status, 200, `${src} is declared in fonts.css but ${res.status}s`);
  }
});

/* ------------------------- Version badge (regression) ---------------------- */
// APP_ENV is only ever set to "qa" (see fly.qa.toml) - prod leaves it unset,
// so the badge shows a bare "vX.Y.Z" there and "qa vX.Y.Z" on QA, making the
// environment obvious at a glance on both the login screen and the app.

test('version badge shows a "qa" label when APP_ENV=qa, and stays a bare version otherwise', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.waitForFunction(() => document.getElementById('version-badge').textContent.length > 0);
  const prodLabel = await page.$eval('#version-badge', (el) => el.textContent);
  assert.match(prodLabel, /^v\d+\.\d+\.\d+$/, 'with APP_ENV unset, the badge should be a bare version, no env label');

  process.env.APP_ENV = 'qa';
  try {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('version-badge').textContent.startsWith('qa '));
    const qaLabel = await page.$eval('#version-badge', (el) => el.textContent);
    assert.match(qaLabel, /^qa v\d+\.\d+\.\d+$/, 'with APP_ENV=qa, the badge should be prefixed "qa "');
  } finally {
    delete process.env.APP_ENV;
  }

  await context.close();
});

/* --------------------------- Dark/light mode ------------------------------ */

test('dark/light mode toggles and persists, and gives each night theme its own dark/light variant', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');

  const initialIsDark = await page.evaluate(() => document.documentElement.classList.contains('mode-dark'));
  assert.equal(initialIsDark, false, 'should default to light mode');

  // On the rata tab (theme-rata active), each night theme now has a distinct
  // light AND dark variant (see html.mode-light/html.mode-dark compound
  // selectors in styles.css), so the card color must actually change when
  // the mode toggle is clicked - it should no longer be flattened away, but
  // it should also no longer stay frozen at a single look either.
  const rataCardBg = await page.$eval('.card', (el) => getComputedStyle(el).backgroundColor);

  await page.click('#theme-toggle');
  await page.waitForTimeout(200);
  const afterToggle = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('mode-dark'),
    stored: localStorage.getItem('appivo_mode'),
    cardBg: getComputedStyle(document.querySelector('.card')).backgroundColor,
  }));
  assert.equal(afterToggle.dark, true, 'clicking the toggle should switch to dark mode');
  assert.equal(afterToggle.stored, 'dark', 'the choice should persist to localStorage');
  assert.notEqual(afterToggle.cardBg, rataCardBg, 'theme-rata card color should switch to its dark variant');

  // The choice must still survive a reload.
  await page.reload();
  await page.waitForSelector('#app:not(.hidden)');
  const stillDark = await page.evaluate(() => document.documentElement.classList.contains('mode-dark'));
  assert.equal(stillDark, true, 'dark mode should survive a reload');

  // settings.html has no night theme competing for these variables, so dark
  // mode's own mystique palette (#1f1a2b = rgb(31,26,43)) applies there.
  await page.goto(base + '/settings.html');
  await page.waitForSelector('#admin-content:not(.hidden)');
  const adminCardBg = await page.$eval('.card', (el) => getComputedStyle(el).backgroundColor);
  assert.equal(adminCardBg, 'rgb(31, 26, 43)', 'settings.html should reflect dark mode with no theme to compete with');

  await context.close();
});

/* ------------------------------- Tutorial ---------------------------------- */

test('first-session tutorial shows once, steps through, then never shows again', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'tutorialtestuser' } });

  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.evaluate((tok) => localStorage.setItem('appivo_token', tok), created.token);
  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)');

  // Shows immediately on a fresh account, asking for a language first.
  await page.waitForSelector('#tutorial-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const langStepVisible = await page.$eval('#tutorial-lang-step', (el) => !el.classList.contains('hidden'));
  assert.ok(langStepVisible, 'tutorial should ask for a language before showing content');

  // Picking English should render the actual tour content in English.
  await page.click('#tutorial-lang-en');
  await page.waitForSelector('#tutorial-content-step:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const firstTitle = await page.$eval('#tutorial-title', (el) => el.textContent);
  assert.ok(firstTitle.length > 0, 'first tutorial step has no title');
  assert.match(firstTitle, /welcome/i, 'choosing English did not render the tour in English');
  let activeDots = await page.$$eval('.tutorial-dots .dot.active', (els) => els.length);
  assert.equal(activeDots, 1, 'exactly one dot should be active at a time');

  // A plain (non-admin, non-owner) account gets no skip - has to read
  // through the whole tour.
  const skipHidden = await page.$eval('#tutorial-skip', (el) => el.classList.contains('hidden'));
  assert.ok(skipHidden, 'a regular user should not see a tutorial skip button');

  // Step through every step via "next" (9 total steps with Memo enabled -
  // see tutorialSteps() in app.js - so 8 clicks to reach the last one; the
  // final "finish" click happens after the loop).
  const tourTitles = [firstTitle.trim().toLowerCase()];
  for (let i = 0; i < 8; i++) {
    const titleBefore = await page.$eval('#tutorial-title', (el) => el.textContent);
    await page.click('#tutorial-next');
    await page.waitForTimeout(100);
    const titleAfter = await page.$eval('#tutorial-title', (el) => el.textContent);
    assert.notEqual(titleAfter, titleBefore, `step ${i + 2} did not render new content`);
    tourTitles.push(titleAfter.trim().toLowerCase());
  }

  // The tour walks the tabs in the order they sit in the tab bar - someone
  // following along should be able to read left to right, not hop about.
  const tabLabels = await page.$$eval('.tabs .tab:not(.hidden)', (els) =>
    els.map((el) => el.textContent.trim().toLowerCase()));
  const tourTabSteps = tourTitles.filter((t) => tabLabels.includes(t));
  assert.deepEqual(tourTabSteps, tabLabels,
    `the tour introduces the tabs as ${tourTabSteps.join(', ')} but the tab bar reads ${tabLabels.join(', ')}`);
  assert.deepEqual(tourTitles.slice(1, 1 + tabLabels.length), tabLabels,
    'the tab tour steps should come first, straight after the welcome step');

  // Last step's button finishes the tutorial instead of advancing further.
  await page.click('#tutorial-next');
  await page.waitForSelector('#tutorial-overlay.hidden', { state: 'attached', timeout: WAIT_TIMEOUT });

  // Reloading (new "session") must not show it again - it's tied to the account.
  await page.reload();
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForTimeout(300);
  const stillHidden = await page.$eval('#tutorial-overlay', (el) => el.classList.contains('hidden'));
  assert.ok(stillHidden, 'tutorial reappeared after being completed once');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

test('an admin account gets a tutorial skip button, and using it marks the tutorial seen', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'tutorialadmintest' } });
  await api('PATCH', `/admin/users/${created.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.evaluate((tok) => localStorage.setItem('appivo_token', tok), created.token);
  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForSelector('#tutorial-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });

  await page.click('#tutorial-lang-en');
  await page.waitForSelector('#tutorial-content-step:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const skipHidden = await page.$eval('#tutorial-skip', (el) => el.classList.contains('hidden'));
  assert.ok(!skipHidden, 'an admin account should see a tutorial skip button');

  await page.click('#tutorial-skip');
  await page.waitForSelector('#tutorial-overlay.hidden', { state: 'attached', timeout: WAIT_TIMEOUT });

  const me = await api('GET', '/me', { token: created.token });
  assert.ok(me.tutorialSeen, 'skipping should mark the tutorial as seen, same as finishing it');

  await context.close();
  await api('DELETE', `/admin/users/${created.id}`, { token: ADMIN });
});

/* ----------------------------------- Chat ---------------------------------- */

test('sending a chat message shows it in the list for another user', async () => {
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/');
  await page.click('[data-tab="chat"]');
  await page.waitForTimeout(200);

  const unique = `hello-${Date.now()}`;
  await page.fill('#chat-text', unique);
  await page.click('#chat-form button[type=submit]');
  await page.waitForTimeout(300);

  const seenBySender = await page.evaluate(() => document.getElementById('chat-messages').textContent);
  assert.ok(seenBySender.includes(unique), 'sender does not see their own message');

  // Someone else polling should see it too, without sending anything themselves.
  const other = await api('GET', '/chat/messages', { token: ADMIN });
  assert.ok(other.messages.some((m) => m.text === unique));

  await context.close();
});

/* ------------------- Snatch: photo required at registration --------------- */

// Smallest possible real PNG (1x1 transparent pixel) - resizePhotoToJpeg()
// runs it through an actual <canvas>, so a fake/truncated buffer wouldn't
// decode; this needs to be genuinely valid, unlike api.test.js's fake-magic-
// bytes fixture which only has to pass the server's own check.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

/** Clicks a button that opens a file input (registerPhotoBtnSelector triggers
 * a hidden <input type=file> via .click(), same as a real tap would) and
 * feeds it a file through Playwright's native file-chooser interception -
 * exercising the actual click -> OS/browser picker -> change event path,
 * not just setInputFiles() on the underlying input directly. That
 * distinction matters here: the input is hidden off-screen for a styled
 * button to stand in for it (see .file-input-visually-hidden in
 * styles.css), and a hidden-via-display:none input silently failing to
 * open on iOS Safari when .click()'d programmatically is a real, previously
 * unrelated failure mode setInputFiles() can't detect since it bypasses the
 * click/open step entirely. */
async function pickPhotoViaButton(page, buttonSelector, file) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click(buttonSelector),
  ]);
  await chooser.setFiles(file);
}

test('Snatch registration warns on a missing name, requires a photo, previews it once attached via the real picker button, and blocks submitting without one', async () => {
  const night = 'furnished';
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo UI Tester' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);
  await page.click('[data-tab="outfit"]');
  await page.waitForSelector('#register-form', { timeout: WAIT_TIMEOUT });

  // No name at all - this used to fail silently (a bare `return`, no
  // message), which reads exactly like a dead/disabled submit button.
  await page.click('#register-form button[type="submit"]');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const nameAlertText = await page.textContent('.modal-message');
  assert.ok(/name|nome/i.test(nameAlertText), 'submitting without a name should say one is required, not silently do nothing');
  await page.click('.modal-actions button');

  // Name filled, no photo yet - submitting should warn, not register.
  await page.fill('#register-name', 'Ghost of Photos Past');
  await page.click('#register-form button[type="submit"]');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  const alertText = await page.textContent('.modal-message');
  assert.ok(/photo|foto/i.test(alertText), 'submitting without a photo should say one is required, not silently fail');
  await page.click('.modal-actions button');

  // The file input starts genuinely absent from the file chooser flow until
  // the styled "choose photo" button is clicked - it's the button, not the
  // input, a real tap lands on.
  await pickPhotoViaButton(page, '#register-photo-btn', { name: 'outfit.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await page.waitForSelector('#register-photo-preview:not(.hidden) img[src^="data:image/jpeg"]', { timeout: WAIT_TIMEOUT });
  // The thumbnail alone is easy to miss on a small screen - a plain
  // confirmation line has to be there too.
  const previewText = await page.textContent('#register-photo-preview');
  assert.ok(/photo|foto/i.test(previewText), 'attaching a photo should say so in text, not just show a thumbnail');

  await page.click('#register-form button[type="submit"]');
  await waitOrExplain(page, '#register-area .highlight');
  const entryText = await page.textContent('#register-area .highlight');
  assert.ok(entryText.includes('Ghost of Photos Past'), 'entry should register once a photo is attached');

  // The registrant can always preview their own entry's photo.
  await page.waitForSelector('#register-area .entry-photo-preview', { timeout: WAIT_TIMEOUT });

  // Either half of a duo can swap the photo later via the same
  // button-triggers-hidden-input pattern - covered here too since it's the
  // exact mechanism that broke. Byte-for-byte replacement is already
  // covered server-side (api.test.js); what matters here is that the real
  // click -> file-chooser -> PUT round trip completes without erroring.
  await pickPhotoViaButton(page, '#change-photo-btn', { name: 'new-outfit.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await page.waitForTimeout(300);
  assert.equal(await page.isVisible('.modal-overlay:not(.hidden)'), false, 'replacing the photo should not surface an error');
  const status = await api('GET', `/votes/status?night=${night}`, { token: user.token });
  assert.equal(status.myContestant.hasPhoto, true, 'the entry should still have a photo after replacing it');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

test('a Best Look poll tick landing while a photo is picked does not wipe the in-progress name/photo', async () => {
  // Reproduces a real bug: Best Look polls for updates every 4s
  // (outfitPollTimer), and picking a photo hands control to the OS
  // camera/library picker - which blurs focus, defeating the "skip while
  // typing" guard, and for however long the user is away. A poll landing
  // in that gap used to fully rebuild the blank registration form,
  // silently wiping the name field and the just-attached photo - reported
  // on a real iPhone as "erases the name box, photo doesn't upload,
  // nothing works". Attaching via setInputFiles() here (not the
  // button-triggering-a-filechooser dance used above) is deliberate: this
  // test is about surviving a poll tick mid-interaction, not about the
  // click-opens-a-picker mechanism the other test already covers.
  const night = 'furnished';
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Poll Race Tester' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);
  await page.click('[data-tab="outfit"]');
  await page.waitForSelector('#register-form', { timeout: WAIT_TIMEOUT });

  await page.fill('#register-name', 'Surviving The Poll');
  // Blurring simulates the focus loss a real native picker sheet causes -
  // the activeElement guard alone no longer protects the form past this
  // point, same as it wouldn't on a real device.
  await page.evaluate(() => document.activeElement?.blur());
  // Longer than outfitPollTimer's 4000ms interval, so at least one poll
  // tick is guaranteed to land before checking the field survived it.
  await page.waitForTimeout(4500);
  assert.equal(await page.inputValue('#register-name'), 'Surviving The Poll', 'a poll tick should not wipe the name field');

  await page.setInputFiles('#register-photo-input', { name: 'outfit.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await page.waitForSelector('#register-photo-preview:not(.hidden) img[src^="data:image/jpeg"]', { timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(4500);
  assert.ok(
    await page.isVisible('#register-photo-preview:not(.hidden) img[src^="data:image/jpeg"]'),
    'a poll tick should not clear the attached photo preview either'
  );

  await page.click('#register-form button[type="submit"]');
  await waitOrExplain(page, '#register-area .highlight');
  const entryText = await page.textContent('#register-area .highlight');
  assert.ok(entryText.includes('Surviving The Poll'), 'the entry should register with the name/photo that survived the poll');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

// Regression: renderRegistration() skipped its whole re-render whenever
// focus sat anywhere inside #register-area - and the submit button is
// inside it. On any engine that leaves a clicked button focused (CI's
// Linux WebKit does; macOS Safari does not, which is why this only ever
// showed up on CI) a registration the server had already accepted was
// never shown: the blank form stayed exactly as it was, every 4s poll
// skipped by that same focus, with no way back short of a reload. The
// guard now covers only the blank form, which is the thing that can
// actually be typed into.
//
// Focus is forced here rather than left to whatever the engine does on a
// click, so this asserts the behaviour on every platform instead of only
// the ones that reproduce it by accident.
test('a submitted entry is shown even when the submit button keeps focus after the tap', async () => {
  const night = 'furnished';
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Focused Submit Tester' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);
  await page.click('[data-tab="outfit"]');
  await page.waitForSelector('#register-form', { timeout: WAIT_TIMEOUT });

  await page.fill('#register-name', 'Focus Survivor');
  await page.setInputFiles('#register-photo-input', { name: 'outfit.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await page.waitForSelector('#register-photo-preview:not(.hidden) img[src^="data:image/jpeg"]', { timeout: WAIT_TIMEOUT });

  await page.evaluate(() => {
    const submit = document.querySelector('#register-form button[type="submit"]');
    submit.click();
    submit.focus();
  });

  const entry = await waitOrExplain(page, '#register-area .highlight');
  assert.match(
    await entry.textContent(),
    /Focus Survivor/,
    'an entry the server has stored must be on screen, not hidden behind a form that still looks empty',
  );

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

test('once results start revealing, "you voted for X" clears instead of sitting on top of the results list', async () => {
  const night = 'furnished';
  const voter = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Reveal Vote Tester' } });
  const contestantOwner = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Reveal Contestant Owner' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  // A direct API call (not going through the client's resize step - see
  // resizePhotoToJpeg()), so this needs to already look like a real JPEG to
  // the server's own magic-byte check, unlike PNG_1X1 above.
  const fakeJpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
  const reg = await api('POST', '/outfit/register', {
    token: contestantOwner.token,
    body: { name: 'Reveal Target', night, photoBase64: fakeJpeg },
  });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  await api('POST', '/votes', { token: voter.token, body: { contestantId: reg.id, night } });
  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, voter.token);
  await page.click('[data-tab="outfit"]');

  // Closed, not revealed yet - the "you voted for X" message is exactly
  // what tells the voter their vote landed, so it stays up here.
  await page.waitForSelector('#vote-area .highlight', { timeout: WAIT_TIMEOUT });
  assert.ok((await page.textContent('#vote-area .highlight')).includes('Reveal Target'), 'should show who was voted for before any reveal');

  // Advance through every reveal stage (hidden -> third -> second -> first
  // -> all) regardless of how many contestants exist.
  for (let i = 0; i < 4; i++) {
    await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });
  }
  await page.waitForSelector('#results-card:not(.hidden) .tier li', { timeout: WAIT_TIMEOUT });
  // The results list is now showing the same information - repeating it
  // in the vote area above is just clutter once that's true.
  const voteAreaEmpty = await page.evaluate(() => document.getElementById('vote-area').innerHTML.trim() === '');
  assert.ok(voteAreaEmpty, 'the "you voted for X" message should clear once results start revealing');
  // Everything Best Outfit had to say is redundant now - it was still
  // showing its "closed" status line on top of the results card until this
  // was fixed. The card itself stays put, because the night switch lives in
  // it, so what has to go quiet is its title, status line and vote area.
  assert.equal(await page.isVisible('#voting-card'), false, 'the votação card should hide entirely once results are revealed');
  assert.equal(await page.isVisible('#theme-switch'), true, 'the night switch is outside it, and survives');
  // With only one contestant, they're both 1st place and the only result -
  // gold medal included.
  const firstResultText = await page.textContent('#results-list li');
  assert.ok(firstResultText.includes('🥇'), 'the winner should get a gold medal emoji in the reveal');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

test('the admin voting-advance button always confirms first - a misclick declined leaves the night untouched', async () => {
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="outfit"]');
  await page.waitForSelector('#voting-advance-btn', { timeout: WAIT_TIMEOUT });

  // Declining the confirm on "open" should leave registration exactly as
  // it was - nothing about the night should have changed underneath.
  await page.click('#voting-advance-btn');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('.modal-actions button.ghost');
  const afterDecline = await api('GET', '/admin/voting', { token: ADMIN });
  assert.equal(afterDecline.nights.find((n) => n.night === night).status, 'registration', 'declining the confirm should not have opened voting');

  // Confirming should actually perform it. Two prompts now, not one: the
  // generic "are you sure", then the server's own refusal because nobody
  // has entered this night - which is exactly the case that warning is for.
  await page.click('#voting-advance-btn');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('.modal-actions button:not(.ghost)');
  // A second prompt may follow - the server refuses to open a night nobody
  // has entered, and whether that fires depends on how many accounts exist
  // when this runs, which is not what this test is about. Confirm it if it
  // shows up; carry on if it does not.
  await page.waitForTimeout(300);
  if (await page.isVisible('.modal-overlay:not(.hidden)')) {
    await page.click('.modal-actions button:not(.ghost)');
  }
  await page.waitForFunction(
    () => document.getElementById('voting-state-label')?.classList.contains('is-open'),
    null,
    { timeout: WAIT_TIMEOUT },
  );
  const afterConfirm = await api('GET', '/admin/voting', { token: ADMIN });
  assert.equal(afterConfirm.nights.find((n) => n.night === night).status, 'open', 'confirming should have opened voting');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

test('a tie for first place shows a "Desempate" button, and running it reopens voting scoped to just the tied contestants', async () => {
  const night = 'swamp';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  const a = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'UI Runoff A', night } });
  const b = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'UI Runoff B', night } });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  const v1 = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'UI Runoff Voter 1' } });
  const v2 = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'UI Runoff Voter 2' } });
  await api('POST', '/votes', { token: v1.token, body: { contestantId: a.id, night } });
  await api('POST', '/votes', { token: v2.token, body: { contestantId: b.id, night } });
  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN, body: { force: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="outfit"]');
  await page.click('[data-night="swamp"]');
  await page.waitForSelector('#voting-runoff-btn:not(.hidden)', { timeout: WAIT_TIMEOUT });

  await page.click('#voting-runoff-btn');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('.modal-actions button:not(.ghost)');
  await page.waitForFunction(
    () => document.getElementById('voting-state-label')?.classList.contains('is-open'),
    { timeout: WAIT_TIMEOUT }
  );

  // A guest sees "it's a tie - vote again" and only the two tied names, not
  // whatever else might be registered for this night.
  const guestPage = await loginPage(context, v1.token, '/?night=swamp');
  await guestPage.click('[data-tab="outfit"]');
  await guestPage.waitForFunction(
    () => document.getElementById('voting-status')?.textContent.length > 0,
    { timeout: WAIT_TIMEOUT }
  );
  const statusText = await guestPage.textContent('#voting-status');
  assert.match(statusText, /tie|empate/i, 'a guest should see runoff-specific status text, not the normal "voting is open" line');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

test('the admin download-photos button shows progress, triggers a real download, and reports errors inline', async () => {
  const night = 'swamp';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="outfit"]');
  // Default night is furnished - switch to the empty one first to check
  // the error path before adding a photo to check the success path.
  await page.click('[data-night="swamp"]');
  await page.waitForTimeout(200);

  await page.click('#download-photos-btn');
  await page.waitForFunction(
    () => document.getElementById('download-photos-msg')?.textContent.length > 0,
    { timeout: WAIT_TIMEOUT }
  );
  const errorText = await page.textContent('#download-photos-msg');
  assert.ok(/photo|foto/i.test(errorText), 'a night with no photos yet should report that inline, not fail silently');
  assert.ok(await page.evaluate(() => document.getElementById('download-photos-msg').classList.contains('error')), 'the error state should be styled as an error');

  // Now with an actual photo, the button should trigger a real download.
  const owner = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Download Flow Persona' } });
  const fakeJpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
  await api('POST', '/outfit/register', { token: owner.token, body: { name: 'Download Flow Target', night, photoBase64: fakeJpeg } });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#download-photos-btn'),
  ]);
  assert.equal(download.suggestedFilename(), `snatch-${night}-photos.zip`);
  // Hardcoded PT text rather than importing the client's t() into this
  // Node context - ADMIN's account language defaults to pt, same as every
  // other test in this file that checks rendered copy.
  await page.waitForFunction(
    () => document.getElementById('download-photos-msg')?.textContent === 'descarregado.',
    { timeout: WAIT_TIMEOUT }
  );
  assert.equal(await page.evaluate(() => document.getElementById('download-photos-msg').classList.contains('error')), false);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await context.close();
});

/* ---------------------------------- Memo ----------------------------------- */
// 5x/day, at a random independent time per user, a slot opens for 15
// minutes to upload a photo/video. The scheduler cron isn't running in
// this test process (only app.js, not server.js) - slots are forced open
// the same way api.test.js does, with a direct DB write.

// Defaults to the app's clock rather than Date.now(), so a pinned test and
// the 15-minute upload window it is exercising agree on what "now" means.
function markMemoSlotNotified(slotId, when = new Date(now())) {
  const ts = when.toISOString().replace('T', ' ').replace('Z', '');
  db.prepare('UPDATE memo_slots SET notified_at = ? WHERE id = ?').run(ts, slotId);
}

// Memo's five moments only exist inside a 14:00-02:00 window, and the app's
// day does not roll over until 06:00 - so between 02:00 and 06:00 there is
// deliberately no schedule to generate, and after roughly 23:15 there is no
// longer room for all five. Any test wanting a normal full day has to say
// what time it is instead of inheriting the hour the suite started at.
//
// This is the same seam api.test.js uses. It was missed here first time
// round, which is why the suite went red at 02:12 one morning on a change
// that had nothing to do with Memo.
function withFullMemoDay(fn) {
  const restore = setClockForTests(zonedTimeToUtc(today(), 15, 0, getTimezone()).toISOString());
  try {
    db.prepare('DELETE FROM memo_slots').run();
    ensureTodaysSlots();
    return fn();
  } finally {
    restore();
  }
}

test('Memo: a guest can shoot an open moment, it shows in the shared feed, another guest can react, and the owner publishes its video to the Wall', async () => {
  const { MEMO_REACTION_EMOJI } = await import('../src/memo.js');
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo UI Tester' } });
  const bystander = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo UI Bystander' } });
  // Built at a pinned afternoon, then read back over HTTP like any guest
  // would. Generating it up front is what stops the hour of the run
  // deciding whether this test has five moments, fewer, or none.
  withFullMemoDay(() => {});
  const todayRes = await api('GET', '/memo/today', { token: user.token });
  assert.ok(todayRes.slots?.length, `expected a full day of moments, got ${JSON.stringify(todayRes)}`);
  const slot = todayRes.slots[0];
  markMemoSlotNotified(slot.id);

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);
  await page.click('[data-tab="memo"]');
  await page.waitForSelector('#memo-dots', { timeout: WAIT_TIMEOUT });

  // The live dot is the trigger. There used to be a separate button below
  // the row, which asked you to read five dots, work out which was open,
  // and then press something else - when the open one is already the thing
  // pulsing at you.
  await page.waitForSelector(`button.memo-dot.memo-dot-open[data-memo-upload-btn="${slot.id}"]`, { timeout: WAIT_TIMEOUT });
  assert.equal(await page.isVisible('#memo-shoot-btn'), false, 'the separate shoot button should be gone');
  const plainDots = await page.$$eval('#memo-dots span.memo-dot', (els) => els.length);
  assert.ok(plainDots > 0, 'the moments you cannot act on stay plain, not pressable');

  // Before posting there is no board at all - just the dots. Not a card
  // saying one is waiting: that gives away that there is something behind
  // it before it has been earned, which is the opposite of the point.
  assert.equal(await page.isVisible('#memo-feed-card'), false, 'no board until you have posted your own');
  assert.equal(await page.$$eval('[data-memo-react]', (els) => els.length), 0, 'and nothing leaks through it');

  await page.setInputFiles(`[data-memo-file-input="${slot.id}"]`, { name: 'moment.png', mimeType: 'image/png', buffer: PNG_1X1 });
  // The dot swaps from open to uploaded once the upload lands (see
  // renderMemoDots() in app.js) - waiting for the class change beats a
  // fixed sleep.
  await page.waitForSelector(`.memo-dot-uploaded`, { timeout: WAIT_TIMEOUT });

  // Alone at this point - and the moment just captured still has to be on
  // screen. The feed used to leave your own upload out, so shooting the
  // first moment of a party left it empty, which hid the whole card: the
  // dot filled in and nothing else happened, so capturing read as broken.
  await page.waitForSelector('#memo-feed-card:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.waitForSelector('.memo-feed-item-mine img.memo-feed-thumb', { timeout: WAIT_TIMEOUT });
  assert.equal(
    await page.$$eval('.memo-feed-item-mine [data-memo-react]', (els) => els.length),
    0,
    'reacting to your own moment is not a thing',
  );

  const bystanderPage = await loginPage(context, bystander.token);
  await bystanderPage.click('[data-tab="memo"]');
  // Same seal for the second guest, and posting is what breaks it - the
  // other guest's moment only appears on the far side of their own.
  assert.equal(await bystanderPage.isVisible('#memo-feed-card'), false, 'the second guest is sealed out the same way');
  await bystanderPage.setInputFiles(`[data-memo-file-input="${slot.id}"]`, { name: 'theirs.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await bystanderPage.waitForSelector('#memo-feed-card:not(.hidden) [data-memo-react]', { timeout: WAIT_TIMEOUT });
  const uploadId = await bystanderPage.getAttribute('[data-memo-react]', 'data-memo-react');

  // Everyone's moment for this slot, the viewer's own included and labelled
  // as theirs - newest first, so the one just posted leads. It used to show
  // only other people, on the grounds that the dot above already stood for
  // your own; shooting the first moment of a party then left the feed empty
  // and hid the card, so capturing looked like it had failed.
  const feedOwners = await bystanderPage.$$eval('.memo-feed-name', (els) => els.map((e) => e.textContent.trim()));
  // Raw name: the all-lowercase look is text-transform, not the text itself.
  assert.deepEqual(feedOwners, ['o teu', 'Memo UI Tester'], 'your own moment belongs in the feed, marked as yours');

  // Regression: the reaction row rendered one button per entry in the
  // client's own emoji list, and that list was left at four after the
  // server's was cut to two - so two buttons shipped completely blank, and
  // tapping either was rejected by the API. Asserting the count alone
  // wouldn't have caught a *renamed* emoji, so this also checks every
  // button actually drew an icon.
  const reactionButtons = await bystanderPage.$$eval(`[data-memo-react="${uploadId}"]`, (els) =>
    els.map((el) => ({ emoji: el.dataset.emoji, svgPaths: el.querySelectorAll('svg path').length }))
  );
  assert.equal(reactionButtons.length, MEMO_REACTION_EMOJI.length, 'one button per server-accepted reaction, no more');
  assert.deepEqual(reactionButtons.map((b) => b.emoji), MEMO_REACTION_EMOJI);
  for (const b of reactionButtons) {
    assert.ok(b.svgPaths > 0, `the "${b.emoji}" reaction button rendered without an icon`);
  }
  await bystanderPage.click(`[data-memo-react="${uploadId}"][data-emoji="💦"]`);
  await bystanderPage.waitForFunction(
    (id) => document.querySelector(`[data-memo-react="${id}"][data-emoji="💦"]`)?.textContent.includes('1'),
    uploadId,
    { timeout: WAIT_TIMEOUT }
  );

  const adminPage = await loginPage(context, ADMIN, '/settings.html');
  await adminPage.click('[data-atab="memo"]');
  await adminPage.waitForSelector('#memo-days-list', { timeout: WAIT_TIMEOUT });
  await adminPage.waitForFunction(
    () => /\d\/\d/.test(document.getElementById('memo-days-list')?.textContent || ''),
    { timeout: WAIT_TIMEOUT }
  );
  const [download] = await Promise.all([
    adminPage.waitForEvent('download'),
    adminPage.click('[data-memo-download-day]'),
  ]);
  assert.ok(download.suggestedFilename().endsWith('.zip'));

  // Publishing is a single button on Memo's own admin tab now: the server
  // stitches the day's photos into an mp4 (1s each, see buildDayRecapVideo()
  // in memo.js) and stores it as that day's recap, which *is* what the Wall
  // player reads - so there's no separate publish step and no file to pick.
  await adminPage.click('[data-memo-publish-day]');
  await adminPage.waitForFunction(
    () => /\d/.test(document.querySelector('[data-memo-day-msg]')?.textContent || ''),
    { timeout: WAIT_TIMEOUT }
  );
  // The download-video button only exists once that day actually has one.
  await adminPage.waitForSelector('[data-memo-download-video]', { timeout: WAIT_TIMEOUT });
  const [videoDownload] = await Promise.all([
    adminPage.waitForEvent('download'),
    adminPage.click('[data-memo-download-video]'),
  ]);
  assert.ok(videoDownload.suggestedFilename().endsWith('.mp4'));

  // Any logged-in guest (not just the uploader/admin) sees it on the Wall -
  // as a real post now, which is what lets the owner pin or delete it from
  // the admin history like anything else (see createVideoPost() in plaza.js).
  await page.click('[data-tab="plaza"]');
  await page.waitForSelector('.plaza-post-video video', { timeout: WAIT_TIMEOUT });

  // And it shows up in the Wall admin history with working pin/remove.
  await adminPage.click('[data-atab="plaza"]');
  await adminPage.waitForFunction(
    () => [...document.querySelectorAll('#plaza-posts-list .badge')]
      .some((b) => b.classList.contains('type-podium')),
    { timeout: WAIT_TIMEOUT }
  );
  const videoRow = adminPage.locator('#plaza-posts-list .user-row').first();
  await videoRow.locator('[data-pin-post]').click();
  await adminPage.waitForSelector('#plaza-posts-list .plaza-pinned-badge', { timeout: WAIT_TIMEOUT });

  await api('POST', '/admin/memo/wipe', { token: ADMIN });
  await context.close();
});

// Ivo could not upload to Memo from a laptop. Two faults in one line of
// markup: capture="environment" is meaningless without a camera and only
// narrows what the picker offers, and accept was image/* on an input whose
// server has always taken video too - so the video half of the feature was
// unreachable from every device, phone included.
/**
 * Draws a picture whose sides cannot be confused: a red left half with a
 * white bar near the left edge, a blue right half with a white disc near the
 * right. Returned as PNG bytes ready to hand to a file input.
 *
 * Colour rather than the word "LEFT" on purpose - text would need reading
 * back with OCR, where a pixel two-thirds of the way across is either blue
 * or it is not.
 */
async function leftRightPhoto(page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const x = c.getContext('2d');
    // Flat halves, nothing else. A white marker was tried and made the test
    // lie: object-fit: cover crops the sides, so the sample point landed on
    // the marker rather than the colour and every reading came back the
    // same. Two solid fields cannot do that.
    x.fillStyle = '#e02020'; x.fillRect(0, 0, 200, 300);
    x.fillStyle = '#2040e0'; x.fillRect(200, 0, 200, 300);
    return c.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** Samples a rendered element by screenshotting it and reading the pixels
 * back through a canvas - so what is measured is what is on the screen,
 * transforms and all, not what is in the file. */
async function sampleRendered(page, selector) {
  const shot = await (await page.$(selector)).screenshot({ type: 'png' });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    // Well inside each half: .memo-feed-thumb is object-fit: cover, so the
    // outer edges may be cropped away entirely. A quarter in from each side
    // still lands in the right field even after a heavy crop.
    const at = (fx) => {
      const d = x.getImageData(Math.round(c.width * fx), Math.round(c.height * 0.5), 1, 1).data;
      // Anything that is neither clearly red nor clearly blue is reported as
      // such rather than guessed at - a sampler that quietly calls white
      // "blue" is how this test passed itself the first time.
      if (d[0] > d[2] + 40) return 'red';
      if (d[2] > d[0] + 40) return 'blue';
      return `neither (rgb ${d[0]},${d[1]},${d[2]})`;
    };
    return { left: at(0.25), right: at(0.75) };
  }, shot.toString('base64'));
}

test('a photo with a red left and a blue right comes out of Memo the same way round', async () => {
  // Ivo's idea, and a better test than the one I wrote first: rather than
  // reasoning about EXIF tags, push a picture through whose sides cannot be
  // confused and look at what lands on the screen. Every earlier attempt at
  // this asserted metadata, which is exactly how I managed to ship a fix
  // pointing the wrong way.
  //
  // Measured from a screenshot of the rendered <img>, so a CSS transform,
  // an EXIF flag or a rewritten file would all show up here identically -
  // as the wrong colour on the wrong side.
  const shooter = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Left Right Tester' } });
  const todayRes = await api('GET', '/memo/today', { token: shooter.token });
  const slot = todayRes.slots.find((sl) => sl.status === 'waiting') ?? todayRes.slots[0];
  markMemoSlotNotified(slot.id);

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, shooter.token);
  await page.click('[data-tab="memo"]');
  await page.waitForSelector(`button.memo-dot.memo-dot-open[data-memo-upload-btn="${slot.id}"]`, { timeout: WAIT_TIMEOUT });

  const photo = await leftRightPhoto(page);
  await page.setInputFiles(`[data-memo-file-input="${slot.id}"]`, { name: 'sides.png', mimeType: 'image/png', buffer: photo });
  await page.waitForSelector('.memo-feed-item-mine img.memo-feed-thumb', { timeout: WAIT_TIMEOUT });
  await page.waitForFunction(
    () => document.querySelector('.memo-feed-item-mine img.memo-feed-thumb')?.naturalWidth > 0,
    { timeout: WAIT_TIMEOUT },
  );

  // Uploading must not turn anything round. This is the assertion that would
  // have caught the mirrored-fix-pointing-the-wrong-way on the day.
  const asPosted = await sampleRendered(page, '.memo-feed-item-mine img.memo-feed-thumb');
  assert.deepEqual(
    asPosted, { left: 'red', right: 'blue' },
    `a photo posted to Memo must keep its sides - got ${JSON.stringify(asPosted)}`,
  );

  // And the mirror button has to genuinely swap them, not merely set a class.
  await page.click('[data-memo-flip]');
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.memo-feed-item-mine img.memo-feed-thumb')).transform.startsWith('matrix(-1'),
    { timeout: WAIT_TIMEOUT },
  );
  const mirrored = await sampleRendered(page, '.memo-feed-item-mine img.memo-feed-thumb');
  assert.deepEqual(
    mirrored, { left: 'blue', right: 'red' },
    `tapping mirror has to actually swap the sides on screen - got ${JSON.stringify(mirrored)}`,
  );

  // Tapping again puts it back, because the point is comparing the two.
  await page.click('[data-memo-flip]');
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.memo-feed-item-mine img.memo-feed-thumb')).transform === 'none',
    { timeout: WAIT_TIMEOUT },
  );
  assert.deepEqual(await sampleRendered(page, '.memo-feed-item-mine img.memo-feed-thumb'), { left: 'red', right: 'blue' });

  await context.close();
  await api('DELETE', `/admin/users/${shooter.id}`, { token: ADMIN });
});

test('a photo attached to a Wall post survives the resize the same way round', async () => {
  // The same check on the other photo path, which is the riskier of the two:
  // a Wall photo is redrawn onto a canvas in the browser before it is sent
  // (resizePhotoToJpeg in photo.js), and a canvas redraw is exactly where an
  // orientation quietly gets applied twice or dropped. Memo uploads the file
  // untouched; this one does not.
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Wall Sides Viewer' } });

  const adminContext = await iphoneContext('iPhone 13');
  const adminPage = await loginPage(adminContext, ADMIN, '/settings.html');
  await adminPage.click('[data-atab="plaza"]');
  await waitOrExplain(adminPage, '#plaza-post-form');
  await adminPage.fill('#plaza-post-text', 'a casa, de frente');
  await pickPhotoViaButton(adminPage, '#plaza-post-photo-btn', {
    name: 'sides.png', mimeType: 'image/png', buffer: await leftRightPhoto(adminPage),
  });
  await waitOrExplain(adminPage, '#plaza-post-photo-preview:not(.hidden)');
  await adminPage.click('#plaza-post-submit');
  await adminPage.waitForTimeout(400);
  await adminContext.close();

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, guest.token);
  await waitOrExplain(page, '.plaza-post-photo');
  await page.waitForFunction(
    () => document.querySelector('.plaza-post-photo')?.naturalWidth > 0,
    { timeout: WAIT_TIMEOUT },
  );

  const shown = await sampleRendered(page, '.plaza-post-photo');
  assert.deepEqual(
    shown, { left: 'red', right: 'blue' },
    `a photo published to the Wall must keep its sides through the resize - got ${JSON.stringify(shown)}`,
  );

  await context.close();
  await api('DELETE', `/admin/users/${guest.id}`, { token: ADMIN });
});

test('tapping mirror actually flips the photo on screen, and it survives a reload', async () => {
  // The browser half. What matters is not that a flag was stored but that
  // the picture on screen turns round - the control exists so somebody can
  // look at their own face and decide, which is worthless if the change
  // waits for the next poll or for a round trip to finish.
  const shooter = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Mirror Tapper' } });
  const todayRes = await api('GET', '/memo/today', { token: shooter.token });
  const slot = todayRes.slots.find((sl) => sl.status === 'waiting') ?? todayRes.slots[0];
  markMemoSlotNotified(slot.id);

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, shooter.token);
  await page.click('[data-tab="memo"]');
  // Shot through the real picker, the way the moment is actually captured.
  await page.waitForSelector(`button.memo-dot.memo-dot-open[data-memo-upload-btn="${slot.id}"]`, { timeout: WAIT_TIMEOUT });
  await page.setInputFiles(`[data-memo-file-input="${slot.id}"]`, { name: 'me.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await waitOrExplain(page, '[data-memo-flip]');

  const transformOf = () => page.$eval('.memo-feed-thumb', (el) => getComputedStyle(el).transform);
  assert.equal(await transformOf(), 'none', 'nothing is mirrored until asked');

  await page.click('[data-memo-flip]');
  // matrix(-1, 0, 0, 1, 0, 0) is scaleX(-1). Asserting the computed
  // transform rather than the class, because a class that styles nothing
  // would pass a class assertion and leave the photo exactly as it was.
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.memo-feed-thumb')).transform.startsWith('matrix(-1'),
    { timeout: WAIT_TIMEOUT },
  );

  // And the choice is remembered, not just applied to the DOM in front of us.
  await page.reload();
  await page.click('[data-tab="memo"]');
  await waitOrExplain(page, '.memo-feed-thumb');
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.memo-feed-thumb')).transform.startsWith('matrix(-1'),
    { timeout: WAIT_TIMEOUT },
  );

  await context.close();
  await api('DELETE', `/admin/users/${shooter.id}`, { token: ADMIN });
});

test('the Memo picker takes video as well as stills, and drops capture where there is no camera', async () => {
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo Desktop' } });
  withFullMemoDay(() => {});
  const today = await api('GET', '/memo/today', { token: user.token });
  markMemoSlotNotified(today.slots[0].id);

  // A desktop-shaped context: fine pointer, no touch, so no camera to hand
  // off to. This is the case that did nothing at all.
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: false });
  const page = await loginPage(desktop, user.token);
  await page.click('[data-tab="memo"]');
  await page.waitForSelector('[data-memo-file-input]', { timeout: WAIT_TIMEOUT });

  const onDesktop = await page.$eval('[data-memo-file-input]', (el) => ({
    accept: el.getAttribute('accept'),
    capture: el.getAttribute('capture'),
  }));
  assert.match(onDesktop.accept, /video/, 'the server accepts video, so the picker must offer it');
  assert.match(onDesktop.accept, /image/, 'stills must still be offered');
  assert.equal(onDesktop.capture, null, 'capture only narrows the picker when there is no camera behind it');
  await desktop.close();

  // On a phone the capture attribute is the whole point of Memo - the dot
  // opens the camera rather than the library, so a moment is shot now
  // rather than dug out of last August.
  const phone = await iphoneContext('iPhone 13');
  const phonePage = await loginPage(phone, user.token);
  await phonePage.click('[data-tab="memo"]');
  await phonePage.waitForSelector('[data-memo-file-input]', { timeout: WAIT_TIMEOUT });
  const onPhone = await phonePage.$eval('[data-memo-file-input]', (el) => el.getAttribute('capture'));
  assert.equal(onPhone, 'environment', 'a phone should still go straight to the camera');
  await phone.close();

  await api('DELETE', `/admin/users/${user.id}`, { token: ADMIN });
});

test('Memo is gated behind ENABLE_MEMO - hidden from the tab bar and the admin panel when disabled', async () => {
  process.env.ENABLE_MEMO = 'false';
  try {
    const context = await iphoneContext('iPhone 13');
    const page = await loginPage(context, ADMIN, '/');
    assert.equal(await page.isVisible('[data-tab="memo"]'), false);
    const adminPage = await loginPage(context, ADMIN, '/settings.html');
    assert.equal(await adminPage.isVisible('[data-atab="memo"]'), false);
    await context.close();
  } finally {
    process.env.ENABLE_MEMO = 'true';
  }
});

/* ------------------ Regressions from the 1.8.45 bug sweep ---------------- */

test('the admin contestant form can actually attach a photo - its picker button was never wired', async () => {
  // The button, the hidden input and the preview box had all been in
  // settings.html from the start, but nothing in settings.js listened to
  // the button and the submit never sent a photo, so "escolher foto" was
  // dead on the admin side while the identical guest-side control worked.
  const night = 'swamp';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Admin Picker Guest' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="outfit"]');
  await page.waitForSelector('#admin-register-form', { timeout: WAIT_TIMEOUT });

  await pickPhotoViaButton(page, '#admin-register-photo-btn', {
    name: 'admin-entry.png', mimeType: 'image/png', buffer: PNG_1X1,
  });
  await page.waitForSelector('#admin-register-photo-preview:not(.hidden) img[src^="data:image/jpeg"]', { timeout: WAIT_TIMEOUT });

  await context.close();
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('DELETE', `/admin/users/${guest.id}`, { token: ADMIN });
});

test('an empty night gets a titled card of its own, and Best Outfit only speaks up when it has something to say', async () => {
  // With nothing running the tab used to be a hero line over empty space,
  // which reads as broken. The empty state is a real state, so it gets a
  // card and a title like everything else here rather than a stray line of
  // italics. Best Outfit stays quiet during registration, where its only
  // line would be "entries are open, put yours in" directly above the entry
  // card that says exactly that.
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Reg Phase Viewer' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);
  await page.click('[data-tab="outfit"]');
  await page.waitForSelector('#outfit-idle-card:not(.hidden)', { timeout: WAIT_TIMEOUT });

  assert.equal(await page.isVisible('#voting-card'), false, 'nothing started, nothing to say');
  const idleTitle = await page.textContent('#outfit-idle-card h2');
  assert.ok(idleTitle.trim().length > 0, 'the empty state is a titled component, not a loose note');
  // The switch governs the whole tab, so it belongs outside every card.
  assert.equal(await page.isVisible('#theme-switch'), true);
  assert.equal(
    await page.$eval('#theme-switch', (el) => !!el.closest('.card')),
    false,
    'the night switch should sit outside the cards, not inside one',
  );

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await page.waitForSelector('#register-card:not(.hidden)', { timeout: WAIT_TIMEOUT });
  assert.equal(await page.isVisible('#voting-card'), false, 'the entry card already says entries are open');
  assert.equal(await page.isVisible('#outfit-idle-card'), false, 'and it is not an empty night either');
  assert.equal(await page.isVisible('#theme-switch'), true, 'the switch survives every phase');

  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  await page.waitForSelector('#voting-card:not(.hidden)', { timeout: WAIT_TIMEOUT });

  await context.close();
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('DELETE', `/admin/users/${user.id}`, { token: ADMIN });
});

test('the consequence box shows how much room is left and stops at the cap', async () => {
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Counter Watcher' } });
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);
  await page.click('[data-tab="rata"]');
  await page.waitForSelector('#suggest-text', { timeout: WAIT_TIMEOUT });

  assert.equal((await page.textContent('#suggest-count')).trim(), '0/200', 'an untouched box reads as empty, not blank');

  await page.fill('#suggest-text', 'x'.repeat(30));
  assert.equal((await page.textContent('#suggest-count')).trim(), '30/200');
  assert.equal(await page.evaluate(() => document.getElementById('suggest-count').classList.contains('at-limit')), false);

  // The cap was always enforced, just silently - typing simply stopped.
  await page.fill('#suggest-text', 'y'.repeat(260));
  const value = await page.inputValue('#suggest-text');
  assert.equal(value.length, 200, 'the field itself still refuses more than the cap');
  assert.equal((await page.textContent('#suggest-count')).trim(), '200/200');
  assert.equal(
    await page.evaluate(() => document.getElementById('suggest-count').classList.contains('at-limit')),
    true,
    'and it says so instead of just going quiet',
  );

  await context.close();
  await api('DELETE', `/admin/users/${user.id}`, { token: ADMIN });
});

test('a results category subtitle never outranks the card header above it', async () => {
  // h3 had no size of its own and fell through to the UA default of
  // 1.17em, which is bigger than .card h2 - so "best outfit" and "miss
  // congeniality" both rendered larger than "resultados da votação".
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  // The standings moved behind the owner-only dot at the end of the Snatch
  // tab, so that is where the two category subtitles now live.
  await page.click('[data-atab="outfit"]');
  await page.waitForSelector('#votelog-secret-btn:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('#votelog-secret-btn');
  await page.waitForSelector('#voting-standings-card', { timeout: WAIT_TIMEOUT });

  const sizes = await page.evaluate(() => {
    const card = document.getElementById('voting-standings-card');
    const px = (el) => parseFloat(getComputedStyle(el).fontSize);
    return { h2: px(card.querySelector('h2')), h3s: [...card.querySelectorAll('h3')].map(px) };
  });
  assert.ok(sizes.h3s.length >= 2, 'both rounds should be labelled');
  for (const h3 of sizes.h3s) {
    assert.ok(h3 < sizes.h2, `a category subtitle (${h3}px) must be smaller than the card header (${sizes.h2}px)`);
  }
  await context.close();
});

test('a destructive button is visible in both modes, not just the one it was tuned in', async () => {
  // Ivo, testing on production: the Wall's remove button "cannot be seen" in
  // light mode. Measured at 1.30:1 - drawn, sized and clickable, and to the
  // eye simply not there.
  //
  // The cause is worth keeping, because the next person to touch these
  // tokens will hit it again. --danger is deliberately a PALE tint in light
  // mode, because it doubles as .error text on the login screen's dark
  // artwork. The outline button reused that same token on pale paper, so it
  // inherited a colour chosen for the opposite background. Hence
  // --danger-edge: a red that is tuned against paper in each mode, which is
  // the only thing this button should ever read from.
  //
  // Measured rather than asserted by colour so it survives a retune, and run
  // in BOTH modes because tuning one is exactly how this happened.
  const relLum = (css) => {
    const nums = css.match(/[\d.]+/g).slice(0, 3).map(Number);
    // Modern WebKit can hand back color(srgb 0 1 scale) as well as rgb(0 255).
    const chans = css.startsWith('color(') ? nums : nums.map((v) => v / 255);
    const [r, g, b] = chans.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (fg, bg) => {
    const [hi, lo] = [relLum(fg), relLum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };

  await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'wifi: mossycottage' } });

  for (const mode of ['light', 'dark']) {
    const context = await iphoneContext('iPhone 13');
    const page = await context.newPage();
    await page.goto(base + '/');
    await page.evaluate(([t, m]) => {
      localStorage.setItem('appivo_token', t);
      localStorage.setItem('appivo_mode', m);
    }, [ADMIN, mode]);
    await page.goto(base + '/settings.html');
    await page.waitForSelector('#admin-content:not(.hidden)', { timeout: WAIT_TIMEOUT });
    await page.click('[data-atab="plaza"]');
    await waitOrExplain(page, 'button.icon-action.danger');

    const seen = await page.$eval('button.icon-action.danger', (el) => {
      // The ground the button is actually drawn on, which is whichever
      // ancestor paints one - the button itself is transparent by design.
      let node = el;
      let bg = '';
      while (node) {
        const c = getComputedStyle(node).backgroundColor;
        if (c && c !== 'transparent' && !/,\s*0\)$/.test(c)) { bg = c; break; }
        node = node.parentElement;
      }
      return { fg: getComputedStyle(el).color, bg };
    });
    const contrast = ratio(seen.fg, seen.bg);
    assert.ok(
      contrast >= 4.5,
      `in ${mode} mode the Wall's remove button reads at ${contrast.toFixed(2)}:1 (${seen.fg} on ${seen.bg}) - it has to clear 4.5`,
    );
    await context.close();
  }
});

test('the day video is a card in the feed like every other post, not bare on the page', async () => {
  // Ivo: "the video of the day should have a post background like the others
  // on the wall."
  //
  // .plaza-post-video had no rule anywhere in styles.css, so it fell through
  // to the plain divider and sat straight on the page background between two
  // cards. Every other type had been boxed over time - announcement, podium,
  // poll, then links - and the video was the last one left.
  //
  // Asserted against a poll rather than against fixed colours, so a retune of
  // the palette moves both together and this keeps testing the thing it is
  // about: that the two read as the same kind of object.
  const day = today();
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const recapName = 'ui-recap.mp4';
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(MEMO_DIR, recapName),
  ]);
  db.prepare('INSERT INTO memo_recaps (day, file_path, mime_type, file_size) VALUES (?, ?, ?, ?)')
    .run(day, recapName, 'video/mp4', 1000);
  const owner = db.prepare('SELECT id FROM users WHERE is_owner = 1').get();
  db.prepare("INSERT INTO plaza_posts (type, author_id, text) VALUES ('video', ?, ?)").run(owner.id, day);
  // A poll to compare against - the video should be indistinguishable from it
  // as a container.
  await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'poll', text: 'quem traz o gelo?', options: ['eu', 'tu'] },
  });

  try {
    for (const mode of ['light', 'dark']) {
      const context = await iphoneContext('iPhone 13');
      const page = await loginPage(context, ADMIN);
      await page.evaluate((m) => localStorage.setItem('appivo_mode', m), mode);
      await page.goto(base + '/');
      await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
      await waitOrExplain(page, '.plaza-post-video');

      const box = (sel) => page.$eval(sel, (el) => {
        const cs = getComputedStyle(el);
        return {
          background: cs.backgroundColor,
          border: `${cs.borderTopWidth} ${cs.borderTopStyle}`,
          radius: cs.borderTopLeftRadius,
          padding: cs.paddingLeft,
        };
      });
      const video = await box('.plaza-post-video');
      const poll = await box('.plaza-post-poll');

      assert.deepEqual(
        video, poll,
        `in ${mode} mode the day video should be boxed exactly like a poll - got ${JSON.stringify(video)} against ${JSON.stringify(poll)}`,
      );
      // And specifically: it must actually paint a ground, not inherit the
      // page's. A transparent background is the bug this is about.
      const parts = video.background.match(/[\d.]+/g);
      assert.ok(
        parts && (parts.length < 4 || Number(parts[3]) > 0.9),
        `in ${mode} mode the day video post has no background of its own (${video.background})`,
      );
      await context.close();
    }
  } finally {
    db.prepare("DELETE FROM plaza_posts WHERE type = 'video' AND text = ?").run(day);
    db.prepare('DELETE FROM memo_recaps WHERE day = ?').run(day);
  }
});

test('the selected tab is the brightest one in the row, on every tab and in both modes', async () => {
  // Ivo: "plaza and snatch tab menu displayed when selected should be a bit
  // more bright like the other pages when selected - it's too faded."
  //
  // Measured, the selected tab was reading FAINTER than the unselected ones
  // it sits next to - Snatch in dark mode at 2.02:1 against neighbours at
  // 7.38:1, Plaza at 2.70 against 6.25. Cause: --clay-active was declared
  // once in the unscoped body.theme-* block, so the light-mode value went on
  // painting the selected tab in dark mode, where the dark block had already
  // moved --clay somewhere brighter. The var(--clay-active, var(--clay))
  // fallback could not save it either, because --clay-active was defined -
  // just wrong.
  //
  // The assertion is deliberately relative as well as absolute. "Clears
  // 4.5:1" alone would have passed a row where the selected tab was still
  // the dimmest thing in it, which is precisely the bug a person sees.
  const relLum = (css) => {
    const nums = css.match(/[\d.]+/g).slice(0, 3).map(Number);
    const chans = css.startsWith('color(') ? nums : nums.map((v) => v / 255);
    const [r, g, b] = chans.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (fg, bg) => {
    const [hi, lo] = [relLum(fg), relLum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };

  const failures = [];
  for (const mode of ['light', 'dark']) {
    const context = await iphoneContext('iPhone 13');
    const page = await loginPage(context, ADMIN);
    await page.evaluate((m) => localStorage.setItem('appivo_mode', m), mode);
    await page.goto(base + '/');
    await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });

    for (const tab of ['plaza', 'rata', 'outfit', 'chat', 'memo']) {
      await page.click(`.tab[data-tab="${tab}"]`);
      // Each tab swaps the whole body theme, so let the new palette settle
      // before reading colours off it.
      await page.waitForFunction(
        (t) => document.querySelector(`.tab[data-tab="${t}"]`)?.classList.contains('active'),
        tab,
        { timeout: WAIT_TIMEOUT },
      );
      await page.waitForTimeout(250);

      const seen = await page.evaluate((t) => {
        const el = document.querySelector(`.tab[data-tab="${t}"]`);
        // The ground the row is actually drawn on - tabs are transparent by
        // design, so walk up to whatever paints one. An alpha of 0 is what
        // disqualifies an ancestor; checking the string for a trailing ", 0)"
        // would also match an opaque rgb(138, 106, 0), which is a real colour
        // in this app's gold theme.
        let node = el.parentElement;
        let bg = '';
        while (node) {
          const c = getComputedStyle(node).backgroundColor;
          const parts = c.match(/[\d.]+/g);
          if (parts && (parts.length < 4 || Number(parts[3]) > 0.9)) { bg = c; break; }
          node = node.parentElement;
        }
        const idle = [...document.querySelectorAll('.tab')].find((x) => !x.classList.contains('active'));
        return {
          label: el.textContent.trim(),
          active: getComputedStyle(el).color,
          idle: getComputedStyle(idle).color,
          bg,
        };
      }, tab);

      const active = ratio(seen.active, seen.bg);
      const idle = ratio(seen.idle, seen.bg);
      if (active < 4.5) {
        failures.push(`${mode}/${seen.label}: selected reads ${active.toFixed(2)}:1, under AA`);
      }
      if (active < idle) {
        failures.push(
          `${mode}/${seen.label}: selected (${active.toFixed(2)}:1) is fainter than the unselected tabs (${idle.toFixed(2)}:1)`,
        );
      }
    }
    await context.close();
  }
  assert.deepEqual(failures, [], `selected tabs that do not stand out:\n  ${failures.join('\n  ')}`);
});

test('an admin attaches a photo to a Wall post and every guest sees it in the feed', async () => {
  // The browser half of the photos-on-posts feature. The API test covers the
  // three edit intentions; this covers the path a person actually takes -
  // the drawn "escolher foto" button standing in for a hidden file input,
  // the client-side resize to JPEG, and the picture arriving in somebody
  // else's feed.
  //
  // It has to be a guest looking, not the admin who posted: the photo is
  // fetched with the key in the query string because an <img> cannot send an
  // Authorization header, and a route that only worked for the poster would
  // pass any check made from the admin's own session.
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Wall Photo Viewer' } });

  const adminContext = await iphoneContext('iPhone 13');
  const adminPage = await loginPage(adminContext, ADMIN, '/settings.html');
  await adminPage.click('[data-atab="plaza"]');
  await waitOrExplain(adminPage, '#plaza-post-form');
  await adminPage.fill('#plaza-post-text', 'a casa por dentro');
  await pickPhotoViaButton(adminPage, '#plaza-post-photo-btn', {
    name: 'casa.png', mimeType: 'image/png', buffer: PNG_1X1,
  });
  // The preview appearing is what tells the admin the file was taken - the
  // resize is async, so publishing before it lands would post without one.
  await waitOrExplain(adminPage, '#plaza-post-photo-preview:not(.hidden)');
  await adminPage.click('#plaza-post-submit');
  await adminPage.waitForTimeout(400);
  await adminContext.close();

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, guest.token);
  await waitOrExplain(page, '.plaza-post-photo');

  // Rendered is not the same as loaded: a broken src still produces an <img>
  // in the DOM, and a JSON-serialized BLOB served as an image is exactly the
  // failure that would leave one here. naturalWidth is 0 until real pixels
  // have decoded.
  const shown = await page.$eval('.plaza-post-photo', (el) => ({
    src: el.getAttribute('src'),
    decoded: el.naturalWidth > 0 && el.naturalHeight > 0,
  }));
  assert.match(shown.src, /\/api\/plaza-posts\/\d+\/photo\?token=/, 'the key has to travel in the query - an <img> cannot send a header');
  assert.ok(shown.decoded, 'the photo has to actually decode, not just be present as a tag');

  await context.close();
  await api('DELETE', `/admin/users/${guest.id}`, { token: ADMIN });
});

test('the settings user search is not something iOS password autofill will grab', async () => {
  // Settings also carries the change-key password fields, and Safari hunts
  // the page for a nearby text input to treat as the username - it popped
  // its Face ID sheet on this field every time settings opened.
  // autocomplete="off" does not stop that; not being a text field does.
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  const fields = await page.evaluate(() => ({
    search: document.getElementById('people-search').type,
    name: document.getElementById('people-search').getAttribute('name'),
    id: document.getElementById('people-search').id,
    current: document.getElementById('current-key-input').getAttribute('autocomplete'),
    next: document.getElementById('new-key-input').getAttribute('autocomplete'),
  }));
  assert.equal(fields.search, 'search', 'the user search must not be a plain text field');
  // Safari reads the name first and only falls back to the placeholder, and
  // this field had no name at all - so it read "procura ou cria um
  // utilizador", decided it was a username box, and focused it on its own
  // every time Settings opened. "search" is the value it maps to "nothing
  // to fill here". The id is checked too: it used to say "user-name".
  assert.equal(fields.name, 'search', 'the field needs a name Safari reads as a search box');
  assert.ok(
    !/user|name|nome|utilizador|email/i.test(fields.id),
    `the id must not read as a username field either, got "${fields.id}"`,
  );
  assert.equal(fields.current, 'current-password', 'the key fields must describe themselves, so Safari stops guessing');
  assert.equal(fields.next, 'new-password');

  // The anchor only works if autofill will actually consider it. WebKit
  // skips readonly fields, so a readonly anchor left the hunt running and
  // the search box still got grabbed - and it has to carry a real value,
  // since a username field with nothing in it anchors nothing.
  const anchor = await page.$eval('#change-key-username', (el) => ({
    autocomplete: el.getAttribute('autocomplete'),
    readOnly: el.readOnly,
    disabled: el.disabled,
    inChangeKeyForm: el.closest('form')?.id,
    value: el.value,
  }));
  assert.equal(anchor.autocomplete, 'username');
  assert.equal(anchor.readOnly, false, 'a readonly anchor is invisible to autofill, which defeats the point');
  assert.equal(anchor.disabled, false, 'so is a disabled one');
  assert.equal(anchor.inChangeKeyForm, 'change-key-form', 'it has to sit in the form with the password fields');
  assert.ok(anchor.value.length > 0, 'and it has to name the account, or there is no credential to pair');

  // The search box must not be in a form - a text input plus a button
  // inside one is the shape read as a sign-in.
  assert.equal(
    await page.$eval('#people-search', (el) => !!el.closest('form')),
    false,
    'the user search should not sit inside a form',
  );
  await context.close();
});

test('the status bar colour follows whichever theme is on screen', async () => {
  // <meta name="theme-color"> is what iOS tints the status bar with. It was
  // pinned to #e7e3d6 - a cream from a palette that no longer exists - so
  // the bar sat on one dead colour through every theme. It now reads the
  // page's own background back, which also means it cannot drift when a
  // theme is retuned.
  //
  // The subtle half: body animates its background over 0.45s, so a read
  // taken the instant a theme class flips returns the colour being animated
  // away from and the bar ends up a whole theme behind. Waiting past the
  // transition here is the point of the test, not incidental.
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Status Bar Watcher' } });
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);

  const themeColor = () => page.$eval('meta[name="theme-color"]', (m) => m.content);
  const pageBackground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  const seen = new Set();
  for (const tab of ['plaza', 'chat', 'rata', 'outfit']) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(700);
    const [meta, bg] = [await themeColor(), await pageBackground()];
    assert.equal(meta, bg, `on ${tab} the status bar should match the page, not the theme before it`);
    seen.add(meta);
  }
  assert.ok(seen.size > 1, 'different tabs should not all report the same colour');

  // And it has to track light/dark too, not just the section.
  const before = await themeColor();
  await page.click('#theme-toggle');
  await page.waitForTimeout(700);
  assert.notEqual(await themeColor(), before, 'switching mode should repaint the status bar');
  assert.equal(await themeColor(), await pageBackground());

  await context.close();
  await api('DELETE', `/admin/users/${user.id}`, { token: ADMIN });
});

test('logging in through the real form lands in the app, and hands the password manager a username', async () => {
  // The form path had no coverage at all - every other test logs in by
  // writing the token straight to localStorage - which is why turning the
  // submit into a navigation broke nothing here while changing how login
  // actually behaves.
  //
  // The navigation is the point: iOS only offers to save a password when a
  // form carrying one is submitted and the page then changes. An SPA that
  // swaps one section for another gives it no such signal, so the key was
  // never saved and guests retyped it every time. The username field is the
  // other half - a password with no account attached is not a credential.
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Form Login Guest' } });
  await api('POST', '/me/tutorial-seen', { token: user.token });

  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.waitForSelector('#login:not(.hidden)', { timeout: WAIT_TIMEOUT });

  assert.equal(
    await page.getAttribute('#token-input', 'autocomplete'),
    'current-password',
    'the key is a password and has to say so, or the manager will not store it',
  );

  // The reload wipes the field, and the only moment that matters is the one
  // just before it - that is when the browser reads the pair off the form.
  // sessionStorage survives the navigation; the field does not.
  await page.evaluate(() => {
    window.addEventListener('beforeunload', () => {
      sessionStorage.setItem('captured-username', document.getElementById('login-username').value);
    });
  });

  await page.fill('#token-input', user.token);
  await page.click('#login-submit-btn');
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });

  assert.equal(
    await page.evaluate(() => sessionStorage.getItem('captured-username')),
    // Stored with its capitals - the app only lowercases names on screen.
    'Form Login Guest',
    'the account name has to be in place before the page leaves, or the saved credential has no account attached',
  );
  // Waited for rather than sampled: this runs just after a real page load,
  // and reading #login the instant #app appears catches it mid-handover on
  // a slow run. Waiting asserts the same thing without racing the reload.
  await page.waitForSelector('#login', { state: 'hidden', timeout: WAIT_TIMEOUT });

  // Switching to find-my-key turns the same box into a name search, where
  // offering to fill a key would be nonsense.
  await page.evaluate(() => localStorage.clear());
  await page.goto(base + '/');
  await page.waitForSelector('#login:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('#find-key-link');
  assert.equal(await page.getAttribute('#token-input', 'autocomplete'), 'off');

  await context.close();
  await api('DELETE', `/admin/users/${user.id}`, { token: ADMIN });
});

// Every admin tab carries the same pair: fill this feature with test data,
// and empty it. They are the two halves of one job, so they have to look
// like it - and they did not: the seed button was a pale tile whose label
// flipped dark/light with the mode, directly above a danger twin whose
// label never flipped. Reading the computed colour off every pair on the
// page covers the hidden tabs too (wall, votelog), since a panel behind
// .hidden still resolves its styles - which is the point, because those are
// exactly the ones nobody checks by eye.
test('the populate and delete buttons carry one label colour, on every admin tab and in both modes', async () => {
  for (const mode of ['light', 'dark']) {
    const context = await iphoneContext('iPhone 13');
    const page = await loginPage(context, ADMIN, '/settings.html');
    await page.evaluate((m) => localStorage.setItem('appivo_mode', m), mode);
    await page.reload();
    await page.waitForSelector('#admin-content:not(.hidden)', { timeout: WAIT_TIMEOUT });
    // The mode switch fades colours in. Reading them mid-fade on a slow CI
    // runner caught one label at rgba(231, 231, 231, 0.976) - almost white,
    // and not a real difference - so let every running transition land first.
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));

    // Worded buttons only. A row action is destructive too, but it is an
    // icon in an outline now (see button.icon-action in styles.css) - it
    // carries the red in its stroke rather than as a label on a red
    // ground, so pooling it with these would be comparing two different
    // things and calling the difference a bug.
    const colours = await page.evaluate(() => {
      const seen = (sel) => [...document.querySelectorAll(sel)].map((el) => getComputedStyle(el).color);
      return { seed: seen('button.seed'), danger: seen('button.danger:not(.icon-action)') };
    });

    assert.ok(colours.seed.length >= 5, `expected a populate button on every feature tab, found ${colours.seed.length}`);
    assert.ok(colours.danger.length >= 5, `expected a delete button on every feature tab, found ${colours.danger.length}`);
    assert.equal(new Set(colours.seed).size, 1, `populate labels disagree in ${mode} mode: ${[...new Set(colours.seed)].join(' vs ')}`);
    assert.equal(new Set(colours.danger).size, 1, `delete labels disagree in ${mode} mode: ${[...new Set(colours.danger)].join(' vs ')}`);
    assert.equal(
      colours.seed[0],
      colours.danger[0],
      `populate and delete should read as a pair, got ${colours.seed[0]} and ${colours.danger[0]} in ${mode} mode`,
    );
    // And that shared colour is white, in both modes. It used to carry 45%
    // of the section's accent, which put a pink-white on one tab and a
    // green-white on the next - on the most consequential control an admin
    // page has.
    assert.match(
      colours.danger[0],
      /rgb\(255, 255, 255\)|#fff/,
      `wipe labels should be white in ${mode} mode, got ${colours.danger[0]}`,
    );
    await context.close();
  }
});

test('every solid button keeps its label readable, on the login screen and in both modes', async () => {
  // A real regression, shipped to QA: the login button paints --ink as its
  // ground and its label with the token the generic button rule names.
  // #login carries a fixed palette over the photo and declares only some
  // tokens, so when that rule moved from --paper-3 to --paper the label
  // fell through to the app's light-mode lilac and "entrar" went
  // pale-on-pale - unreadable, on the one screen every guest has to use.
  //
  // Contrast is measured rather than the colour asserted, so this keeps
  // working through any future retune of either palette.
  const relLum = (css) => {
    const [r, g, b] = css.match(/\d+/g).map(Number).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (fg, bg) => {
    const [hi, lo] = [relLum(fg), relLum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const mode of ['light', 'dark']) {
    const context = await iphoneContext('iPhone 13');
    const page = await context.newPage();
    await page.goto(base + '/');
    await page.evaluate((m) => localStorage.setItem('appivo_mode', m), mode);
    await page.goto(base + '/');
    await page.waitForSelector('#login:not(.hidden)', { timeout: WAIT_TIMEOUT });

    const { fg, bg } = await page.$eval('#login-submit-btn', (el) => {
      const s = getComputedStyle(el);
      return { fg: s.color, bg: s.backgroundColor };
    });
    const contrast = ratio(fg, bg);
    assert.ok(
      contrast >= 4.5,
      `in ${mode} mode "entrar" reads at ${contrast.toFixed(2)}:1 (${fg} on ${bg}) - it has to clear 4.5`,
    );
    await context.close();
  }
});

test('focusing the key field lights it up in the screen\'s own colours, not a browser outline', async () => {
  // The default focus-visible outline landed a hard salmon ring on the one
  // field every guest types into, over the photo, in a palette that belongs
  // to nothing else on that screen. Inputs now take a soft halo drawn from
  // --focus-ring, which #login redefines to its own cream.
  const context = await iphoneContext('iPhone 13');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.waitForSelector('#login:not(.hidden)', { timeout: WAIT_TIMEOUT });

  const before = await page.$eval('#token-input', (el) => getComputedStyle(el).borderColor);
  await page.focus('#token-input');
  await page.waitForTimeout(120);
  const after = await page.$eval('#token-input', (el) => {
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle, shadow: s.boxShadow, border: s.borderColor };
  });

  assert.equal(after.outline, 'none', 'the hard focus outline should be gone from text fields');
  assert.notEqual(after.shadow, 'none', 'a focused field still has to be visibly focused - the halo is missing');
  assert.notEqual(after.border, before, 'the border should also pick up the focus colour');

  // On-theme means the halo comes from #login's cream, not the app's clay.
  const [r, g, b] = after.border.match(/\d+/g).map(Number);
  assert.ok(r > 200 && g > 200 && b > 180,
    `the login halo should be the screen's cream, got ${after.border}`);

  await context.close();
});

test('the login screen does not resize itself when the keyboard opens', async () => {
  // dvh tracks the *dynamic* viewport, so every time iOS raised the keyboard
  // the min-height changed and the whole centred column slid up and back
  // down. svh is the small viewport - the keyboard-open size - so the layout
  // is already sitting where the keyboard would put it.
  const css = await (await fetch(base + '/css/styles.css')).text();
  const loginBlock = css.slice(css.indexOf('#login {'), css.indexOf('}', css.indexOf('#login {')));
  assert.ok(/min-height:\s*100svh/.test(loginBlock),
    '#login should size itself with svh so the keyboard cannot reflow it');
  assert.ok(!/min-height:\s*100dvh/.test(loginBlock),
    '#login is back on dvh - the page will jump again when the keyboard opens');
});

test('an empty Wall feed is a titled card too, not a stray line under the hero', async () => {
  // Matches the empty night on Snatch. Every other thing on these tabs is a
  // titled component, so a lone grey sentence floating below the hero reads
  // as something that failed to load rather than as "nothing yet".
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Empty Wall Viewer' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);
  await page.waitForSelector('#plaza-feed-empty:not(.hidden)', { timeout: WAIT_TIMEOUT });

  assert.equal(
    await page.$eval('#plaza-feed-empty', (el) => el.classList.contains('card')),
    true,
    'the empty state should be a card',
  );
  const title = await page.textContent('#plaza-feed-empty h2');
  assert.ok(title.trim().length > 0, 'and a card here always carries a title');

  // It goes away the moment there is something to show.
  await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'first post' } });
  await page.waitForSelector('#plaza-feed-empty', { state: 'hidden', timeout: WAIT_TIMEOUT });

  await context.close();
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  await api('DELETE', `/admin/users/${user.id}`, { token: ADMIN });
});

test('Miss Congeniality never offers you your own name, and its finished button reads like Best Outfit\'s', async () => {
  // castCongenialityVote() has always refused a self-vote, but the list
  // still showed you - so the only way to find out was to tap your own name
  // and be told off. Best Outfit already leaves you out; this matches it.
  const night = 'swamp';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const me = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cong Self Voter' } });
  const other = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cong Other Person' } });
  for (const u of [me, other]) {
    await api('POST', '/admin/contestants/register', {
      token: ADMIN, body: { userId: u.id, name: `${u.name} persona`, night },
    });
  }
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'open' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, me.token);
  await page.evaluate((n) => localStorage.setItem('appivo_night', n), night);
  await page.goto(base + '/?tab=outfit');
  await page.waitForSelector('#congeniality-card:not(.hidden) [data-congeniality-vote]', { timeout: WAIT_TIMEOUT });

  const names = await page.$$eval('[data-congeniality-vote]', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(names.length > 0, 'there should be someone to vote for');
  assert.ok(
    !names.some((n) => n.toLowerCase().includes('cong self voter')),
    `you should not be in your own congeniality list, but got: ${names.join(', ')}`,
  );
  assert.ok(names.some((n) => n.toLowerCase().includes('cong other person')), 'everyone else still is');
  await context.close();

  // Once revealed there is nowhere left to go, and the disabled button says
  // so in the same word Best Outfit uses for the same state.
  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'closed' } });
  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'revealed' } });

  const adminCtx = await iphoneContext('iPhone 13');
  const adminPage = await loginPage(adminCtx, ADMIN, '/settings.html');
  await adminPage.evaluate((n) => localStorage.setItem('appivo_night', n), night);
  await adminPage.reload();
  await adminPage.waitForSelector('#admin-content:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await adminPage.click('[data-atab="outfit"]');
  await adminPage.waitForSelector('#congeniality-advance-btn', { timeout: WAIT_TIMEOUT });
  await adminPage.waitForTimeout(800);

  assert.equal(await adminPage.isDisabled('#congeniality-advance-btn'), true, 'a finished round has no next step');
  // The phase button is an icon now - the phase itself is named right above
  // it - so the word it used to carry lives in its accessible name. Which
  // still has to be there, and still has to read as finished rather than as
  // a status word: one round reading "done" beside another reading
  // "revealed" was the bug this line was written for.
  const congLabel = (await adminPage.getAttribute('#congeniality-advance-btn', 'aria-label')).trim();
  assert.ok(congLabel.length > 0, 'the finished button still has to say what it is');
  assert.notEqual(congLabel, 'revelada', 'it should read as finished, the same word Best Outfit uses, not as a status');
  assert.equal(
    await adminPage.$eval('#congeniality-advance-btn', (el) => !!el.querySelector('svg')),
    true,
    'and it still carries its icon while disabled',
  );

  await adminCtx.close();
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  for (const u of [me, other]) await api('DELETE', `/admin/users/${u.id}`, { token: ADMIN });
});

test('the chosen night is remembered, on both the admin page and the app', async () => {
  // The admin switch kept its choice only in which button carried .active,
  // so every page load fell back to furnished - on a swamp night that is a
  // reach for the switch after every single open. It now shares the key the
  // guest app already used, so the two pages agree as well as persist.
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="outfit"]');
  await page.waitForSelector('#admin-night-switch', { timeout: WAIT_TIMEOUT });

  await page.click('#admin-night-switch [data-night="swamp"]');
  await page.waitForTimeout(400);

  await page.reload();
  await page.waitForSelector('#admin-content:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('[data-atab="outfit"]');
  assert.equal(
    await page.$eval('#admin-night-switch .active', (el) => el.dataset.night),
    'swamp',
    'the admin page should reopen on the night last chosen',
  );

  await page.goto(base + '/?tab=outfit');
  await page.waitForSelector('#theme-switch .active', { timeout: WAIT_TIMEOUT });
  assert.equal(
    await page.$eval('#theme-switch .active', (el) => el.dataset.theme),
    'swamp',
    'and the guest app should agree with it',
  );

  await context.close();
});

test('a solid button label takes its colour from the section it is in, not from one global tint', async () => {
  // The tokens behind these labels reference --clay, and a custom property
  // that references another resolves on the element where it is *declared*,
  // not where it is used. Declared on :root they computed against the base
  // accent and every theme got the same washed-out label - which looked
  // exactly like "the tint is too weak" rather than like a bug. Moving them
  // to body, where the theme's own --clay lives, is what makes them follow.
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');

  const labelOn = async (atab) => {
    await page.click(`[data-atab="${atab}"]`);
    await page.waitForTimeout(500);
    return page.$eval('#plaza-post-form button[type="submit"], [data-reveal-next]', (el) => getComputedStyle(el).color);
  };

  const wall = await labelOn('plaza');
  const rata = await labelOn('rata');
  assert.notEqual(wall, rata, `the Wall and Rata labels should not be the same colour (both ${wall})`);

  // And it has to still be readable, which is the whole reason the tint has
  // a ceiling at all.
  const contrast = await page.$eval('#plaza-post-form button[type="submit"], [data-reveal-next]', (el) => {
    const s = getComputedStyle(el);
    const lum = (css) => {
      const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
        const c = v <= 1 ? v : v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(s.color), lum(s.backgroundColor)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });
  assert.ok(contrast >= 4.5, `the tinted label still has to be readable, got ${contrast.toFixed(2)}:1`);

  await context.close();
});

test('filtering the user list does not yank the page out from under you', async () => {
  // Typing a name shortens the list, a shorter page cannot hold the scroll
  // position you were at, and the browser clamps it - so the page jumped
  // upward mid-word, exactly as the results appeared. Reported from a real
  // phone, where it is far more disruptive than on a desktop.
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.waitForSelector('#people-search', { timeout: WAIT_TIMEOUT });

  // Enough accounts for the list to be worth shortening.
  for (const name of ['Scroll Anna', 'Scroll Bruno', 'Scroll Carla', 'Scroll Diogo', 'Scroll Elsa']) {
    await api('POST', '/admin/users', { token: ADMIN, body: { name } });
  }
  await page.reload();
  await page.waitForSelector('#users-list .user-row', { timeout: WAIT_TIMEOUT });

  await page.$eval('#people-search', (el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.scrollY);

  await page.click('#people-search');
  await page.type('#people-search', 'carla', { delay: 60 });
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => window.scrollY);
  assert.ok(
    Math.abs(after - before) <= 2,
    `the page should stay put while the list filters, but it moved ${Math.abs(after - before)}px`,
  );
  // And the filter did actually run - otherwise this passes for the wrong reason.
  const rows = await page.$$eval('#users-list .user-row', (els) => els.length);
  assert.equal(rows, 1, 'exactly one account matches "carla"');

  // The role chips shorten the same list the same way, and were reported
  // separately - one shared helper covers both, so both are checked.
  await page.fill('#people-search', '');
  await page.waitForTimeout(300);
  await page.$eval('#user-role-filter', (el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const beforeChip = await page.evaluate(() => window.scrollY);
  await page.click('#user-role-filter [data-role="user"]');
  await page.waitForTimeout(400);
  const afterChip = await page.evaluate(() => window.scrollY);
  assert.ok(
    Math.abs(afterChip - beforeChip) <= 2,
    `toggling a role chip should not move the page, but it moved ${Math.abs(afterChip - beforeChip)}px`,
  );

  await context.close();
});

test('a guest writes their message on Plaza and can rewrite it; only the owner sees the collection', async () => {
  await api('POST', '/admin/dedications/wipe', { token: ADMIN });
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Dedication Writer' } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, guest.token);
  await page.click('[data-tab="chat"]');
  await page.waitForSelector('#dedication-text', { timeout: WAIT_TIMEOUT });

  await page.fill('#dedication-text', 'que noite, obrigado por tudo');
  await page.click('#dedication-save-btn');

  // Once written it reads as a message rather than as a form: the text sits
  // in a highlight box and the button offers to edit it.
  await page.waitForSelector('#dedication-area .highlight', { timeout: WAIT_TIMEOUT });
  assert.equal((await page.textContent('#dedication-area .highlight')).trim(), 'que noite, obrigado por tudo');
  assert.equal(await page.isVisible('#dedication-text'), false, 'the editor should be put away');
  assert.equal(await page.isVisible('#dedication-edit-btn'), true);

  // And it comes back that way after a reload, not as an empty form.
  await page.reload();
  await page.click('[data-tab="chat"]');
  await page.waitForSelector('#dedication-area .highlight', { timeout: WAIT_TIMEOUT });

  // A dedication laid out over several lines comes back laid out that way -
  // HTML would collapse the blank line and the run of spaces otherwise, and
  // in a message like this the shape is half the meaning.
  await page.click('#dedication-edit-btn');
  await page.waitForSelector('#dedication-text', { timeout: WAIT_TIMEOUT });
  const shaped = 'primeira linha\n\nsegunda,   com  espaços\nterceira';
  await page.fill('#dedication-text', shaped);
  await page.click('#dedication-save-btn');
  await page.waitForSelector('#dedication-area .highlight', { timeout: WAIT_TIMEOUT });
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.querySelector('#dedication-area .highlight')).whiteSpace),
    'pre-wrap',
    'the written dedication has to preserve its own line breaks and spacing',
  );
  assert.equal(await page.textContent('#dedication-area .highlight'), shaped);
  // Two lines of text really do occupy two lines on screen.
  const lineCount = await page.evaluate(() => {
    const el = document.querySelector('#dedication-area .highlight');
    const cs = getComputedStyle(el);
    return Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight));
  });
  assert.ok(lineCount >= 4, `a four-line dedication should render on four lines, got ${lineCount}`);

  await page.click('#dedication-edit-btn');
  await page.waitForSelector('#dedication-text', { timeout: WAIT_TIMEOUT });
  await page.fill('#dedication-text', 'que noite, obrigado por tudo');
  await page.click('#dedication-save-btn');
  await page.waitForSelector('#dedication-area .highlight', { timeout: WAIT_TIMEOUT });

  // Editing puts the box back with the text in it - people redraft these.
  await page.click('#dedication-edit-btn');
  await page.waitForSelector('#dedication-text', { timeout: WAIT_TIMEOUT });
  assert.equal(await page.inputValue('#dedication-text'), 'que noite, obrigado por tudo');
  await page.fill('#dedication-text', 'na verdade: a melhor noite');
  await page.click('#dedication-save-btn');
  await page.waitForSelector('#dedication-area .highlight', { timeout: WAIT_TIMEOUT });
  await context.close();

  const stored = await api('GET', '/admin/dedications', { token: ADMIN });
  assert.equal(stored.dedications.length, 1, 'rewriting replaces, it does not add a second');
  assert.equal(stored.dedications[0].text, 'na verdade: a melhor noite');

  // The owner reads them behind the same hidden dot as the rest of that tab.
  const ownerCtx = await iphoneContext('iPhone 13');
  const ownerPage = await loginPage(ownerCtx, ADMIN, '/settings.html');
  await ownerPage.click('[data-atab="memo"]');
  await ownerPage.waitForSelector('#wall-secret-btn:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await ownerPage.click('#wall-secret-btn');
  await ownerPage.waitForSelector('#dedications-card', { timeout: WAIT_TIMEOUT });
  const listed = await ownerPage.textContent('#dedications-list');
  assert.ok(listed.includes('na verdade: a melhor noite'), 'the message should be there');
  assert.ok(listed.toLowerCase().includes('dedication writer'), 'signed with who wrote it');
  assert.equal(await ownerPage.isDisabled('#dedications-pdf-btn'), false, 'and there is something to download');

  // No wipe button here: the whole-app data card already clears these along
  // with everything else, and a second delete-everything control sitting
  // next to the messages themselves was one more way to lose them by
  // accident. The endpoint stays (covered server-side) - only the button
  // that nobody needed is gone.
  assert.equal(await ownerPage.isVisible('#dedications-wipe-btn'), false, 'the redundant wipe button should be gone');
  await ownerCtx.close();

  await api('POST', '/admin/dedications/wipe', { token: ADMIN });
  await api('DELETE', `/admin/users/${guest.id}`, { token: ADMIN });
});

// A guest writing in Portuguese and a guest reading in English are the same
// party. This asserts what a person actually sees, not that an extra field
// arrived in the JSON.
//
// There is deliberately no "see original" control any more: Ivo's call on
// 13 Sept 2026 after seeing it on QA - the app's own language toggle is
// already that control, and a second one under every message was clutter
// on a screen that is mostly other people's messages.
test('a translated Wall post reads in your language, with no second control to manage', async () => {
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  const posted = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'announcement', text: 'o jantar é às oito' },
  });

  // Stands in for the API call - the suite never talks to Anthropic.
  db.prepare(`
    INSERT INTO translations (entity_type, entity_id, field, lang, text, status)
    VALUES ('plaza_post', ?, 'text', 'en', 'dinner is at eight', 'ok')
    ON CONFLICT(entity_type, entity_id, field, lang)
      DO UPDATE SET text = excluded.text, status = 'ok'
  `).run(posted.id);

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN);
  await page.evaluate(() => localStorage.setItem('appivo_lang', 'en'));
  await page.reload();
  await page.waitForSelector('.plaza-post', { timeout: WAIT_TIMEOUT });

  assert.equal(await page.$eval('.plaza-post-text', (el) => el.textContent.trim()), 'dinner is at eight');
  assert.equal(await page.$('.translation-toggle'), null, 'the per-message control was removed on purpose');

  // Exactly one paragraph of body text - the original must not be rendered
  // hidden alongside it, which is what the toggle used to need.
  const bodies = await page.$$eval('.plaza-post-text', (els) => els.length);
  assert.equal(bodies, 1, 'the original should not be shipped to the page at all');

  await context.close();
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
});

// Ivo could not get past closing the voting: the reveal button appeared to
// do nothing. It works - but each of the four reveals asks for confirmation,
// cancel is the focused button, and tapping outside the card also cancels.
// Declining used to be completely silent, so a stage that did not advance
// looked exactly like a stage that could not.
test('the reveal steps advance when confirmed, and say so when they are not', async () => {
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  const people = [];
  for (const name of ['Reveal Ana', 'Reveal Bruno']) {
    const u = await api('POST', '/admin/users', { token: ADMIN, body: { name } });
    people.push(u);
    await api('POST', '/admin/contestants', { token: ADMIN, body: { name, night, userId: u.id } });
  }
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  const roster = (await api('GET', `/votes/status?night=${night}`, { token: ADMIN })).contestants;
  for (let i = 0; i < people.length; i += 1) {
    await api('POST', '/votes', { token: people[i].token, body: { night, contestantId: roster[(i + 1) % roster.length].id } });
  }
  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN, body: { force: true } });

  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="outfit"]');
  await page.waitForSelector('#voting-advance-btn', { timeout: WAIT_TIMEOUT });

  const phase = async () => (await api('GET', `/votes/status?night=${night}`, { token: ADMIN })).resultsPhase;
  assert.equal(await phase(), 'hidden', 'closing should leave the night ready to reveal, not already revealed');

  // Cancelling must leave the night alone AND say something, or the button
  // reads as broken.
  await page.click('#voting-advance-btn');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('.modal-actions button:first-child');
  await page.waitForTimeout(300);
  assert.equal(await phase(), 'hidden', 'a declined confirmation must not advance the night');
  const msg = await page.$eval('#voting-msg', (el) => el.textContent.trim());
  assert.ok(msg.length > 0, 'declining silently is what made this look broken - it must say something');

  // And the screen has to change when a reveal *does* happen. The button is
  // the same arrow at every stage and its label lives in aria-label, which a
  // phone never shows - so without this the screen was byte-identical after
  // confirming, and four taps read as a dead button. This is the fault Ivo
  // actually hit; it was never about contestants or about being blocked.
  const stateLine = () => page.$eval('#voting-msg', (el) => el.textContent.trim());
  const beforeReveal = await stateLine();

  // Confirming advances it.
  await page.click('#voting-advance-btn');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('.modal-actions button:last-child');
  await page.waitForTimeout(900);
  assert.equal(await phase(), 'third', 'confirming should move the night on one stage');

  const afterReveal = await stateLine();
  assert.notEqual(afterReveal, beforeReveal,
    'the screen must visibly change when a position is revealed, or the button reads as dead');
  assert.ok(afterReveal.length > 0, 'the night should say what has been revealed so far');

  // Reveal the rest, then check the end state is not a dead end. A night
  // that has been fully revealed leaves this button disabled and reading
  // "done", and the only way to run it again is the reset beside it - which
  // is an icon with no words on it. Ivo hit exactly this and read it as the
  // button being jammed.
  for (let i = 0; i < 3; i += 1) {
    await page.click('#voting-advance-btn');
    await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
    await page.click('.modal-actions button:last-child');
    await page.waitForTimeout(500);
  }
  assert.equal(await phase(), 'all', 'four confirmed reveals should finish the night');
  assert.equal(await page.$eval('#voting-advance-btn', (el) => el.disabled), true,
    'with everything revealed there is nothing left for this button to do');
  const endMsg = await page.$eval('#voting-msg', (el) => el.textContent.trim());
  assert.ok(endMsg.length > 0,
    'a disabled button with no explanation is a dead end - it must say how to run the night again');

  await context.close();
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  for (const p of people) await api('DELETE', `/admin/users/${p.id}`, { token: ADMIN });
});

// The same complaint as the tour, one screen over: dialogs put the end of
// one sentence and the start of the next on the same line. They come from
// one place (modal.js), so every confirm in the app is fixed or none is -
// this checks the Memo one Ivo was looking at, and then a second from
// somewhere else to be sure it is the shared path and not a special case.
test('a dialog never puts two sentences on one line', async () => {
  const context = await iphoneContext('iPhone SE');
  const page = await loginPage(context, ADMIN, '/settings.html');
  await page.click('[data-atab="memo"]');
  await page.waitForSelector('#memo-trigger-btn', { timeout: WAIT_TIMEOUT });

  // "this opens the next moment and notifies everyone. continue?" - two
  // sentences, and the one he was looking at.
  await page.click('#memo-trigger-btn');
  await page.waitForSelector('.modal-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });

  const readModal = () => page.$eval('.modal-message', (el) => ({
    text: el.textContent.trim(),
    whiteSpace: getComputedStyle(el).whiteSpace,
    // How many lines the browser actually laid out, rather than how many we
    // asked for - the point is what a person sees.
    lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
  }));

  const memo = await readModal();
  const sentences = memo.text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 1) {
    assert.ok(memo.text.includes('\n'),
      `two sentences with no break between them: "${memo.text}"`);
    assert.ok(memo.lines >= sentences.length,
      'each sentence should occupy at least its own line');
  }
  assert.equal(memo.whiteSpace, 'pre-line', 'the newlines only render because of this');

  await page.click('.modal-actions button:first-child');
  await context.close();
});

test('the app tour never puts two sentences on one line', async () => {
  // Ivo's note, 13 Sept 2026: several steps are two short sentences, and
  // letting them wrap freely put the end of one and the start of the next
  // on the same line. Each sentence gets its own line now.
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Tour Reader' } });
  const context = await iphoneContext('iPhone SE');
  const page = await context.newPage();
  await page.goto(base + '/');
  await page.evaluate((tok) => localStorage.setItem('appivo_token', tok), user.token);
  await page.goto(base + '/');
  await page.waitForSelector('#app:not(.hidden)', { timeout: WAIT_TIMEOUT });
  // The tour asks for a language before it shows any content.
  await page.waitForSelector('#tutorial-overlay:not(.hidden)', { timeout: WAIT_TIMEOUT });
  await page.click('#tutorial-lang-pt');
  await page.waitForSelector('#tutorial-content-step:not(.hidden)', { timeout: WAIT_TIMEOUT });

  // Walk every step and check none of them renders a sentence boundary
  // mid-line. A <br> between sentences is what makes that true.
  for (let step = 0; step < 8; step += 1) {
    const html = await page.$eval('#tutorial-text', (el) => el.innerHTML);
    const text = await page.$eval('#tutorial-text', (el) => el.textContent.trim());
    const sentences = text.split(/(?<=\.)\s+/).filter(Boolean);
    if (sentences.length > 1) {
      assert.ok(html.includes('<br>'),
        `step ${step} has ${sentences.length} sentences but no line break: "${text}"`);
    }
    const next = await page.$('#tutorial-next');
    if (!next || !(await next.isVisible())) break;
    await next.click();
    await page.waitForTimeout(120);
  }

  await context.close();
  await api('DELETE', `/admin/users/${user.id}`, { token: ADMIN });
});

test('switching language repaints every visible string at once, not on the next poll', async () => {
  // applyI18n() only rewrites nodes carrying data-i18n. Anything a render
  // function bakes into innerHTML is invisible to it, so those strings used
  // to sit in the old language until that view's next poll - seconds, on a
  // tab you were looking at. Reported as "the language switch is slow"; it
  // was not slow, it was not happening.
  await api('POST', '/admin/chat/wipe', { token: ADMIN });
  const user = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Language Switcher' } });
  const context = await iphoneContext('iPhone 13');
  const page = await loginPage(context, user.token);

  // Sampled right after the click, with no waiting at all: anything that
  // needs a poll to catch up fails here, which is the point.
  const switchAndRead = async (tab, selector) => {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForSelector(selector, { timeout: WAIT_TIMEOUT });
    const before = (await page.textContent(selector)).trim();
    const started = Date.now();
    await page.click('#lang-toggle');
    await page.waitForFunction(
      ([sel, was]) => {
        const el = document.querySelector(sel);
        return !!el && el.textContent.trim() !== was;
      },
      [selector, before],
      { timeout: 2000 },
    );
    return { tab, ms: Date.now() - started, before, after: (await page.textContent(selector)).trim() };
  };

  const results = [];
  // One of each kind, deliberately. The hero lines carry data-i18n and were
  // never the problem; .chat-empty is written into innerHTML by loadChat()
  // and is exactly the string that used to lag. A selector that can fall
  // back to a data-i18n node would pass either way and prove nothing.
  results.push(await switchAndRead('rata', '#tab-rata .hero-line'));
  results.push(await switchAndRead('chat', '#tab-chat .chat-empty'));

  for (const r of results) {
    assert.notEqual(r.after, r.before, `${r.tab} did not change language at all`);
    assert.ok(r.ms < 1500, `${r.tab} took ${r.ms}ms to change language - it should be immediate`);
  }

  await context.close();
  await api('DELETE', `/admin/users/${user.id}`, { token: ADMIN });
});
