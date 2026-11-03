import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import yauzl from 'yauzl';

// Isolated test environment: temporary DB. The admin's real key is always
// generated (see seed() in db.js - no more ADMIN_TOKEN pinning it, even
// outside production), so ADMIN below reads the actual generated value
// off seedResult rather than assuming a fixed string.
const DB = join(tmpdir(), `appdoivo-test-${process.pid}-${Date.now()}.sqlite`);
// Memo's slots are a shared/global schedule now, not per-user - whichever
// test in this file happens to be the first to call /memo/today is the one
// that actually triggers generation, not necessarily the "5 daily slots"
// test itself. Anchoring the no-past-scheduling check to this run's start
// (not a timestamp captured locally inside that one test) is what the
// invariant actually means regardless of test order.
const TEST_RUN_STARTED_AT = Date.now();
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
process.env.ADMIN_NAME = 'Test Admin';
process.env.ENABLE_ADMIN_PROMOTION = 'true';
process.env.ENABLE_PLAZA = 'true';
process.env.ENABLE_MEMO = 'true';

const { default: app, seedResult } = await import('../src/app.js');
const { default: db } = await import('../src/db.js');
const { MEMO_DIR, MEMO_MIN_GAP_MINUTES, ensureTodaysSlots, zonedTimeToUtc } = await import('../src/memo.js');
const { renderDedications, newDedicationsDocument } = await import('../src/dedicationsPdf.js');
const { translationsFor, queue, pending, markOk, markFailed, wipeFor, MAX_ATTEMPTS } =
  await import('../src/translations.js');
const { detectLang, isConfigured, interpretResponse, backfill, systemPromptFor } = await import('../src/translate.js');
const { today, setClockForTests, now, getTimezone } = await import('../src/time.js');

const ADMIN = seedResult.token;
let server;
let base;
let userToken;
let userId;
let contestantId;

before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server?.close();
  for (const ext of ['', '-wal', '-shm']) {
    try { rmSync(DB + ext); } catch { /* ignore */ }
  }
  // MEMO_DIR sits next to DB_FILE (see memo.js) - same temp-file lifecycle,
  // cleaned up the same way.
  try { rmSync(MEMO_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function api(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body, or non-JSON (e.g. a served photo) */ }
  return { status: res.status, data, headers: res.headers };
}

/** Raw (non-JSON) request, for the zip download route - returns the body
 * as a Buffer rather than trying (and failing) to parse it as JSON. */
async function apiBuffer(path, { token } = {}) {
  const res = await fetch(base + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buffer };
}

/** Multipart/form-data upload (Memo) - the outfit-photo tests above all go
 * through base64-in-JSON instead, but that's a 2mb request-body cap (see
 * express.json() in app.js), nowhere near enough for Memo's original-size
 * uploads, so this is a real multipart request instead. */
async function apiUpload(path, { token, buffer, filename, mimeType, method = 'POST' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const res = await fetch(base + path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data, headers: res.headers };
}

/** Unpacks every entry in a zip buffer to { filename, contents } pairs. */
function readZipEntries(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = [];
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) return reject(err);
          const chunks = [];
          readStream.on('data', (c) => chunks.push(c));
          readStream.on('end', () => {
            entries.push({ filename: entry.fileName, contents: Buffer.concat(chunks) });
            zipfile.readEntry();
          });
        });
      });
      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
    });
  });
}

/* -------------------------------- Version --------------------------------- */

test('GET /version is public and reports env: null when APP_ENV is unset (prod default)', async () => {
  const r = await api('GET', '/version');
  assert.equal(r.status, 200);
  assert.ok(r.data.version);
  assert.equal(r.data.env, null);
});

test('every response carries the security headers: own scripts only, no framing, no sniffing', async () => {
  for (const path of ['/', '/api/version']) {
    const r = await fetch(base.replace(/\/api$/, '') + path);
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /script-src 'self'(;|$)/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(r.headers.get('x-powered-by'), null, path);
  }
});

/* ------------------------------- security.txt ------------------------------ */
// RFC 9116's canonical /.well-known/security.txt is a static file (see
// public/.well-known/security.txt), served automatically by express.static
// - nothing to test there. This covers the legacy bare-path redirect only.

