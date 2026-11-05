// Public demo mode (src/demo.js). DEMO_MODE is read once at startup, so it
// gets its own file: everything here boots the app with it on, against a
// throwaway database seeded the way the demo server seeds itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `appdoivo-demo-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_FILE = DB;
process.env.TOKEN_SECRET = 'demo-test-secret';
process.env.DEMO_MODE = 'true';
process.env.ANTHROPIC_API_KEY = '';
process.env.ENABLE_PLAZA = 'true';
process.env.CANONICAL_HOST = 'festa-demo.appdoivo.com';
process.env.REDIRECT_HOSTS = 'appdoivo-demo.fly.dev';

const { default: app } = await import('../src/app.js');
const { seedDemo } = await import('../src/seedDemo.js');
seedDemo();

let server;
let base;
before(async () => {
  server = createServer(app).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => {
  server?.close();
  for (const ext of ['', '-wal', '-shm']) {
    try { rmSync(DB + ext); } catch { /* ignore */ }
  }
});

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function demoKeys() {
  const { data } = await api('GET', '/demo');
  return Object.fromEntries(data.keys.map((k) => [k.role, k.key]));
}

test('the demo offers a guest key and an admin key, and both log in as what they say', async () => {
  const keys = await demoKeys();
  const guest = await api('POST', '/auth/login', { body: { token: keys.guest } });
  const admin = await api('POST', '/auth/login', { body: { token: keys.admin } });
  assert.equal(guest.status, 200);
  assert.equal(admin.status, 200);

  const guestMe = await api('GET', '/me', { token: keys.guest });
  const adminMe = await api('GET', '/me', { token: keys.admin });
  assert.ok(!guestMe.data.isAdmin, 'the guest key is a regular guest');
  assert.ok(adminMe.data.isAdmin, 'the admin key opens the admin panel');
  assert.ok(!adminMe.data.isOwner, 'but it is not the owner - keys and pseudonyms stay hidden');
});

test('nobody can lock the next visitor out of the shared keys', async () => {
  const keys = await demoKeys();
  const changed = await api('POST', '/me/change-token', { token: keys.guest, body: { currentToken: keys.guest, newToken: 'mine12345' } });
  assert.equal(changed.status, 403);
  assert.equal(changed.data.error, 'err_demo_disabled');
  assert.equal((await api('POST', '/auth/login', { body: { token: keys.guest } })).status, 200, 'the shared key still works');
});

test('what a stranger could abuse, or what wipes the demo for everyone, is refused', async () => {
  const { guest, admin } = await demoKeys();
  const refused = [
    ['POST', '/chat/messages', guest, { text: 'hello' }],
    ['POST', '/admin/plaza-posts', admin, { type: 'links', text: 'links', links: [{ emoji: '🔗', label: 'x', url: 'https://example.com' }] }],
    ['POST', '/admin/consequences/wipe', admin],
    ['POST', '/admin/plaza-posts/wipe', admin],
    ['POST', '/admin/voting/furnished/reset-all', admin],
    ['POST', '/admin/contestants/seed-demo', admin],
    ['DELETE', '/admin/contestants/1', admin],
    ['PUT', '/admin/settings', admin, {}],
  ];
  for (const [method, path, token, body] of refused) {
    const res = await api(method, path, { token, body });
    assert.equal(res.status, 403, `${method} ${path} should be refused in the demo`);
    assert.equal(res.data.error, 'err_demo_disabled');
  }
});

test('the rest of the app still works: a plain announcement and a guest vote', async () => {
  const { guest, admin } = await demoKeys();
  const post = await api('POST', '/admin/plaza-posts', { token: admin, body: { type: 'announcement', text: 'hello from the demo' } });
  assert.ok(post.status < 300, `an announcement is fine: ${JSON.stringify(post.data)}`);

  const { posts } = (await api('GET', '/plaza-posts', { token: guest })).data;
  const poll = posts.find((p) => p.type === 'poll');
  assert.ok(poll, 'the demo seeds a poll');
  const vote = await api('POST', `/plaza-posts/${poll.id}/vote`, { token: guest, body: { optionId: poll.options[0].id } });
  assert.ok(vote.status < 300, `voting on the seeded poll works: ${JSON.stringify(vote.data)}`);
});

test('an uploaded photo is swapped for the placeholder, so entering an outfit still works', async () => {
  const { guest, admin } = await demoKeys();
  await api('POST', '/admin/voting/swamp/registration', { token: admin });

  // Not a real JPEG at all - in the demo it never reaches the decoder.
  const res = await api('POST', '/outfit/register', { token: guest, body: { night: 'swamp', name: 'Lily Pad', photoBase64: 'data:image/png;base64,AAAA' } });
  assert.ok(res.status < 300, `registration with a photo works in the demo: ${JSON.stringify(res.data)}`);
});

// GET with a chosen Host header (fetch() won't let you set Host).
function getAs(host, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => { res.resume(); resolve(res); }).on('error', reject).end();
  });
}

test('the old fly.dev address forwards to festa-demo.appdoivo.com', async () => {
  for (const host of ['appdoivo-demo.fly.dev']) {
    const res = await getAs(host, '/plaza?x=1');
    assert.equal(res.statusCode, 301, host);
    assert.equal(res.headers.location, 'https://festa-demo.appdoivo.com/plaza?x=1', host);
  }
});

test('the demo domain and unlisted hosts (health checks) are served directly, not redirected', async () => {
  for (const host of ['festa-demo.appdoivo.com', '172.19.0.2:3000']) {
    const res = await getAs(host, '/api/health');
    assert.notEqual(res.statusCode, 301, host);
  }
});

// The keys sat inside the hidden strip above the screen once the login gained the
// painting behind the clock (#15), so phones could not see or tap them. Real browser,
// iPhone and desktop sizes: both keys must be fully on screen and one tap logs in.
test('the shared keys are on screen and one tap logs in, on a phone and a desktop', async () => {
  const { webkit, devices } = await import('playwright');
  const browser = await webkit.launch();
  try {
    for (const device of [devices['iPhone 13'], devices['iPhone SE'], { viewport: { width: 1280, height: 800 } }]) {
      const page = await browser.newPage(device);
      await page.goto(base.replace(/\/api$/, '/'), { waitUntil: 'networkidle' });
      const keys = page.locator('#demo-keys-list button');
      assert.equal(await keys.count(), 2);
      for (const k of await keys.all()) {
        const onScreen = await k.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 0; });
        assert.ok(onScreen, `${JSON.stringify(device.viewport)}: demo key off screen`);
      }
      await keys.first().click({ timeout: 5000 });
      await page.locator('#app:not(.hidden)').waitFor({ timeout: 5000 });
      await page.close();
    }
  } finally { await browser.close(); }
});