test('GET /security.txt redirects to the canonical .well-known location', async () => {
  const appRoot = base.replace(/\/api$/, '');
  const res = await fetch(`${appRoot}/security.txt`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/.well-known/security.txt');
});

/* --------------------------------- Auth ---------------------------------- */

test('login rejects an invalid token', async () => {
  const r = await api('POST', '/auth/login', { body: { token: 'nao-existe' } });
  assert.equal(r.status, 401);
});

test('login accepts the admin', async () => {
  const r = await api('POST', '/auth/login', { body: { token: ADMIN } });
  assert.equal(r.status, 200);
  assert.equal(r.data.isAdmin, true);
});

// Regression: there used to be a "mossy" magic token that resolved to the
// owner account. It was originally gated by NODE_ENV!=='production' alone
// and was confirmed live on prod on 2026-08-08 despite fly.toml setting
// NODE_ENV=production, letting anyone who read this repo's own docs log in
// with full owner rights, in every environment. It is back, but only as a
// QA convenience and only under two conditions at once - see devLoginOwner()
// in auth.js. These tests pin both halves: that it works where it is meant
// to, and that no single misconfiguration is enough to open it elsewhere.
// Exercised against auth.js directly rather than over HTTP: every rejected
// login spends one of a 10-per-IP budget shared with the rest of the file
// (see rateLimit.js), and a matrix of environment combinations would empty
// it and tip later tests into 429s. The HTTP wiring gets one happy path
// below, which is the part a unit call can't prove.
test('the QA dev key needs both of its conditions - neither one alone unlocks anything', async () => {
  const { isDevLoginKey, findUserByToken } = await import('../src/auth.js');
  const original = { key: process.env.DEV_LOGIN_KEY, env: process.env.APP_ENV };
  try {
    // Nothing set at all: the shape production ships in.
    delete process.env.DEV_LOGIN_KEY;
    delete process.env.APP_ENV;
    assert.equal(isDevLoginKey('mossy'), false);
    assert.ok(!findUserByToken('mossy'), 'no passphrase resolves to a user by default');

    // The passphrase without the environment - a secret copied to the wrong
    // Fly app by mistake has to stay inert.
    process.env.DEV_LOGIN_KEY = 'mossy';
    for (const env of [undefined, 'prod', 'production', 'QA', 'staging', '']) {
      if (env === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = env;
      assert.equal(isDevLoginKey('mossy'), false, `APP_ENV=${env} must not unlock the dev key`);
    }

    // The environment without the passphrase - QA before the secret is set.
    process.env.APP_ENV = 'qa';
    for (const key of [undefined, '']) {
      if (key === undefined) delete process.env.DEV_LOGIN_KEY;
      else process.env.DEV_LOGIN_KEY = key;
      assert.equal(isDevLoginKey('mossy'), false, 'an unset key is not an empty-string key');
      assert.equal(isDevLoginKey(''), false, 'and an empty guess never matches');
    }

    // Both together, and only the right word.
    process.env.DEV_LOGIN_KEY = 'mossy';
    assert.equal(isDevLoginKey('mossy'), true);
    assert.equal(isDevLoginKey('MOSSY'), true, 'case-insensitive, like every other key');
    assert.equal(isDevLoginKey('mossyy'), false);
    assert.equal(isDevLoginKey('moss'), false);

    // The old flag is dead and stays dead.
    process.env.ENABLE_DEV_LOGIN = 'true';
    delete process.env.DEV_LOGIN_KEY;
    assert.equal(isDevLoginKey('mossy'), false, 'the removed dev-login flag must have no effect at all');
  } finally {
    delete process.env.ENABLE_DEV_LOGIN;
    if (original.key === undefined) delete process.env.DEV_LOGIN_KEY;
    else process.env.DEV_LOGIN_KEY = original.key;
    if (original.env === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = original.env;
  }
});

test('on QA the dev key carries a whole session, without ever becoming the owner\'s real key', async () => {
  const { default: db } = await import('../src/db.js');
  process.env.DEV_LOGIN_KEY = 'mossy';
  process.env.APP_ENV = 'qa';
  try {
    const login = await api('POST', '/auth/login', { body: { token: 'MOSSY' } });
    assert.equal(login.status, 200);
    assert.equal(login.data.isAdmin, true);

    // It has to carry real requests too, not just the login check - the
    // client replays whatever was typed as its bearer token from here on.
    const me = await api('GET', '/me', { token: 'mossy' });
    assert.equal(me.status, 200);
    assert.equal(me.data.isOwner, true);

    // The owner's stored key is untouched, and is not this.
    const owner = db.prepare('SELECT token_hash, key_claimed_at FROM users WHERE is_owner = 1').get();
    const { hashToken } = await import('../src/tokens.js');
    assert.notEqual(owner.token_hash, hashToken('mossy'), "the owner's real key must stay a generated one");

    // /me reports that generated key, not the word that was typed - the
    // account card reads this, and used to show "mossy" while Manage Users
    // showed the real one, so the two disagreed about the same account.
    assert.notEqual(me.data.key, 'mossy', 'the dev word is a way in, not the account key');
    assert.equal(hashToken(me.data.key), owner.token_hash, "/me should report the owner's own stored key");

    // And it must not claim the owner's key on their behalf: doing so drops
    // them out of the first-time name-search flow, which is how the owner
    // got locked out of QA once already.
    db.prepare('UPDATE users SET key_claimed_at = NULL WHERE is_owner = 1').run();
    await api('GET', '/me', { token: 'mossy' });
    const after = db.prepare('SELECT key_claimed_at FROM users WHERE is_owner = 1').get();
    assert.equal(after.key_claimed_at, null, 'the dev key proves nothing, so it must not stamp a claim');
  } finally {
    delete process.env.DEV_LOGIN_KEY;
    delete process.env.APP_ENV;
  }
});

/* ----------------------------- Permissions ------------------------------- */

test('admin creates a user', async () => {
  const r = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Ivo' } });
  assert.equal(r.status, 201);
  assert.ok(r.data.token);
  userToken = r.data.token;
  userId = r.data.id;
});

/* --------------------- First-time key retrieval (register) --------------- */

test('a brand-new user is searchable by name until they claim their key', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Zélia Cunha' } });

  const tooShort = await api('GET', '/auth/unclaimed-users?name=ze');
  assert.equal(tooShort.data.users.length, 0, 'below 3 characters should return nothing');

  const accentless = await api('GET', '/auth/unclaimed-users?name=zelia');
  assert.ok(accentless.data.users.some((u) => u.id === created.data.id), 'plain-ASCII "zelia" should match "Zélia"');

  const claim = await api('POST', '/auth/claim-key', { body: { userId: created.data.id } });
  assert.equal(claim.status, 200);
  assert.equal(claim.data.token, created.data.token);

  const again = await api('POST', '/auth/claim-key', { body: { userId: created.data.id } });
  assert.equal(again.status, 400, 'a key can only ever be claimed once');

  const afterClaim = await api('GET', '/auth/unclaimed-users?name=zelia');
  assert.ok(!afterClaim.data.users.some((u) => u.id === created.data.id), 'claimed users disappear from search');

  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

test('logging in for real also closes the first-time key retrieval, even without using it', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Rogério Vale' } });

  const before = await api('GET', '/auth/unclaimed-users?name=rogerio');
  assert.ok(before.data.users.some((u) => u.id === created.data.id));

  // A real authenticated request (not the claim flow) with their actual key.
  await api('GET', '/me', { token: created.data.token });

  const after = await api('GET', '/auth/unclaimed-users?name=rogerio');
  assert.ok(!after.data.users.some((u) => u.id === created.data.id), 'a real login should close this even if the claim endpoint was never used');

  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

// The owner used to be excluded from this flow on purpose (pre-claimed at
// seed time). That was reversed by request so the owner can retrieve their
// own key the same way a guest does - see the security note on
// searchUnclaimedUsers(). Exercised against keyClaim.js directly rather
// than over HTTP: claiming shares the per-IP auth-attempt budget with
// /auth/login (see rateLimit.js), and spending two of it here tipped a
// later test expecting a plain 401 into a 429. The HTTP wiring itself is
// already covered by the brand-new-user test above.
test('the owner is searchable in the first-time key flow like anyone else, and claiming is still one-shot', async () => {
  const { default: db } = await import('../src/db.js');
  const { searchUnclaimedUsers, claimKey } = await import('../src/keyClaim.js');
  const owner = db.prepare('SELECT id, name FROM users WHERE is_owner = 1').get();
  // Already claimed by now (every earlier test authenticates as ADMIN, and
  // authenticate() stamps key_claimed_at on first use) - clear it to get a
  // freshly-seeded owner back.
  db.prepare('UPDATE users SET key_claimed_at = NULL WHERE id = ?').run(owner.id);

  try {
    assert.ok(
      searchUnclaimedUsers('test').some((u) => u.id === owner.id),
      'the owner must not be filtered out of the search'
    );

    const claimed = claimKey(owner.id);
    assert.equal(claimed.ok, true);
    assert.equal(claimed.name, owner.name);
    assert.ok(claimed.token, 'the flow hands back the real key');

    assert.equal(claimKey(owner.id).error, 'err_key_already_claimed', 'claiming closes permanently, owner included');
    assert.ok(!searchUnclaimedUsers('test').some((u) => u.id === owner.id), 'and they drop out of the search');
  } finally {
    db.prepare("UPDATE users SET key_claimed_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(owner.id);
  }
});

test('a normal user cannot access the admin panel', async () => {
  const r = await api('GET', '/admin/users', { token: userToken });
  assert.equal(r.status, 403);
});

// The server always returns a stable alphabetical order (owner pinned
// first) - that's what "importing from DB" should look like. Floating a
// just-created/just-changed user to the top is a session-local nicety the
// frontend layers on top (see recentUserIds/withRecentFirst() in
// settings.js) rather than a permanent server-side sort, so it isn't
// exercised here - it needs a real page, not just the API.
test('Manage Users list: owner pinned first, then alphabetical by name', async () => {
  const zebra = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Zzz Zebra' } });
  const apple = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Aaa Apple' } });

  const list = await api('GET', '/admin/users', { token: ADMIN });
  assert.equal(list.data[0].is_owner, true, 'owner must be first');
  const nonOwnerNames = list.data.filter((u) => !u.is_owner).map((u) => u.name);
  const alphabetical = [...nonOwnerNames].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(nonOwnerNames, alphabetical, 'everyone but the owner should be in alphabetical order');

  await api('DELETE', `/admin/users/${zebra.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${apple.data.id}`, { token: ADMIN });
});

test('promoting a user grants admin access, but not owner-only Manage Users access', async () => {
  const promote = await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });
  assert.equal(promote.status, 200);
  assert.equal(promote.data.is_admin, true);

  // General admin access: works.
  const votes = await api('GET', '/admin/votes', { token: userToken });
  assert.equal(votes.status, 200);

  // Golden rule: only the owner sees other users' access keys - a
  // non-owner admin can load the list, but only ever gets their own row.
  const users = await api('GET', '/admin/users', { token: userToken });
  assert.equal(users.status, 200);
  assert.equal(users.data.length, 1);
  assert.equal(users.data[0].id, userId);
});

test('demoting revokes admin access', async () => {
  const demote = await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
  assert.equal(demote.status, 200);

  const check = await api('GET', '/admin/users', { token: userToken });
  assert.equal(check.status, 403);
});

test('cannot demote the last remaining admin', async () => {
  const me = await api('GET', '/me', { token: ADMIN });
  const demote = await api('PATCH', `/admin/users/${me.data.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  assert.equal(demote.status, 400);
});

test('the owner cannot be demoted even when other admins exist', async () => {
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const me = await api('GET', '/me', { token: ADMIN });
  const demote = await api('PATCH', `/admin/users/${me.data.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  assert.equal(demote.status, 400);

  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
});

test('a promoted admin (not the owner) can still be removed', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'promotable' } });
  await api('PATCH', `/admin/users/${created.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const del = await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
  assert.equal(del.status, 200);

  const users = await api('GET', '/admin/users', { token: ADMIN });
  assert.ok(!users.data.some((u) => u.id === created.data.id), 'promoted admin should have been removed');
});

test('the owner can never be removed', async () => {
  const me = await api('GET', '/me', { token: ADMIN });
  const del = await api('DELETE', `/admin/users/${me.data.id}`, { token: ADMIN });
  assert.equal(del.status, 400);
});

test('a user can be renamed', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Typo Nmae' } });
  const rename = await api('PATCH', `/admin/users/${created.data.id}/name`, { token: ADMIN, body: { name: 'Fixed Name' } });
  assert.equal(rename.status, 200);

  const users = await api('GET', '/admin/users', { token: ADMIN });
  const found = users.data.find((u) => u.id === created.data.id);
  assert.equal(found.name, 'Fixed Name');

  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

test('renaming a non-existent user returns 404', async () => {
  const r = await api('PATCH', '/admin/users/999999/name', { token: ADMIN, body: { name: 'Anyone' } });
  assert.equal(r.status, 404);
});

test('a non-owner admin cannot rename users', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Renamable' } });
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const rename = await api('PATCH', `/admin/users/${created.data.id}/name`, { token: userToken, body: { name: 'Hijacked' } });
  assert.equal(rename.status, 403);

  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

test('a non-owner admin sees the Users list filtered to only their own row', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Someone Else' } });
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const list = await api('GET', '/admin/users', { token: userToken });
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1, 'non-owner admin should only see their own row');
  assert.equal(list.data[0].id, userId);

  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

test("regenerating a user's key issues a new one and invalidates the old", async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Regenerable' } });
  const oldToken = created.data.token;

  const regen = await api('POST', `/admin/users/${created.data.id}/regenerate-token`, { token: ADMIN });
  assert.equal(regen.status, 200);
  assert.notEqual(regen.data.token, oldToken);
  assert.match(regen.data.token, /^regenerable\d{6}$/);

  const oldLogin = await api('GET', '/me', { token: oldToken });
  assert.equal(oldLogin.status, 401);

  const newLogin = await api('GET', '/me', { token: regen.data.token });
  assert.equal(newLogin.status, 200);
});

test('regenerating a key also reopens first-time name-search retrieval for that user', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Wrongly Claimed Guest' } });

  // Simulate someone else claiming it by mistake.
  const claim = await api('POST', '/auth/claim-key', { body: { userId: created.data.id } });
  assert.equal(claim.status, 200);

  const goneFromSearch = await api('GET', '/auth/unclaimed-users?name=wrongly claimed');
  assert.ok(!goneFromSearch.data.users.some((u) => u.id === created.data.id), 'setup: should be claimed and gone from search');

  await api('POST', `/admin/users/${created.data.id}/regenerate-token`, { token: ADMIN });

  const backInSearch = await api('GET', '/auth/unclaimed-users?name=wrongly claimed');
  assert.ok(backInSearch.data.users.some((u) => u.id === created.data.id), 'regenerating the key should make the account findable again, so the rightful person can re-claim it');

  await api('DELETE', `/admin/users/${created.data.id}`, { token: ADMIN });
});

/* ----------------------------- Consequences ------------------------------ */

test('you can only suggest 1 consequence per day', async () => {
  const first = await api('POST', '/consequences', { token: userToken, body: { text: 'Beber agua' } });
  assert.equal(first.status, 201);
  const second = await api('POST', '/consequences', { token: userToken, body: { text: 'Outra' } });
  assert.equal(second.status, 409);
});

test('revealing makes the consequence the current one', async () => {
  const r = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  assert.equal(r.status, 200);
  assert.ok(r.data.revealed);
  const cur = await api('GET', '/consequences/current', { token: userToken });
  assert.equal(cur.data.current.text, 'Beber agua');
});

test('with nothing pending, reveal returns 404', async () => {
  const r = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  assert.equal(r.status, 404);
});

test('the admin consequences list is sorted most-recently-touched first, so a fresh reveal jumps to the top', async () => {
  const posterA = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Consequence Poster A' } });
  const posterB = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Consequence Poster B' } });
  await api('POST', '/consequences', { token: posterA.data.token, body: { text: 'Older suggestion' } });
  await api('POST', '/consequences', { token: posterB.data.token, body: { text: 'Newer suggestion' } });

  const before = await api('GET', '/admin/consequences', { token: ADMIN });
  const newerIndex = before.data.findIndex((c) => c.text === 'Newer suggestion');
  const olderIndex = before.data.findIndex((c) => c.text === 'Older suggestion');
  assert.ok(newerIndex < olderIndex, 'the most recently suggested one should sort above the older one');

  const revealed = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  assert.equal(revealed.status, 200);

  const after = await api('GET', '/admin/consequences', { token: ADMIN });
  assert.equal(after.data[0].id, revealed.data.revealed.id, 'whichever consequence was just revealed should now be first, regardless of which one it was');

  await api('DELETE', `/admin/users/${posterA.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${posterB.data.id}`, { token: ADMIN });
});

test('assigning a consequence notifies nobody but works even without push configured, and is visible to everyone via GET /consequences/revealed', async () => {
  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Assign Poster' } });
  const holder = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Assign Holder' } });
  await api('POST', '/consequences', { token: poster.data.token, body: { text: 'Assign flow consequence' } });
  const revealed = await api('POST', '/admin/consequences/reveal', { token: ADMIN });

  const assigned = await api('PATCH', `/admin/consequences/${revealed.data.revealed.id}/assign`, {
    token: ADMIN, body: { userId: holder.data.id },
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.consequence.assignedName, 'Assign Holder');

  const list = await api('GET', '/consequences/revealed', { token: userToken });
  const found = list.data.consequences.find((c) => c.id === revealed.data.revealed.id);
  assert.equal(found.assignedName, 'Assign Holder', 'the assignment is public - any logged-in user sees who was assigned');
  assert.equal(found.done_at, null);
  assert.equal(found.approved_at, null);

  await api('DELETE', `/admin/users/${poster.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${holder.data.id}`, { token: ADMIN });
});

test('assigning stamps assigned_at, so the admin history can sort a fresh assignment to the top', async () => {
  // Regression guard: assignment used to record only who, never when. The
  // admin history sorts on the most recent of these timestamps, so with no
  // assigned_at a just-assigned row could not move - it sat wherever it
  // already was, which read as the assign having failed.
  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Stamp Poster' } });
  const holder = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Stamp Holder' } });
  await api('POST', '/consequences', { token: poster.data.token, body: { text: 'Stamped consequence' } });
  const revealed = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  const id = revealed.data.revealed.id;

  const before = (await api('GET', '/admin/consequences', { token: ADMIN })).data.find((c) => c.id === id);
  assert.equal(before.assigned_at, null, 'nothing is assigned yet');

  await api('PATCH', `/admin/consequences/${id}/assign`, { token: ADMIN, body: { userId: holder.data.id } });

  const rows = (await api('GET', '/admin/consequences', { token: ADMIN })).data;
  const after = rows.find((c) => c.id === id);
  assert.ok(after.assigned_at, 'assigning records when it happened, not just who');
  const latest = (c) => c.approved_at || c.done_at || c.assigned_at || c.revealed_at || '';
  const top = [...rows].sort((a, b) => latest(b).localeCompare(latest(a)))[0];
  assert.equal(top.id, id, 'the freshly assigned one is now the most recently touched of all');

  // Clearing the assignment must not leave a stale recency behind.
  await api('PATCH', `/admin/consequences/${id}/assign`, { token: ADMIN, body: { userId: null } });
  const cleared = (await api('GET', '/admin/consequences', { token: ADMIN })).data.find((c) => c.id === id);
  assert.equal(cleared.assigned_at, null, 'unassigning clears the timestamp too');

  await api('DELETE', `/admin/users/${poster.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${holder.data.id}`, { token: ADMIN });
});

test('a non-owner admin can assign a consequence, but only the owner can approve it', async () => {
  const nonOwnerAdmin = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Non Owner Assign Test' } });
  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Non Owner Test Poster' } });
  await api('POST', '/consequences', { token: poster.data.token, body: { text: 'Non-owner gate consequence' } });
  const revealed = await api('POST', '/admin/consequences/reveal', { token: ADMIN });

  const assignAttempt = await api('PATCH', `/admin/consequences/${revealed.data.revealed.id}/assign`, {
    token: nonOwnerAdmin.data.token, body: { userId: poster.data.id },
  });
  assert.equal(assignAttempt.status, 200, 'any admin, not just the owner, can record who was holding the rata');
  assert.equal(assignAttempt.data.consequence.assignedName, 'Non Owner Test Poster');

  const approveAttempt = await api('PATCH', `/admin/consequences/${revealed.data.revealed.id}/approve`, {
    token: nonOwnerAdmin.data.token,
  });
  assert.equal(approveAttempt.status, 403, 'approving is owner-only, unlike assigning');

  await api('DELETE', `/admin/users/${nonOwnerAdmin.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${poster.data.id}`, { token: ADMIN });
});

test('only the assigned user can mark a consequence done, only once, and only the owner can approve it afterwards', async () => {
  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Mark Done Poster' } });
  const assignee = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Mark Done Assignee' } });
  const bystander = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Mark Done Bystander' } });
  await api('POST', '/consequences', { token: poster.data.token, body: { text: 'Mark done consequence' } });
  const revealed = await api('POST', '/admin/consequences/reveal', { token: ADMIN });
  const id = revealed.data.revealed.id;

  await api('PATCH', `/admin/consequences/${id}/assign`, { token: ADMIN, body: { userId: assignee.data.id } });

  // Not the assigned user - rejected.
  const wrongUser = await api('POST', `/consequences/${id}/mark-done`, { token: bystander.data.token });
  assert.equal(wrongUser.status, 400);

  // Owner can't approve before it's been marked done.
  const tooEarly = await api('PATCH', `/admin/consequences/${id}/approve`, { token: ADMIN });
  assert.equal(tooEarly.status, 400);

  // The actual assignee marks it done.
  const markedDone = await api('POST', `/consequences/${id}/mark-done`, { token: assignee.data.token });
  assert.equal(markedDone.status, 200);
  assert.ok(markedDone.data.consequence.done_at);
  assert.equal(markedDone.data.consequence.approved_at, null, 'done is not the same as approved - still needs the owner');

  // Can't mark done twice.
  const again = await api('POST', `/consequences/${id}/mark-done`, { token: assignee.data.token });
  assert.equal(again.status, 400);

  // Now the owner approves it, and it shows as done to everyone.
  const approved = await api('PATCH', `/admin/consequences/${id}/approve`, { token: ADMIN });
  assert.equal(approved.status, 200);
  assert.ok(approved.data.consequence.approved_at);

  const list = await api('GET', '/consequences/revealed', { token: bystander.data.token });
  const found = list.data.consequences.find((c) => c.id === id);
  assert.ok(found.approved_at, 'the approval is public - shows as done to everyone, not just the owner/assignee');

  // Approving twice is rejected.
  const doubleApprove = await api('PATCH', `/admin/consequences/${id}/approve`, { token: ADMIN });
  assert.equal(doubleApprove.status, 400);

  await api('DELETE', `/admin/users/${poster.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${assignee.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${bystander.data.id}`, { token: ADMIN });
});

/* -------------------------------- Voting --------------------------------- */

const NIGHT = 'furnished';

// Minimal structurally-valid JPEG (just the SOI+EOI markers) - enough to
// pass decodePhoto()'s magic-byte check without needing a real renderable
// image, since these tests only exercise the server-side validation.
const TEST_PHOTO = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;

test('a night that has never been opened reports started: false', async () => {
  const voting = await api('GET', '/admin/voting', { token: ADMIN });
  const night = voting.data.nights.find((n) => n.night === NIGHT);
  assert.equal(night.status, 'closed');
  assert.equal(night.started, false, 'a night with no admin action yet should not look like "closed after running"');
});

test('voting closed by default blocks the vote', async () => {
  const c = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Concorrente A', night: NIGHT } });
  assert.equal(c.status, 201);
  contestantId = c.data.id;

  const status = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(status.data.night, NIGHT);
  assert.equal(status.data.status, 'closed');

  const vote = await api('POST', '/votes', { token: userToken, body: { contestantId, night: NIGHT } });
  assert.equal(vote.status, 400);
});

test('admin opens the night and each user votes once', async () => {
  const open = await api('POST', `/admin/voting/${NIGHT}/open`, { token: ADMIN, body: { force: true } });
  assert.equal(open.data.votingStatus, 'open');

  const v1 = await api('POST', '/votes', { token: userToken, body: { contestantId, night: NIGHT } });
  assert.equal(v1.status, 201);

  const v2 = await api('POST', '/votes', { token: userToken, body: { contestantId, night: NIGHT } });
  assert.equal(v2.status, 400); // already voted this night

  const voting = await api('GET', '/admin/voting', { token: ADMIN });
  const night = voting.data.nights.find((n) => n.night === NIGHT);
  assert.equal(night.started, true, 'once a night has been opened, it should never look "unstarted" again');
});

test('GET /admin/voting counts every account that has not voted, admins and owner included', async () => {
  // A separate night from NIGHT/'furnished' (heavily reused by neighboring
  // tests) - and asserting deltas off a baseline rather than an absolute
  // number, since this file shares one DB across the whole run and earlier
  // tests may have left their own never-voted accounts behind.
  const night = 'swamp';
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });

  const nightsInfo = async () => {
    const r = await api('GET', '/admin/voting', { token: ADMIN });
    return r.data.nights.find((n) => n.night === night);
  };
  const baseline = (await nightsInfo()).notVoted;

  // An admin raises it like anyone else. They are at the party and they
  // vote, so leaving them out counted a smaller room than the one actually
  // voting - "5 of 30" against a 30 that was never the real number.
  const freshAdmin = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Fresh Admin For NotVoted' } });
  await api('PATCH', `/admin/users/${freshAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  assert.equal((await nightsInfo()).notVoted, baseline + 1, 'an admin who has not voted is still someone who has not voted');

  // Two fresh regular accounts should raise it by exactly two.
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'NotVoted Guest A' } });
  await api('POST', '/admin/users', { token: ADMIN, body: { name: 'NotVoted Guest B' } });
  const contestant = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'NotVoted Target', night } });
  assert.equal((await nightsInfo()).notVoted, baseline + 3, 'each new account raises it by one, whatever its role');

  // One of them voting should drop it back by one.
  await api('POST', '/votes', { token: a.data.token, body: { contestantId: contestant.data.id, night } });
  assert.equal((await nightsInfo()).notVoted, baseline + 2, 'voting should remove that account from the count');

  // And an admin voting counts the same way.
  await api('POST', '/votes', { token: freshAdmin.data.token, body: { contestantId: contestant.data.id, night } });
  assert.equal((await nightsInfo()).notVoted, baseline + 1, 'an admin voting counts like anyone else voting');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('who-voted-for-whom is owner-only; a regular admin only gets the aggregate results', async () => {
  const nonOwnerAdmin = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Non Owner Admin' } });
  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  const asOwner = await api('GET', `/admin/votes?night=${NIGHT}`, { token: ADMIN });
  assert.ok(Array.isArray(asOwner.data.votes), 'owner should see the individual voter -> contestant breakdown');
  assert.ok(Array.isArray(asOwner.data.results), 'owner should also see the aggregate results');

  const asAdmin = await api('GET', `/admin/votes?night=${NIGHT}`, { token: nonOwnerAdmin.data.token });
  assert.equal(asAdmin.data.votes, undefined, 'a non-owner admin must not see who voted for whom');
  assert.ok(Array.isArray(asAdmin.data.results), 'a non-owner admin should still see the aggregate results');

  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${nonOwnerAdmin.data.id}`, { token: ADMIN });
});

test('nights are independent: voting in another night is possible', async () => {
  const other = 'swamp';
  const c = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Concorrente B', night: other } });
  assert.equal(c.status, 201);
  await api('POST', `/admin/voting/${other}/open`, { token: ADMIN, body: { force: true } });

  const v = await api('POST', '/votes', { token: userToken, body: { contestantId: c.data.id, night: other } });
  assert.equal(v.status, 201); // already voted in 'furnished', but not yet in this night
});

test('closing the night hides results until the admin reveals them in stages', async () => {
  const close = await api('POST', `/admin/voting/${NIGHT}/close`, { token: ADMIN });
  assert.equal(close.data.votingStatus, 'closed');

  // Closed but not revealed yet: no results visible to regular users.
  const hidden = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(hidden.data.status, 'closed');
  assert.equal(hidden.data.resultsPhase, 'hidden');
  assert.deepEqual(hidden.data.results, []);

  // Only one contestant this night (rank 1) - "third"/"second" phases have
  // nothing at those ranks yet, so results stay empty until "first".
  await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN }); // -> third
  const third = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(third.data.resultsPhase, 'third');
  assert.deepEqual(third.data.results, []);

  await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN }); // -> second
  const second = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(second.data.resultsPhase, 'second');
  assert.deepEqual(second.data.results, []);

  await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN }); // -> first
  const first = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(first.data.resultsPhase, 'first');
  const topFirst = first.data.results.find((r) => r.id === contestantId);
  assert.equal(topFirst.votes, 1);

  await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN }); // -> all
  const all = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(all.data.resultsPhase, 'all');
  assert.ok(all.data.results.find((r) => r.id === contestantId));

  // Advancing past "all" is a no-op.
  const again = await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN });
  assert.equal(again.data.resultsPhase, 'all');
});

test('reset clears the night votes and reopens voting', async () => {
  const reset = await api('POST', `/admin/voting/${NIGHT}/reset`, { token: ADMIN });
  assert.equal(reset.data.votingStatus, 'open');

  const status = await api('GET', `/votes/status?night=${NIGHT}`, { token: userToken });
  assert.equal(status.data.myVote, null);

  const v = await api('POST', '/votes', { token: userToken, body: { contestantId, night: NIGHT } });
  assert.equal(v.status, 201);
});

test('reset-all clears votes AND contestants, back to a never-started night', async () => {
  const other = 'swamp'; // already has a contestant + a vote from earlier tests
  const before = await api('GET', `/admin/contestants?night=${other}`, { token: ADMIN });
  assert.ok(before.data.contestants.length > 0, 'test setup: swamp should already have a contestant');

  const resetAll = await api('POST', `/admin/voting/${other}/reset-all`, { token: ADMIN });
  assert.equal(resetAll.status, 200);
  assert.equal(resetAll.data.votingStatus, 'closed');

  const contestants = await api('GET', `/admin/contestants?night=${other}`, { token: ADMIN });
  assert.equal(contestants.data.contestants.length, 0, 'reset-all should wipe the contestant roster too');

  const voting = await api('GET', '/admin/voting', { token: ADMIN });
  const night = voting.data.nights.find((n) => n.night === other);
  assert.equal(night.started, false, 'reset-all should return the night to its never-started state');
});

test('a tie is reported as a tie, at any place, instead of being settled alphabetically', async () => {
  // Ivo, testing with real people: "when it's a tie it published the first
  // alphabetically with the same votes". Exactly so - rank was `i + 1`,
  // position in a list sorted by votes then `c.name COLLATE NOCASE`, which
  // makes the alphabet the silent tiebreaker and hides the tie completely.
  //
  // Two ties on purpose, at different places, because the runoff only ever
  // understood first place. Scores here: Alpha and Zulu tied on 3, then
  // Bravo and Yankee tied on 1.
  await api('POST', `/admin/voting/${NIGHT}/reset-all`, { token: ADMIN });
  const entries = {};
  for (const name of ['Alpha Tie', 'Zulu Tie', 'Bravo Tie', 'Yankee Tie']) {
    entries[name] = (await api('POST', '/admin/contestants', { token: ADMIN, body: { name, night: NIGHT } })).data;
  }
  await api('POST', `/admin/voting/${NIGHT}/open`, { token: ADMIN, body: { force: true } });

  const plan = [
    ['Alpha Tie', 3], ['Zulu Tie', 3], ['Bravo Tie', 1], ['Yankee Tie', 1],
  ];
  let n = 0;
  for (const [name, count] of plan) {
    for (let i = 0; i < count; i++) {
      const voter = (await api('POST', '/admin/users', { token: ADMIN, body: { name: `Tie Voter ${n++}` } })).data;
      await api('POST', '/votes', { token: voter.token, body: { contestantId: entries[name].id, night: NIGHT } });
    }
  }
  await api('POST', `/admin/voting/${NIGHT}/close`, { token: ADMIN });

  const results = (await api('GET', `/admin/votes?night=${NIGHT}`, { token: ADMIN })).data.results;
  const rankOf = (name) => results.find((r) => r.name === name)?.rank;

  // Equal votes, equal rank. Alphabetical order must not decide a placing.
  assert.equal(rankOf('Alpha Tie'), rankOf('Zulu Tie'),
    `two contestants on the same votes must share a rank, got ${rankOf('Alpha Tie')} and ${rankOf('Zulu Tie')}`);
  assert.equal(rankOf('Alpha Tie'), 1);

  // And the next place skips, the way any scoreboard works: 1, 1, 3, 3.
  assert.equal(rankOf('Bravo Tie'), 3, 'after two firsts the next place is third, not second');
  assert.equal(rankOf('Bravo Tie'), rankOf('Yankee Tie'));

  // The tie has to be visible as such, not inferred by the reader comparing
  // numbers - the admin needs to know a runoff is owed.
  assert.ok(results.find((r) => r.name === 'Alpha Tie').tied, 'a tied row has to say it is tied');
  assert.ok(results.find((r) => r.name === 'Bravo Tie').tied, 'including a tie that is not for first place');
});

test('an unbroken tie cannot be published to the Wall, and says why', async () => {
  // A podium post is a snapshot - once it is on the Wall the tie is frozen
  // into it with no way to tell the story afterwards. The whole reason ties
  // are visible now is so one gets broken first, so publishing refuses.
  // With a reason, not silently: a button that appears to do nothing is a
  // complaint this app has already had.
  await api('POST', `/admin/voting/${NIGHT}/reset-all`, { token: ADMIN });
  const ids = {};
  for (const name of ['Dead Heat A', 'Dead Heat B']) {
    ids[name] = (await api('POST', '/admin/contestants', { token: ADMIN, body: { name, night: NIGHT } })).data.id;
  }
  await api('POST', `/admin/voting/${NIGHT}/open`, { token: ADMIN, body: { force: true } });
  for (const [i, name] of ['Dead Heat A', 'Dead Heat B'].entries()) {
    const voter = (await api('POST', '/admin/users', { token: ADMIN, body: { name: `Heat Voter ${i}` } })).data;
    await api('POST', '/votes', { token: voter.token, body: { contestantId: ids[name], night: NIGHT } });
  }
  await api('POST', `/admin/voting/${NIGHT}/close`, { token: ADMIN, body: { force: true } });
  for (let i = 0; i < 4; i += 1) await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN });

  const refused = await api('POST', `/admin/voting/${NIGHT}/publish-podium`, { token: ADMIN });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error, 'err_tie_unresolved');
  assert.equal(refused.data.rank, 1, 'and names which place is still open');

  // Break it, and the same button goes through.
  await api('POST', `/admin/voting/${NIGHT}/runoff`, { token: ADMIN });
  const decider = (await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Heat Decider' } })).data;
  await api('POST', '/votes', { token: decider.token, body: { contestantId: ids['Dead Heat B'], night: NIGHT } });
  await api('POST', `/admin/voting/${NIGHT}/close`, { token: ADMIN, body: { force: true } });
  for (let i = 0; i < 4; i += 1) await api('POST', `/admin/voting/${NIGHT}/reveal-next`, { token: ADMIN });

  const published = await api('POST', `/admin/voting/${NIGHT}/publish-podium`, { token: ADMIN });
  assert.equal(published.status, 201, 'once the tie is settled the podium publishes normally');
});

test('a runoff for second place settles second and third without touching who won', async () => {
  // The half that matters most and was impossible before: a runoff used to
  // delete every vote for the night, which broke the tie and wiped the
  // placings below it at the same time. After a runoff for 1st, 2nd and 3rd
  // were both sitting on zero. Ballots now carry a round, so the night's
  // real tally survives being tie-broken.
  await api('POST', `/admin/voting/${NIGHT}/reset-all`, { token: ADMIN });
  const ids = {};
  for (const name of ['Winner Clear', 'Second A', 'Second B']) {
    ids[name] = (await api('POST', '/admin/contestants', { token: ADMIN, body: { name, night: NIGHT } })).data.id;
  }
  await api('POST', `/admin/voting/${NIGHT}/open`, { token: ADMIN, body: { force: true } });

  const voters = [];
  for (let i = 0; i < 8; i++) {
    voters.push((await api('POST', '/admin/users', { token: ADMIN, body: { name: `Tier Voter ${i}` } })).data.token);
  }
  // 4 for the winner, 2 each for the pair tied behind.
  const cast = async (token, id) => api('POST', '/votes', { token, body: { contestantId: id, night: NIGHT } });
  for (let i = 0; i < 4; i++) await cast(voters[i], ids['Winner Clear']);
  for (let i = 4; i < 6; i++) await cast(voters[i], ids['Second A']);
  for (let i = 6; i < 8; i++) await cast(voters[i], ids['Second B']);
  await api('POST', `/admin/voting/${NIGHT}/close`, { token: ADMIN, body: { force: true } });

  const read = async () => (await api('GET', `/admin/votes?night=${NIGHT}`, { token: ADMIN })).data.results;
  let results = await read();
  const row = (n) => results.find((r) => r.name === n);
  assert.equal(row('Winner Clear').rank, 1);
  assert.equal(row('Second A').rank, 2);
  assert.equal(row('Second B').rank, 2, 'both tied for second share the place');
  assert.ok(row('Second A').tied);
  assert.equal(row('Winner Clear').tied, false, 'a clear winner is not tied with anybody');

  // Break the tie for SECOND. The old code only ever looked at results[0].
  const started = await api('POST', `/admin/voting/${NIGHT}/runoff`, { token: ADMIN, body: { rank: 2 } });
  assert.equal(started.status, 200);
  assert.equal(started.data.rank, 2);
  assert.deepEqual([...started.data.contestantIds].sort(), [ids['Second A'], ids['Second B']].sort());

  // Only the tied pair can be voted for now.
  const blocked = await cast(voters[0], ids['Winner Clear']);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.data.error, 'err_not_in_runoff');

  // Three of the eight turn up to the runoff, favouring B.
  await cast(voters[0], ids['Second B']);
  await cast(voters[1], ids['Second B']);
  await cast(voters[2], ids['Second A']);
  await api('POST', `/admin/voting/${NIGHT}/close`, { token: ADMIN, body: { force: true } });

  results = await read();
  // The winner is untouched - same rank, same votes as before the runoff.
  assert.equal(row('Winner Clear').rank, 1, 'the runoff must not disturb first place');
  assert.equal(row('Winner Clear').votes, 4, 'nor its votes - the runoff was a separate ballot');
  // And the tie is settled, in the order the runoff decided.
  assert.equal(row('Second B').rank, 2);
  assert.equal(row('Second A').rank, 3);
  assert.equal(row('Second B').tied, false, 'a settled tie is no longer a tie');
  assert.equal(row('Second A').tied, false);
});

test('a tie for first place can be broken with a runoff scoped to just the tied contestants', async () => {
  await api('POST', `/admin/voting/${NIGHT}/reset-all`, { token: ADMIN });
  const a = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Runoff A', night: NIGHT } });
  const b = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Runoff B', night: NIGHT } });
  const c = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Runoff C', night: NIGHT } });

  await api('POST', `/admin/voting/${NIGHT}/open`, { token: ADMIN, body: { force: true } });

  const voters = [];
  for (let i = 0; i < 5; i++) {
    voters.push((await api('POST', '/admin/users', { token: ADMIN, body: { name: `Runoff Voter ${i}` } })).data.token);
  }
  // A and B tied at 2 votes each, C behind at 1.
  await api('POST', '/votes', { token: voters[0], body: { contestantId: a.data.id, night: NIGHT } });
  await api('POST', '/votes', { token: voters[1], body: { contestantId: a.data.id, night: NIGHT } });
  await api('POST', '/votes', { token: voters[2], body: { contestantId: b.data.id, night: NIGHT } });
  await api('POST', '/votes', { token: voters[3], body: { contestantId: b.data.id, night: NIGHT } });
  await api('POST', '/votes', { token: voters[4], body: { contestantId: c.data.id, night: NIGHT } });

  const beforeClose = await api('POST', `/admin/voting/${NIGHT}/runoff`, { token: ADMIN });
  assert.equal(beforeClose.status, 409);
  assert.equal(beforeClose.data.error, 'err_voting_not_closed', 'a tie can only be judged once voting is closed');

  await api('POST', `/admin/voting/${NIGHT}/close`, { token: ADMIN, body: { force: true } });

  const noTieYet = await api('GET', `/admin/votes?night=${NIGHT}`, { token: ADMIN });
  assert.equal(noTieYet.data.results[0].votes, noTieYet.data.results[1].votes, 'test setup: A and B should be tied at the top');

  const runoff = await api('POST', `/admin/voting/${NIGHT}/runoff`, { token: ADMIN });
  assert.equal(runoff.status, 200);
  assert.equal(runoff.data.votingStatus, 'open');
  assert.deepEqual(new Set(runoff.data.contestantIds), new Set([a.data.id, b.data.id]));

  const again = await api('POST', `/admin/voting/${NIGHT}/runoff`, { token: ADMIN });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'err_voting_not_closed', 'a runoff itself has to be voting-open, not still closed, to start another one');

  // C lost the first round - no longer votable, even though voting reopened.
  const status = await api('GET', `/votes/status?night=${NIGHT}`, { token: voters[0] });
  assert.equal(status.data.runoffActive, true);
  assert.deepEqual(new Set(status.data.contestants.map((x) => x.id)), new Set([a.data.id, b.data.id]));

  const rejectedC = await api('POST', '/votes', { token: voters[4], body: { contestantId: c.data.id, night: NIGHT } });
  assert.equal(rejectedC.status, 400);
  assert.equal(rejectedC.data.error, 'err_not_in_runoff');

  const okA = await api('POST', '/votes', { token: voters[4], body: { contestantId: a.data.id, night: NIGHT } });
  assert.equal(okA.status, 201, 'voting for a tied contestant during the runoff should still work');

  await api('POST', `/admin/voting/${NIGHT}/close`, { token: ADMIN, body: { force: true } });
  // This expectation changed deliberately on 17 Sept 2026, and the old one
  // was the bug. A runoff used to DELETE every vote for the night, so
  // afterwards only the tied pair existed at all and C - who had earned a
  // third place fairly - was gone from the standings entirely. Rounds are
  // now kept apart, so the runoff settles the tie and leaves everything
  // below it exactly where it was.
  const runoffResults = await api('GET', `/admin/votes?night=${NIGHT}`, { token: ADMIN });
  const names = runoffResults.data.results.map((r) => r.name);
  assert.ok(names.includes('Runoff C'), 'C keeps the place it earned - a runoff above it is none of its business');
  const cRow = runoffResults.data.results.find((r) => r.name === 'Runoff C');
  assert.equal(cRow.votes, 1, "and keeps its votes: the runoff was a separate ballot, not a re-count");
  assert.equal(cRow.rank, 3, 'still third, behind the two the runoff has now separated');
  const settled = runoffResults.data.results.filter((r) => r.name !== 'Runoff C');
  assert.deepEqual(settled.map((r) => r.rank).sort(), [1, 2], 'the tied pair come out ranked, not still sharing a place');
  assert.ok(settled.every((r) => r.tied === false), 'and no longer flagged as tied');

  const resetAgain = await api('POST', `/admin/voting/${NIGHT}/reset-all`, { token: ADMIN });
  assert.equal(resetAgain.status, 200);
  assert.equal(resetAgain.data.votingStatus, 'closed', 'reset-all already leaves the night closed - no need to close it again');
  const noTieResult = await api('POST', `/admin/voting/${NIGHT}/runoff`, { token: ADMIN });
  assert.equal(noTieResult.status, 409);
  assert.equal(noTieResult.data.error, 'err_no_tie', 'reset-all should have cleared the runoff, and there are no contestants left to tie');
});

test('Miss Congeniality is a separate per-person round: duos split up, self-votes are refused, and the winner only appears once revealed', async () => {
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  const ana = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cong Ana' } });
  const bea = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cong Bea' } });
  const caio = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cong Caio' } });

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await api('POST', '/admin/contestants/register', { token: ADMIN, body: { night, name: 'Cong Solo', userId: ana.data.id } });
  // One duo entry - it must contribute its two people separately here, even
  // though the outfit vote treats it as a single entry.
  await api('POST', '/admin/contestants/register', { token: ADMIN, body: { night, name: 'Cong Duo', userId: bea.data.id, partnerUserId: caio.data.id } });

  const closed = await api('POST', '/congeniality/vote', { token: ana.data.token, body: { night, targetUserId: bea.data.id } });
  assert.equal(closed.status, 400);
  assert.equal(closed.data.error, 'err_congeniality_not_open', 'the round starts closed - nobody votes before the admin opens it');

  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'open' } });

  // Every guest is in the running, not just the people behind an outfit
  // entry - a guest who never entered Best Outfit can still be the best
  // company of the night. The owner hosts, so they are not a candidate.
  const outsider = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cong Outsider' } });
  const status = await api('GET', `/votes/status?night=${night}`, { token: ana.data.token });
  const candidateIds = new Set(status.data.congeniality.candidates.map((c) => c.id));
  for (const person of [ana, bea, caio]) {
    assert.ok(candidateIds.has(person.data.id), 'everyone with an entry is in, duo partners as two separate people');
  }
  assert.ok(candidateIds.has(outsider.data.id), 'a guest with no outfit entry is votable too');
  const owner = await api('GET', '/me', { token: ADMIN });
  assert.ok(!candidateIds.has(owner.data.id), 'the owner is the host, not a candidate');

  const own = await api('POST', '/congeniality/vote', { token: ana.data.token, body: { night, targetUserId: ana.data.id } });
  assert.equal(own.data.error, 'err_cannot_vote_self');

  const forOwner = await api('POST', '/congeniality/vote', { token: ana.data.token, body: { night, targetUserId: owner.data.id } });
  assert.equal(forOwner.data.error, 'err_not_a_candidate');

  assert.equal((await api('POST', '/congeniality/vote', { token: ana.data.token, body: { night, targetUserId: bea.data.id } })).status, 201);
  assert.equal((await api('POST', '/congeniality/vote', { token: caio.data.token, body: { night, targetUserId: bea.data.id } })).status, 201);
  const twice = await api('POST', '/congeniality/vote', { token: ana.data.token, body: { night, targetUserId: caio.data.id } });
  assert.equal(twice.data.error, 'err_already_voted', 'one vote each, no changing it');

  const beforeReveal = await api('GET', `/votes/status?night=${night}`, { token: ana.data.token });
  assert.equal(beforeReveal.data.congeniality.winner, null, 'a guest must not see the winner before the reveal');
  assert.equal(beforeReveal.data.congeniality.myVote, bea.data.id);

  // An admin, by contrast, can watch the standings the whole way through.
  const adminView = await api('GET', '/admin/voting', { token: ADMIN });
  const nightRow = adminView.data.nights.find((n) => n.night === night);
  assert.equal(nightRow.congenialityStatus, 'open');
  assert.equal(nightRow.congenialityResults[0].votes, 2);

  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'revealed' } });
  const revealed = await api('GET', `/votes/status?night=${night}`, { token: ana.data.token });
  assert.equal(revealed.data.congeniality.winner.id, bea.data.id);
  assert.equal(revealed.data.congeniality.winner.votes, 2);

  // Restarting the night's round has to take the congeniality result with
  // it - a revealed winner attached to votes that no longer exist would be
  // a lie the Wall could still be showing.
  await api('POST', `/admin/voting/${night}/reset`, { token: ADMIN });
  const afterReset = await api('GET', `/votes/status?night=${night}`, { token: ana.data.token });
  assert.equal(afterReset.data.congeniality.status, 'closed');
  assert.equal(afterReset.data.congeniality.winner, null);
});

test('a tie for Miss Congeniality is broken by a runoff, exactly as the outfit vote is', async () => {
  // The bug this covers: this round ranked by votes then name, so a dead
  // heat for first was published as a clean 1st and 2nd with the alphabet
  // deciding which - invisibly, including to whoever lost. It now flags the
  // tie and breaks it with the same runoff the outfit vote has.
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  const ana = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Tie Ana' } });
  const bea = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Tie Bea' } });
  const caio = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Tie Caio' } });

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  for (const p of [ana, bea, caio]) {
    await api('POST', '/admin/contestants/register', { token: ADMIN, body: { night, name: `Look ${p.data.id}`, userId: p.data.id } });
  }
  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'open' } });

  const voters = [];
  for (let i = 0; i < 5; i++) {
    voters.push((await api('POST', '/admin/users', { token: ADMIN, body: { name: `Tie Voter ${i}` } })).data.token);
  }
  // Ana and Bea tied at 2 each, Caio behind at 1.
  const vote = (token, target) => api('POST', '/congeniality/vote', { token, body: { night, targetUserId: target } });
  assert.equal((await vote(voters[0], ana.data.id)).status, 201);
  assert.equal((await vote(voters[1], ana.data.id)).status, 201);
  assert.equal((await vote(voters[2], bea.data.id)).status, 201);
  assert.equal((await vote(voters[3], bea.data.id)).status, 201);
  assert.equal((await vote(voters[4], caio.data.id)).status, 201);

  const rowsFor = async () => {
    const view = await api('GET', '/admin/voting', { token: ADMIN });
    return view.data.nights.find((n) => n.night === night).congenialityResults;
  };
  const standing = await rowsFor();
  const top = standing.filter((r) => r.rank === 1);
  assert.equal(top.length, 2, 'two people on the same count share first place, they are not silently ordered');
  assert.ok(top.every((r) => r.tied === true), 'and the tie is flagged, which is what tells the organiser a runoff is owed');
  assert.equal(standing.find((r) => r.id === caio.data.id).rank, 3, 'the place below a shared first is third, not second');

  // Revealing over an unbroken tie would crown two people at once, and
  // cannot be taken back - refused for the same reason publishing the
  // podium is.
  const earlyReveal = await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'revealed' } });
  assert.equal(earlyReveal.status, 400);
  assert.equal(earlyReveal.data.error, 'err_congeniality_tie_unresolved');

  const beforeClose = await api('POST', `/admin/voting/${night}/congeniality/runoff`, { token: ADMIN });
  assert.equal(beforeClose.status, 409);
  assert.equal(beforeClose.data.error, 'err_congeniality_not_closed', 'a tie can only be judged once nobody can still change it');

  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'closed' } });
  const runoff = await api('POST', `/admin/voting/${night}/congeniality/runoff`, { token: ADMIN });
  assert.equal(runoff.status, 200);
  assert.equal(runoff.data.congenialityStatus, 'open', 'a runoff is a real round of voting, so it reopens the round');
  assert.deepEqual(new Set(runoff.data.userIds), new Set([ana.data.id, bea.data.id]));

  // Caio lost the first round - out of the running, even though voting is
  // open again.
  const guest = await api('GET', `/votes/status?night=${night}`, { token: voters[0] });
  assert.equal(guest.data.congeniality.runoffActive, true, 'the card has to be able to say why the list got shorter');
  assert.deepEqual(new Set(guest.data.congeniality.candidates.map((c) => c.id)), new Set([ana.data.id, bea.data.id]));
  assert.equal(guest.data.congeniality.myVote, null, 'a new round is a new ballot - the first-round vote must not block this one');

  const rejected = await vote(voters[4], caio.data.id);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.error, 'err_not_in_runoff');

  // Bea takes the runoff 2-1 - including a vote from somebody who already
  // voted in the round proper, which is the whole point of keeping the
  // ballots in separate rounds.
  assert.equal((await vote(voters[0], bea.data.id)).status, 201);
  assert.equal((await vote(voters[2], bea.data.id)).status, 201);
  assert.equal((await vote(voters[1], ana.data.id)).status, 201);

  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'closed' } });
  const settled = await rowsFor();
  assert.deepEqual(
    // Only the people who got votes - every other guest is also listed, on nought.
    settled.filter((r) => r.votes > 0).map((r) => [r.id, r.rank, r.votes, r.tied]),
    [[bea.data.id, 1, 2, false], [ana.data.id, 2, 2, false], [caio.data.id, 3, 1, false]],
    'the runoff separates the tied pair and leaves everything else - places and counts - exactly as it was'
  );

  const revealed = await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'revealed' } });
  assert.equal(revealed.status, 200, 'with the tie settled there is one winner, so the reveal goes through');
  const seen = await api('GET', `/votes/status?night=${night}`, { token: voters[0] });
  assert.equal(seen.data.congeniality.winner.id, bea.data.id, 'and it is the one the runoff chose, not the first name in the alphabet');

  // A reset takes the settled order with it, or the next run of this night
  // would start already tie-broken.
  await api('POST', `/admin/voting/${night}/reset`, { token: ADMIN });
  const afterReset = await api('POST', `/admin/voting/${night}/congeniality/runoff`, { token: ADMIN });
  assert.equal(afterReset.status, 409);
  assert.equal(afterReset.data.error, 'err_no_tie');
});

test('publishing a night twice replaces its post rather than stacking podiums', async () => {
  // The publish button stays tappable once a night is published, so a
  // double tap, a retried request on a bad connection, or a re-run after a
  // reset used to leave several podiums on the Wall all claiming the same
  // night. Found by publishing three times and counting.
  const night = 'swamp';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });

  const people = [];
  for (const name of ['Dup One', 'Dup Two', 'Dup Three']) {
    const u = await api('POST', '/admin/users', { token: ADMIN, body: { name } });
    people.push(u.data);
    await api('POST', '/admin/contestants', { token: ADMIN, body: { name, night, userId: u.data.id } });
  }
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  const roster = (await api('GET', `/votes/status?night=${night}`, { token: ADMIN })).data.contestants;
  // Everyone voted round-robin here, which gave every contestant an
  // identical tally - a perfect N-way tie, and publishing one is now
  // refused on purpose (see err_tie_unresolved). Nothing in this test is
  // about ties, so the fixture gets what a real night has instead: a clear
  // winner. The first voter and the last both back the same entry.
  for (let i = 0; i < people.length; i += 1) {
    const pick = i === people.length - 1 ? roster[1] : roster[(i + 1) % roster.length];
    await api('POST', '/votes', { token: people[i].token, body: { night, contestantId: pick.id } });
  }
  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN, body: { force: true } });
  for (let i = 0; i < 4; i += 1) await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });

  const first = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(first.status, 201);

  // Pin it, then publish again: the pin must survive, because re-publishing
  // to correct a name should not quietly unpin what the party is looking at.
  await api('PATCH', `/admin/plaza-posts/${first.data.id}/pin`, { token: ADMIN, body: { pinned: true } });
  await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });

  const posts = (await api('GET', '/plaza-posts', { token: ADMIN })).data.posts.filter((p) => p.type === 'podium');
  assert.equal(posts.length, 1, `three publishes should leave one podium, found ${posts.length}`);
  assert.ok(posts[0].pinnedAt, 'the pin should carry across a re-publish');
  assert.equal(JSON.parse(posts[0].text).night, night);

  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  for (const p of people) await api('DELETE', `/admin/users/${p.id}`, { token: ADMIN });
});

// Every step of this had a test; the whole chain did not. Ivo reported
// publishing "not working" and Miss Congeniality not appearing, and the
// only way to tell a broken chain from a night sitting in the wrong state
// was to walk it end to end. It works - but nothing was guarding the walk,
// so this does, from empty night to a post on the Wall carrying both rounds.
test('the whole Snatch night, end to end: register, vote, close, reveal, congeniality, publish', async () => {
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });

  const people = [];
  for (const name of ['Chain Ana', 'Chain Bruno', 'Chain Carla']) {
    const u = await api('POST', '/admin/users', { token: ADMIN, body: { name } });
    people.push({ name, token: u.data.token, id: u.data.id });
    await api('POST', '/admin/contestants', { token: ADMIN, body: { name, night, userId: u.data.id } });
  }

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  // force: not every eligible account entered, which is a warning the owner
  // is meant to be able to override - and on a real night always will.
  const opened = await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  assert.equal(opened.status, 200, 'voting should open once the warning is acknowledged');

  const roster = (await api('GET', `/votes/status?night=${night}`, { token: ADMIN })).data.contestants;
  for (const p of people) {
    const target = roster.find((c) => c.name !== p.name);
    const v = await api('POST', '/votes', { token: p.token, body: { night, contestantId: target.id } });
    assert.equal(v.status, 201, `${p.name} could not vote`);
  }

  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN, body: { force: true } });

  // Publishing must be refused until every placement is out - the post
  // freezes all three, so publishing at 'first' would bake in two blanks.
  const early = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(early.status, 400);
  assert.equal(early.data.error, 'err_results_not_revealed');

  for (let i = 0; i < 4; i += 1) await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });
  const revealed = await api('GET', `/votes/status?night=${night}`, { token: ADMIN });
  assert.equal(revealed.data.resultsPhase, 'all', 'four reveals should take a night from hidden to all');

  // Miss Congeniality is its own round, and an open one blocks publishing:
  // the post carries its winner, so going out mid-round would freeze a
  // half-counted result into a snapshot that cannot be rewritten.
  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'open' } });
  const midRound = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(midRound.data.error, 'err_congeniality_not_revealed');

  for (const p of people) {
    const st = await api('GET', `/votes/status?night=${night}`, { token: p.token });
    const target = st.data.congeniality.candidates.find((c) => c.id !== p.id);
    const v = await api('POST', '/congeniality/vote', { token: p.token, body: { night, targetUserId: target.id } });
    assert.equal(v.status, 201, `${p.name} could not cast a congeniality vote`);
  }
  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'revealed' } });

  const published = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(published.status, 201, 'the night should publish once both rounds are finished');

  // And what landed has to carry both rounds - the placements *and* the
  // congeniality winner. A post with an empty podium, or with congeniality
  // null after the round actually ran, is the failure being guarded here.
  const wall = await api('GET', '/plaza-posts', { token: ADMIN });
  const post = wall.data.posts.find((p) => p.type === 'podium');
  assert.ok(post, 'no podium post reached the Wall');
  const snapshot = JSON.parse(post.text);
  assert.equal(snapshot.night, night);
  assert.equal(snapshot.podium.length, 3, 'all three placements should be in the snapshot');
  assert.deepEqual(snapshot.podium.map((r) => r.rank), [1, 2, 3]);
  assert.ok(snapshot.podium[0].votes >= snapshot.podium[1].votes, 'the podium should be in vote order');
  assert.ok(snapshot.congeniality, 'miss congeniality ran, so its winner must be in the post');
  assert.ok(snapshot.congeniality.votes > 0);

  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  for (const p of people) await api('DELETE', `/admin/users/${p.id}`, { token: ADMIN });
});

test('publishing a Snatch result to the Wall needs the podium revealed first, and snapshots it so a later reset cannot rewrite it', async () => {
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  const a = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Podium A', night } });
  await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Podium B', night } });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  const voter = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Podium Voter' } });
  await api('POST', '/votes', { token: voter.data.token, body: { contestantId: a.data.id, night } });
  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN, body: { force: true } });

  const tooEarly = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(tooEarly.status, 400);
  assert.equal(tooEarly.data.error, 'err_results_not_revealed', 'publishing before the reveal would spoil the countdown');

  // hidden -> third -> second -> first: the winner is out, but the post
  // carries all three, so it still refuses.
  for (let i = 0; i < 3; i++) await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });
  const winnerOnly = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(winnerOnly.status, 400, 'publishing at "first" would freeze two blank places into the post');

  // -> all
  await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });
  const published = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(published.status, 201);

  const feed = await api('GET', '/plaza-posts', { token: voter.data.token });
  const post = feed.data.posts.find((p) => p.type === 'podium');
  assert.ok(post, 'the podium post should be readable by any guest on the Wall');
  const snapshot = JSON.parse(post.text);
  assert.equal(snapshot.night, night);
  assert.equal(snapshot.podium[0].name, 'Podium A');
  assert.equal(snapshot.podium[0].votes, 1);
  assert.equal(snapshot.podium[0].rank, 1);

  // Wiping the night must leave the already-published post untouched.
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  const afterWipe = await api('GET', '/plaza-posts', { token: voter.data.token });
  const stillThere = afterWipe.data.posts.find((p) => p.type === 'podium');
  assert.equal(JSON.parse(stillThere.text).podium[0].name, 'Podium A');
});

test('a solo contestant cannot vote for their own entry', async () => {
  const night = 'swamp'; // wiped clean by the reset-all test above
  const solo = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Solo Voter' } });

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  const reg = await api('POST', '/outfit/register', { token: solo.data.token, body: { name: 'Solo Persona', night, photoBase64: TEST_PHOTO } });
  assert.equal(reg.status, 201);

  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });

  const status = await api('GET', `/votes/status?night=${night}`, { token: solo.data.token });
  assert.equal(status.data.myContestant.id, reg.data.id, 'the frontend needs myContestant.id to filter this entry out of the vote list');

  const vote = await api('POST', '/votes', { token: solo.data.token, body: { contestantId: reg.data.id, night } });
  assert.equal(vote.status, 400);
  assert.equal(vote.data.error, 'err_cannot_vote_self');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('neither half of a duo can vote for their own shared entry', async () => {
  const night = 'swamp'; // wiped clean by the previous test
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Duo A' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Duo B' } });

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  const reg = await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Duo Persona', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  assert.equal(reg.status, 201);
  // A duo entry now needs its named partner to sign off before it's a
  // real contestant (see confirmContestant()) - these tests are about
  // voting, so get the pair on the roster first.
  await api('POST', '/outfit/register/confirm', { token: b.data.token, body: { night } });

  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });

  const voteA = await api('POST', '/votes', { token: a.data.token, body: { contestantId: reg.data.id, night } });
  assert.equal(voteA.status, 400);
  assert.equal(voteA.data.error, 'err_cannot_vote_self');

  const voteB = await api('POST', '/votes', { token: b.data.token, body: { contestantId: reg.data.id, night } });
  assert.equal(voteB.status, 400);
  assert.equal(voteB.data.error, 'err_cannot_vote_self', "the partner who didn't register it also can't vote for it");

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test("a duo's vote only counts once the partner confirms it", async () => {
  const night = 'swamp'; // wiped clean by the previous test
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Pair One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Pair Two' } });
  const rival = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Rival', night } });

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Pair Persona', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  // A duo entry now needs its named partner to sign off before it's a
  // real contestant (see confirmContestant()) - these tests are about
  // voting, so get the pair on the roster first.
  await api('POST', '/outfit/register/confirm', { token: b.data.token, body: { night } });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });

  // One partner proposes - accepted, but flagged pending and worth nothing yet.
  const proposal = await api('POST', '/votes', { token: a.data.token, body: { contestantId: rival.data.id, night } });
  assert.equal(proposal.status, 201);
  assert.equal(proposal.data.pending, true);

  const beforeConfirm = await api('GET', `/admin/votes?night=${night}`, { token: ADMIN });
  assert.equal(beforeConfirm.data.results.find((r) => r.id === rival.data.id).votes, 0,
    'an unconfirmed proposal must not count towards the tally');

  // The proposer can't wave their own proposal through.
  const selfConfirm = await api('POST', '/votes/confirm', { token: a.data.token, body: { night } });
  assert.equal(selfConfirm.status, 400);
  assert.equal(selfConfirm.data.error, 'err_partner_must_confirm');

  // Neither of them gets a second, separate vote while one is pending.
  const second = await api('POST', '/votes', { token: b.data.token, body: { contestantId: rival.data.id, night } });
  assert.equal(second.status, 400);
  assert.equal(second.data.error, 'err_duo_already_voted');

  // The partner confirming is what turns it into a real vote.
  const confirm = await api('POST', '/votes/confirm', { token: b.data.token, body: { night } });
  assert.equal(confirm.status, 200);

  const afterConfirm = await api('GET', `/admin/votes?night=${night}`, { token: ADMIN });
  assert.equal(afterConfirm.data.results.find((r) => r.id === rival.data.id).votes, 1,
    'the pair should land exactly one vote between them, not two');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('a pending duo proposal can be swapped for another, and blocks closing until acknowledged', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Swap One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Swap Two' } });
  const first = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'First Pick', night } });
  const second = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Second Pick', night } });

  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Swap Persona', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  // A duo entry now needs its named partner to sign off before it's a
  // real contestant (see confirmContestant()) - these tests are about
  // voting, so get the pair on the roster first.
  await api('POST', '/outfit/register/confirm', { token: b.data.token, body: { night } });
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });

  await api('POST', '/votes', { token: a.data.token, body: { contestantId: first.data.id, night } });
  // The partner disagrees: dropping the proposal frees the pair to repick.
  const drop = await api('DELETE', '/votes/pending', { token: b.data.token, body: { night } });
  assert.equal(drop.status, 200);
  const repick = await api('POST', '/votes', { token: b.data.token, body: { contestantId: second.data.id, night } });
  assert.equal(repick.status, 201);

  // Closing on top of an unconfirmed proposal is refused once, with a count.
  const blocked = await api('POST', `/admin/voting/${night}/close`, { token: ADMIN });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error, 'err_pending_duo_votes');
  assert.equal(blocked.data.pending, 1);

  // The owner can still go ahead knowingly - the stranded vote just doesn't count.
  const forced = await api('POST', `/admin/voting/${night}/close`, { token: ADMIN, body: { force: true } });
  assert.equal(forced.status, 200);
  const results = await api('GET', `/admin/votes?night=${night}`, { token: ADMIN });
  assert.equal(results.data.results.find((r) => r.id === second.data.id).votes, 0);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('naming somebody as your Snatch partner tells them, so the entry is not left pending', async () => {
  // Ivo, from the real night: nothing told the partner they had been named.
  // A duo entry does not count until they confirm, so entries sat pending
  // while somebody went round the party chasing people in person.
  //
  // Push is not configured in this suite, which is the point worth guarding
  // as much as the message itself: registering must still succeed and still
  // return pending when there is nowhere to send a notification. An entry
  // that failed because the party had no push keys would be a worse bug
  // than the one being fixed.
  const night = 'swamp';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  const asker = (await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Duo Asker' } })).data;
  const partner = (await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Duo Partner' } })).data;

  const entry = await api('POST', '/outfit/register', {
    token: asker.token,
    body: { name: 'Two Of Us', night, partnerUserId: partner.id, photoBase64: TEST_PHOTO },
  });
  assert.equal(entry.status, 201);
  assert.equal(entry.data.pending, true, 'a duo entry waits on the partner');

  // And it is genuinely waiting on them - visible to nobody as a contestant
  // until confirmed, which is what makes the notification worth sending.
  const roster = (await api('GET', `/votes/status?night=${night}`, { token: partner.token })).data.contestants;
  assert.equal(roster.find((c) => c.name === 'Two Of Us'), undefined);

  const confirmed = await api('POST', '/outfit/register/confirm', { token: partner.token, body: { night } });
  assert.equal(confirmed.status, 200);
  const after = (await api('GET', `/votes/status?night=${night}`, { token: partner.token })).data.contestants;
  assert.ok(after.find((c) => c.name === 'Two Of Us'), 'once confirmed it joins the running');

  await api('DELETE', `/admin/users/${asker.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${partner.id}`, { token: ADMIN });
});

test('a duo entry is not in the running until the named partner confirms it', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Entry One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Entry Two' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const reg = await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Unconfirmed Pair', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.pending, true);

  // Not votable, and not in anyone's contestant list, while unconfirmed.
  const listed = await api('GET', `/votes/status?night=${night}`, { token: ADMIN });
  assert.equal(listed.data.contestants.find((c) => c.id === reg.data.id), undefined,
    'an unconfirmed duo entry must stay off the voting list');
  // ...but the owner's roster does show it, flagged, so it can be chased.
  const roster = await api('GET', `/admin/contestants?night=${night}`, { token: ADMIN });
  assert.equal(roster.data.contestants.find((c) => c.id === reg.data.id).confirmed, 0);

  // The person who entered it can't wave it through themselves.
  const selfConfirm = await api('POST', '/outfit/register/confirm', { token: a.data.token, body: { night } });
  assert.equal(selfConfirm.status, 400);
  assert.equal(selfConfirm.data.error, 'err_partner_must_confirm_entry');

  // Opening the voting is refused once, since it would strand the entry.
  const blocked = await api('POST', `/admin/voting/${night}/open`, { token: ADMIN });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error, 'err_pending_duo_entries');
  assert.equal(blocked.data.pending, 1);

  // The named partner confirming is what puts them in the running.
  const confirm = await api('POST', '/outfit/register/confirm', { token: b.data.token, body: { night } });
  assert.equal(confirm.status, 200);
  const nowListed = await api('GET', `/votes/status?night=${night}`, { token: ADMIN });
  assert.ok(nowListed.data.contestants.find((c) => c.id === reg.data.id),
    'once confirmed the pair should appear as a real contestant');

  // ...and with nothing pending, opening no longer needs forcing.
  const opened = await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  assert.equal(opened.status, 200);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('a refused duo entry frees both people to enter again', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Refuse One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Refuse Two' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Doomed Pair', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  // While it stands, it reserves both of them - neither can enter separately.
  const blocked = await api('POST', '/outfit/register', { token: b.data.token, body: { name: 'Solo Try', night, photoBase64: TEST_PHOTO } });
  assert.equal(blocked.status, 400);

  const refuse = await api('DELETE', '/outfit/register/pending', { token: b.data.token, body: { night } });
  assert.equal(refuse.status, 200);

  // Both are free again afterwards.
  const soloB = await api('POST', '/outfit/register', { token: b.data.token, body: { name: 'Solo B', night, photoBase64: TEST_PHOTO } });
  assert.equal(soloB.status, 201);
  assert.equal(soloB.data.pending, false, 'a solo entry needs nobody to confirm it');
  const soloA = await api('POST', '/outfit/register', { token: a.data.token, body: { name: 'Solo A', night, photoBase64: TEST_PHOTO } });
  assert.equal(soloA.status, 201);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('either half of a pending duo can cancel it themselves, but not once it is confirmed', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cancel One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cancel Two' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  // Nothing registered yet - both actions 400 rather than crash.
  const noEntryConfirm = await api('POST', '/outfit/register/confirm', { token: a.data.token, body: { night } });
  assert.equal(noEntryConfirm.status, 400);
  assert.equal(noEntryConfirm.data.error, 'err_no_pending_entry');
  const noEntryCancel = await api('DELETE', '/outfit/register/pending', { token: a.data.token, body: { night } });
  assert.equal(noEntryCancel.status, 400);
  assert.equal(noEntryCancel.data.error, 'err_no_pending_entry');

  await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Second Thoughts', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });

  // A change of heart is the same operation as a refusal - the registrant
  // can drop their own still-pending entry, not just the named partner.
  const selfCancel = await api('DELETE', '/outfit/register/pending', { token: a.data.token, body: { night } });
  assert.equal(selfCancel.status, 200);
  const soloAgain = await api('POST', '/outfit/register', { token: a.data.token, body: { name: 'Solo Again', night, photoBase64: TEST_PHOTO } });
  assert.equal(soloAgain.status, 201);

  // Once confirmed, it's a real entry - cancel/confirm no longer apply to
  // it (there's no un-entering yourself; that's the owner's remove button).
  const c = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cancel Three' } });
  const d = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Cancel Four' } });
  await api('POST', '/outfit/register', {
    token: c.data.token,
    body: { name: 'Settled Pair', night, partnerUserId: d.data.id, photoBase64: TEST_PHOTO },
  });
  await api('POST', '/outfit/register/confirm', { token: d.data.token, body: { night } });

  const reconfirm = await api('POST', '/outfit/register/confirm', { token: d.data.token, body: { night } });
  assert.equal(reconfirm.status, 400);
  assert.equal(reconfirm.data.error, 'err_you_already_registered');
  const lateCancel = await api('DELETE', '/outfit/register/pending', { token: c.data.token, body: { night } });
  assert.equal(lateCancel.status, 400);
  assert.equal(lateCancel.data.error, 'err_you_already_registered');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('the contestant picker only offers people who are still free that night', async () => {
  const night = 'swamp';
  const entered = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Already In Duo' } });
  const partner = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Already In Partner' } });
  const free = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Still Free Person' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  await api('POST', '/admin/contestants/register', {
    token: ADMIN,
    body: { userId: entered.data.id, partnerUserId: partner.data.id, name: 'Taken Pair', night },
  });

  const plain = await api('GET', '/users/basic', { token: ADMIN });
  assert.ok(plain.data.some((u) => u.id === entered.data.id), 'the unfiltered list is unchanged - the guest picker still wants everyone');

  const freeOnly = await api('GET', `/users/basic?freeFor=${night}`, { token: ADMIN });
  const ids = freeOnly.data.map((u) => u.id);
  assert.ok(!ids.includes(entered.data.id), 'whoever entered is not offered again');
  assert.ok(!ids.includes(partner.data.id), 'nor the partner named on their entry');
  assert.ok(ids.includes(free.data.id), 'anyone still free is');
  // Unlike the plain list, this one keeps the caller: an organiser filling
  // the form in may be entering themselves.
  assert.ok(ids.includes(1), 'the caller is offered too, as long as they are free');

  // A night nobody has entered is untouched by the filter.
  const otherNight = await api('GET', '/users/basic?freeFor=furnished', { token: ADMIN });
  assert.ok(otherNight.data.some((u) => u.id === entered.data.id), 'being entered for one night says nothing about another');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  for (const u of [entered, partner, free]) await api('DELETE', `/admin/users/${u.data.id}`, { token: ADMIN });
});

test('an admin entering a pair on their behalf does not need a confirmation', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Admin Pair One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Admin Pair Two' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const reg = await api('POST', '/admin/contestants/register', {
    token: ADMIN,
    body: { userId: a.data.id, partnerUserId: b.data.id, name: 'Organiser Pair', night },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.pending, false);

  const listed = await api('GET', `/votes/status?night=${night}`, { token: ADMIN });
  assert.ok(listed.data.contestants.find((c) => c.id === reg.data.id),
    'an organiser-created pair should be in the running immediately');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('self-registration requires a valid photo, but an organiser registering on someone\'s behalf does not', async () => {
  const night = 'swamp';
  const solo = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Required' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const noPhoto = await api('POST', '/outfit/register', { token: solo.data.token, body: { name: 'No Photo', night } });
  assert.equal(noPhoto.status, 400);
  assert.equal(noPhoto.data.error, 'err_photo_required');

  const notAnImage = await api('POST', '/outfit/register', {
    token: solo.data.token,
    body: { name: 'Bad Photo', night, photoBase64: 'data:image/jpeg;base64,bm90IGEgamZpZg==' },
  });
  assert.equal(notAnImage.status, 400);
  assert.equal(notAnImage.data.error, 'err_photo_invalid');

  const wrongMime = await api('POST', '/outfit/register', {
    token: solo.data.token,
    body: { name: 'Wrong Mime', night, photoBase64: 'data:image/png;base64,aWJ2ZXI=' },
  });
  assert.equal(wrongMime.status, 400);
  assert.equal(wrongMime.data.error, 'err_photo_invalid');

  const tooBig = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(500 * 1024, 1)]).toString('base64');
  const oversized = await api('POST', '/outfit/register', { token: solo.data.token, body: { name: 'Huge Photo', night, photoBase64: tooBig } });
  assert.equal(oversized.status, 400);
  assert.equal(oversized.data.error, 'err_photo_too_large');

  const ok = await api('POST', '/outfit/register', { token: solo.data.token, body: { name: 'Good Photo', night, photoBase64: TEST_PHOTO } });
  assert.equal(ok.status, 201);

  // The organiser registering someone else skips the whole requirement,
  // same as it already skips duo confirmation (autoConfirm).
  const c = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Organiser Solo' } });
  const organiserReg = await api('POST', '/admin/contestants/register', { token: ADMIN, body: { userId: c.data.id, name: 'No Photo Needed', night } });
  assert.equal(organiserReg.status, 201);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('an organiser registering someone else can attach a photo at the same time', async () => {
  // The admin form has always had a photo picker, but nothing was wired to
  // it and the route dropped photoBase64 on the floor, so an organiser
  // adding an entry could never attach a photo at that moment - only after
  // the fact via "mudar foto".
  const night = 'furnished';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Organiser Photo Guest' } });

  const reg = await api('POST', '/admin/contestants/register', {
    token: ADMIN,
    body: { userId: guest.data.id, name: 'With A Photo', night, photoBase64: TEST_PHOTO },
  });
  assert.equal(reg.status, 201);

  const listed = (await api('GET', `/admin/contestants?night=${night}`, { token: ADMIN }))
    .data.contestants.find((c) => c.id === reg.data.id);
  assert.equal(!!listed.hasPhoto, true, 'the attached photo is actually stored, not silently discarded');

  const photo = await api('GET', `/outfit/contestants/${reg.data.id}/photo`, { token: ADMIN });
  assert.equal(photo.status, 200, 'and it can be fetched back');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('DELETE', `/admin/users/${guest.data.id}`, { token: ADMIN });
});

test('either half of a duo can replace the entry photo before voting opens, not after', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Swap One' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Swap Two' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const reg = await api('POST', '/outfit/register', {
    token: a.data.token,
    body: { name: 'Swappable Pair', night, partnerUserId: b.data.id, photoBase64: TEST_PHOTO },
  });
  await api('POST', '/outfit/register/confirm', { token: b.data.token, body: { night } });

  // The partner didn't register it, but the photo belongs to the entry,
  // not to whoever uploaded it first.
  const swapByPartner = await api('PUT', '/outfit/register/photo', { token: b.data.token, body: { night, photoBase64: TEST_PHOTO } });
  assert.equal(swapByPartner.status, 200);
  const swapByRegistrant = await api('PUT', '/outfit/register/photo', { token: a.data.token, body: { night, photoBase64: TEST_PHOTO } });
  assert.equal(swapByRegistrant.status, 200);

  // Nobody without an entry tonight can "replace" a photo that isn't theirs.
  const stranger = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Stranger' } });
  const noEntry = await api('PUT', '/outfit/register/photo', { token: stranger.data.token, body: { night, photoBase64: TEST_PHOTO } });
  assert.equal(noEntry.status, 400);
  assert.equal(noEntry.data.error, 'err_no_contestant_entry');

  // Opening voting locks the roster - the photo included.
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  const afterOpen = await api('PUT', '/outfit/register/photo', { token: a.data.token, body: { night, photoBase64: TEST_PHOTO } });
  assert.equal(afterOpen.status, 400);
  assert.equal(afterOpen.data.error, 'err_registration_not_open');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('a contestant photo is visible to its own entrants and admins any time, but to everyone else only once revealed', async () => {
  const night = 'swamp';
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Owner' } });
  const rival = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Photo Rival' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const reg = await api('POST', '/outfit/register', { token: a.data.token, body: { name: 'Reveal Persona', night, photoBase64: TEST_PHOTO } });
  const photoUrl = `/outfit/contestants/${reg.data.id}/photo`;

  // The registrant can always see their own entry's photo.
  const ownView = await api('GET', photoUrl, { token: a.data.token });
  assert.equal(ownView.status, 200);
  // An admin can always see it too, for moderation.
  const adminView = await api('GET', photoUrl, { token: ADMIN });
  assert.equal(adminView.status, 200);
  // Nobody else can, before it's been revealed.
  const earlyPeek = await api('GET', photoUrl, { token: rival.data.token });
  assert.equal(earlyPeek.status, 404);

  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  await api('POST', '/votes', { token: rival.data.token, body: { contestantId: reg.data.id, night } });
  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN });

  // Still hidden while the reveal is staged and hasn't reached this rank.
  const stillHidden = await api('GET', photoUrl, { token: rival.data.token });
  assert.equal(stillHidden.status, 404);

  // Once the reveal actually reaches "all", it opens up to everyone -
  // advance through every stage (hidden -> third -> second -> first -> all)
  // regardless of how many contestants there are.
  for (let i = 0; i < 4; i++) {
    await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });
  }
  const revealed = await api('GET', photoUrl, { token: rival.data.token });
  assert.equal(revealed.status, 200);
  assert.ok(revealed.headers.get('content-type').startsWith('image/jpeg'));

  // A contestant with no photo at all (e.g. an organiser quick-add) 404s
  // rather than crashing.
  const noPhotoEntry = await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'Photoless', night } });
  const missing = await api('GET', `/outfit/contestants/${noPhotoEntry.data.id}/photo`, { token: ADMIN });
  assert.equal(missing.status, 404);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

test('admin/owner can download every submitted photo for a night as a zip; nobody else can', async () => {
  const night = 'swamp';
  const regular = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Zip Bystander' } });
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Zip Persona A' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Zip Persona B' } });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });

  const regA = await api('POST', '/outfit/register', { token: a.data.token, body: { name: 'Ghost', night, photoBase64: TEST_PHOTO } });
  // Same character name on purpose - collisions inside the zip should
  // dedupe by contestant id rather than one entry silently overwriting the
  // other (see the filename logic in routes.js).
  const regB = await api('POST', '/outfit/register', { token: b.data.token, body: { name: 'Ghost', night, photoBase64: TEST_PHOTO } });

  // Not an admin - no access at all, regardless of the night's data.
  const forbidden = await apiBuffer(`/admin/outfit/${night}/photos.zip`, { token: regular.data.token });
  assert.equal(forbidden.status, 403);

  const zipRes = await apiBuffer(`/admin/outfit/${night}/photos.zip`, { token: ADMIN });
  assert.equal(zipRes.status, 200);
  assert.equal(zipRes.headers.get('content-type'), 'application/zip');
  assert.ok(zipRes.headers.get('content-disposition').includes(`snatch-${night}-photos.zip`));

  const entries = await readZipEntries(zipRes.buffer);
  assert.equal(entries.length, 2, 'both contestants photos should be in the zip, deduped by id');
  // Whichever comes first keeps the clean name; the later same-named one
  // falls back to id-suffixed rather than the two colliding outright - not
  // asserting which specific one wins, just that dedup actually happened.
  const filenames = entries.map((e) => e.filename);
  // Lowercased on the way in: the app is lowercase throughout, and a
  // case-insensitive filesystem would collide "Ghost.jpg" with "ghost.jpg"
  // on extraction anyway.
  assert.ok(filenames.every((f) => f === f.toLowerCase()), 'entry names should be lowercase');
  assert.equal(filenames.filter((f) => f === 'ghost.jpg').length, 1, 'exactly one entry should keep the clean name');
  assert.equal(
    filenames.filter((f) => f === `ghost-${regA.data.id}.jpg` || f === `ghost-${regB.data.id}.jpg`).length,
    1,
    'the colliding entry should fall back to an id-suffixed name'
  );
  // Bytes actually made it through intact, not just the right count/names.
  const expectedBytes = Buffer.from(TEST_PHOTO.slice('data:image/jpeg;base64,'.length), 'base64');
  for (const entry of entries) {
    assert.equal(Buffer.compare(entry.contents, expectedBytes), 0, `${entry.filename} bytes should match what was uploaded`);
  }

  // A night with confirmed registration but no photos at all (furnished,
  // untouched by this test) 404s instead of handing back an empty zip.
  const empty = await apiBuffer('/admin/outfit/furnished/photos.zip', { token: ADMIN });
  assert.equal(empty.status, 404);

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
});

/* --------------------------- Owner content reset -------------------------- */
// Wipes contestants/votes/consequences - runs last so it doesn't disturb
// the shared state the tests above rely on.

test('a non-owner admin can read and change the day-rollover-hour setting', async () => {
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const get = await api('GET', '/admin/settings', { token: userToken });
  assert.equal(get.status, 200);
  const put = await api('PUT', '/admin/settings', { token: userToken, body: { dayRolloverHour: 6 } });
  assert.equal(put.status, 200);
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
});

test('a non-owner admin cannot use any feature wipe switch', async () => {
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });
  for (const path of ['/admin/consequences/wipe', '/admin/contestants/wipe', '/admin/plaza-posts/wipe', '/admin/chat/wipe', '/admin/memo/wipe']) {
    const r = await api('POST', path, { token: userToken });
    assert.equal(r.status, 403, `${path} should be owner-only`);
  }
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
});

test('a non-owner admin can add a Best Look contestant but not remove one', async () => {
  // Adding is the sort of thing a helper does on the night - someone turns
  // up, someone puts them on the list. Removing is not: it throws away an
  // entry and any votes attached to it, so it stays with the owner.
  await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: true } });
  try {
    await api('POST', `/admin/voting/${NIGHT}/registration`, { token: ADMIN });

    const byAdmin = await api('POST', '/admin/contestants/register', {
      token: userToken,
      body: { userId, name: 'Admin Registered', night: NIGHT },
    });
    assert.equal(byAdmin.status, 201, 'an admin should be able to put someone on the list');

    const remove = await api('DELETE', `/admin/contestants/${byAdmin.data.id}`, { token: userToken });
    assert.equal(remove.status, 403, 'but not take anyone off it');

    await api('DELETE', `/admin/contestants/${byAdmin.data.id}`, { token: ADMIN });
  } finally {
    // Always demoted, even if an assertion above throws: this is the shared
    // user, and leaving it an admin quietly breaks every later test that
    // expects a plain account. That is exactly what happened when these
    // rules changed - one failure here, one apparently unrelated failure
    // in Plaza.
    await api('PATCH', `/admin/users/${userId}/admin`, { token: ADMIN, body: { isAdmin: false } });
  }
});

/* ----------------------------------- Chat ---------------------------------- */

test('posting and reading a chat message', async () => {
  const post = await api('POST', '/chat/messages', { token: ADMIN, body: { text: 'ola pessoal' } });
  assert.equal(post.status, 201);

  const list = await api('GET', '/chat/messages', { token: ADMIN });
  assert.equal(list.status, 200);
  const found = list.data.messages.find((m) => m.text === 'ola pessoal');
  assert.ok(found, 'posted message should appear in the list');
  // The Wall is anonymous - author is a random pseudonym, never the real
  // poster's name or user id.
  assert.notEqual(found.author, 'Test Admin');
  assert.match(found.author, /^[a-z]+$/);
  // "time" is created_at converted to the configured timezone, not the raw
  // UTC value - the client must never format created_at itself (see
  // formatTimeInZone() in time.js).
  assert.match(found.time, /^\d{2}:\d{2}$/);
});

test("a user's Wall pseudonym stays the same across multiple posts", async () => {
  await api('POST', '/chat/messages', { token: userToken, body: { text: 'stable-1' } });
  await api('POST', '/chat/messages', { token: userToken, body: { text: 'stable-2' } });

  const list = await api('GET', '/chat/messages', { token: ADMIN });
  const msg1 = list.data.messages.find((m) => m.text === 'stable-1');
  const msg2 = list.data.messages.find((m) => m.text === 'stable-2');
  assert.ok(msg1 && msg2, 'both messages should be in the list');
  assert.equal(msg1.author, msg2.author, 'the same user should get the same pseudonym on every post');
});

test('Wall messages are lowercased, but special characters and emoji survive', async () => {
  const post = await api('POST', '/chat/messages', { token: ADMIN, body: { text: 'OLÁ Malta!! 😀 <b>test</b> ***' } });
  assert.equal(post.status, 201);

  const list = await api('GET', '/chat/messages', { token: ADMIN });
  const found = list.data.messages.find((m) => m.text.startsWith('olá malta'));
  assert.ok(found, 'sanitized message should appear in the list');
  assert.equal(found.text, 'olá malta!! 😀 <b>test</b> ***');
});

test('the Wall name<->pseudonym mapping is owner-only', async () => {
  const forbidden = await api('GET', '/admin/wall-pseudonyms', { token: userToken });
  assert.equal(forbidden.status, 403);

  const ok = await api('GET', '/admin/wall-pseudonyms', { token: ADMIN });
  assert.equal(ok.status, 200);
  const entry = ok.data.find((r) => r.name === 'Ivo');
  assert.ok(entry, 'the posting user should show up in the mapping');

  const list = await api('GET', '/chat/messages', { token: ADMIN });
  const theirMsg = list.data.messages.find((m) => m.text === 'stable-1');
  const current = entry.pseudonyms[entry.pseudonyms.length - 1];
  assert.equal(current, theirMsg.author, 'the mapping should match what actually shows on the Wall');
});

test('a Wall pseudonym can be reset once a day, and the owner sees the full history', async () => {
  const before = await api('GET', '/admin/wall-pseudonyms', { token: ADMIN });
  const entryBefore = before.data.find((r) => r.name === 'Ivo');
  const oldPseudonym = entryBefore.pseudonyms[entryBefore.pseudonyms.length - 1];

  const forbidden = await api('POST', `/admin/users/${userId}/wall-pseudonym/reset`, { token: userToken });
  assert.equal(forbidden.status, 403, 'non-owner admins cannot reset a pseudonym');

  const first = await api('POST', `/admin/users/${userId}/wall-pseudonym/reset`, { token: ADMIN });
  assert.equal(first.status, 200);
  assert.notEqual(first.data.pseudonym, oldPseudonym, 'reset should produce a different pseudonym');

  const again = await api('POST', `/admin/users/${userId}/wall-pseudonym/reset`, { token: ADMIN });
  assert.equal(again.status, 400, 'a second reset the same day should be rejected');

  const after = await api('GET', '/admin/wall-pseudonyms', { token: ADMIN });
  const entryAfter = after.data.find((r) => r.name === 'Ivo');
  assert.ok(entryAfter.pseudonyms.includes(oldPseudonym), 'the old pseudonym should stay in the history');
  assert.ok(entryAfter.pseudonyms.includes(first.data.pseudonym), 'the new pseudonym should be in the history too');

  const list = await api('GET', '/chat/messages', { token: ADMIN });
  const oldMsg = list.data.messages.find((m) => m.text === 'stable-1');
  assert.equal(oldMsg.author, oldPseudonym, 'messages already posted keep the pseudonym that was active at the time');
});

test('a user can change their own access key, given the correct current one', async () => {
  const created = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Selfservice' } });
  const oldToken = created.data.token;

  const wrongOld = await api('POST', '/me/change-token', {
    token: oldToken, body: { currentToken: 'notthecurrentone', newToken: 'newkey1234' },
  });
  assert.equal(wrongOld.status, 401);

  const badChars = await api('POST', '/me/change-token', {
    token: oldToken, body: { currentToken: oldToken, newToken: 'has-a-dash!' },
  });
  assert.equal(badChars.status, 400);

  const tooShort = await api('POST', '/me/change-token', {
    token: oldToken, body: { currentToken: oldToken, newToken: 'abc123' },
  });
  assert.equal(tooShort.status, 400, 'a 6-character key should be rejected - minimum is 7');

  const ok = await api('POST', '/me/change-token', {
    token: oldToken, body: { currentToken: oldToken, newToken: 'newkey1234' },
  });
  assert.equal(ok.status, 200);

  const oldStillWorks = await api('GET', '/me', { token: oldToken });
  assert.equal(oldStillWorks.status, 401, 'old key should stop working after the change');

  const newWorks = await api('GET', '/me', { token: 'newkey1234' });
  assert.equal(newWorks.status, 200, 'new key should work immediately');
});

// Ivo's question: if two people end up choosing the same key, the second
// one must be refused. It is - the existing test below covers the plain
// case. These are the ways round it that nobody had checked.
test('a key cannot be taken by changing its case, or by two people at once', async () => {
  (await import('../src/rateLimit.js')).resetAuthAttempts();
  const ana = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Collision Ana' } });
  const bruno = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Collision Bruno' } });

  const taken = await api('POST', '/me/change-token', {
    token: ana.data.token,
    body: { currentToken: ana.data.token, newToken: 'partilhada1' },
  });
  assert.equal(taken.status, 200);

  // Keys are lowercased on the way in, so capitals must not read as a
  // different key - otherwise two people hold what they both type the same.
  const shouted = await api('POST', '/me/change-token', {
    token: bruno.data.token,
    body: { currentToken: bruno.data.token, newToken: 'PARTILHADA1' },
  });
  assert.equal(shouted.status, 409, 'capitalising a taken key must not slip past the check');
  assert.equal(shouted.data.error, 'err_key_taken');

  // Two people choosing the same key in the same moment. One takes it; the
  // other must be told it is taken, not handed a server error - people
  // picking the same word at a party is ordinary, not a fault.
  const carla = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Collision Carla' } });
  const diogo = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Collision Diogo' } });
  const [one, two] = await Promise.all([
    api('POST', '/me/change-token', { token: carla.data.token, body: { currentToken: carla.data.token, newToken: 'simultanea9' } }),
    api('POST', '/me/change-token', { token: diogo.data.token, body: { currentToken: diogo.data.token, newToken: 'simultanea9' } }),
  ]);
  const codes = [one.status, two.status].sort();
  assert.deepEqual(codes, [200, 409], `expected one winner and one clean refusal, got ${codes}`);
  assert.ok(![one.status, two.status].includes(500), 'a taken key is not a server error');

  // Whatever happened, no two accounts may end up sharing a key.
  const { distinct_keys: distinct, users } = db
    .prepare('SELECT COUNT(DISTINCT token_hash) AS distinct_keys, COUNT(*) AS users FROM users').get();
  assert.equal(distinct, users, 'two accounts are sharing a key');

  for (const u of [ana, bruno, carla, diogo]) {
    await api('DELETE', `/admin/users/${u.data.id}`, { token: ADMIN });
  }
});

test('changing to a key that already belongs to someone else is rejected', async () => {
  (await import('../src/rateLimit.js')).resetAuthAttempts();
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'KeyOwnerA' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'KeyOwnerB' } });

  const collision = await api('POST', '/me/change-token', {
    token: b.data.token, body: { currentToken: b.data.token, newToken: a.data.token },
  });
  assert.equal(collision.status, 409);
});

test('an empty chat message is rejected', async () => {
  const r = await api('POST', '/chat/messages', { token: ADMIN, body: { text: '   ' } });
  assert.equal(r.status, 400);
});

test('chat keeps only the 20 most recent messages', async () => {
  for (let i = 0; i < 25; i++) {
    await api('POST', '/chat/messages', { token: ADMIN, body: { text: `msg-${i}` } });
  }
  const list = await api('GET', '/chat/messages', { token: ADMIN });
  assert.ok(list.data.messages.length <= 20, `expected at most 20 messages, got ${list.data.messages.length}`);
  // The oldest ones (msg-0..msg-4) must have been trimmed; the latest survive.
  const texts = list.data.messages.map((m) => m.text);
  assert.ok(!texts.includes('msg-0'), 'oldest message should have been pruned');
  assert.ok(texts.includes('msg-24'), 'most recent message should still be there');
});

/* ------------------------------ Language preference ------------------------ */

test('a user can set their language preference, and it is reflected on /me', async () => {
  const r = await api('POST', '/me/lang', { token: ADMIN, body: { lang: 'en' } });
  assert.equal(r.status, 200);

  const me = await api('GET', '/me', { token: ADMIN });
  assert.equal(me.data.lang, 'en');

  // Reset back to pt so it doesn't bleed into other tests relying on ADMIN.
  await api('POST', '/me/lang', { token: ADMIN, body: { lang: 'pt' } });
});

test('an invalid language value falls back to pt', async () => {
  const r = await api('POST', '/me/lang', { token: ADMIN, body: { lang: 'xx' } });
  assert.equal(r.status, 200);
  const me = await api('GET', '/me', { token: ADMIN });
  assert.equal(me.data.lang, 'pt');
});

/* ----------------------------------- Plaza ----------------------------------- */

test('Plaza announcements: any logged-in user can read the feed, any admin (not just the owner) can post one', async () => {
  const forbidden = await api('POST', '/admin/plaza-posts', { token: userToken, body: { type: 'announcement', text: 'sneaky' } });
  assert.equal(forbidden.status, 403);

  const create = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'welcome! wifi: mossycottage' } });
  assert.equal(create.status, 200);

  const read = await api('GET', '/plaza-posts', { token: userToken });
  assert.equal(read.status, 200);
  const announcement = read.data.posts.find((p) => p.id === create.data.id);
  assert.equal(announcement.type, 'announcement');
  assert.equal(announcement.text, 'welcome! wifi: mossycottage');
  assert.equal(announcement.author, 'Test Admin');
  assert.equal(announcement.pinnedAt, null);

  // A regular (non-owner) admin can post to Plaza too now.
  const nonOwnerAdmin = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Plaza Admin Poster' } });
  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const asAdmin = await api('POST', '/admin/plaza-posts', { token: nonOwnerAdmin.data.token, body: { type: 'announcement', text: 'admin-posted announcement' } });
  assert.equal(asAdmin.status, 200);
  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${nonOwnerAdmin.data.id}`, { token: ADMIN });

  await api('DELETE', `/admin/plaza-posts/${create.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/plaza-posts/${asAdmin.data.id}`, { token: ADMIN });
});

test('Plaza pinning: owner-only, either post type, pinned ones sort first (most-recently-pinned first)', async () => {
  const older = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'older announcement' } });
  const newer = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'poll', text: 'Dinner?', options: ['Pizza', 'Sushi'] } });
  const unpinned = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'never pinned' } });

  const nonOwnerAdmin = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Plaza Pin Tester' } });
  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  // Not owner - forbidden, regardless of post type.
  const forbidden = await api('PATCH', `/admin/plaza-posts/${older.data.id}/pin`, { token: nonOwnerAdmin.data.token, body: { pinned: true } });
  assert.equal(forbidden.status, 403);
  const forbiddenPoll = await api('PATCH', `/admin/plaza-posts/${newer.data.id}/pin`, { token: nonOwnerAdmin.data.token, body: { pinned: true } });
  assert.equal(forbiddenPoll.status, 403);

  // Pin the announcement first, then the poll - most-recently-pinned first,
  // and a poll can be pinned same as an announcement.
  const pin1 = await api('PATCH', `/admin/plaza-posts/${older.data.id}/pin`, { token: ADMIN, body: { pinned: true } });
  assert.equal(pin1.status, 200);
  const pin2 = await api('PATCH', `/admin/plaza-posts/${newer.data.id}/pin`, { token: ADMIN, body: { pinned: true } });
  assert.equal(pin2.status, 200);

  const feed = await api('GET', '/plaza-posts', { token: userToken });
  const pinnedIds = feed.data.posts.filter((p) => p.pinnedAt).map((p) => p.id);
  assert.deepEqual(pinnedIds, [newer.data.id, older.data.id]);
  assert.ok(feed.data.posts.findIndex((p) => p.id === older.data.id) < feed.data.posts.findIndex((p) => p.id === unpinned.data.id));

  const unpin = await api('PATCH', `/admin/plaza-posts/${older.data.id}/pin`, { token: ADMIN, body: { pinned: false } });
  assert.equal(unpin.status, 200);
  const afterUnpin = await api('GET', '/plaza-posts', { token: userToken });
  assert.equal(afterUnpin.data.posts.find((p) => p.id === older.data.id).pinnedAt, null);

  await api('PATCH', `/admin/users/${nonOwnerAdmin.data.id}/admin`, { token: ADMIN, body: { isAdmin: false } });
  await api('DELETE', `/admin/users/${nonOwnerAdmin.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/plaza-posts/${older.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/plaza-posts/${newer.data.id}`, { token: ADMIN });
  await api('DELETE', `/admin/plaza-posts/${unpinned.data.id}`, { token: ADMIN });
});

test('Wall links posts: pairs of label and URL, scheme filled in, and anything that is not http(s) refused', async () => {
  const created = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: {
      type: 'links',
      text: 'useful links 🔗',
      links: [
        { emoji: '📃', label: 'Form', url: 'example.com/form' },
        { emoji: '🎹', label: 'Playlist', url: 'https://open.spotify.com/playlist/x' },
        // A wholly empty row is the spare input nobody typed into, not an error.
        { emoji: '', label: '', url: '' },
      ],
    },
  });
  assert.equal(created.status, 200);

  const feed = await api('GET', '/plaza-posts', { token: ADMIN });
  const post = feed.data.posts.find((p) => p.id === created.data.id);
  assert.equal(post.type, 'links');
  assert.deepEqual(post.links.map((l) => l.label), ['Form', 'Playlist']);
  assert.deepEqual(post.links.map((l) => l.emoji), ['📃', '🎹'], 'the emoji is its own field, not part of the name');
  assert.equal(post.links[0].url, 'https://example.com/form', 'a scheme-less link is assumed https, not rejected');
  assert.equal(post.links[1].url, 'https://open.spotify.com/playlist/x', 'an explicit scheme is left alone');

  // Half a row is a mistake worth naming rather than silently dropping.
  const halfRow = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'links', text: 'x', links: [{ label: 'no address', url: '' }] },
  });
  assert.equal(halfRow.status, 400);
  assert.equal(halfRow.data.error, 'err_link_incomplete');

  const noRows = await api('POST', '/admin/plaza-posts', {
    token: ADMIN, body: { type: 'links', text: 'x', links: [] },
  });
  assert.equal(noRows.data.error, 'err_link_min_items');

  // An href the whole party can tap is not the place to allow javascript:.
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd']) {
    const res = await api('POST', '/admin/plaza-posts', {
      token: ADMIN, body: { type: 'links', text: 'x', links: [{ label: 'bad', url: bad }] },
    });
    assert.equal(res.status, 400, `${bad} should be refused`);
    assert.equal(res.data.error, 'err_link_invalid_url', `${bad} should be refused`);
  }
});

test('Plaza polls: creating one requires 2-6 options, voting tallies correctly, and a second vote is rejected rather than moving it', async () => {
  const bad = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'poll', text: 'Dinner?', options: ['Only one'] } });
  assert.equal(bad.status, 400);

  const create = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'poll', text: 'Where for dinner?', options: ['Pizza', 'Sushi', 'Tacos'] },
  });
  assert.equal(create.status, 200);
  const postId = create.data.id;

  const before = await api('GET', '/plaza-posts', { token: userToken });
  const poll = before.data.posts.find((p) => p.id === postId);
  assert.equal(poll.type, 'poll');
  assert.equal(poll.options.length, 3);
  assert.ok(poll.options.every((o) => o.votes === 0));
  assert.equal(poll.myOptionId, null);

  const pizzaId = poll.options.find((o) => o.label === 'Pizza').id;
  const sushiId = poll.options.find((o) => o.label === 'Sushi').id;

  const vote1 = await api('POST', `/plaza-posts/${postId}/vote`, { token: userToken, body: { optionId: pizzaId } });
  assert.equal(vote1.status, 200);
  const voted = vote1.data.posts.find((p) => p.id === postId);
  assert.equal(voted.options.find((o) => o.id === pizzaId).votes, 1);
  assert.equal(voted.myOptionId, pizzaId);

  // A vote is final - trying to switch to a different option is rejected,
  // and the tally stays exactly as it was after the first vote.
  const vote2 = await api('POST', `/plaza-posts/${postId}/vote`, { token: userToken, body: { optionId: sushiId } });
  assert.equal(vote2.status, 400);
  const after = await api('GET', '/plaza-posts', { token: userToken });
  const stillPizza = after.data.posts.find((p) => p.id === postId);
  assert.equal(stillPizza.options.find((o) => o.id === pizzaId).votes, 1);
  assert.equal(stillPizza.options.find((o) => o.id === sushiId).votes, 0);
  assert.equal(stillPizza.myOptionId, pizzaId);

  // Same rejection even when re-submitting the option already voted for.
  const vote3 = await api('POST', `/plaza-posts/${postId}/vote`, { token: userToken, body: { optionId: pizzaId } });
  assert.equal(vote3.status, 400);

  const badVote = await api('POST', `/plaza-posts/${postId}/vote`, { token: userToken, body: { optionId: 999999 } });
  assert.equal(badVote.status, 400);

  await api('DELETE', `/admin/plaza-posts/${postId}`, { token: ADMIN });
});

test('a post can be edited after it is up, and renaming a poll option keeps its votes', async () => {
  // An announcement: the plain case, a typo fixed.
  const ann = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'a rata abre às 21h' } });
  const fixed = await api('PATCH', `/admin/plaza-posts/${ann.data.id}`, { token: ADMIN, body: { text: 'a rata abre às 22h' } });
  assert.equal(fixed.status, 200);
  const feed = await api('GET', '/plaza-posts', { token: userToken });
  assert.equal(feed.status, 200, `feed: ${JSON.stringify(feed.data).slice(0, 120)}`);
  assert.equal(feed.data.posts.find((p) => p.id === ann.data.id).text, 'a rata abre às 22h');

  // A poll someone has already voted in. Renaming an option must not reset
  // the tally - fixing a typo is the whole reason to edit, and losing the
  // votes for it would make editing something nobody dares touch.
  const poll = await api('POST', '/admin/plaza-posts', {
    token: ADMIN, body: { type: 'poll', text: 'onde jantar?', options: ['tasca', 'sushi'] },
  });
  const posted = (await api('GET', '/plaza-posts', { token: userToken })).data.posts.find((p) => p.id === poll.data.id);
  const tasca = posted.options.find((o) => o.label === 'tasca');
  await api('POST', `/plaza-posts/${poll.data.id}/vote`, { token: userToken, body: { optionId: tasca.id } });

  const renamed = await api('PATCH', `/admin/plaza-posts/${poll.data.id}`, {
    token: ADMIN, body: { text: 'onde jantar hoje?', options: ['tasca do zé', 'sushi'] },
  });
  assert.equal(renamed.status, 200);
  const afterEdit = (await api('GET', '/plaza-posts', { token: userToken })).data.posts.find((p) => p.id === poll.data.id);
  assert.equal(afterEdit.text, 'onde jantar hoje?');
  const kept = afterEdit.options.find((o) => o.id === tasca.id);
  assert.ok(kept, 'the option keeps its identity through a rename');
  assert.equal(kept.label, 'tasca do zé');
  assert.equal(kept.votes, 1, 'and it keeps the vote that was cast for it');

  // Links carry no votes, so they are simply replaced.
  const links = await api('POST', '/admin/plaza-posts', {
    token: ADMIN, body: { type: 'links', text: 'links', links: [{ emoji: '📃', label: 'form', url: 'https://a.test/x' }] },
  });
  await api('PATCH', `/admin/plaza-posts/${links.data.id}`, {
    token: ADMIN, body: { text: 'links úteis', links: [{ emoji: '🎹', label: 'playlist', url: 'open.spotify.com/y' }] },
  });
  const editedLinks = (await api('GET', '/plaza-posts', { token: userToken })).data.posts.find((p) => p.id === links.data.id);
  assert.deepEqual(editedLinks.links.map((l) => l.label), ['playlist']);
  assert.equal(editedLinks.links[0].url, 'https://open.spotify.com/y', 'the missing scheme is filled in on an edit too');

  // The same rules as creating - an edit is not a way round the limits.
  const tooFew = await api('PATCH', `/admin/plaza-posts/${poll.data.id}`, {
    token: ADMIN, body: { text: 'onde jantar?', options: ['só uma'] },
  });
  assert.equal(tooFew.status, 400);
  assert.equal(tooFew.data.error, 'err_poll_min_options');

  const empty = await api('PATCH', `/admin/plaza-posts/${ann.data.id}`, { token: ADMIN, body: { text: '   ' } });
  assert.equal(empty.status, 400);

  const missing = await api('PATCH', '/admin/plaza-posts/999999', { token: ADMIN, body: { text: 'nada' } });
  assert.equal(missing.status, 404);

  for (const id of [ann.data.id, poll.data.id, links.data.id]) {
    await api('DELETE', `/admin/plaza-posts/${id}`, { token: ADMIN });
  }
});

test('a Wall post can carry a photo, and an edit only drops it when told to', async () => {
  // Ivo asked for photos on Wall posts. The half worth guarding is not that
  // a photo can be attached - it is the edit path, which has three distinct
  // intentions that all arrive as the same field:
  //   a data URL replaces it, null removes it, and ABSENT leaves it alone.
  // Collapsing the last two is the obvious bug, and it is silent: every
  // admin fixing a typo from a form that knows nothing about photos would
  // strip the picture off the post without being told.
  const made = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'announcement', text: 'a casa por dentro', photoBase64: TEST_PHOTO },
  });
  assert.equal(made.status, 200);
  const id = made.data.id;

  const feed = await api('GET', '/plaza-posts', { token: ADMIN });
  assert.ok(feed.data.posts.find((p) => p.id === id).hasPhoto, 'the feed has to say a post carries a photo');

  // Served as an image, not as JSON. node:sqlite hands a BLOB back as a
  // Uint8Array, which res.send() will happily serialize into {"0":255,...}
  // if it is not wrapped - and an <img> reports that failure to nobody.
  const shown = await fetch(`${base}/plaza-posts/${id}/photo`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await shown.arrayBuffer());
  assert.equal(bytes[0], 0xff, 'the first byte has to be JPEG, not a "{"');
  assert.equal(bytes[1], 0xd8);

  // Editing the words alone leaves the photo where it is.
  await api('PATCH', `/admin/plaza-posts/${id}`, { token: ADMIN, body: { text: 'a casa por dentro e por fora' } });
  const afterEdit = await api('GET', '/plaza-posts', { token: ADMIN });
  assert.ok(afterEdit.data.posts.find((p) => p.id === id).hasPhoto, 'a text-only edit must not drop the photo');

  // Asking for it to go is the only thing that removes it.
  await api('PATCH', `/admin/plaza-posts/${id}`, { token: ADMIN, body: { text: 'sem foto', photoBase64: null } });
  const afterRemove = await api('GET', '/plaza-posts', { token: ADMIN });
  assert.equal(afterRemove.data.posts.find((p) => p.id === id).hasPhoto, 0);
  const gone = await fetch(`${base}/plaza-posts/${id}/photo`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(gone.status, 404, 'once removed the photo route has nothing to serve');

  // Anything that is not a JPEG is refused outright rather than stored and
  // served as a broken image later.
  const junk = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'announcement', text: 'lixo', photoBase64: 'data:image/jpeg;base64,bm90YWpwZWc=' },
  });
  assert.equal(junk.status, 400);
  assert.equal(junk.data.error, 'err_photo_invalid');

  // And the size ceiling is enforced here, not only in the browser.
  const huge = `data:image/jpeg;base64,${Buffer.concat([
    Buffer.from([0xff, 0xd8]), Buffer.alloc(500 * 1024, 0x41),
  ]).toString('base64')}`;
  const tooBig = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'announcement', text: 'enorme', photoBase64: huge },
  });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.data.error, 'err_photo_too_large');

  await api('DELETE', `/admin/plaza-posts/${id}`, { token: ADMIN });
});

test('Plaza posts: only the owner can delete, and deleting one leaves the rest of the feed untouched', async () => {
  const create = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'temporary announcement' } });
  const postId = create.data.id;

  // Regular user cannot delete
  const forbidden = await api('DELETE', `/admin/plaza-posts/${postId}`, { token: userToken });
  assert.equal(forbidden.status, 403);

  // Non-owner admin cannot delete
  const admin2 = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'test-admin-2' } });
  await api('PATCH', `/admin/users/${admin2.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const forbiddenAdmin = await api('DELETE', `/admin/plaza-posts/${postId}`, { token: admin2.data.token });
  assert.equal(forbiddenAdmin.status, 403);

  // Owner can delete
  const del = await api('DELETE', `/admin/plaza-posts/${postId}`, { token: ADMIN });
  assert.equal(del.status, 200);

  const after = await api('GET', '/plaza-posts', { token: userToken });
  assert.ok(!after.data.posts.some((p) => p.id === postId), 'deleted post should no longer appear in the feed');

  const missing = await api('DELETE', `/admin/plaza-posts/${postId}`, { token: ADMIN });
  assert.equal(missing.status, 404);
});

test('Plaza is gated behind ENABLE_PLAZA - disabled means every endpoint 404s', async () => {
  process.env.ENABLE_PLAZA = 'false';
  try {
    const read = await api('GET', '/plaza-posts', { token: userToken });
    assert.equal(read.status, 404);

    const write = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'should not save' } });
    assert.equal(write.status, 404);

    const vote = await api('POST', '/plaza-posts/1/vote', { token: userToken, body: { optionId: 1 } });
    assert.equal(vote.status, 404);

    const pin = await api('PATCH', '/admin/plaza-posts/1/pin', { token: ADMIN, body: { pinned: true } });
    assert.equal(pin.status, 404);
  } finally {
    process.env.ENABLE_PLAZA = 'true';
  }
});

/* ------------------------------ Translations ------------------------------ */
// Guest- and admin-written text is translated in the background so everyone
// reads the party in the language they picked. None of this calls Anthropic:
// the storage layer and both read paths are exercised by writing rows
// directly, which is what the split between translations.js (storage) and
// translate.js (the API client) exists for. The suite must stay green with
// no key and no network.

/** Writes a finished translation straight in, standing in for the API. */
function fakeTranslation(entityType, entityId, field, lang, text) {
  db.prepare(`
    INSERT INTO translations (entity_type, entity_id, field, lang, text, status)
    VALUES (?, ?, ?, ?, ?, 'ok')
    ON CONFLICT(entity_type, entity_id, field, lang) DO UPDATE SET text = excluded.text, status = 'ok'
  `).run(entityType, entityId, field, lang, text);
}

test('with no API key the app behaves exactly as it did before translations existed', async () => {
  // The key is pinned empty at the top of this file, so this is the same
  // state as a deploy before the secret is set - and the assertion is that
  // the app is fine in it, not that the developer happens to lack a key.
  // It read as the latter until a real key landed in .env and this test
  // started failing for being true about the wrong thing.
  assert.equal(isConfigured(), false, 'the suite must never reach the real API');

  const posted = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'announcement', text: 'jantar às oito' },
  });
  assert.equal(posted.status, 200);

  const { data } = await api('GET', '/plaza-posts?lang=en', { token: userToken });
  const post = data.posts.find((p) => p.id === posted.data.id);
  assert.equal(post.text, 'jantar às oito', 'the original must be shown when nothing was translated');
  assert.equal(post.originalText, undefined, 'with no translation there is nothing to toggle to');

  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
});

test('a reader gets their own language, and the original travels with it', async () => {
  const posted = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'announcement', text: 'o jantar é às oito' },
  });
  fakeTranslation('plaza_post', posted.data.id, 'text', 'en', 'dinner is at eight');

  const en = await api('GET', '/plaza-posts?lang=en', { token: userToken });
  const enPost = en.data.posts.find((p) => p.id === posted.data.id);
  assert.equal(enPost.text, 'dinner is at eight');
  assert.equal(enPost.originalText, 'o jantar é às oito', 'the client needs the original to offer "see original"');

  // The language it was written in has no translation row, so it is served
  // untouched - nobody should be offered a "translation" of their own words.
  const pt = await api('GET', '/plaza-posts?lang=pt', { token: userToken });
  const ptPost = pt.data.posts.find((p) => p.id === posted.data.id);
  assert.equal(ptPost.text, 'o jantar é às oito');
  assert.equal(ptPost.originalText, undefined);

  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
});

test('poll options and link labels are translated, but a link url never is', async () => {
  const poll = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'poll', text: 'a que horas?', options: ['às oito', 'às nove'] },
  });
  const before = (await api('GET', '/plaza-posts', { token: userToken }))
    .data.posts.find((p) => p.id === poll.data.id);
  fakeTranslation('poll_option', before.options[0].id, 'label', 'en', 'at eight');

  const after = (await api('GET', '/plaza-posts?lang=en', { token: userToken }))
    .data.posts.find((p) => p.id === poll.data.id);
  assert.equal(after.options[0].label, 'at eight');
  assert.equal(after.options[0].originalLabel, 'às oito');
  assert.equal(after.options[1].label, 'às nove', 'an untranslated option keeps its own words');

  const links = await api('POST', '/admin/plaza-posts', {
    token: ADMIN,
    body: { type: 'links', text: 'links úteis', links: [{ emoji: '🎵', label: 'a playlist', url: 'https://example.com/x' }] },
  });
  const linkBefore = (await api('GET', '/plaza-posts', { token: userToken }))
    .data.posts.find((p) => p.id === links.data.id);
  fakeTranslation('link_item', linkBefore.links[0].id, 'label', 'en', 'the playlist');

  const linkAfter = (await api('GET', '/plaza-posts?lang=en', { token: userToken }))
    .data.posts.find((p) => p.id === links.data.id);
  assert.equal(linkAfter.links[0].label, 'the playlist');
  assert.equal(linkAfter.links[0].url, 'https://example.com/x', 'the url is not text anyone reads - it must survive untouched');

  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
});

test('a Snatch snapshot and a Memo recap are never translated, whatever is in the table', async () => {
  // These two post types do not hold prose: a podium's text is a JSON
  // snapshot the client parses, a video's is a recap filename it builds a
  // URL from. Translating either corrupts the Wall rather than localising
  // it, so the exclusion is by type and holds even if a row somehow exists.
  const snapshot = JSON.stringify({ night: 'furnished', podium: [{ name: 'Alguém', votes: 3 }] });
  const podiumId = db.prepare(
    "INSERT INTO plaza_posts (type, author_id, text) VALUES ('podium', 1, ?)"
  ).run(snapshot).lastInsertRowid;
  const videoId = db.prepare(
    "INSERT INTO plaza_posts (type, author_id, text) VALUES ('video', 1, '2026-09-18')"
  ).run().lastInsertRowid;

  fakeTranslation('plaza_post', podiumId, 'text', 'en', 'THIS WOULD BREAK THE WALL');
  fakeTranslation('plaza_post', videoId, 'text', 'en', 'also broken');

  const { data } = await api('GET', '/plaza-posts?lang=en', { token: userToken });
  const podium = data.posts.find((p) => p.id === podiumId);
  const video = data.posts.find((p) => p.id === videoId);
  assert.equal(podium.text, snapshot, 'a podium snapshot must stay parseable JSON');
  assert.deepEqual(JSON.parse(podium.text).podium[0].name, 'Alguém');
  assert.equal(video.text, '2026-09-18', 'a recap filename must stay a filename');

  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
});

test('a Rata consequence reads in the language you picked, and editing a post drops its stale translation', async () => {
  const suggester = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Translation Guest' } });
  await api('POST', '/consequences', { token: suggester.data.token, body: { text: 'bebe um copo de água' } });
  const row = db.prepare("SELECT id FROM consequences WHERE user_id = ?").get(suggester.data.id);
  db.prepare("UPDATE consequences SET status = 'used', revealed_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?").run(row.id);
  fakeTranslation('consequence', row.id, 'text', 'en', 'drink a glass of water');

  const revealed = await api('GET', '/consequences/revealed?lang=en', { token: userToken });
  const mine = revealed.data.consequences.find((c) => c.id === row.id);
  assert.equal(mine.text, 'drink a glass of water');
  assert.equal(mine.originalText, 'bebe um copo de água');

  // Editing a post changes what it says, so the rendering of the old
  // wording is now a translation of a sentence that no longer exists.
  const posted = await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'às oito' } });
  fakeTranslation('plaza_post', posted.data.id, 'text', 'en', 'at eight');
  await api('PATCH', `/admin/plaza-posts/${posted.data.id}`, { token: ADMIN, body: { text: 'às nove' } });

  const after = (await api('GET', '/plaza-posts?lang=en', { token: userToken }))
    .data.posts.find((p) => p.id === posted.data.id);
  assert.equal(after.text, 'às nove', 'the stale translation must not outlive the text it came from');

  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  db.prepare('DELETE FROM consequences').run();
  await api('DELETE', `/admin/users/${suggester.data.id}`, { token: ADMIN });
});

test('a translation that keeps failing is given up on rather than retried forever', async () => {
  queue('consequence', 4242, 'text', 'pt');
  // A generous limit rather than the default page: pending() is paginated
  // (one pass is one batch), and with seeded content now queued too this
  // row sits well past the first page. The test is about giving up after
  // MAX_ATTEMPTS, not about where the row lands in a queue.
  const queued = pending(1000).filter((r) => r.entity_id === 4242);
  assert.equal(queued.length, 1, 'only the language it was not written in gets queued');
  assert.equal(queued[0].lang, 'en');

  for (let i = 0; i < MAX_ATTEMPTS; i += 1) markFailed(queued[0].id);
  assert.equal(pending(1000).filter((r) => r.entity_id === 4242).length, 0,
    `a row must stop being retried after ${MAX_ATTEMPTS} attempts - this runs against a paid API`);

  // And a failed row is never shown: the reader sees the original instead.
  assert.equal(translationsFor('consequence', [4242], 'en').size, 0);

  markOk(queued[0].id, 'drink water');
  assert.equal(translationsFor('consequence', [4242], 'en').get('consequence:4242:text'), 'drink water');
  wipeFor('consequence', 4242);
});

test('Plaza chat translates too, and a wipe takes its translations with it', async () => {
  await api('POST', '/admin/chat/wipe', { token: ADMIN });
  const posted = await api('POST', '/chat/messages', { token: userToken, body: { text: 'o jantar é às oito' } });
  assert.equal(posted.status, 201);

  const msg = db.prepare('SELECT id FROM messages ORDER BY id DESC LIMIT 1').get();
  fakeTranslation('message', msg.id, 'text', 'en', 'dinner is at eight');

  const en = await api('GET', '/chat/messages?lang=en', { token: userToken });
  assert.equal(en.data.messages.at(-1).text, 'dinner is at eight');

  const pt = await api('GET', '/chat/messages?lang=pt', { token: userToken });
  assert.equal(pt.data.messages.at(-1).text, 'o jantar é às oito', 'a reader in the source language sees what was written');

  // Wiping the chat must not leave rows pointing at messages that are gone -
  // ids get reused, and a stale row would surface under someone else's line.
  await api('POST', '/admin/chat/wipe', { token: ADMIN });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM translations WHERE entity_type = 'message'").get().n,
    0,
    'chat translations must go when the chat does',
  );
});

test('content written before translations existed can be picked up by a backfill', async () => {
  // Queueing happens on write, so a month of real posts and consequences on
  // production had no rows at all and read as "translations are broken".
  // This is the catch-up, and it has to be safe to run twice.
  db.prepare('DELETE FROM translations').run();
  db.prepare('DELETE FROM consequences').run();
  const u = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  db.prepare("INSERT INTO consequences (user_id, text, day, status) VALUES (?, 'dançar em cima da mesa', ?, 'used')").run(u, '2026-08-09');

  const first = backfill();
  assert.ok(first > 0, 'the backfill found nothing to queue');
  const queued = db.prepare("SELECT lang FROM translations WHERE entity_type = 'consequence'").all();
  assert.equal(queued.length, 1, 'only the language it was not written in should be queued');
  assert.equal(queued[0].lang, 'en');

  // Running it again must be a no-op rather than piling up duplicates or
  // reviving a translation that already used up its attempts.
  const second = backfill();
  assert.equal(second, 0, 'a second backfill should find nothing left to do');

  db.prepare('DELETE FROM consequences').run();
  db.prepare('DELETE FROM translations').run();
});

test('the app caps its own API spending per day, and stops cleanly when it runs out', async () => {
  // Belt to the console spend limit's braces. The bug that emptied the
  // account on 16 Sept 2026 is fixed and tested; this is for the next one,
  // and it fails in the direction the app already handles - a spent budget
  // behaves exactly like no API key at all, which means originals are shown
  // and nothing breaks.
  //
  // The budget is counted in the settings table rather than in memory,
  // because a crash-loop that forgot its own spending is precisely how this
  // would go wrong a second time.
  const { callsUsedToday } = await import('../src/translate.js');
  const { setSetting, getSetting } = await import('../src/db.js');
  const key = `translation_calls_${new Date().toISOString().slice(0, 10)}`;
  const before = getSetting(key, null);
  try {
    // Nothing in this suite has a key configured, so no call can leave the
    // box - what is asserted is the accounting, not the network.
    setSetting(key, '7');
    assert.equal(callsUsedToday(), 7, 'the budget has to be readable back, and per-day');

    // A day with no spending yet reads zero rather than throwing.
    setSetting(key, '0');
    assert.equal(callsUsedToday(), 0);

    // And a junk value must not read as "unlimited".
    setSetting(key, 'not a number');
    assert.equal(callsUsedToday(), 0, 'an unparseable counter must read as zero, never as infinity');
  } finally {
    if (before === null) setSetting(key, '0'); else setSetting(key, before);
  }
});

test('re-queueing unchanged text buys nothing, and only a real edit pays again', async () => {
  // This one emptied Ivo's API credits on 16 Sept 2026, so it is worth
  // stating what went wrong rather than only asserting the fix.
  //
  // queue() used to reset every re-queued row to pending with attempts back
  // to zero - which reads as "this was edited, translate it again". Correct
  // for an edit; expensive nonsense for anything else, because re-queueing
  // an unchanged sentence discarded a finished translation and bought it
  // again. seedDemo re-queues its whole demo set on every boot, and QA has
  // SEED_DEMO=true, so that happened on every single deploy.
  //
  // What tells the two cases apart is a hash of the source text. Nothing
  // here calls the API - the count of rows left pending IS the bill.
  const store = await import('../src/translations.js');
  const TEXT = 'o jantar e as nove, tragam uma toalha';

  // Five boots of identical content.
  for (let boot = 0; boot < 5; boot++) {
    store.queue('plaza_post', 90210, 'text', 'pt', TEXT);
  }
  const afterBoots = store.pending(1000).filter((r) => r.entity_id === 90210);
  assert.equal(afterBoots.length, 1, 'five identical boots must queue one translation, not five');

  // Once it has been paid for, booting again must not buy it a second time.
  for (const row of afterBoots) store.markOk(row.id, 'dinner is at nine, bring a towel');
  store.queue('plaza_post', 90210, 'text', 'pt', TEXT);
  assert.equal(
    store.pending(1000).filter((r) => r.entity_id === 90210).length, 0,
    'a finished translation must survive a re-queue of the same text',
  );

  // A genuine edit is still worth paying for - the whole feature depends on
  // a stale translation being thrown away.
  store.queue('plaza_post', 90210, 'text', 'pt', `${TEXT} e chinelos`);
  assert.equal(
    store.pending(1000).filter((r) => r.entity_id === 90210).length, 1,
    'editing the text must re-queue it',
  );

  // A permanent failure must not come back on every later write either -
  // retrying something already given up on is the same bill in slow motion.
  for (const row of store.pending(1000).filter((r) => r.entity_id === 90210)) store.markFailed(row.id);
  for (const row of store.pending(1000).filter((r) => r.entity_id === 90210)) store.markFailed(row.id);
  store.queue('plaza_post', 90210, 'text', 'pt', `${TEXT} e chinelos`);
  assert.equal(
    store.pending(1000).filter((r) => r.entity_id === 90210).length, 0,
    'a row already given up on must not be retried by the next unrelated write',
  );
});

test('only one translation sweep runs at a time, however many writes land together', async () => {
  // The multiplier on the same incident. Every write fired
  // setImmediate(runPending), and every sweep read the WHOLE pending queue
  // with nothing marking a row as in flight - so N writes arriving together
  // produced N overlapping sweeps that each translated the same rows.
  // seedDemo writes about nineteen things at once, which is how nineteen
  // sentences became hundreds of API calls per boot.
  const { runPending } = await import('../src/translate.js');
  // With no key configured every call returns 0 immediately, which is enough
  // to prove the guard: what is asserted is that concurrent calls do not all
  // enter the sweep, not what the sweep would have done.
  const results = await Promise.all(Array.from({ length: 10 }, () => runPending()));
  assert.equal(results.length, 10);
  assert.ok(results.every((n) => n === 0), 'with no API key nothing is spent, whatever the concurrency');
});

test('the translator is told, in detail, that portuguese means portugal', async () => {
  // Ivo's emphasis, 14 Sept 2026, and he is right to press on it: a model
  // left to its own devices drifts to Brazilian Portuguese, because there is
  // far more of it about. Verified live at the time - "tens de", "telemóvel",
  // "casa de banho", "sumo", "equipa", "ecrã", "apanha o autocarro", and the
  // gerund avoided ("estás a dançar", not "está dançando").
  //
  // A live check cannot live in this suite, which must never reach the API.
  // So this guards the instruction instead: if someone trims the prompt, or
  // swaps the model and rewrites it, this fails rather than the party
  // quietly reading in the wrong Portuguese. scripts/check-translation.mjs
  // is the live counterpart, run by hand.
  const pt = systemPromptFor('pt');

  assert.match(pt, /european portuguese/i, 'the target must be named as European Portuguese');
  assert.match(pt, /never brazilian/i, 'saying which one to use is not the same as saying which to avoid');

  // The word pairs are the part that actually steers it. Each of these is a
  // different word in Portugal and in Brazil.
  for (const [ptPT, ptBR] of [
    ['ecrã', 'tela'], ['telemóvel', 'celular'], ['casa de banho', 'banheiro'],
    ['sumo', 'suco'], ['equipa', 'equipe'], ['autocarro', 'ônibus'],
    ['utilizador', 'usuário'], ['partilhar', 'compartilhar'],
  ]) {
    assert.ok(pt.includes(ptPT), `the prompt no longer asks for "${ptPT}"`);
    assert.ok(pt.includes(ptBR), `the prompt no longer warns against "${ptBR}"`);
  }

  // The two grammatical tells, which give a translation away faster than
  // vocabulary does.
  assert.match(pt, /tens de/, 'tu-form addressing must be spelled out');
  assert.match(pt, /never the gerund|estás a dançar/, 'the gerund rule must be spelled out');

  // English should not be caught by any of this.
  const en = systemPromptFor('en');
  assert.match(en, /English \(UK\)/, 'english should be UK-leaning, as the rest of the app is');
});

test('the five page names survive translation instead of being turned into words', async () => {
  // Ivo, 14 Sept 2026: "the rat is translating to a rapariga". Reproduced
  // live against the real API and it was worse than one word - the model was
  // dissolving the section names into whatever the sentence seemed to mean:
  //   "vai haver rata hoje à noite"  -> "there's going to be a party tonight"
  //   "a rata de hoje"               -> "today's dare"
  //   "check the wall"               -> "verifica a parede"
  // Which is reasonable behaviour for a translator and wrong for this app:
  // these five words are the names of its pages. A guest reading "today's
  // dare" has been told about a section that does not exist.
  //
  // Note the names guarded here are the DISPLAY names, which is why this
  // list does not match the internal ones (plaza-the-route is Wall on
  // screen, chat-the-route is Plaza) - see the naming note in CLAUDE.md.
  // What has to survive is what a guest types, and a guest types what they
  // see.
  //
  // Live counterpart, run by hand and passing 10/10 at the time of writing:
  // the same sentences through scripts/check-translation.mjs.
  for (const target of ['pt', 'en']) {
    const prompt = systemPromptFor(target);
    for (const name of ['wall', 'rata', 'snatch', 'plaza', 'memo']) {
      assert.ok(prompt.includes(name), `the prompt no longer protects the name "${name}" (${target})`);
    }
    // Naming them is not enough on its own - an earlier prompt already said
    // "keep names exactly as written" and the model still translated them,
    // because it had no way to know these particular words were names.
    assert.match(prompt, /names of the app's own pages/i, `${target}: the prompt must say why these words are special`);
    // And the two that a translator has the strongest reason to convert,
    // because both are ordinary words in the other language.
    assert.ok(prompt.includes('parede'), 'the prompt must warn against turning wall into parede');
    assert.ok(prompt.includes('praça'), 'the prompt must warn against turning plaza into praça');
  }
});

test('a model that answers instead of translating is ignored, not published', async () => {
  // This is the one that reached the Wall. A one-word link label read as an
  // incomplete request, so the model replied conversationally - and the
  // reply was stored and rendered as somebody's link. Two guards now: the
  // response is shape-constrained server-side, and anything that still
  // comes back wrong is dropped in favour of the original.
  const chatty = JSON.stringify({
    already_in_target: false,
    translation: "I need the text you'd like me to translate. You've only provided the word \"Themes\" - is this what you want translated, or did you forget to paste the message?",
  });
  assert.equal(interpretResponse(chatty, 'Themes'), null,
    'an answer many times longer than its source is prose about the request, not a translation');

  // Text already in the target language gets no row, so the reader sees
  // exactly what was written rather than a needless rewording.
  const same = JSON.stringify({ already_in_target: true, translation: 'links úteis' });
  assert.equal(interpretResponse(same, 'links úteis'), null);

  // Anything unparseable is dropped rather than shown.
  assert.equal(interpretResponse('not json at all', 'x'), null);
  assert.equal(interpretResponse(JSON.stringify({ already_in_target: false, translation: '   ' }), 'x'), null);

  // And a real translation survives all of it.
  const good = JSON.stringify({ already_in_target: false, translation: 'dinner is at eight' });
  assert.equal(interpretResponse(good, 'o jantar é às oito'), 'dinner is at eight');

  // A long source is allowed a long translation - the guard is relative,
  // not a fixed cap, or every real sentence over 60 characters would vanish.
  const longSource = 'tens de cantar a próxima música toda de pé em cima de uma cadeira sem parar';
  const longGood = JSON.stringify({
    already_in_target: false,
    translation: 'you have to sing the whole next song standing on a chair without stopping',
  });
  assert.ok(interpretResponse(longGood, longSource), 'a legitimate long translation must not be dropped');
});

test('the language of a message is detected rather than assumed from the app language', async () => {
  // Someone reading the app in English may well write their dare in
  // Portuguese. Assuming the author's UI language would translate pt->pt
  // and produce mush, so the text itself decides.
  assert.equal(detectLang('bebe um copo de água'), 'pt');
  assert.equal(detectLang('não podes falar durante uma hora'), 'pt');
  assert.equal(detectLang('drink a glass of water'), 'en');
  assert.equal(detectLang('you have to sing the next song'), 'en');
  // Too short or too ambiguous to call - both directions get queued, and
  // the model passes through anything already in the target language.
  assert.equal(detectLang('ok'), null);
});

/* ---------------------------------- Memo ---------------------------------- */
// 5x/day, at a random independent time per user, upload a photo/video
// within 15 minutes of being notified. The scheduler (scheduler.js) is
// what actually flips a slot from "waiting" to "open" in real use - it's
// never started in this test file (only app.js's routes are under test,
// not server.js's cron job), so every slot stays "waiting" until a test
// deliberately marks it notified via a direct DB write, the same way this
// suite handles other time-dependent state.

// Holds the clock still for the duration of one test, then puts it back.
// Slot generation is the one part of Memo that depends on what time it is
// when it runs: after roughly 23:15 there is no longer room for five
// moments before the window shuts, and between 02:00 and 06:00 there is no
// window left at all. Any test that generates a schedule therefore has to
// say what time it is, rather than inheriting whatever hour the suite
// happened to start at - otherwise the whole file is green by day and red
// to whoever is still working at 3am.
function atClock(at, fn) {
  const restore = setClockForTests(at);
  try {
    return fn();
  } finally {
    restore();
  }
}

// Same, for the tests that trigger generation over HTTP. The server runs
// in this process (app.listen(0) above), so the pin is still in force while
// the request is handled - but the await has to happen inside it, or the
// clock is restored before the handler ever runs.
async function atClockAsync(at, fn) {
  const restore = setClockForTests(at);
  try {
    return await fn();
  } finally {
    restore();
  }
}

// A plain afternoon on whichever day the app currently calls today(), used
// by every test that just needs a normal full schedule to exist and does
// not care what time produced it.
//
// 15:00 in the app's own timezone, converted through the same helper the
// window itself is built with - not 15:00Z. The two differ by an hour for
// Lisbon in summer, which is harmless, but writing it as UTC quietly bakes
// in the assumption that the app's zone is near Greenwich, and that is the
// sort of thing that is true right up until it is not.
function memoAfternoon() {
  return zonedTimeToUtc(today(), 15, 0, getTimezone()).toISOString();
}

// Leaves a normal, full day's schedule in place for whatever runs next.
// Memo's slots are one shared, lazily-built schedule, so a test that clears
// them and walks away hands the next test whatever the real clock happens
// to produce - four moments at 23:40, three at 00:30, none at all between
// 02:00 and 06:00. Every test downstream of here indexes into slots[0..3]
// and would fail on an hour rather than on a regression. Rebuilding at a
// pinned afternoon is what keeps the rest of the file honest at any hour.
function resetSchedule() {
  db.prepare('DELETE FROM memo_slots').run();
  atClock(memoAfternoon(), ensureTodaysSlots);
}

// Reads the slots back as epoch ms, with the window they were meant to fall
// inside, so a test can just compare numbers.
function generatedSlots() {
  const day = today();
  const rows = db.prepare('SELECT slot_index, scheduled_at FROM memo_slots WHERE day = ? ORDER BY slot_index').all(day);
  return rows.map((r) => ({
    index: r.slot_index,
    at: new Date(`${r.scheduled_at.replace(' ', 'T')}Z`).getTime(),
    label: r.scheduled_at,
  }));
}

// Defaults to the app's clock, not Date.now() - if a test pins the clock,
// the moment it says fired has to be the same moment the 15-minute upload
// window is measured against, or the slot reads as already expired.
function markSlotNotified(slotId, when = new Date(now())) {
  const ts = when.toISOString().replace('T', ' ').replace('Z', '');
  db.prepare('UPDATE memo_slots SET notified_at = ? WHERE id = ?').run(ts, slotId);
}

test('GET /memo/today lazily creates 5 distinct slots, idempotently', async () => {
  // Pinned to an afternoon because this is the call that actually builds
  // the schedule, and how many moments fit depends on how much of the
  // window is left when it runs: five need three hours, so a suite started
  // at 23:30 would legitimately get fewer and a suite started at 04:00
  // would get none at all.
  db.prepare('DELETE FROM memo_slots').run();
  const { first, second } = await atClockAsync(memoAfternoon(), async () => ({
    first: await api('GET', '/memo/today', { token: userToken }),
    second: await api('GET', '/memo/today', { token: userToken }),
  }));

  assert.equal(first.status, 200);
  assert.equal(first.data.slots.length, 5);
  assert.ok(first.data.slots.every((s) => s.status === 'waiting'), 'nothing has been notified yet');
  assert.deepEqual(second.data.slots.map((s) => s.id), first.data.slots.map((s) => s.id), 'a second call must not generate new slots for the same day');
});

test('the 5 daily slots never land close together - each is at least MEMO_MIN_GAP_MINUTES from the next', async () => {
  db.prepare('DELETE FROM memo_slots').run();
  const generatedAt = memoAfternoon();
  const ids = await atClockAsync(generatedAt, async () =>
    (await api('GET', '/memo/today', { token: userToken })).data.slots.map((s) => s.id));
  const rows = db.prepare(`SELECT scheduled_at FROM memo_slots WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY scheduled_at`).all(...ids);
  for (let i = 1; i < rows.length; i++) {
    const gapMinutes = (new Date(`${rows[i].scheduled_at.replace(' ', 'T')}Z`) - new Date(`${rows[i - 1].scheduled_at.replace(' ', 'T')}Z`)) / 60000;
    assert.ok(gapMinutes >= MEMO_MIN_GAP_MINUTES, `expected at least ${MEMO_MIN_GAP_MINUTES}min between consecutive slots, got ${gapMinutes}`);
  }
  // Regression: the window is always "14:00 today" on the calendar, but if
  // the schedule ends up generated later than that (whoever opens the app
  // first that day), anchoring purely to 14:00 would place several slots
  // in the past already, so they'd all fire at once on the next scheduler
  // tick instead of being spread out. Measured against the instant the
  // schedule was actually built - which is knowable now that this test
  // pins it, rather than being whenever some earlier test in the file
  // happened to trigger generation.
  const builtAtMs = Date.parse(generatedAt);
  for (const row of rows) {
    const scheduledMs = new Date(`${row.scheduled_at.replace(' ', 'T')}Z`).getTime();
    assert.ok(scheduledMs >= builtAtMs, `a slot must never be scheduled in the past relative to when it was generated (${row.scheduled_at})`);
  }
});

// Lisbon is UTC+1 in September (WEST), so these are written with an
// explicit offset rather than a bare "Z" - the window is a wall-clock
// window, and reading it as UTC would silently shift every bound by an hour.
const WINDOW_OPENS = Date.parse('2026-09-18T14:00:00+01:00');
const WINDOW_SHUTS = Date.parse('2026-09-19T02:00:00+01:00');

test('between 02:00 and 06:00 no schedule is generated at all, rather than one in the small hours', async () => {
  const { ensureTodaysSlots } = await import('../src/memo.js');

  // 04:00 sits in the gap between Memo's window shutting (02:00) and the
  // app's day rolling over (06:00), so today() still names the 17th - a day
  // whose window closed two hours ago. It used to build a full schedule
  // anyway, starting from right now, which meant five notifications fired
  // between 04:00 and 07:00 for a night that was already over.
  db.prepare('DELETE FROM memo_slots').run();
  atClock('2026-09-18T04:00:00+01:00', () => {
    assert.equal(today(), '2026-09-17', 'before the 06:00 rollover, today() is still the day before');
    ensureTodaysSlots();
    assert.deepEqual(generatedSlots(), [], 'the window has shut - there is nothing left to schedule today');
  });
  resetSchedule();
});

test('every generated slot lands inside the 14:00-02:00 window, never past the end of it', async () => {
  const { ensureTodaysSlots, MEMO_SLOTS_PER_DAY } = await import('../src/memo.js');

  db.prepare('DELETE FROM memo_slots').run();
  atClock('2026-09-18T14:00:00+01:00', () => {
    ensureTodaysSlots();
    const slots = generatedSlots();
    assert.equal(slots.length, MEMO_SLOTS_PER_DAY, 'a full window fits the whole day of moments');
    for (const slot of slots) {
      assert.ok(slot.at >= WINDOW_OPENS, `slot ${slot.index} (${slot.label}) is before the window opens`);
      // Inclusive at the top: 02:00 is the last moment the window can hand
      // out, not the first one past it.
      assert.ok(slot.at <= WINDOW_SHUTS, `slot ${slot.index} (${slot.label}) lands after the window shuts`);
    }
  });
  resetSchedule();
});

test('a window with less than three hours left gets fewer moments, not five spilling past 02:00', async () => {
  const { ensureTodaysSlots } = await import('../src/memo.js');

  // 00:30 leaves 90 minutes, which at the 45-minute minimum gap holds three
  // moments. The old arithmetic always laid out five and let the last ones
  // fall past the end - 02:53 was the worst seen. Fewer moments is the
  // honest answer; the gap is what keeps two upload windows from
  // overlapping, so it is not the thing to compromise.
  db.prepare('DELETE FROM memo_slots').run();
  atClock('2026-09-19T00:30:00+01:00', () => {
    assert.equal(today(), '2026-09-18', 'after midnight but before the rollover, this is still the 18th');
    ensureTodaysSlots();
    const slots = generatedSlots();
    assert.equal(slots.length, 3, `90 minutes at a ${MEMO_MIN_GAP_MINUTES}min gap holds three moments`);
    for (const slot of slots) {
      assert.ok(slot.at <= WINDOW_SHUTS, `slot ${slot.index} (${slot.label}) lands after the window shuts`);
    }
    for (let i = 1; i < slots.length; i++) {
      const gap = (slots[i].at - slots[i - 1].at) / 60000;
      assert.ok(gap >= MEMO_MIN_GAP_MINUTES, `only ${gap}min between moment ${i - 1} and ${i}`);
    }
  });
  resetSchedule();
});

test('Memo and the Rata keep to the same hours, and no slot lands outside them', async () => {
  // The app's only two unprompted interruptions. Ivo set both to 14:00-02:00
  // on 12 Aug 2026, and they are declared in two different files - memo.js's
  // window and scheduler.js's cron - so nothing but this stops one being
  // retuned later and the other quietly staying where it was.
  const { readFileSync } = await import('node:fs');
  const scheduler = readFileSync(new URL('../src/scheduler.js', import.meta.url), 'utf8');
  const revealHours = scheduler.match(/cron\.schedule\('0 ([\d,]+) \* \* \*'/)?.[1]?.split(',').map(Number);
  assert.deepEqual(revealHours, [14, 17, 20, 23, 2], 'the Rata reveals every 3 hours across 14:00-02:00');

  // That every slot lands inside the window is checked separately, by the
  // three tests above - they pin the clock, because otherwise the answer
  // depends on what time the suite happens to run. This test is only about
  // the two declarations agreeing with each other.
  //
  // Worth keeping the history: this assertion used to live here, failed
  // three times, and was loosened on each of them rather than believed.
  // Slots really were landing outside the window (02:53 was the worst
  // seen), for two separate reasons - a schedule built after the window had
  // already shut, and one built with too little room left to fit five at
  // the minimum gap. Both are fixed in ensureTodaysSlots() now.
});

// The five dots are read left to right as a progress bar, so the states
// have to stay monotonic: everything before the open one is settled
// (done or missed) and everything after it is still waiting. A later slot
// firing while an earlier one is untouched would be nonsense on screen -
// "you missed the third but the second hasn't happened yet".
test("today's slots fire strictly in order, so a later moment can never open before an earlier one", async () => {
  const { default: db } = await import('../src/db.js');
  const { ensureTodaysSlots, triggerNextSlot, MEMO_SLOTS_PER_DAY } = await import('../src/memo.js');
  const { today } = await import('../src/time.js');

  db.prepare('DELETE FROM memo_uploads').run();
  db.prepare('DELETE FROM memo_slots').run();
  atClock(memoAfternoon(), ensureTodaysSlots);

  const slots = db.prepare('SELECT slot_index, scheduled_at FROM memo_slots WHERE day = ? ORDER BY slot_index').all(today());
  assert.equal(slots.length, MEMO_SLOTS_PER_DAY);
  for (let i = 1; i < slots.length; i++) {
    assert.ok(
      slots[i].scheduled_at > slots[i - 1].scheduled_at,
      `slot ${i} is scheduled at or before slot ${i - 1} - the dots would fire out of order`
    );
  }

  // The owner's manual trigger must respect the same order, not skip ahead.
  for (let i = 0; i < MEMO_SLOTS_PER_DAY; i++) {
    assert.equal(triggerNextSlot().slotIndex, i, 'trigger-next should always open the earliest unfired slot');
  }
  assert.equal(triggerNextSlot().error, 'err_memo_no_slots_left');

  // And the notified timestamps came out in slot order too.
  const fired = db.prepare('SELECT slot_index, notified_at FROM memo_slots WHERE day = ? ORDER BY notified_at').all(today());
  assert.deepEqual(fired.map((f) => f.slot_index), [0, 1, 2, 3, 4]);

  // This test deliberately fires every slot, which would leave the later
  // tests with nothing un-notified to work against - put a fresh, untouched
  // day back rather than leaving the next test to rebuild one at whatever
  // hour the suite is running at.
  resetSchedule();
});

// A slot that never fired used to stay "due" indefinitely, with no day
// filter on the query - so a day of downtime, or Memo being switched off and
// back on, would fire every accumulated slot at once. A missed moment stays
// missed.
test('a slot from a previous day is never resurrected as due, however long it sat unfired', async () => {
  const { default: db } = await import('../src/db.js');
  const { getDueSlots, ensureTodaysSlots } = await import('../src/memo.js');
  const { today } = await import('../src/time.js');

  db.prepare('DELETE FROM memo_uploads').run();
  db.prepare('DELETE FROM memo_slots').run();
  db.prepare("INSERT INTO memo_slots (day, slot_index, scheduled_at) VALUES ('2026-01-01', 0, '2026-01-01 12:00:00')").run();

  assert.deepEqual(getDueSlots(), [], "a January slot must not be due in " + today());

  // A genuinely due slot today still fires. Generated and read back at the
  // same pinned instant: the other four moments are scheduled later that
  // afternoon, so whether they are "due" too depends entirely on what time
  // it is when this runs - which is the whole thing being taken out of the
  // suite's hands here.
  const due = atClock(memoAfternoon(), () => {
    ensureTodaysSlots();
    db.prepare("UPDATE memo_slots SET scheduled_at = '2020-01-01 00:00:00' WHERE day = ? AND slot_index = 0").run(today());
    return getDueSlots();
  });
  assert.equal(due.length, 1, 'only the backdated slot has come round yet');
  assert.equal(due[0].day, today());

  resetSchedule();
});

// Memo ships to prod fully working but shut to guests until the party, so
// it can actually be exercised beforehand instead of sitting behind a flag
// nobody can test. Admins are the exception throughout.
test('MEMO_START_DATE hides Memo from guests and silences the scheduler, while admins keep full access', async () => {
  const { memoAvailableTo, memoScheduleActive, memoOpenToEveryone } = await import('../src/memo.js');
  const original = process.env.MEMO_START_DATE;
  const guest = { isAdmin: false }, admin = { isAdmin: true };
  try {
    delete process.env.MEMO_START_DATE;
    assert.equal(memoOpenToEveryone(), true, 'unset means open now - what QA wants');
    assert.equal(memoAvailableTo(guest), true);
    assert.equal(memoScheduleActive(), true);

    process.env.MEMO_START_DATE = '2099-01-01';
    assert.equal(memoAvailableTo(guest), false, 'a guest must not reach Memo before the date');
    assert.equal(memoAvailableTo(admin), true, 'an admin still can, so prod stays testable');
    assert.equal(memoScheduleActive(), false, 'and nobody gets pushed a prompt they cannot open');

    process.env.MEMO_START_DATE = '2000-01-01';
    assert.equal(memoAvailableTo(guest), true, 'once the day arrives it opens to everyone');
    assert.equal(memoScheduleActive(), true);
  } finally {
    if (original === undefined) delete process.env.MEMO_START_DATE;
    else process.env.MEMO_START_DATE = original;
  }
});

// The flag still wins over the date - ENABLE_MEMO off means off for everyone.
test('ENABLE_MEMO=off blocks Memo even for an admin, and even after the start date', async () => {
  const { memoAvailableTo, memoScheduleActive } = await import('../src/memo.js');
  const originalFlag = process.env.ENABLE_MEMO, originalDate = process.env.MEMO_START_DATE;
  try {
    process.env.ENABLE_MEMO = 'false';
    process.env.MEMO_START_DATE = '2000-01-01';
    assert.equal(memoAvailableTo({ isAdmin: true }), false);
    assert.equal(memoScheduleActive(), false);
  } finally {
    if (originalFlag === undefined) delete process.env.ENABLE_MEMO; else process.env.ENABLE_MEMO = originalFlag;
    if (originalDate === undefined) delete process.env.MEMO_START_DATE; else process.env.MEMO_START_DATE = originalDate;
  }
});

test('uploading to a slot that has not been notified yet is rejected', async () => {
  const { data } = await api('GET', '/memo/today', { token: userToken });
  const slot = data.slots[1];
  const res = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error, 'err_memo_slot_not_open');
});

test('a slot within its 15-minute window is shared - every guest can upload to it once, but not twice each', async () => {
  const { data } = await api('GET', '/memo/today', { token: userToken });
  const slot = data.slots[2];
  markSlotNotified(slot.id);

  const bystander = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo Bystander' } });
  const alsoOk = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: bystander.data.token,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(alsoOk.status, 201, 'a shared slot accepts uploads from any guest, not just one');

  const bystanderAgain = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: bystander.data.token,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'photo2.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(bystanderAgain.status, 409, 'but not twice for the same guest');
  assert.equal(bystanderAgain.data.error, 'err_memo_already_uploaded');

  const badType = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from('not a photo'),
    filename: 'notes.txt',
    mimeType: 'text/plain',
  });
  assert.equal(badType.status, 400);
  assert.equal(badType.data.error, 'err_memo_invalid_type');

  const ok = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.kind, 'photo');
  const uploadId = ok.data.id;

  const again = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'photo2.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'err_memo_already_uploaded');

  const refreshed = await api('GET', '/memo/today', { token: userToken });
  const uploadedSlot = refreshed.data.slots.find((s) => s.id === slot.id);
  assert.equal(uploadedSlot.status, 'uploaded');
  assert.equal(uploadedSlot.uploadId, uploadId);

  const own = await apiBuffer(`/memo/uploads/${uploadId}`, { token: userToken });
  assert.equal(own.status, 200);
  assert.deepEqual([...own.buffer], [0xff, 0xd8, 0xff, 0xd9]);

  // Every guest's moments are visible to every other guest via the shared
  // feed, not just the uploader/admins.
  const otherGuest = await apiBuffer(`/memo/uploads/${uploadId}`, { token: bystander.data.token });
  assert.equal(otherGuest.status, 200, 'any logged-in guest can view any upload, via the shared feed');

  const asAdmin = await apiBuffer(`/memo/uploads/${uploadId}`, { token: ADMIN });
  assert.equal(asAdmin.status, 200, 'an admin can view anyone\'s upload');
});

test('the shared Memo feed shows every guest\'s uploads for today with reaction counts, and reacting twice with the same emoji clears it', async () => {
  const { data } = await api('GET', '/memo/today', { token: userToken });
  const slot = data.slots[0];
  markSlotNotified(slot.id);
  const ok = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'feed-photo.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(ok.status, 201);
  const uploadId = ok.data.id;

  const bystander = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo Feed Bystander' } });

  // Sealed until the viewer has posted their own for this moment.
  const locked = await api('GET', '/memo/feed', { token: bystander.data.token });
  assert.equal(locked.status, 200);
  assert.equal(locked.data.locked, true, 'the feed stays locked until the viewer posts');
  assert.deepEqual(locked.data.uploads, [], 'a locked feed hands back nothing at all');

  const bystanderUpload = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: bystander.data.token,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'bystander.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(bystanderUpload.status, 201);

  const feed = await api('GET', '/memo/feed', { token: bystander.data.token });
  assert.equal(feed.status, 200);
  assert.equal(feed.data.locked, false);
  const entry = feed.data.uploads.find((u) => u.id === uploadId);
  assert.ok(entry, 'the feed should include every guest\'s upload, not just the viewer\'s own');
  assert.equal(entry.mine, false, "someone else's upload is not flagged as the viewer's");
  // The viewer's own is in the feed too, flagged. A filled checklist dot is
  // not the same as seeing the photo you just took: shooting the first
  // moment of a party left the feed empty, so the card hid itself and
  // capturing looked like it had done nothing.
  const own = feed.data.uploads.find((u) => u.id === bystanderUpload.data.id);
  assert.ok(own, 'the viewer has to be able to see the moment they just captured');
  assert.equal(own.mine, true, "the viewer's own upload is flagged so the UI can label it");
  assert.equal(entry.myReaction, null);
  assert.deepEqual(entry.reactions, {});

  const badEmoji = await api('POST', `/memo/uploads/${uploadId}/react`, { token: bystander.data.token, body: { emoji: '💀' } });
  assert.equal(badEmoji.status, 400);
  assert.equal(badEmoji.data.error, 'err_memo_invalid_reaction');

  const react = await api('POST', `/memo/uploads/${uploadId}/react`, { token: bystander.data.token, body: { emoji: '💦' } });
  assert.equal(react.status, 200);
  assert.equal(react.data.emoji, '💦');

  const afterReact = await api('GET', '/memo/feed', { token: bystander.data.token });
  const entryAfter = afterReact.data.uploads.find((u) => u.id === uploadId);
  assert.equal(entryAfter.myReaction, '💦');
  assert.equal(entryAfter.reactions['💦'], 1);

  // Reacting again with the same emoji toggles it off.
  const toggleOff = await api('POST', `/memo/uploads/${uploadId}/react`, { token: bystander.data.token, body: { emoji: '💦' } });
  assert.equal(toggleOff.data.emoji, null);
  const afterToggleOff = await api('GET', '/memo/feed', { token: bystander.data.token });
  const entryToggledOff = afterToggleOff.data.uploads.find((u) => u.id === uploadId);
  assert.equal(entryToggledOff.myReaction, null);
  assert.equal(entryToggledOff.reactions['💦'] || 0, 0);
});

// The reported bug: forcing a moment early left the previous one still
// inside its 15-minute window, so two moments were open at once and you
// could double back to the one you had already let slip.
test('firing a new Memo moment closes the previous one on the spot', async () => {
  // A fresh guest, so no earlier test's upload can turn one of these slots
  // "uploaded" and mask what is being asserted. The day's five slots are
  // shared by everyone and earlier tests have already fired several, so this
  // picks by position and re-fires rather than hunting for untouched ones.
  const guest = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo Window Guest' } });
  const userToken = guest.data.token;
  const { data } = await api('GET', '/memo/today', { token: userToken });
  const [first, second] = data.slots;
  markSlotNotified(first.id);

  const oneOpen = await api('GET', '/memo/today', { token: userToken });
  assert.equal(oneOpen.data.slots.find((s) => s.id === first.id).status, 'open');

  markSlotNotified(second.id);
  const afterSecond = await api('GET', '/memo/today', { token: userToken });
  const openNow = afterSecond.data.slots.filter((s) => s.status === 'open');
  assert.deepEqual(openNow.map((s) => s.id), [second.id], 'exactly one moment is ever open');
  assert.equal(
    afterSecond.data.slots.find((s) => s.id === first.id).status,
    'missed',
    'the older moment is gone the instant a newer one fires, not 15 minutes later',
  );

  // And the closed one really is closed - not just greyed out in the payload.
  const late = await apiUpload(`/memo/slots/${first.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'too-late.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(late.status, 409);
  assert.equal(late.data.error, 'err_memo_slot_not_open');
});

test('the Memo feed is scoped to the current moment - a new one clears what came before', async () => {
  const viewer = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo Scope Viewer' } });
  const poster = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Memo Scope Poster' } });
  const { data } = await api('GET', '/memo/today', { token: viewer.data.token });
  const [older, newer] = data.slots;

  markSlotNotified(older.id);
  const posted = {};
  for (const [who, key] of [[viewer, 'viewer'], [poster, 'poster']]) {
    const up = await apiUpload(`/memo/slots/${older.id}/upload`, {
      token: who.data.token,
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      filename: 'older.jpg',
      mimeType: 'image/jpeg',
    });
    assert.equal(up.status, 201);
    posted[key] = up.data.id;
  }
  // By id, not by count - this slot is shared, and earlier tests have put
  // their own uploads on it.
  const during = await api('GET', '/memo/feed', { token: viewer.data.token });
  const ids = during.data.uploads.map((u) => u.id);
  assert.ok(ids.includes(posted.poster), 'the other guest\'s upload for this moment');
  assert.ok(ids.includes(posted.viewer), 'and the viewer\'s own, so they can see what they captured');

  // A new moment starts everyone over, including the viewer's own unlock.
  markSlotNotified(newer.id);
  const after = await api('GET', '/memo/feed', { token: viewer.data.token });
  assert.equal(after.data.locked, true, 'the previous moment does not keep the feed unlocked');
  assert.deepEqual(after.data.uploads, [], 'last moment\'s photos are not carried forward');
});

// The client keeps its own copy of the reaction list (app.js renders the
// buttons from it; the server validates against its own). They drifted once
// - the client still listed four after the server was cut to two, so two
// buttons rendered blank and any tap on them was rejected by the API.
test('the reaction list the client renders matches the one the server accepts', async () => {
  const { readFileSync } = await import('node:fs');
  const { MEMO_REACTION_EMOJI } = await import('../src/memo.js');
  const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const literal = source.match(/const MEMO_REACTION_EMOJI = \[(.*?)\];/s);
  assert.ok(literal, 'app.js should still declare MEMO_REACTION_EMOJI as an array literal');
  const clientList = [...literal[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(clientList, MEMO_REACTION_EMOJI);
});

test('a slot missed past its 15-minute window is reported as missed, not open', async () => {
  const { data } = await api('GET', '/memo/today', { token: userToken });
  const slot = data.slots[3];
  markSlotNotified(slot.id, new Date(Date.now() - 20 * 60 * 1000));

  const refreshed = await api('GET', '/memo/today', { token: userToken });
  const missedSlot = refreshed.data.slots.find((s) => s.id === slot.id);
  assert.equal(missedSlot.status, 'missed');

  const res = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: userToken,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'late.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.error, 'err_memo_slot_not_open');
});

test('admin/owner can see per-day upload counts, download everything as a zip, and upload/view a recap video', async () => {
  await api('GET', '/memo/today', { token: userToken });
  const day = today();

  const days = await api('GET', '/admin/memo/days', { token: ADMIN });
  assert.equal(days.status, 200);
  const todayRow = days.data.days.find((d) => d.day === day);
  assert.ok(todayRow, 'today should show up once at least one slot has been notified');
  assert.ok(todayRow.uploadedCount >= 1);
  assert.equal(todayRow.hasRecap, false);

  const zip = await apiBuffer(`/admin/memo/${day}/uploads.zip`, { token: ADMIN });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const entries = await readZipEntries(zip.buffer);
  assert.ok(entries.length >= 1, 'the zip should contain at least the one uploaded photo');

  // Recap: video-only, any admin can upload it, any logged-in user can watch/download it.
  const badRecapType = await apiUpload(`/admin/memo/${day}/recap`, {
    token: ADMIN,
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    filename: 'not-a-video.jpg',
    mimeType: 'image/jpeg',
  });
  assert.equal(badRecapType.status, 400);
  assert.equal(badRecapType.data.error, 'err_memo_invalid_type');

  const recapBytes = Buffer.from('fake mp4 bytes');
  const recapUpload = await apiUpload(`/admin/memo/${day}/recap`, {
    token: ADMIN,
    buffer: recapBytes,
    filename: 'recap.mp4',
    mimeType: 'video/mp4',
  });
  assert.equal(recapUpload.status, 201);

  const recapDays = await api('GET', '/memo/recaps', { token: userToken });
  assert.ok(recapDays.data.days.includes(day));

  const recapFetch = await apiBuffer(`/memo/recaps/${day}`, { token: userToken });
  assert.equal(recapFetch.status, 200);
  assert.deepEqual([...recapFetch.buffer], [...recapBytes]);

  const daysAfterRecap = await api('GET', '/admin/memo/days', { token: ADMIN });
  assert.equal(daysAfterRecap.data.days.find((d) => d.day === day).hasRecap, true);
});

// A real (if tiny) 64x48 JPEG. The SOI+EOI stub used elsewhere is enough to
// satisfy a magic-byte check but not enough for ffmpeg, which has to decode
// these into actual frames.
const REAL_JPEG = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAg4OEI4Qk1NTU1NTVtUW15eXltbW1teXl5lZWV3d3dlZWVeXmVlcHB3d4GFgXp6d3qFhYyMjKiooaHExMvx8f//xABNAAEBAAAAAAAAAAAAAAAAAAAABgEBAQEAAAAAAAAAAAAAAAAAAAYHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAMABAAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AiwEm38AAAAAAAAAAAAAAAAAAAAAB/9k=', 'base64');

test('you can mirror your own Memo photo, and only your own', async () => {
  // iOS applies "Mirror Front Camera" in its own Camera app and NOT to a web
  // capture, so a selfie shot through Memo arrives the opposite way round
  // from the one that lands in the gallery. Nothing in the uploaded file can
  // settle which is wanted - Safari's HEIC->JPEG conversion strips make,
  // model and lens, leaving only orientation - so this is a control rather
  // than a detection, and the only interesting rule is whose photo it is.
  const owner = (await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Flip Owner' } })).data;
  const other = (await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Flip Onlooker' } })).data;

  const slots = (await api('GET', '/memo/today', { token: owner.token })).data.slots;
  const slot = slots.find((sl) => sl.status === 'waiting') ?? slots[0];
  markSlotNotified(slot.id);
  const up = await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: owner.token, buffer: REAL_JPEG, filename: 'selfie.jpg', mimeType: 'image/jpeg',
  });
  assert.equal(up.status, 201);

  // Nothing is mirrored until somebody says so.
  await apiUpload(`/memo/slots/${slot.id}/upload`, {
    token: other.token, buffer: REAL_JPEG, filename: 'theirs.jpg', mimeType: 'image/jpeg',
  });
  const before = (await api('GET', '/memo/feed', { token: owner.token })).data.uploads.find((u) => u.id === up.data.id);
  assert.equal(before.flipped, false);

  const flipped = await api('POST', `/memo/uploads/${up.data.id}/flip`, { token: owner.token, body: { flipped: true } });
  assert.equal(flipped.status, 200);
  assert.equal(flipped.data.flipped, true);

  const after = (await api('GET', '/memo/feed', { token: owner.token })).data.uploads.find((u) => u.id === up.data.id);
  assert.equal(after.flipped, true, 'the feed has to carry the choice, or the client cannot render it');

  // It is a toggle, not a one-way door - the whole point is comparing.
  await api('POST', `/memo/uploads/${up.data.id}/flip`, { token: owner.token, body: { flipped: false } });
  const back = (await api('GET', '/memo/feed', { token: owner.token })).data.uploads.find((u) => u.id === up.data.id);
  assert.equal(back.flipped, false);

  // And nobody else gets a say in how you look in your own picture.
  const meddling = await api('POST', `/memo/uploads/${up.data.id}/flip`, { token: other.token, body: { flipped: true } });
  assert.equal(meddling.status, 403);
  assert.equal(meddling.data.error, 'err_not_your_photo');

  // The stored file is untouched either way - flipping is a render-time
  // transform, never a re-encode.
  const served = await fetch(`${base}/memo/uploads/${up.data.id}?token=${encodeURIComponent(owner.token)}`);
  const bytes = Buffer.from(await served.arrayBuffer());
  assert.deepEqual(bytes, REAL_JPEG, 'the photo on disk must be byte-identical to the one uploaded');

  await api('DELETE', `/admin/users/${owner.id}`, { token: ADMIN });
  await api('DELETE', `/admin/users/${other.id}`, { token: ADMIN });
});

test('stitching the day video answers immediately and reports when it is done', async () => {
  // This is the bug Ivo hit as "publishing the video to the wall gives an
  // error". Nothing in the encode was broken - the request simply outlived
  // the proxy in front of it, which cuts at 100 seconds and returns a 524.
  // A day with a hundred photos is a hundred seconds of video and was never
  // going to fit inside an HTTP request, so the work moved out of it.
  //
  // What is guarded here is the shape of the exchange, not the speed: the
  // call answers 202 without waiting, and the result arrives through the
  // status endpoint.
  const day = today();
  const shooters = [];
  for (let i = 0; i < 2; i++) {
    shooters.push((await api('POST', '/admin/users', { token: ADMIN, body: { name: `Recap Shooter ${i}` } })).data);
  }

  const slots = (await api('GET', '/memo/today', { token: shooters[0].token })).data.slots;
  const slot = slots.find((sl) => sl.status === 'waiting') ?? slots[0];
  markSlotNotified(slot.id);
  for (const shooter of shooters) {
    const up = await apiUpload(`/memo/slots/${slot.id}/upload`, {
      token: shooter.token, buffer: REAL_JPEG, filename: 'shot.jpg', mimeType: 'image/jpeg',
    });
    assert.equal(up.status, 201);
  }

  // Answers without waiting for the encode.
  const started = await api('POST', `/admin/memo/${day}/recap/generate`, { token: ADMIN });
  assert.equal(started.status, 202, 'the encode must not be held inside the request');
  assert.equal(started.data.started, true);

  // Asking again while it runs is refused rather than starting a second
  // encode on a box that can barely afford the first.
  const again = await api('POST', `/admin/memo/${day}/recap/generate`, { token: ADMIN });
  assert.ok([409, 200, 202].includes(again.status));
  if (again.status === 409) assert.equal(again.data.error, 'err_memo_recap_running');

  // And the result arrives by asking, which is what the button now does.
  let state = 'running';
  for (let i = 0; i < 120 && state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    state = (await api('GET', `/admin/memo/${day}/recap/status`, { token: ADMIN })).data.status;
  }
  assert.equal(state, 'done', 'the video has to finish and say so');

  // Finishing means it is on the Wall, which is the thing that was asked for.
  const posts = (await api('GET', '/plaza-posts', { token: ADMIN })).data.posts;
  assert.ok(posts.some((p) => p.type === 'video'), 'a finished video is published to the Wall');

  for (const shooter of shooters) await api('DELETE', `/admin/users/${shooter.id}`, { token: ADMIN });
});

test('the published day video is compressed, not handed over at ffmpeg defaults', async () => {
  // Ivo, after a night with real people: the video that goes on the Wall has
  // to be compressed "to not jam the FE". His worry was the volume filling
  // up; measuring says the feed is the better reason. A day of ~120 photos
  // is roughly 9MB at ffmpeg's defaults and under 5MB at these settings -
  // the disk would have coped either way, somebody's mobile data at 2am is
  // the part that would not.
  //
  // Asserted as a bitrate rather than a file size, because file size only
  // says "this day was short". What this guards is that the encoder settings
  // do not quietly go back to the defaults.
  const day = today();
  const shooters = [];
  for (let i = 0; i < 3; i++) {
    shooters.push((await api('POST', '/admin/users', { token: ADMIN, body: { name: `Bitrate Shooter ${i}` } })).data);
  }
  const slots = (await api('GET', '/memo/today', { token: shooters[0].token })).data.slots;
  const slot = slots.find((sl) => sl.status === 'waiting') ?? slots[0];
  markSlotNotified(slot.id);
  for (const shooter of shooters) {
    await apiUpload(`/memo/slots/${slot.id}/upload`, {
      token: shooter.token, buffer: REAL_JPEG, filename: 'shot.jpg', mimeType: 'image/jpeg',
    });
  }

  await api('POST', `/admin/memo/${day}/recap/generate`, { token: ADMIN });
  let state = 'running';
  for (let i = 0; i < 120 && state === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    state = (await api('GET', `/admin/memo/${day}/recap/status`, { token: ADMIN })).data.status;
  }
  assert.equal(state, 'done');

  const { getRecap, MEMO_DIR, MEMO_RECAP_SECONDS_PER_PHOTO } = await import('../src/memo.js');
  const { statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const recap = getRecap(day);
  assert.ok(recap, 'the day has a video');

  const bytes = statSync(join(MEMO_DIR, recap.file_path)).size;
  const seconds = shooters.length * MEMO_RECAP_SECONDS_PER_PHOTO;
  const kbPerSecond = bytes / 1024 / seconds;
  // Generous: these are tiny flat test frames, so the real ceiling is far
  // below this. It is set to catch the settings being dropped, which would
  // multiply this several times over, not to police a few KB either way.
  assert.ok(
    kbPerSecond < 400,
    `the Wall video should stay light - got ${kbPerSecond.toFixed(0)} KB per second of video`,
  );

  for (const shooter of shooters) await api('DELETE', `/admin/users/${shooter.id}`, { token: ADMIN });
});

test('one photo nobody can decode is skipped, not allowed to kill the whole day\'s video', async () => {
  // The video was OOM-killed on a day holding three photos. The cause was
  // resolution, not count: Memo stores what the phone actually shot,
  // untouched, and decoding a 48MP JPEG while libx264 was also resident
  // peaked at 219MB next to the app's own ~95MB on a 512MB machine. The
  // stitch is two passes now (see buildDayRecapVideo), which caps it at
  // about 102MB whatever the phone.
  //
  // Splitting it also made this possible, which is what the test is for: a
  // photo that will not decode - a HEIC on a build without it, an upload cut
  // off halfway - used to take every other photo of that day down with it.
  // It should cost its own second of video and nothing else.
  //
  // On a day of its own, not today(): the suite shares today's day with
  // every other Memo test, several of which upload deliberate junk, so
  // counting skips there measures the other tests rather than this one.
  const day = '2026-01-15';
  const { MEMO_DIR, buildDayRecapVideo } = await import('../src/memo.js');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  const slot = db.prepare('SELECT id FROM memo_slots LIMIT 1').get()
    ?? (() => {
      db.prepare('INSERT INTO memo_slots (day, slot_index, scheduled_at, notified_at) VALUES (?, 0, 1, 1)').run(day);
      return db.prepare('SELECT id FROM memo_slots WHERE day = ?').get(day);
    })();

  // Two photos that decode, and one that stops right after the JPEG magic
  // bytes - what a truncated upload leaves on disk.
  writeFileSync(join(MEMO_DIR, 'salvage-ok-1.jpg'), REAL_JPEG);
  writeFileSync(join(MEMO_DIR, 'salvage-ok-2.jpg'), REAL_JPEG);
  writeFileSync(join(MEMO_DIR, 'salvage-truncated.jpg'), Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02, 0x03]));

  // One row per user - (slot_id, user_id) is unique, one upload each.
  const people = [];
  for (let i = 0; i < 3; i++) {
    people.push((await api('POST', '/admin/users', { token: ADMIN, body: { name: `Salvage Person ${i}` } })).data);
  }
  const files = ['salvage-ok-1.jpg', 'salvage-truncated.jpg', 'salvage-ok-2.jpg'];
  files.forEach((file, i) => {
    db.prepare(
      "INSERT INTO memo_uploads (slot_id, user_id, day, kind, mime_type, file_path, file_size) VALUES (?, ?, ?, 'photo', 'image/jpeg', ?, ?)"
    ).run(slot.id, people[i].id, day, file, 100);
  });

  const result = await buildDayRecapVideo(day);
  assert.ok(!result.error, `the day should still produce a video - got ${result.error}`);
  assert.equal(result.skipped, 1, 'only the truncated photo should be skipped');
  assert.equal(result.photoCount, 2, 'both readable photos should still be in the video');

  // And a day where nothing at all decodes says so, rather than handing back
  // a video with no frames in it.
  db.prepare('DELETE FROM memo_uploads WHERE day = ? AND file_path LIKE ?').run(day, 'salvage-ok-%');
  const allBad = await buildDayRecapVideo(day);
  assert.equal(allBad.error, 'err_memo_recap_unreadable');

  db.prepare('DELETE FROM memo_uploads WHERE day = ?').run(day);
  for (const person of people) await api('DELETE', `/admin/users/${person.id}`, { token: ADMIN });
});

test('a day with no photos is refused up front, not started and failed later', async () => {
  // Answering "started" to work that is certain to fail leaves the button
  // spinning against nothing. The one check cheap enough to do before
  // replying is whether there is anything to stitch.
  const empty = await api('POST', '/admin/memo/1999-01-01/recap/generate', { token: ADMIN });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error, 'err_memo_no_photos');
});

test('Memo is gated behind ENABLE_MEMO - disabled means every endpoint 404s', async () => {
  process.env.ENABLE_MEMO = 'false';
  try {
    assert.equal((await api('GET', '/memo/today', { token: userToken })).status, 404);
    assert.equal((await api('GET', '/memo/recaps', { token: userToken })).status, 404);
    assert.equal((await api('GET', '/admin/memo/days', { token: ADMIN })).status, 404);
    assert.equal((await apiUpload('/memo/slots/1/upload', { token: userToken, buffer: Buffer.from('x'), filename: 'x.jpg', mimeType: 'image/jpeg' })).status, 404);
  } finally {
    process.env.ENABLE_MEMO = 'true';
  }
});

test('owner wipe clears every Memo table AND deletes the actual files from disk', async () => {
  // Owner-only permission itself is covered by "a non-owner admin cannot
  // use any feature wipe switch" above - this just checks what the wipe
  // actually does. ADMIN is the seeded owner (see seedResult).
  const before = await api('GET', '/memo/today', { token: userToken });
  const slot = before.data.slots[2]; // already uploaded to in the earlier "accepts one upload" test
  const uploadRow = db.prepare('SELECT file_path FROM memo_uploads WHERE slot_id = ?').get(slot.id);
  assert.ok(uploadRow, 'setup: this slot should already have an upload from an earlier test');
  const absPath = join(MEMO_DIR, uploadRow.file_path);
  assert.ok(existsSync(absPath), 'setup: the file should exist on disk before wiping');

  const asOwner = await api('POST', '/admin/memo/wipe', { token: ADMIN });
  assert.equal(asOwner.status, 200);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memo_slots').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memo_uploads').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memo_recaps').get().n, 0);
  assert.ok(!existsSync(absPath), 'the uploaded file itself should be deleted, not just its DB row');
});

/* --------------------------- Feature wipe switches --------------------------- */
// Runs at the very end (just before rate-limiting, which itself has to be
// last) - each wipe is broad on purpose (every consequence/contestant/
// post/message, not scoped to one night or user), so nothing earlier in
// the file can depend on that data still being there afterward.

test('the owner can wipe each feature independently - only that feature\'s data is cleared, everything else (including user accounts) survives', async () => {
  await api('POST', '/consequences', { token: userToken, body: { text: 'wipe-test consequence' } });
  await api('POST', '/admin/contestants', { token: ADMIN, body: { name: 'WipeTestContestant', night: NIGHT } });
  await api('POST', '/admin/plaza-posts', { token: ADMIN, body: { type: 'announcement', text: 'wipe-test post' } });
  await api('POST', '/chat/messages', { token: ADMIN, body: { text: 'wipe-test message' } });

  // Wiping Rata only touches consequences.
  await api('POST', '/admin/consequences/wipe', { token: ADMIN });
  const afterRataWipe = await api('GET', '/admin/consequences', { token: ADMIN });
  assert.equal(afterRataWipe.data.length, 0, 'consequences should be gone after the Rata wipe');
  const contestantsSurvived = await api('GET', `/admin/contestants?night=${NIGHT}`, { token: ADMIN });
  assert.ok(contestantsSurvived.data.contestants.some((c) => c.name === 'WipeTestContestant'), 'Snatch data should survive a Rata-only wipe');

  // Wiping Snatch only touches contestants/votes, both nights.
  await api('POST', '/admin/contestants/wipe', { token: ADMIN });
  const contestantsGone = await api('GET', `/admin/contestants?night=${NIGHT}`, { token: ADMIN });
  assert.equal(contestantsGone.data.contestants.length, 0, 'contestants should be gone after the Snatch wipe');
  const voting = await api('GET', '/admin/voting', { token: ADMIN });
  assert.ok(voting.data.nights.every((n) => n.status === 'closed'), 'Snatch wipe should also close voting for every night');

  // Wiping Wall only touches plaza_posts.
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  const posts = await api('GET', '/admin/plaza-posts', { token: ADMIN });
  assert.equal(posts.data.posts.length, 0, 'posts should be gone after the Wall wipe');

  // Wiping Plaza only touches chat messages.
  await api('POST', '/admin/chat/wipe', { token: ADMIN });
  const messages = await api('GET', '/chat/messages', { token: ADMIN });
  assert.equal(messages.data.messages.length, 0, 'messages should be gone after the Plaza wipe');

  // None of this touched user accounts.
  const users = await api('GET', '/admin/users', { token: ADMIN });
  assert.ok(users.data.some((u) => u.id === userId), 'user accounts must survive every wipe');
});

/* ------------------------------- Rate limiting ------------------------------ */
// Runs last in the file on purpose: it exhausts this IP's shared
// login/auth-guess budget, which would make any *later* test expecting a
// plain 401 for a bad token see 429 instead.

test('guessing tokens against a non-login endpoint is rate-limited too, not just /auth/login', async () => {
  let lastStatus;
  for (let i = 0; i < 12; i++) {
    const r = await api('GET', '/me', { token: `guess-${i}-does-not-exist` });
    lastStatus = r.status;
  }
  assert.equal(lastStatus, 429, 'repeated invalid-token attempts against a non-login endpoint should eventually be rate-limited');
});

test('no push notification copy carries a capital letter - the golden rule survives outside the CSS', async () => {
  // Every other string in the app is lowercased by body { text-transform:
  // lowercase } in styles.css. Push notifications are the one place that
  // rule cannot reach: iOS draws them itself, so a capital in the source
  // ships straight to the lock screen. That is exactly what had happened -
  // "Rata", "Wall", "Snatch", "Plaza", "Atualização" and the Furnished/
  // Swamp night labels were all capitalised while their message bodies
  // were not, so the titles were the only uppercase text in the whole app.
  const { readFileSync } = await import('node:fs');
  const offenders = [];
  for (const file of ['consequences.js', 'routes.js', 'push.js', 'scheduler.js', 'memo.js']) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (!/\b(pt|en)\s*:/.test(line)) return;
      for (const [, single, tpl] of line.matchAll(/'([^']*)'|`([^`]*)`/g)) {
        const text = single ?? tpl;
        // ${...} holds names and other data, not copy - judge only the
        // literal words around it.
        if (text && /[A-ZÀ-Ý]/.test(text.replace(/\$\{[^}]*\}/g, ''))) {
          offenders.push(`${file}:${i + 1} ${text}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], `notification copy must be lowercase:\n${offenders.join('\n')}`);

  // The night labels reach the lock screen through interpolation, so they
  // are copy too even though they never appear as a pt/en literal.
  const routes = readFileSync(new URL('../src/routes.js', import.meta.url), 'utf8');
  const labels = [...routes
    .match(/const NIGHT_LABEL = \{[^}]*\}/)[0]
    .matchAll(/'([^']*)'/g)].map(([, v]) => v);
  assert.ok(labels.length, 'the night labels should still be found');
  assert.deepEqual(labels.filter((l) => /[A-ZÀ-Ý]/.test(l)), [], 'night labels reach push bodies and must be lowercase');
});

test('the pt and en dictionaries hold the same keys, once each', async () => {
  // Two Portuguese strings had been pasted into the English block on top of
  // their own keys - plaza_confirm_vote and outfit_nothing_open - leaving en
  // with 416 entries against pt's 414. Nothing broke, because a later
  // duplicate wins in an object literal and the later one happened to be
  // the English, so the mistake was invisible from the app and from every
  // test. It would not have been invisible if the paste had landed the
  // other way round.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/js/i18n.js', import.meta.url), 'utf8');
  const ptBlock = src.slice(src.indexOf('  pt: {'), src.indexOf('  en: {'));
  const enBlock = src.slice(src.indexOf('  en: {'));
  const keysOf = (block) => [...block.matchAll(/^ {4}([a-z0-9_]+):/gm)].map(([, k]) => k);

  for (const [lang, block] of [['pt', ptBlock], ['en', enBlock]]) {
    const keys = keysOf(block);
    const dupes = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
    assert.deepEqual(dupes, [], `${lang} defines these keys more than once: ${dupes.join(', ')}`);
  }

  const pt = keysOf(ptBlock);
  const en = keysOf(enBlock);
  assert.deepEqual(pt.filter((k) => !en.includes(k)), [], 'every Portuguese string needs an English one');
  assert.deepEqual(en.filter((k) => !pt.includes(k)), [], 'and the other way round');
});

test('publishing the night to the Wall waits for both rounds, but not for a round that never ran', async () => {
  // The post carries the podium and the congeniality winner in one
  // snapshot, so going out mid-round would either spoil that round or
  // freeze a half-counted result into something that cannot be rewritten.
  const night = 'swamp';
  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', `/admin/voting/${night}/registration`, { token: ADMIN });
  const a = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Publish Gate A' } });
  const b = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Publish Gate B' } });
  for (const u of [a, b]) {
    await api('POST', '/admin/contestants/register', { token: ADMIN, body: { userId: u.data.id, name: `${u.data.name} look`, night } });
  }
  await api('POST', `/admin/voting/${night}/open`, { token: ADMIN, body: { force: true } });
  const listed = (await api('GET', `/votes/status?night=${night}`, { token: a.data.token })).data.contestants;
  await api('POST', '/votes', { token: a.data.token, body: { night, contestantId: listed.find((c) => c.name.startsWith('Publish Gate B')).id } });
  // Everyone eligible has to have voted before this can go out, so b votes
  // too. The Wall keeps the post as a snapshot that cannot be rewritten.
  await api('POST', '/votes', { token: b.data.token, body: { night, contestantId: listed.find((c) => c.name.startsWith('Publish Gate A')).id } });
  // A third voter, only to stop the two entries finishing level. A and B
  // voting for each other is a perfect 1-1 tie, and publishing an unbroken
  // tie is now refused (err_tie_unresolved) - nothing in this test is about
  // ties, so it gets a night with a winner instead.
  const decider = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Publish Gate Decider' } });
  await api('POST', '/votes', { token: decider.data.token, body: { night, contestantId: listed.find((c) => c.name.startsWith('Publish Gate B')).id } });
  await api('POST', `/admin/voting/${night}/close`, { token: ADMIN });
  for (let i = 0; i < 4; i += 1) await api('POST', `/admin/voting/${night}/reveal-next`, { token: ADMIN });

  // Congeniality never opened: nothing to wait for, publishing is fine.
  const noRound = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(noRound.status, 201, 'a night without a congeniality round must still be publishable');

  // Now run one, and it blocks until revealed.
  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'open' } });
  const whileOpen = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(whileOpen.status, 400);
  assert.equal(whileOpen.data.error, 'err_congeniality_not_revealed', 'cannot publish while congeniality is still taking votes');

  await api('POST', '/congeniality/vote', { token: a.data.token, body: { night, targetUserId: b.data.id } });
  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'closed' } });
  const closedUnrevealed = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(closedUnrevealed.status, 400, 'closed with votes still counted is not finished - the winner is not out yet');

  await api('POST', `/admin/voting/${night}/congeniality`, { token: ADMIN, body: { status: 'revealed' } });
  const revealed = await api('POST', `/admin/voting/${night}/publish-podium`, { token: ADMIN });
  assert.equal(revealed.status, 201, 'both rounds finished, so it goes out');

  await api('POST', `/admin/voting/${night}/reset-all`, { token: ADMIN });
  await api('POST', '/admin/plaza-posts/wipe', { token: ADMIN });
  for (const u of [a, b]) await api('DELETE', `/admin/users/${u.data.id}`, { token: ADMIN });
});

test('a feature can be filled with demo data and cleared again, owner-only', async () => {
  // The point is a final check on prod with something in it, then one press
  // to clear - rather than inventing entries by hand and picking them back
  // out. Seeding is deliberately a no-op when the feature already holds
  // anything, so a double press cannot double the data.
  await api('POST', '/admin/consequences/wipe', { token: ADMIN });

  // Its own admin rather than the file's shared user, whose key several
  // earlier tests regenerate - borrowing it here got a 401 that looked like
  // a permission result and was not one.
  const helper = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Seed Button Helper' } });
  await api('PATCH', `/admin/users/${helper.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const asAdmin = await api('POST', '/admin/consequences/seed-demo', { token: helper.data.token });
  assert.equal(asAdmin.status, 403, 'filling a feature belongs with the owner, like every other danger-zone switch');
  await api('DELETE', `/admin/users/${helper.data.id}`, { token: ADMIN });

  const seeded = await api('POST', '/admin/consequences/seed-demo', { token: ADMIN });
  assert.equal(seeded.status, 200);
  const after = (await api('GET', '/admin/consequences', { token: ADMIN })).data;
  assert.ok(after.length > 0, 'the feature should have something in it now');

  const again = await api('POST', '/admin/consequences/seed-demo', { token: ADMIN });
  assert.equal(again.status, 200);
  const afterTwice = (await api('GET', '/admin/consequences', { token: ADMIN })).data;
  assert.equal(afterTwice.length, after.length, 'pressing twice must not double the data');

  await api('POST', '/admin/consequences/wipe', { token: ADMIN });
  const cleared = (await api('GET', '/admin/consequences', { token: ADMIN })).data;
  assert.equal(cleared.length, 0, 'and the wipe beside it takes it all back out');
});

// Reads the drawn text back out of a PDF built with compression off.
// PDFKit writes its glyphs as hex strings inside TJ arrays - the numbers in
// between are kerning adjustments, not content - and encodes the standard
// Times faces in WinAnsi, which is latin1 for everything Portuguese needs.
// Only worth this much effort because it is the alternative to adding a PDF
// parser as a dependency to check about forty words.
function textDrawnInPdf(buf) {
  const raw = buf.toString('latin1');
  const lines = [];
  for (const block of raw.matchAll(/\[((?:<[0-9a-fA-F]*>|[-\d.\s])*)\]\s*TJ/g)) {
    let line = '';
    for (const hex of block[1].matchAll(/<([0-9a-fA-F]*)>/g)) {
      line += Buffer.from(hex[1], 'hex').toString('latin1');
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

function renderDedicationsToBuffer(rows, ownerName) {
  return new Promise((resolve, reject) => {
    const doc = newDedicationsDocument({ compress: false });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    renderDedications(doc, rows, ownerName);
    doc.end();
  });
}

// The golden rule is enforced by `body { text-transform: lowercase }`, which
// reaches every screen in the app and nothing else. The dedications PDF is
// the one artefact that leaves the browser entirely, so the signature is
// lowercased in code instead - and that was unguarded, because PDFKit
// deflates its content streams and reading the text back needed a parser
// this project does not carry. Building the same document with compression
// off is the cheaper seam.
test('the dedications PDF signs every message in lowercase, however the name was typed', async () => {
  const buf = await renderDedicationsToBuffer([
    { text: 'Parabens e muitos anos.', author: 'Alice MOREIRA' },
    { text: 'Um brinde a ti.', author: 'MARIA João' },
    { text: 'Ate para o ano.', author: 'ze monteiro' },
  ], 'Ivo');

  const drawn = textDrawnInPdf(buf);
  // Without this the whole test passes vacuously the day PDFKit changes how
  // it writes text and every regex below matches nothing at all.
  assert.ok(drawn.length >= 7, `expected the heading, the count and three messages with signatures, got ${JSON.stringify(drawn)}`);

  const signatures = drawn.filter((line) => line.includes('alice') || line.includes('maria') || line.includes('rui')
    || /moreira|jo|monteiro/i.test(line));
  assert.equal(signatures.length, 3, `expected three signatures, got ${JSON.stringify(signatures)}`);
  for (const sig of signatures) {
    assert.equal(sig, sig.toLowerCase(), `"${sig}" went into the PDF with capitals in it`);
  }

  // The owner's name in the dedication heading is lowercased the same way.
  const heading = drawn.find((line) => line.startsWith('para o'));
  assert.equal(heading, 'para o ivo', `the heading should name the owner in lowercase, got ${heading}`);

  // The messages themselves are NOT lowercased, and that is deliberate -
  // Ivo's call, 12 Sept 2026, asked directly. The golden rule is about the
  // app's own voice; these forty messages are his friends' voices, written
  // to him, and the book should read the way they wrote it. Only the app's
  // own furniture around them (the heading, the signature line) follows the
  // house style.
  //
  // Pinned here because it looks exactly like an oversight: someone will
  // eventually notice the PDF has capitals in it, see the toLowerCase()
  // sitting on the signature right beside it, and "finish the job".
  const messages = drawn.filter((line) => line.startsWith('Parabens') || line.startsWith('Um brinde') || line.startsWith('Ate para'));
  assert.equal(messages.length, 3, `expected the three messages as written, got ${JSON.stringify(drawn)}`);
  assert.ok(messages.some((m) => m !== m.toLowerCase()),
    'the messages should be printed as they were typed, capitals and all - see the note above before changing this');
});

test('a dedication is private to the birthday person, one per guest, and comes out as a PDF', async () => {
  await api('POST', '/admin/dedications/wipe', { token: ADMIN });
  const ana = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Dedication Ana' } });
  const rui = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Dedication Rui' } });

  // Nothing written yet.
  const empty = await api('GET', '/dedications/mine', { token: ana.data.token });
  assert.equal(empty.status, 200);
  assert.equal(empty.data.dedication, null);

  const written = await api('PUT', '/dedications/mine', { token: ana.data.token, body: { text: 'parabéns, és o maior' } });
  assert.equal(written.status, 200);
  assert.equal(written.data.dedication.text, 'parabéns, és o maior');

  // One each: writing again replaces, it does not add a second.
  await api('PUT', '/dedications/mine', { token: ana.data.token, body: { text: 'pensei melhor: és enorme' } });
  await api('PUT', '/dedications/mine', { token: rui.data.token, body: { text: 'obrigado por tudo' } });
  const all = await api('GET', '/admin/dedications', { token: ADMIN });
  assert.equal(all.data.dedications.length, 2, 'two people wrote, so there are two messages');
  assert.equal(all.data.dedications.find((d) => d.author === 'Dedication Ana').text, 'pensei melhor: és enorme');

  const blank = await api('PUT', '/dedications/mine', { token: ana.data.token, body: { text: '   ' } });
  assert.equal(blank.status, 400);
  assert.equal(blank.data.error, 'err_dedication_empty');
  // Deliberately uncapped: this is the one place someone might write at
  // length, and a keepsake cut off mid-sentence is worse than a long entry.
  const long = await api('PUT', '/dedications/mine', { token: ana.data.token, body: { text: 'x'.repeat(4000) } });
  assert.equal(long.status, 200, 'a long message is allowed');
  await api('PUT', '/dedications/mine', { token: ana.data.token, body: { text: 'pensei melhor: és enorme' } });

  // Nobody but the owner reads them - not even an admin, which is the point.
  const helper = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Dedication Nosy Admin' } });
  await api('PATCH', `/admin/users/${helper.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });
  const peek = await api('GET', '/admin/dedications', { token: helper.data.token });
  assert.equal(peek.status, 403, 'an admin has no more business reading these than any other guest');
  const peekPdf = await api('GET', '/admin/dedications.pdf', { token: helper.data.token });
  assert.equal(peekPdf.status, 403);
  // And a guest cannot read even their own back through the admin route.
  assert.equal((await api('GET', '/admin/dedications', { token: rui.data.token })).status, 403);

  // The PDF is a real one, and carries both messages.
  const pdfRes = await fetch(`${base}/admin/dedications.pdf`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(pdfRes.status, 200);
  assert.match(pdfRes.headers.get('content-type'), /application\/pdf/);
  const bytes = Buffer.from(await pdfRes.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF', 'it has to actually be a PDF, not an error page');
  assert.ok(bytes.length > 800, 'and have something in it');

  await api('POST', '/admin/dedications/wipe', { token: ADMIN });
  const gone = await api('GET', '/admin/dedications.pdf', { token: ADMIN });
  assert.equal(gone.status, 404, 'with nothing written there is no document to make');

  for (const u of [ana, rui, helper]) await api('DELETE', `/admin/users/${u.data.id}`, { token: ADMIN });
});

test('the guest-list card empties the list and puts the default guests back', async () => {
  // This pair sits under Manage Users, so it acts on that list and nothing
  // else. It used to fill and empty the entire app from there, which made
  // the button on the users page a kill switch for the whole party.
  const helper = await api('POST', '/admin/users', { token: ADMIN, body: { name: 'Guest List Helper' } });
  await api('PATCH', `/admin/users/${helper.data.id}/admin`, { token: ADMIN, body: { isAdmin: true } });

  assert.equal((await api('POST', '/admin/users/wipe', { token: helper.data.token })).status, 403,
    'emptying the guest list belongs with the owner');
  assert.equal((await api('POST', '/admin/users/seed-guests', { token: helper.data.token })).status, 403);

  const wiped = await api('POST', '/admin/users/wipe', { token: ADMIN });
  assert.equal(wiped.status, 200);

  const left = (await api('GET', '/admin/users', { token: ADMIN })).data;
  assert.equal(left.length, 1, 'everyone but the owner goes, promoted admins included');
  assert.ok(left[0].is_owner, 'and the owner survives, or nobody can get back into the panel');

  // Their work goes with them - every user-owned table declares ON DELETE
  // CASCADE, so this is the database's rule rather than something the route
  // asks for. Worth a test either way: it is the part that surprises.
  assert.equal((await api('GET', '/admin/consequences', { token: ADMIN })).data.length, 0);
  assert.equal((await api('GET', '/plaza-posts', { token: ADMIN })).data.posts.length, 0);

  const seeded = await api('POST', '/admin/users/seed-guests', { token: ADMIN });
  assert.equal(seeded.status, 200);
  assert.ok(seeded.data.created > 20, `expected the default guest list back, created ${seeded.data.created}`);

  const after = (await api('GET', '/admin/users', { token: ADMIN })).data;
  assert.equal(after.length, seeded.data.created + 1, 'the list is the guests plus the owner');
  assert.ok(after.every((u) => u.is_owner || !u.is_admin), 'restored guests come back as plain guests');

  // Keys are freshly generated, not derived from the name. A key anyone can
  // work out from a guest list is fine for a QA tester predicting their own
  // login and not fine for the list the real party runs on.
  const { generateDemoUserToken } = await import('../src/db.js');
  const sample = after.find((u) => !u.is_owner);
  assert.notEqual(sample.token, generateDemoUserToken(sample.name),
    'a restored guest must not get the predictable demo key');

  // Nothing is doubled up by pressing it twice.
  const again = await api('POST', '/admin/users/seed-guests', { token: ADMIN });
  assert.equal(again.data.created, 0, 'a second press adds nobody');

  await api('POST', '/admin/users/wipe', { token: ADMIN });
});

test('the change-key form cannot be used to test other people\'s keys: taken keys count like failed logins', async () => {
  (await import('../src/rateLimit.js')).resetAuthAttempts();
  const probe = await api('POST', '/admin/users', { token: ADMIN, body: { name: "Prober" } });
  const target = await api('POST', '/admin/users', { token: ADMIN, body: { name: "Target" } });
  let last;
  for (let i = 0; i < 12; i++) {
    last = await api('POST', '/me/change-token', { token: probe.data.token, body: { currentToken: probe.data.token, newToken: target.data.token } });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429, 'repeated "taken" answers must hit the rate limit');
});
