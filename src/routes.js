import { Router } from 'express';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { ZipFile } from 'yazl';
import multer from 'multer';
import db from './db.js';
import { authenticate, findUserByToken, isDevLoginKey, requireAdmin, requireOwner } from './auth.js';
import { loginRateLimit, checkAuthAttempt } from './rateLimit.js';
import { generateUserToken, getSetting, setSetting } from './db.js';
import { hashToken, encryptToken, decryptToken } from './tokens.js';
import { today, nightStatus } from './time.js';
import { NIGHTS, isNight, DEFAULT_NIGHT } from './nights.js';
import {
  revealRandomConsequence,
  currentConsequence,
  revealedConsequences,
  pendingCount,
  mySuggestionToday,
  assignConsequenceUser,
  markConsequenceDone,
  approveConsequence,
} from './consequences.js';
import {
  contestantsForNight,
  myVoteForNight,
  myContestantForNight,
  registerContestant,
  confirmContestant,
  cancelPendingContestant,
  pendingContestantCount,
  replaceContestantPhoto,
  contestantPhotoRow,
  allPhotosForNight,
  castVote,
  confirmDuoVote,
  cancelPendingVote,
  pendingVoteCount,
  usersWithoutVoteCount,
  eligibleVoterCount,
  enteredPeopleCount,
  resultsForNight,
  visibleResultsForNight,
  resetResultsPhase,
  advanceResultsPhase,
  getResultsPhase,
  isRunoffActive,
  clearRunoff,
  startRunoff,
  resolveRunoff,
  congenialityStatus,
  setCongenialityStatus,
  congenialityCandidates,
  myCongenialityVote,
  castCongenialityVote,
  congenialityResults,
  congenialityWinner,
  isCongenialityRunoffActive,
  startCongenialityRunoff,
  resolveCongenialityRunoff,
  resetCongeniality,
  resetCongenialityVotes,
} from './votes.js';
import {
  getPublicKey,
  isPushConfigured,
  saveSubscription,
  removeSubscription,
  broadcast,
  notifyUser,
} from './push.js';
import { listMessages, postMessage, resetPseudonym, wallPseudonymDirectory } from './chat.js';
import { seedDemo, seedGuestList, seedDemoConsequences, seedDemoContestants, seedDemoWall, seedDemoChat, seedDemoMemo } from './seedDemo.js';
import { searchUnclaimedUsers, claimKey } from './keyClaim.js';
import { demoGuard, demoKeys } from './demo.js';
import { myDedication, saveDedication, allDedications, wipeAll as wipeAllDedications } from './dedications.js';
import { renderDedications, newDedicationsDocument } from './dedicationsPdf.js';
import { queueAndRun, backfill as backfillTranslations } from './translate.js';
import { LANGS, wipeFor as wipeTranslationsFor } from './translations.js';
import { localiseConsequences } from './consequences.js';

/**
 * Which language to render guest-written text in. The query parameter wins
 * over the stored preference because the app switches language instantly on
 * a tap and only persists it afterwards - reading the stored value here
 * would show one stale feed immediately after someone switches.
 */
function readerLang(req) {
  const asked = String(req.query?.lang ?? '');
  if (LANGS.includes(asked)) return asked;
  return LANGS.includes(req.user?.lang) ? req.user.lang : null;
}
import { listPlazaPosts, listPlazaPostsForAdmin, updatePlazaPost,
  createPlazaPost, deletePlazaPost, castPlazaVote, pinPlazaPost, createPodiumPost, createVideoPost,
  plazaPostPhotoRow } from './plaza.js';
import {
  MEMO_DIR,
  MEMO_MAX_FILE_BYTES,
  extForMime,
  getTodayForUser,
  recordUpload,
  getUpload,
  getTodayFeed,
  toggleReaction,
  listDays,
  listUploadsForDay,
  saveRecap,
  buildDayRecapVideo,
  memoAvailableTo,
  memoOpenToEveryone,
  triggerNextSlot,
  getRecap,
  listRecapDays,
  wipeAll as wipeAllMemo,
  dayHasPhotos,
  countDayPhotos,
  setUploadFlipped,
} from './memo.js';

const router = Router();
router.use(demoGuard);

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: appVersion } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

/* ---------------------------------- Auth --------------------------------- */

// App version shown as a small on-screen reference (see version.js), so QA
// vs prod mismatches are obvious when reporting a bug. Public - no need to
// be logged in to see it (the login screen shows it too). APP_ENV is only
// ever set to "qa" (see fly.qa.toml) - prod leaves it unset, so the badge
// only ever gets an env label on QA, never a redundant "prod" one.
router.get('/version', (req, res) => {
  res.json({ version: appVersion, env: process.env.APP_ENV || null });
});

// The shared logins for the public demo's login screen - empty everywhere
// else (see src/demo.js).
router.get('/demo', (req, res) => {
  res.json({ keys: demoKeys() });
});

// Validates a token and returns the user.
// Keys are always lowercase (generated that way, and self-service changes
// are forced lowercase below) - normalizing the typed value here makes
// login case-insensitive in practice, so a phone keyboard auto-capitalizing
// the first letter doesn't lock someone out.
router.post('/auth/login', loginRateLimit, (req, res) => {
  const token = (req.body?.token || '').trim().toLowerCase();
  if (!token) return res.status(400).json({ error: 'err_token_missing' });
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ error: 'err_token_invalid' });
  // Proves they know their key - same claimed-key stamp authenticate()
  // applies (see auth.js), so they stop showing up in the first-time
  // name-search flow (keyClaim.js) from here on. The QA dev key proves no
  // such thing, so it deliberately doesn't stamp: claiming the owner on
  // their behalf is what quietly locked them out of "find my key" the first
  // time round.
  if (!isDevLoginKey(token)) {
    db.prepare("UPDATE users SET key_claimed_at = COALESCE(key_claimed_at, strftime('%Y-%m-%d %H:%M:%f', 'now')) WHERE id = ?").run(user.id);
  }
  res.json({ id: user.id, name: user.name, isAdmin: !!user.is_admin });
});

// First-time key retrieval: lets someone who's never logged in find their
// own account by name and get their key, instead of the owner having to
// message everyone individually. Public and unauthenticated by necessity -
// they don't have a key yet. Search itself isn't rate-limited (it doesn't
// reveal a secret, just names of accounts nobody's claimed yet, and needs
// 3+ characters); claiming the actual key shares the login attempt budget,
// same as guessing a token would.
router.get('/auth/unclaimed-users', (req, res) => {
  res.json({ users: searchUnclaimedUsers(req.query.name) });
});

router.post('/auth/claim-key', loginRateLimit, (req, res) => {
  const result = claimKey(Number(req.body?.userId));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Everything below requires authentication.
router.use(authenticate);

router.get('/me', (req, res) => {
  // The account card used to show whatever was typed at login, straight out
  // of localStorage. That is the same string as the real key for everyone
  // except the owner on QA, who signs in with the short dev word (see
  // isDevLoginKey() in auth.js) - so the card showed that word while
  // Manage Users showed the generated key, and the two disagreed about what
  // the account's key even was. This is the account's own key, decrypted
  // from its own row, so both read from the same place.
  const row = db.prepare('SELECT token_enc FROM users WHERE id = ?').get(req.user.id);
  res.json({
    ...req.user,
    key: row ? decryptToken(row.token_enc) : null,
    adminPromotionEnabled: process.env.ENABLE_ADMIN_PROMOTION === 'true',
    plazaEnabled: process.env.ENABLE_PLAZA === 'true',
    // Hidden from guests until MEMO_START_DATE; admins always see it.
    memoEnabled: memoAvailableTo(req.user),
  });
});

router.post('/me/tutorial-seen', (req, res) => {
  db.prepare('UPDATE users SET tutorial_seen = 1 WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

// Remembers the user's last-selected app language, so push notifications can
// be sent in it later (see broadcast() in push.js).
router.post('/me/lang', (req, res) => {
  const lang = req.body?.lang === 'en' ? 'en' : 'pt';
  db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, req.user.id);
  res.json({ ok: true });
});

// Self-service key change - open to every logged-in user, not admin-gated.
// Requires the current key as an extra confirmation layer beyond the bearer
// token itself (e.g. a device left logged in shouldn't let a stranger
// silently take over the account). New key must be letters/numbers only.
router.post('/me/change-token', (req, res) => {
  const currentToken = String(req.body?.currentToken || '').toLowerCase();
  // Keys are always lowercase (see /auth/login) - forcing it here too means
  // the stored key stays canonical regardless of how it was typed/pasted.
  const newToken = String(req.body?.newToken || '').trim().toLowerCase();

  // "That key is taken" says the key belongs to someone, so a logged-in guest
  // could use this form to test other people's keys. Every wrong current key
  // and every taken key counts against the same per-address budget as a
  // failed login (10 per 15 minutes), so it is no faster than guessing there.
  const failed = (status, error) => {
    const limit = checkAuthAttempt(req.ip);
    if (limit.blocked) { res.set('Retry-After', String(limit.retryAfter)); return res.status(429).json({ error: 'err_rate_limited' }); }
    return res.status(status).json({ error });
  };
  const user = db.prepare('SELECT token_hash FROM users WHERE id = ?').get(req.user.id);
  if (hashToken(currentToken) !== user.token_hash) {
    return failed(401, 'err_current_key_wrong');
  }
  if (!/^[a-z0-9]+$/.test(newToken)) {
    return res.status(400).json({ error: 'err_key_invalid_chars' });
  }
  if (newToken.length < 7) {
    return res.status(400).json({ error: 'err_key_too_short' });
  }

  const newHash = hashToken(newToken);
  const collision = db.prepare('SELECT id FROM users WHERE token_hash = ? AND id != ?').get(newHash, req.user.id);
  if (collision) {
    return failed(409, 'err_key_taken');
  }

  try {
    db.prepare("UPDATE users SET token_hash = ?, token_enc = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?")
      .run(newHash, encryptToken(newToken), req.user.id);
  } catch (err) {
    // The check above and this write are two separate statements, and today
    // nothing can slip between them - there is no await in the gap, so the
    // handler runs to completion before another request is served. That is
    // true by accident of how this function is written rather than by
    // design, and it stops being true the moment somebody adds an await.
    //
    // token_hash is UNIQUE in the schema, so the database catches it either
    // way; without this the caller would get a 500 for what is really "that
    // key is taken". Two people picking the same key is a normal thing to
    // happen at a party, not a server fault.
    if (String(err?.code || '').includes('SQLITE_CONSTRAINT')) {
      return failed(409, 'err_key_taken');
    }
    throw err;
  }
  res.json({ ok: true });
});

/* ---------------------------------- Plaza --------------------------------- */
// Owner/admin-authored feed shown on the Wall tab (internal name "plaza"
// stays as-is - only the displayed label changed, see tab_plaza in
// i18n.js) - the app's landing page. Two post types: a plain announcement
// (welcome message, wifi
// password, house rules, release notes) and a poll (e.g. picking a dinner
// spot). Any admin can post, not just the owner; only the owner can pin a
// post, either type (see PATCH .../pin below) - pinned ones float to the
// top of the feed, most-recently-pinned first.
//
// Gated behind ENABLE_PLAZA - it's being reworked from a single pinned
// note into this real posts feed, so it stays QA-only (see fly.qa.toml)
// until that's ready, rather than living on prod mid-rebuild. Same
// on/off-by-env-var pattern as ENABLE_ADMIN_PROMOTION/SEED_DEMO.

router.get('/plaza-posts', (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'err_not_found' });
  res.json({ posts: listPlazaPosts(req.user.id, readerLang(req)) });
});

// The photo on a post, if it has one. Readable by any logged-in guest, the
// same as the post it belongs to - unlike a Snatch entry photo, which is a
// reveal-night surprise and is gated accordingly. Nothing here is secret;
// the admin chose to publish it to everybody.
router.get('/plaza-posts/:id/photo', (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'err_not_found' });
  const row = plazaPostPhotoRow(Number(req.params.id));
  if (!row) return res.status(404).end();
  res.set('Content-Type', row.photo_mime);
  res.set('Cache-Control', 'no-store');
  // Buffer.from is belt-and-braces rather than a fix for a live bug: the
  // Snatch photo route needs it because node:sqlite hands a BLOB back as a
  // plain Uint8Array, which res.send() JSON-serializes instead of sending
  // as bytes. Verified that this driver returns a real Buffer already, so
  // dropping the wrap here changes nothing today - it is kept so that a
  // driver swap cannot quietly turn every Wall photo into {"0":255,...}.
  res.send(Buffer.from(row.photo));
});

router.get('/admin/plaza-posts', requireAdmin, (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'err_not_found' });
  res.json({ posts: listPlazaPostsForAdmin() });
});

router.post('/admin/plaza-posts', requireAdmin, async (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'err_not_found' });
  const result = createPlazaPost(req.user.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
  const bodyByType = {
    poll: { pt: 'há uma nova sondagem na wall, vem votar.', en: 'there’s a new poll on the wall, come and vote.' },
    links: { pt: 'há links novos na wall.', en: 'there are new links on the wall.' },
    announcement: { pt: 'a organização deixou um novo anúncio na wall.', en: 'the hosts left a new announcement on the wall.' },
  };
  await broadcast({
    title: { pt: 'wall', en: 'wall' },
    body: bodyByType[req.body?.type] || bodyByType.announcement,
    tag: 'plaza-announcement',
    url: '/?tab=plaza',
  });
});

// Editing what is already up - a typo in an announcement, a wrong address,
// an option nobody understood. Any admin, same as publishing: whoever can
// put a post on the Wall can fix it. Deleting stays owner-only, because
// that is the one that cannot be undone.
router.patch('/admin/plaza-posts/:id', requireAdmin, (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'err_not_found' });
  const result = updatePlazaPost(Number(req.params.id), req.body || {});
  if (result.error) {
    return res.status(result.error === 'err_post_not_found' ? 404 : 400).json({ error: result.error });
  }
  res.json(result);
});

router.delete('/admin/plaza-posts/:id', requireOwner, (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'err_not_found' });
  const result = deletePlazaPost(Number(req.params.id));
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
});

// Owner-only: pins or unpins any post (announcement or poll) so it floats
// to the top of everyone's Plaza feed. Not exposed to regular admins - same
// reuse of requireOwner as the rest of the golden-rule-gated admin actions.
router.patch('/admin/plaza-posts/:id/pin', requireOwner, (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'err_not_found' });
  const result = pinPlazaPost(Number(req.params.id), !!req.body?.pinned);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.post('/plaza-posts/:id/vote', (req, res) => {
  if (process.env.ENABLE_PLAZA !== 'true') return res.status(404).json({ error: 'err_not_found' });
  const result = castPlazaVote(req.user.id, Number(req.params.id), Number(req.body?.optionId));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ posts: listPlazaPosts(req.user.id, readerLang(req)) });
});

/* ------------------------------ Consequences ----------------------------- */

// Suggest one consequence per day.
router.post('/consequences', (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'err_consequence_text_required' });
  if (text.length > 200) return res.status(400).json({ error: 'err_max_200_chars' });

  const existing = mySuggestionToday(req.user.id);
  if (existing) return res.status(409).json({ error: 'err_consequence_already_suggested_today' });

  // Explicit millisecond-precision timestamp rather than relying on the
  // table's own DEFAULT - that only takes effect for tables created fresh
  // after this fix, and would silently stay at second-only precision (see
  // GET /admin/consequences's sort) on any database that already existed.
  const info = db.prepare(
    "INSERT INTO consequences (user_id, text, day, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))"
  ).run(req.user.id, text, today());
  // Answer first, translate after. A dare is suggested the moment this
  // returns; whether anyone else reads it in their own language is a
  // separate question that must never hold up the 201.
  res.status(201).json({ ok: true });
  queueAndRun('consequence', info.lastInsertRowid, 'text', text);
});

// Currently revealed consequence (everyone sees the same one) + state.
router.get('/consequences/current', (req, res) => {
  res.json({
    current: currentConsequence(readerLang(req)),
    pending: pendingCount(),
    mySuggestion: mySuggestionToday(req.user.id),
  });
});

// Public tracking list - every revealed consequence, who was assigned,
// and whether it's done/approved. Visible to every logged-in user (not
// admin-gated) since the whole point is social pressure via visibility.
router.get('/consequences/revealed', (req, res) => {
  res.json({ consequences: revealedConsequences(readerLang(req)) });
});

// Self-report: the assigned user marks their own consequence as done.
// Still needs the owner's approval (see PATCH .../approve) before it
// shows as done to everyone else.
router.post('/consequences/:id/mark-done', (req, res) => {
  const result = markConsequenceDone(Number(req.params.id), req.user.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, consequence: result.consequence });
});

/* --------------------------------- Votes --------------------------------- */

router.get('/votes/status', (req, res) => {
  const night = isNight(req.query.night) ? req.query.night : DEFAULT_NIGHT;
  const status = nightStatus(night);
  const { phase, results } = status === 'closed'
    ? visibleResultsForNight(night)
    : { phase: null, results: null };
  res.json({
    night,
    status,
    // Whether this night has ever gone through registration/open at least
    // once - lets the frontend tell "hasn't started yet" (status defaults
    // to 'closed' before anything happens) apart from "voting closed after
    // running" (status is 'closed' again, but this time for real).
    started: getSetting(`voting_started_${night}`) === '1',
    contestants: contestantsForNight(night),
    myVote: myVoteForNight(req.user.id, night),
    myContestant: myContestantForNight(req.user.id, night),
    results,
    resultsPhase: phase,
    // So the voting screen can say "it's a tie - vote again" instead of
    // just silently showing a shorter contestant list with no context.
    runoffActive: isRunoffActive(night),
    // The separate Miss Congeniality round (see votes.js) - its own status,
    // its own candidate list of individuals, and the winner only once the
    // admin actually reveals it.
    congeniality: {
      status: congenialityStatus(night),
      candidates: congenialityCandidates(night),
      myVote: myCongenialityVote(req.user.id, night),
      winner: congenialityWinner(night),
      // Same reason as runoffActive above: otherwise the card just quietly
      // shows a shorter list of people with no word about why.
      runoffActive: isCongenialityRunoffActive(night),
    },
  });
});

router.post('/congeniality/vote', (req, res) => {
  const night = isNight(req.body?.night) ? req.body.night : DEFAULT_NIGHT;
  const result = castCongenialityVote(req.user.id, Number(req.body?.targetUserId), night);
  if (result.error) return res.status(400).json(result);
  res.status(201).json(result);
});

// Self-registration for Best Look: everyone (not just admins) can enter
// their own persona/creature-of-the-night, optionally teamed up with
// another user (picked via /users/basic) - see registerContestant() for
// the duo-matching and vote-merging rules.
router.post('/outfit/register', async (req, res) => {
  const night = isNight(req.body?.night) ? req.body.night : DEFAULT_NIGHT;
  // A photo is required to complete a self-registration (not to use the
  // app at all) - see registerContestant()'s requirePhoto. Organiser-
  // created entries below skip it, same as they skip duo confirmation.
  const result = registerContestant(req.user.id, night, req.body?.name || '', req.body?.partnerUserId, {
    photoBase64: req.body?.photoBase64 || null,
    requirePhoto: true,
  });
  if (result.error) return res.status(400).json({ error: result.error });
  // pending: a duo entry the named partner hasn't agreed to yet - not on
  // the voting list until they confirm below.
  res.status(201).json(result);
  // Tell the partner, because nothing else will. A duo entry does not count
  // until they confirm it, and until now the only way they learned they had
  // been named was opening Snatch and noticing - so entries sat pending
  // until somebody chased them round the party in person.
  //
  // Only on the self-registration path: an organiser entering a pair on
  // their behalf auto-confirms, so there is nothing to ask for.
  if (result.pending && req.body?.partnerUserId) {
    await notifyUser(Number(req.body.partnerUserId), {
      title: { pt: 'snatch', en: 'snatch' },
      body: {
        pt: `${req.user.name} inscreveu-te em par no snatch, confirma para a inscrição contar.`,
        en: `${req.user.name} entered snatch as a duo with you, confirm so the entry counts.`,
      },
      tag: 'outfit-duo-invite',
      url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
    });
  }
});

// The named partner's half of a duo entry (see confirmContestant()): only
// they can sign it off, and only while registration is still open.
router.post('/outfit/register/confirm', (req, res) => {
  const night = isNight(req.body?.night) ? req.body.night : DEFAULT_NIGHT;
  const result = confirmContestant(req.user.id, night);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// Drops an unconfirmed duo entry so both are free to enter again - either
// of them, since a refusal and a change of heart amount to the same thing.
router.delete('/outfit/register/pending', (req, res) => {
  const night = isNight(req.body?.night) ? req.body.night : DEFAULT_NIGHT;
  const result = cancelPendingContestant(req.user.id, night);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// Swaps the entry's photo - either half of a duo, any time before voting
// opens (see replaceContestantPhoto()).
router.put('/outfit/register/photo', (req, res) => {
  const night = isNight(req.body?.night) ? req.body.night : DEFAULT_NIGHT;
  const result = replaceContestantPhoto(req.user.id, night, req.body?.photoBase64 || '');
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// Serves a contestant's outfit photo. Either half of the entry and any
// admin can always see it (their own preview, or moderation); anyone else
// only once that contestant's rank has actually been revealed to guests
// (see visibleResultsForNight()) - photos are a reveal-night surprise, not
// visible during voting, so this is enforced here rather than trusted to
// the frontend alone.
router.get('/outfit/contestants/:id/photo', (req, res) => {
  const row = contestantPhotoRow(Number(req.params.id));
  if (!row) return res.status(404).end();
  const isOwn = row.user_id === req.user.id || row.partner_user_id === req.user.id;
  if (!isOwn && !req.user.isAdmin) {
    const { results } = visibleResultsForNight(row.night);
    if (!results.some((r) => r.id === row.id)) return res.status(404).end();
  }
  res.set('Content-Type', row.photo_mime);
  res.set('Cache-Control', 'no-store');
  // node:sqlite hands back a BLOB column as a plain Uint8Array, not a real
  // Buffer - Buffer.isBuffer() is false for it, so res.send() doesn't
  // recognize it as raw binary and instead JSON-serializes it as
  // {"0":255,"1":216,...}, which browsers duly fail to decode as an image
  // (silently - an <img> tag has no error UI of its own). Wrapping it in an
  // actual Buffer is enough for Express to serve it correctly.
  res.send(Buffer.from(row.photo));
});

// Minimal user list (id + name only, no tokens/roles) for the "team up with"
// picker on Best Look registration - every logged-in user can see it.
//
// ?freeFor=<night> drops anyone who already has an entry that night, either
// as the entrant or as the named partner. registerContestant() refuses those
// anyway (err_you_already_registered), so offering them up could only ever
// end in an error message - the organiser picks a name off the list and is
// told off for it. Not filtering by default: the guest-facing duo picker
// wants everyone, and refusing there is the honest answer, since who is
// already entered is not something to publish to the whole party.
router.get('/users/basic', (req, res) => {
  const freeFor = req.query.freeFor;
  if (isNight(freeFor)) {
    // Keeps the caller, unlike the plain list below: the organiser filling
    // in the admin form may well be entering themselves, and this list is
    // "who is still free", not "everyone but you".
    const rows = db.prepare(`
      SELECT u.id, u.name FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM contestants c
        WHERE c.night = ? AND (c.user_id = u.id OR c.partner_user_id = u.id)
      )
      ORDER BY u.name COLLATE NOCASE
    `).all(freeFor);
    return res.json(rows);
  }
  const rows = db.prepare(
    'SELECT id, name FROM users WHERE id != ? ORDER BY name COLLATE NOCASE'
  ).all(req.user.id);
  res.json(rows);
});

router.post('/votes', (req, res) => {
  const contestantId = Number(req.body?.contestantId);
  const night = req.body?.night;
  if (!contestantId) return res.status(400).json({ error: 'err_choose_contestant' });
  const result = castVote(req.user.id, contestantId, night);
  if (result.error) return res.status(400).json({ error: result.error });
  // pending: a duo's proposal, not a vote yet - the partner still has to
  // confirm it below before it counts for anything.
  res.status(201).json({ ok: true, pending: !!result.pending });
});

// The other half of a duo's shared vote (see confirmDuoVote()): only the
// partner who did NOT propose it can sign it off.
router.post('/votes/confirm', (req, res) => {
  const result = confirmDuoVote(req.user.id, req.body?.night);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// Drops a duo's unconfirmed proposal so they can pick someone else -
// either partner, and only while it's still unconfirmed.
router.delete('/votes/pending', (req, res) => {
  const result = cancelPendingVote(req.user.id, req.body?.night);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

/* ---------------------------------- Chat ---------------------------------- */
// Open, ephemeral group chat - keeps only the last 15 messages, no time
// expiry (see src/chat.js). Displayed as "Plaza" now (internal name "chat"
// stays as-is, see tab_chat in i18n.js).

router.get('/chat/messages', (req, res) => {
  res.json({ messages: listMessages(readerLang(req)) });
});

router.post('/chat/messages', async (req, res) => {
  const result = postMessage(req.user.id, req.body?.text);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json({ ok: true });
  // Announce by pseudonym only - same golden rule as the rest of the
  // Plaza, nobody but the owner learns who's behind a post. Skip the
  // poster's own device, they don't need telling about their own message.
  await broadcast({
    title: { pt: 'plaza', en: 'plaza' },
    body: { pt: `${result.pseudonym} acabou de partilhar algo novo na plaza.`, en: `${result.pseudonym} just shared something new in the plaza.` },
    tag: 'plaza-share',
    url: '/?tab=chat',
  }, { excludeUserId: req.user.id });
});

/* ---------------------------------- Push --------------------------------- */

router.get('/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: getPublicKey(), enabled: isPushConfigured() });
});

router.post('/push/subscribe', (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint) return res.status(400).json({ error: 'err_invalid_subscription' });
  saveSubscription(req.user.id, sub);
  res.status(201).json({ ok: true });
});

router.post('/push/unsubscribe', (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) removeSubscription(endpoint);
  res.json({ ok: true });
});

/* ---------------------------------- Memo --------------------------------- */
// 5x/day, at a random independent time per guest, a push notification asks
// them to upload a photo/video within a 15-minute window. QA-only until
// tested (see ENABLE_MEMO) - same gating shape as ENABLE_PLAZA above.
// Uploads are original-size photos/video, not the small resized-JPEG BLOBs
// outfit entries use, so they're multipart/form-data straight to disk
// (MEMO_DIR, see memo.js) rather than base64-in-JSON.

const memoUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = join(MEMO_DIR, today());
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${req.user.id}-slot${req.params.id}${extForMime(file.mimetype)}`),
});
const memoUpload = multer({
  storage: memoUploadStorage,
  limits: { fileSize: MEMO_MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype)),
});

router.get('/memo/today', (req, res) => {
  if (!memoAvailableTo(req.user)) return res.status(404).json({ error: 'err_not_found' });
  res.json({ slots: getTodayForUser(req.user.id) });
});

router.post('/memo/slots/:id/upload', (req, res) => {
  if (!memoAvailableTo(req.user)) return res.status(404).json({ error: 'err_not_found' });
  memoUpload.single('file')(req, res, (err) => {
    if (err) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 'err_memo_file_too_large' : 'err_memo_upload_failed';
      return res.status(400).json({ error: code });
    }
    if (!req.file) return res.status(400).json({ error: 'err_memo_invalid_type' });
    try {
      const upload = recordUpload(Number(req.params.id), req.user.id, {
        mimeType: req.file.mimetype,
        filePath: relative(MEMO_DIR, req.file.path),
        fileSize: req.file.size,
      });
      res.status(201).json({ id: upload.id, kind: upload.kind });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });
});

// Serves a guest's own upload (or any admin's, for moderation/download) -
// same ?token= query-param auth as the outfit contestant photo route
// above, needed because <img>/<video> tags can't send an Authorization
// header. res.sendFile() (not a manual read+send) handles Range requests
// on its own, which video scrubbing needs.
router.get('/memo/uploads/:id', (req, res) => {
  if (!memoAvailableTo(req.user)) return res.status(404).json({ error: 'err_not_found' });
  const upload = getUpload(Number(req.params.id));
  if (!upload) return res.status(404).end();
  // Every guest's moments are visible to every other guest via the shared
  // feed (see GET /memo/feed) - not just the uploader/admins, unlike the
  // outfit contestant photo route this pattern is otherwise copied from.
  res.sendFile(join(MEMO_DIR, upload.file_path));
});

// The current moment's feed - what everyone else posted for the slot that is
// live now, newest first, with reaction counts and the viewer's own reaction
// on each. `locked` means the viewer hasn't posted theirs yet, so there is
// something to see but they haven't earned it.
router.get('/memo/feed', (req, res) => {
  if (!memoAvailableTo(req.user)) return res.status(404).json({ error: 'err_not_found' });
  res.json(getTodayFeed(req.user.id));
});

// Mirror your own photo, or put it back. Needed because iOS's "Mirror Front
// Camera" setting governs the Camera app and not a web capture, so a selfie
// shot through Memo arrives un-mirrored while the same shot taken normally
// sits mirrored in the gallery. Nothing in the uploaded file says which
// camera took it - Safari's HEIC->JPEG conversion strips make, model and
// lens - so this cannot be detected, only chosen.
router.post('/memo/uploads/:id/flip', (req, res) => {
  if (!memoAvailableTo(req.user)) return res.status(404).json({ error: 'err_not_found' });
  try {
    const flipped = setUploadFlipped(Number(req.params.id), req.user.id, !!req.body?.flipped);
    res.json({ flipped });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/memo/uploads/:id/react', (req, res) => {
  if (!memoAvailableTo(req.user)) return res.status(404).json({ error: 'err_not_found' });
  try {
    const emoji = toggleReaction(Number(req.params.id), req.user.id, req.body?.emoji);
    res.json({ emoji });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.get('/memo/recaps', (req, res) => {
  if (!memoAvailableTo(req.user)) return res.status(404).json({ error: 'err_not_found' });
  res.json({ days: listRecapDays() });
});

router.get('/memo/recaps/:day', (req, res) => {
  if (!memoAvailableTo(req.user)) return res.status(404).json({ error: 'err_not_found' });
  const recap = getRecap(req.params.day);
  if (!recap) return res.status(404).end();
  res.sendFile(join(MEMO_DIR, recap.file_path));
});

/* --------------------------------- Admin --------------------------------- */

router.use('/admin', requireAdmin);

// Golden rule: nobody but the owner can see OTHER users' access keys, so
// every mutation below (create/rename/regenerate/promote/remove) is locked
// down beyond plain admin. The list itself is the one exception: a regular
// admin can see it too, filtered down to just their own row - lets them get
// familiar with the Users tab/their own entry without exposing anyone
// else's secrets.
router.get('/admin/users', (req, res) => {
  const users = db.prepare(
    'SELECT id, name, token_enc, is_admin, is_owner, created_at FROM users ORDER BY is_owner DESC, name COLLATE NOCASE ASC'
  ).all();
  const visible = req.user.isOwner ? users : users.filter((u) => u.id === req.user.id);
  res.json(visible.map((u) => ({
    id: u.id,
    name: u.name,
    token: decryptToken(u.token_enc),
    is_admin: !!u.is_admin,
    is_owner: !!u.is_owner,
    created_at: u.created_at,
  })));
});

router.use('/admin/users', requireOwner);

router.post('/admin/users', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'err_name_missing' });
  const token = generateUserToken(name);
  const info = db.prepare(
    "INSERT INTO users (name, token_hash, token_enc, is_admin, updated_at) VALUES (?, ?, ?, 0, strftime('%Y-%m-%d %H:%M:%f', 'now'))"
  ).run(name, hashToken(token), encryptToken(token));
  res.status(201).json({ id: info.lastInsertRowid, name, token });
});

// Fixes a typo or updates a display name - there was previously no way to
// correct a user's name after creation short of deleting and recreating them
// (which would also generate them a new access key).
router.patch('/admin/users/:id/name', (req, res) => {
  const id = Number(req.params.id);
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'err_name_missing' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'err_user_not_found' });
  db.prepare("UPDATE users SET name = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(name, id);
  res.json({ ok: true, id, name });
});

// Issues a brand-new access key for a user (e.g. they think it leaked, or
// someone else claimed it by mistake via the first-time name-search flow).
// Invalidates the previous key immediately, AND reopens that same
// name-search flow for them (key_claimed_at back to NULL) - so recovering
// from a wrongly-claimed key is just "tell the owner, get regenerated,
// find your name again," not the owner manually messaging a new key.
router.post('/admin/users/:id/regenerate-token', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'err_user_not_found' });
  const token = generateUserToken(user.name);
  db.prepare("UPDATE users SET token_hash = ?, token_enc = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), key_claimed_at = NULL WHERE id = ?")
    .run(hashToken(token), encryptToken(token), id);
  res.json({ ok: true, id, name: user.name, token });
});

// Toggle the logo customization state (appde<firstname> vs plain appdoivo).
// Self-only; returns the new state.
router.post('/me/logo-customized', (req, res) => {
  const customized = req.body?.customized;
  if (customized !== true && customized !== false) {
    return res.status(400).json({ error: 'err_invalid_logo_value' });
  }
  db.prepare('UPDATE users SET logo_customized = ? WHERE id = ?').run(customized ? 1 : 0, req.user.id);
  res.json({ ok: true, logo_customized: customized });
});

router.delete('/admin/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT is_owner FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'err_user_not_found' });
  // Only the owner is protected from removal. A promoted admin is still
  // just a regular user with an extra role, so they stay deletable.
  if (user.is_owner) return res.status(400).json({ error: 'err_cannot_remove_owner' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Promotes or revokes admin status. Disabled outside environments that opt
// in via ENABLE_ADMIN_PROMOTION. Always keeps at least one admin, and the
// owner can never be demoted, by themselves or anyone else. The golden
// rule (only the owner sees access keys) is enforced separately below
// regardless of this flag.
router.patch('/admin/users/:id/admin', (req, res) => {
  if (process.env.ENABLE_ADMIN_PROMOTION !== 'true') {
    return res.status(403).json({ error: 'err_feature_disabled' });
  }

  const id = Number(req.params.id);
  const isAdmin = !!req.body?.isAdmin;
  const user = db.prepare('SELECT is_admin, is_owner FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'err_user_not_found' });

  if (!isAdmin && user.is_owner) {
    return res.status(400).json({ error: 'err_cannot_demote_owner' });
  }

  if (!isAdmin && user.is_admin) {
    const { c: adminCount } = db.prepare('SELECT count(*) c FROM users WHERE is_admin = 1').get();
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'err_last_admin' });
    }
  }

  db.prepare("UPDATE users SET is_admin = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?").run(isAdmin ? 1 : 0, id);
  res.json({ ok: true, is_admin: isAdmin });

  // Tell the person whose role it is. Their open session already changes
  // under them within 30s (see startRoleWatcher() in app.js/settings.js) -
  // buttons appearing or vanishing with no explanation is unsettling, and
  // someone who is not looking at the app finds out only by accident. Sent
  // after the response so a push failure cannot fail the role change, which
  // is the part that matters.
  notifyUser(id, {
    title: { pt: 'appdoivo', en: 'appdoivo' },
    body: isAdmin
      ? { pt: 'agora és admin e tens acesso ao painel de administração.',
          en: 'you are an admin now and have access to the admin panel.' }
      : { pt: 'já não és admin, mas continuas a ter acesso a tudo o resto.',
          en: 'you are no longer an admin, but you keep access to everything else.' },
    url: '/settings.html',
  }).catch((err) => console.error('[push] role-change notify failed:', err));
});

/* ---------------------------------- Wall ---------------------------------- */
// Owner-only: the Wall is anonymous to everyone else, including other
// admins - only the owner can see who's behind each pseudonym.

router.get('/admin/wall-pseudonyms', requireOwner, (req, res) => {
  res.json(wallPseudonymDirectory());
});

// Owner-only: re-rolls a user's Wall pseudonym to a fresh random one, at
// most once a day (see resetPseudonym() in chat.js) - the old one stays in
// their history, it's just no longer the one new posts use.
router.post('/admin/users/:id/wall-pseudonym/reset', requireOwner, (req, res) => {
  const result = resetPseudonym(Number(req.params.id));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Owner-only kill switches, one per feature - each wipes only its own
// data (never touches user accounts/keys, and never another feature's
// data), unlike the single cross-feature "reset everything" this
// replaced. Lives on each feature's own admin tab, not a shared "danger
// zone" bundling all of them together.

// Rata: every consequence, any status/day.
// Fills a single feature with throwaway data, so a final check on prod can
// be done with something in it and then cleared with the wipe button right
// beside this one - rather than inventing entries by hand and picking them
// back out afterwards. Owner-only, like every other switch in a danger
// zone, and a no-op if that feature already holds anything.
// Everything at once. Seeding covers the guest accounts too, which no
// per-feature button does - the point is to set the whole app up as a demo
// for a run-through and then put it back.
// The card these two live in sits under Manage Users, so they act on the
// guest list and nothing else. It used to fill and empty the entire app,
// which meant the one button on the users page could take the whole party
// with it - a kill switch nobody asked for. Each feature tab already has
// its own seed and wipe for its own data.
router.post('/admin/users/seed-guests', requireOwner, (req, res) => {
  res.json({ ok: true, ...seedGuestList() });
});

// Empties the guest list. Everyone but the owner goes, promoted admins
// included - the list on that page shows them all, so the button under it
// clears them all. The owner survives because deleting it locks everyone
// out of the admin panel with no way back in.
//
// What each person wrote goes with them, and not because this asks for it:
// consequences, contestants, messages, posts, uploads and dedications all
// declare ON DELETE CASCADE on users(id) (see db.js). Worth knowing before
// pressing it - there is no version of "remove the account, keep the
// evidence" here.
router.post('/admin/users/wipe', requireOwner, (req, res) => {
  const { changes } = db.prepare('DELETE FROM users WHERE is_owner = 0').run();
  res.json({ ok: true, removed: changes });
});

router.post('/admin/consequences/seed-demo', requireOwner, (req, res) => {
  seedDemoConsequences();
  res.json({ ok: true });
});

router.post('/admin/contestants/seed-demo', requireOwner, (req, res) => {
  seedDemoContestants();
  res.json({ ok: true });
});

router.post('/admin/plaza-posts/seed-demo', requireOwner, (req, res) => {
  seedDemoWall();
  res.json({ ok: true });
});

router.post('/admin/chat/seed-demo', requireOwner, (req, res) => {
  seedDemoChat();
  res.json({ ok: true });
});

router.post('/admin/memo/seed-demo', requireOwner, (req, res) => {
  seedDemoMemo();
  res.json({ ok: true });
});

router.post('/admin/consequences/wipe', requireOwner, (req, res) => {
  db.prepare('DELETE FROM consequences').run();
  // The translations belonged to rows that no longer exist. Left behind,
  // they would attach themselves to whatever reused those ids next.
  wipeTranslationsFor('consequence');
  res.json({ ok: true });
});

// Snatch: every contestant (cascades to votes), both nights at once - the
// existing per-night "Reiniciar tudo" on the voting-controls card only
// ever clears whichever night is currently selected.
router.post('/admin/contestants/wipe', requireOwner, (req, res) => {
  db.prepare('DELETE FROM contestants').run();
  for (const night of NIGHTS) {
    setSetting(`voting_status_${night}`, 'closed');
    setSetting(`voting_started_${night}`, '0');
    resetResultsPhase(night);
  }
  res.json({ ok: true });
});

// Wall: every post (announcements + polls, cascades poll options/votes).
router.post('/admin/plaza-posts/wipe', requireOwner, (req, res) => {
  db.prepare('DELETE FROM plaza_posts').run();
  for (const kind of ['plaza_post', 'poll_option', 'link_item']) wipeTranslationsFor(kind);
  res.json({ ok: true });
});

// Plaza: every chat message.
/**
 * Queues everything written before translations existed. Owner-only and
 * safe to run repeatedly - anything already queued is skipped, so this
 * neither duplicates work nor revives a translation that already used up
 * its attempts.
 */
router.post('/admin/translations/backfill', requireOwner, (req, res) => {
  res.json({ ok: true, queued: backfillTranslations() });
});

router.post('/admin/chat/wipe', requireOwner, (req, res) => {
  db.prepare('DELETE FROM messages').run();
  wipeTranslationsFor('message');
  res.json({ ok: true });
});

// Votes for a night. Same golden rule as the Wall's real-name mapping:
// only the owner sees who voted for whom - a regular admin only gets the
// aggregate tally/ranking, the same numbers that go public on the Best
// Outfit page once results are revealed. No individual-vote data should
// leak to a role that isn't the owner.
router.get('/admin/votes', (req, res) => {
  const night = isNight(req.query.night) ? req.query.night : DEFAULT_NIGHT;
  const results = resultsForNight(night);
  if (!req.user.isOwner) {
    return res.json({ night, results });
  }
  // confirmed flags a duo proposal still waiting on the partner - it isn't
  // counted in `results` above, so the log would look like it disagreed
  // with the tally if these were listed indistinguishably.
  const rows = db.prepare(`
    SELECT v.id, v.night, u.name AS voter, c.name AS contestant, v.created_at,
           v.confirmed_at IS NOT NULL AS confirmed
    FROM votes v
    JOIN users u ON u.id = v.user_id
    JOIN contestants c ON c.id = v.contestant_id
    WHERE v.night = ?
    ORDER BY v.created_at
  `).all(night);
  // Miss Congeniality's own log, kept separate rather than merged: it is a
  // vote for a person, not for an entry, and a duo shows up as two names
  // here where it is one entry above.
  const congenialityVotes = db.prepare(`
    SELECT cv.id, u.name AS voter, t.name AS target, cv.created_at
    FROM congeniality_votes cv
    JOIN users u ON u.id = cv.user_id
    JOIN users t ON t.id = cv.target_user_id
    WHERE cv.night = ?
    ORDER BY cv.created_at
  `).all(night);
  res.json({ night, votes: rows, congenialityVotes, results });
});

// Dedications: a private message to the birthday person. Writing one is
// open to every guest; reading them is not, which is the entire point.
router.get('/dedications/mine', (req, res) => {
  res.json({ dedication: myDedication(req.user.id) });
});

router.put('/dedications/mine', (req, res) => {
  const result = saveDedication(req.user.id, req.body?.text);
  if (result.error) return res.status(400).json(result);
  res.json({ ok: true, dedication: myDedication(req.user.id) });
});

// Owner-only from here down. Not requireAdmin: an admin helping run the
// night has no more business reading these than any other guest.
router.get('/admin/dedications', requireOwner, (req, res) => {
  res.json({ dedications: allDedications() });
});

router.post('/admin/dedications/wipe', requireOwner, (req, res) => {
  wipeAllDedications();
  res.json({ ok: true });
});

// The collection as a document, meant to be taken out once at the end - a
// book you read straight through, which is what a pile of messages from
// your friends actually is.
//
// It borrows the landing page's own palette rather than inventing one for
// print: cream paper, warm ink, the terracotta accent, and the same faint
// speckle the app lays over its background. Times rather than the app's
router.get('/admin/dedications.pdf', requireOwner, (req, res) => {
  const rows = allDedications();
  if (rows.length === 0) return res.status(404).json({ error: 'err_no_dedications' });

  const owner = db.prepare('SELECT name FROM users WHERE is_owner = 1').get();
  const doc = newDedicationsDocument();
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'attachment; filename="dedicatorias.pdf"');
  doc.pipe(res);
  renderDedications(doc, rows, owner?.name);
  doc.end();
});

// Consequences (full view)
router.get('/admin/consequences', (req, res) => {
  // Most recently touched first - a pending one sorts by when it was
  // suggested, but the moment it's revealed it jumps to the top too
  // (revealed_at, once set, is always more recent than created_at).
  // id DESC breaks the tie: the timestamps are millisecond strings, and two
  // suggestions posted in the same millisecond otherwise came back in
  // whatever order the scan happened to produce - i.e. oldest first, the
  // opposite of what this list promises.
  const rows = db.prepare(`
    SELECT c.id, c.text, c.day, c.status, c.revealed_at, u.name AS author,
           c.assigned_user_id, a.name AS assignedName, c.assigned_at,
           c.done_at, c.approved_at
    FROM consequences c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN users a ON a.id = c.assigned_user_id
    ORDER BY COALESCE(c.revealed_at, c.created_at) DESC, c.id DESC
  `).all();
  res.json(localiseConsequences(rows, readerLang(req)));
});

// Reveal a consequence manually (for testing).
router.post('/admin/consequences/reveal', async (req, res) => {
  const revealed = await revealRandomConsequence();
  if (!revealed) return res.status(404).json({ error: 'err_no_pending_consequences' });
  res.json({ ok: true, revealed });
});

// Any admin (not owner-only) records who's actually holding the rata for
// a revealed consequence - whoever's at the party when it's noticed can
// enter it, it can't be inferred from anything in the app. Not tied to
// "who has it right now" - can be set any time after the reveal, since
// that's easier to keep track of than requiring it at the exact moment.
// Approving that it was actually done, below, is owner-only though.
router.patch('/admin/consequences/:id/assign', async (req, res) => {
  const userId = req.body?.userId === null ? null : Number(req.body?.userId);
  if (userId !== null) {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'err_user_not_found' });
  }
  // assignConsequenceUser() already notifies the assigned user directly
  // (see src/consequences.js) - a second notification here duplicated it.
  const updated = await assignConsequenceUser(Number(req.params.id), userId);
  if (!updated) return res.status(404).json({ error: 'err_consequence_not_found' });
  res.json({ ok: true, consequence: updated });
});

// Owner-only: confirms a consequence the assigned user self-reported as
// done actually happened - only then does it show as done to everyone.
router.patch('/admin/consequences/:id/approve', requireOwner, (req, res) => {
  const result = approveConsequence(Number(req.params.id));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, consequence: result.consequence });
});

// Contestants for a night. registered_by/partner_name are set only for
// self-registered entries (see registerContestant() in votes.js) - admin-
// added contestants leave both null, so the owner can tell them apart.
router.get('/admin/contestants', (req, res) => {
  const night = isNight(req.query.night) ? req.query.night : DEFAULT_NIGHT;
  const rows = db.prepare(`
    SELECT c.id, c.name, c.night, u1.name AS registered_by, u2.name AS partner_name,
           c.confirmed_at IS NOT NULL AS confirmed, c.photo IS NOT NULL AS hasPhoto
    FROM contestants c
    LEFT JOIN users u1 ON u1.id = c.user_id
    LEFT JOIN users u2 ON u2.id = c.partner_user_id
    WHERE c.night = ? ORDER BY c.name COLLATE NOCASE
  `).all(night);
  res.json({ night, contestants: rows });
});

// Bundles every submitted outfit photo for a night into a single zip -
// an admin/owner convenience for keeping the photos after the party
// (QA/prod's DB storage, see the migration in db.js, has no browsing UI of
// its own). Includes pending (unconfirmed) entries too, unlike the guest-
// facing routes above - see allPhotosForNight() in votes.js. Built
// entirely in memory: even a generous night's worth of photos (each
// capped at 400KB, see MAX_PHOTO_BYTES in votes.js) stays a few MB total,
// nowhere near worth the complexity of streaming from disk.
router.get('/admin/outfit/:night/photos.zip', (req, res) => {
  if (!isNight(req.params.night)) return res.status(400).json({ error: 'err_invalid_night' });
  const night = req.params.night;
  const photos = allPhotosForNight(night);
  if (!photos.length) return res.status(404).json({ error: 'err_no_photos' });

  const zip = new ZipFile();
  const usedNames = new Set();
  for (const p of photos) {
    // Contestant names are free-text and often repeated/generic ("gato",
    // "bruxa") - two entries picking the same one would otherwise silently
    // overwrite each other inside the zip, so collisions fall back to
    // appending the contestant id.
    // Lowercased like everything else the app writes - a zip full of
    // "Gato.jpg" next to "bruxa.jpg" reads as inconsistent, and on a
    // case-insensitive filesystem the two spellings collide anyway.
    const base = p.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'sem-nome';
    let filename = `${base}.jpg`;
    if (usedNames.has(filename)) filename = `${base}-${p.id}.jpg`;
    usedNames.add(filename);
    zip.addBuffer(Buffer.from(p.photo), filename);
  }
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="snatch-${night}-photos.zip"`);
  zip.outputStream.pipe(res);
  zip.end();
});

// userId optionally links this entry to a real registered user (picked
// from /users/basic on the frontend, not typed) - same identity link
// self-registration already gets, so an admin adding someone else's entry
// doesn't leave it unattributed forever (see contestantsForNight()).
router.post('/admin/contestants', (req, res) => {
  const name = (req.body?.name || '').trim();
  const night = isNight(req.body?.night) ? req.body.night : DEFAULT_NIGHT;
  if (!name) return res.status(400).json({ error: 'err_name_missing' });
  let userId = null;
  if (req.body?.userId) {
    userId = Number(req.body.userId);
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(400).json({ error: 'err_user_invalid' });
    const taken = db.prepare(
      'SELECT id FROM contestants WHERE night = ? AND (user_id = ? OR partner_user_id = ?)'
    ).get(night, userId, userId);
    if (taken) return res.status(400).json({ error: 'err_already_registered_this_night' });
  }
  const info = db.prepare(
    "INSERT INTO contestants (name, night, user_id, confirmed_at) VALUES (?, ?, ?, datetime('now'))"
  ).run(name, night, userId);
  res.status(201).json({ id: info.lastInsertRowid, name, night });
});

// Same registration capability as /outfit/register (solo or teamed up with
// a partner), just usable from admin on someone else's behalf instead of
// only for yourself - reuses registerContestant() as-is rather than
// duplicating its rules (duplicate-entry checks, partner validation, the
// night having to actually be in "registration"), so an admin follows the
// exact same constraints a self-registering guest would.
// Any admin, not just the owner: fixing the roster is exactly the sort of
// thing a helper does on the night. Removing an entry stays owner-only.
router.post('/admin/contestants/register', (req, res) => {
  const night = isNight(req.body?.night) ? req.body.night : DEFAULT_NIGHT;
  const userId = Number(req.body?.userId);
  if (!userId) return res.status(400).json({ error: 'err_choose_user' });
  // autoConfirm: the organiser entering a pair themselves is a deliberate
  // act on both their behalfs - making them chase a guest's confirmation
  // would just block the person fixing the roster.
  // photoBase64 is optional here, unlike the guest-facing route: an
  // organiser fixing the roster may not have a photo of that person to
  // hand, and one can be attached afterwards via "mudar foto".
  const result = registerContestant(userId, night, req.body?.name || '', req.body?.partnerUserId, {
    autoConfirm: true,
    photoBase64: req.body?.photoBase64 || null,
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

// Renames a contestant (e.g. fixing a typo in a self-registered entry, or
// just reviewing/cleaning up submissions before opening voting).
router.patch('/admin/contestants/:id', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'err_name_missing' });
  if (name.length > 60) return res.status(400).json({ error: 'err_max_60_chars' });
  const info = db.prepare('UPDATE contestants SET name = ? WHERE id = ?').run(name, Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'err_contestant_not_found' });
  res.json({ ok: true });
});

router.delete('/admin/contestants/:id', requireOwner, (req, res) => {
  db.prepare('DELETE FROM contestants WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Settings (day-rollover hour used by A Rata - timezone is fixed to
// Europe/Lisbon, see getTimezone() in time.js, not user-configurable)
router.get('/admin/settings', (req, res) => {
  res.json({
    dayRolloverHour: Number(getSetting('day_rollover_hour', 6)),
  });
});

router.put('/admin/settings', (req, res) => {
  const { dayRolloverHour } = req.body || {};
  if (dayRolloverHour !== undefined) {
    const h = Number(dayRolloverHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) return res.status(400).json({ error: 'err_invalid_rollover_hour' });
    setSetting('day_rollover_hour', h);
  }
  res.json({ ok: true });
});

// Per-night voting control (Best Look): status + open / close / reset.
router.get('/admin/voting', (req, res) => {
  res.json({
    nights: NIGHTS.map((night) => ({
      night,
      status: nightStatus(night),
      resultsPhase: getResultsPhase(night),
      // Lets the admin panel tell "never run yet" apart from "closed after
      // running" - both report status 'closed' otherwise (see /votes/status).
      started: getSetting(`voting_started_${night}`) === '1',
      // Advisory only (see usersWithoutVoteCount()) - the admin panel warns
      // once before closing if this is nonzero, but nothing server-side
      // enforces it, since plenty of real nights close with some guests
      // never getting around to voting and that's fine.
      notVoted: usersWithoutVoteCount(night),
      // The denominator, so the panel can say "5 of 30" rather than a bare
      // count that means nothing without knowing how many were expected.
      eligibleVoters: eligibleVoterCount(),
      // Lets the admin panel show "tie-breaker round in progress" - whether
      // there IS a tie worth breaking is for the panel to work out from the
      // results it already fetches via GET /admin/votes (rank 1 and 2
      // sharing a vote count), not duplicated here.
      runoffActive: isRunoffActive(night),
      // The Miss Congeniality round runs on its own clock, after this one -
      // its phase plus the live standings, which an admin may see at any
      // point (guests only ever get the winner, and only once revealed).
      congenialityStatus: congenialityStatus(night),
      congenialityResults: congenialityResults(night),
      congenialityRunoffActive: isCongenialityRunoffActive(night),
    })),
  });
});

// Lowercase like every other piece of copy - these get interpolated
// into push bodies, which iOS renders itself, well outside the reach
// of the app's own body { text-transform: lowercase }.
const NIGHT_LABEL = { furnished: 'furnished', swamp: 'swamp' };

const CONGENIALITY_NOTIFY = {
  open: {
    pt: (n) => `miss congeniality: a votação abriu para a noite ${n}.`,
    en: (n) => `miss congeniality: voting is open for ${n} night.`,
  },
  revealed: {
    pt: (n) => `miss congeniality: já se sabe quem ganhou a noite ${n}.`,
    en: (n) => `miss congeniality: the winner for ${n} night is in.`,
  },
};

// Miss Congeniality's whole admin surface: open -> closed -> revealed, no
// staged reveal (unlike the outfit vote's /reveal-next above - there's a
// single winner here, so there's nothing to count down through).
router.post('/admin/voting/:night/congeniality', async (req, res) => {
  const { night } = req.params;
  const status = req.body?.status;
  // Whether a runoff is running has to be read before the status changes,
  // since closing is what ends one.
  const closingRunoff = status === 'closed' && isCongenialityRunoffActive(night);
  const result = setCongenialityStatus(night, status);
  if (result.error) return res.status(400).json(result);
  // Closing is what records what a runoff decided, exactly as it is for the
  // outfit vote - so an organiser cannot leave one half-finished by walking
  // away from a separate button.
  const settled = closingRunoff ? resolveCongenialityRunoff(night) : null;
  res.json({ ...result, ...(settled ? { runoffResolved: true, stillTied: !!settled.stillTied } : {}) });

  const notify = CONGENIALITY_NOTIFY[status];
  if (notify) {
    await broadcast({
      title: { pt: 'snatch', en: 'snatch' },
      body: { pt: notify.pt(NIGHT_LABEL[night]), en: notify.en(NIGHT_LABEL[night]) },
      tag: 'congeniality',
      url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
    });
  }
});

// Publishes the night's result to the Wall: podium + Miss Congeniality.
// Requires the top 3 to already be revealed - the Wall post is public to
// every guest, so publishing before the reveal would spoil the countdown
// the staged reveal exists for (and the photos it links to are gated on
// that same reveal state, see GET /outfit/contestants/:id/photo).
router.post('/admin/voting/:night/publish-podium', requireOwner, (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'err_invalid_night' });
  // The whole podium, not just the winner: the post carries all three, so
  // publishing at 'first' would freeze two blanks into it.
  const phase = getResultsPhase(night);
  if (phase !== 'all') {
    return res.status(400).json({ error: 'err_results_not_revealed' });
  }
  // Deliberately NOT "every eligible account has voted". Voting is closed
  // by the time the podium is revealed, so nobody can change the standings
  // any more - and on a real night somebody always never gets around to
  // voting, which under that rule would make the post unpublishable
  // forever. Closed plus fully revealed is the same guarantee without the
  // trap: whatever is on screen is final.
  // Both rounds have to be finished, not just the outfit one: the post
  // carries the congeniality winner alongside the podium, so publishing
  // mid-round would either spoil it or freeze a half-counted result into a
  // snapshot that cannot be rewritten. Deliberately keyed on whether that
  // round is actually running rather than on "is it revealed" - a night
  // where congeniality was never opened has no votes and nothing to wait
  // for, and must still be publishable.
  const congStatus = congenialityStatus(night);
  const congVotes = congenialityResults(night).reduce((n, r) => n + r.votes, 0);
  if (congStatus === 'open' || (congStatus === 'closed' && congVotes > 0)) {
    return res.status(400).json({ error: 'err_congeniality_not_revealed' });
  }

  // An unsettled tie must not be frozen into the post. Publishing it would
  // put two people in the same place on the Wall with no way to tell the
  // story afterwards - and the whole reason ties are now visible is so one
  // gets broken first. Refused with a reason rather than silently, because
  // a button that does nothing is the complaint this app has had before.
  const standings = resultsForNight(night);
  const unsettled = standings.find((r) => r.tied && r.rank <= 3);
  if (unsettled) {
    return res.status(400).json({ error: 'err_tie_unresolved', rank: unsettled.rank });
  }

  const podium = standings
    .filter((r) => r.rank <= 3)
    .map((r) => ({
      rank: r.rank, id: r.id, name: r.name, votes: r.votes,
      hasPhoto: r.hasPhoto, registeredBy: r.registeredBy, partnerName: r.partnerName,
    }));
  if (podium.length === 0) return res.status(400).json({ error: 'err_no_results' });

  const winner = congenialityWinner(night);
  const result = createPodiumPost(req.user.id, { night, podium, congeniality: winner });
  res.status(201).json(result);
});

// Miss Congeniality's tie-breaker, the same gesture as the outfit vote's
// /runoff above: needs the round closed and a real tie, reopens voting
// between only the tied people, and is settled by closing it again. Without
// a `rank` in the body it takes the highest unresolved tie.
router.post('/admin/voting/:night/congeniality/runoff', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'err_invalid_night' });
  const result = startCongenialityRunoff(night, req.body?.rank ?? null);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true, night, congenialityStatus: 'open', rank: result.rank, userIds: result.userIds });
  await broadcast({
    title: { pt: 'snatch', en: 'snatch' },
    body: {
      pt: `miss congeniality: houve um empate na noite ${NIGHT_LABEL[night]}, vota outra vez!`,
      en: `miss congeniality: it's a tie on ${NIGHT_LABEL[night]} night, vote again!`,
    },
    tag: 'congeniality',
    url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
  });
});

router.post('/admin/voting/:night/congeniality/reset', (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'err_invalid_night' });
  resetCongeniality(night);
  res.json({ ok: true, night });
});

// Wipes the votes but leaves the round open, same shape as the outfit vote's
// own /reset above - "everyone vote again" rather than "shut it all down".
router.post('/admin/voting/:night/congeniality/reset-votes', (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'err_invalid_night' });
  resetCongenialityVotes(night);
  res.json({ ok: true, night, congenialityStatus: 'open' });
});

// Opens registration: contestants can self-enter (see POST /outfit/register).
// Voting options stay hidden from everyone until the admin explicitly moves
// on to /open, once they've reviewed/cleaned up the submissions. Wipes any
// votes already cast - reopening registration means a new round is starting
// (maybe a new contestant joins, maybe it's a full redo), so votes tied to
// the previous roster would otherwise linger and skew a later re-tally.
// Contestants themselves are untouched - the admin edits/removes those
// directly in the Contestants table.
router.post('/admin/voting/:night/registration', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'err_invalid_night' });
  db.prepare('DELETE FROM votes WHERE night = ?').run(night);
  clearRunoff(night);
  resetCongeniality(night);
  setSetting(`voting_status_${night}`, 'registration');
  setSetting(`voting_started_${night}`, '1');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'registration' });
  await broadcast({
    title: { pt: 'snatch', en: 'snatch' },
    body: { pt: `as inscrições para a noite ${NIGHT_LABEL[night]} estão abertas!`, en: `entries for ${NIGHT_LABEL[night]} night are open!` },
    tag: 'outfit-registration',
    url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
  });
});

router.post('/admin/voting/:night/open', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'err_invalid_night' });
  // Opening the voting locks the roster, so a duo entry whose named
  // partner never confirmed is stranded - it isn't on the voting list and
  // can't be confirmed any more. Warn once with the count and let the
  // owner decide (force), same as closing does for pending votes.
  const pendingEntries = pendingContestantCount(night);
  if (pendingEntries > 0 && !req.body?.force) {
    return res.status(409).json({ error: 'err_pending_duo_entries', pending: pendingEntries });
  }
  // Everyone who can vote should also be in the running - a guest left off
  // the roster spends the night voting on other people's looks with none of
  // their own in it, and by the time anyone notices the vote is under way.
  // A duo counts as the two people in it. Warned rather than blocked, and
  // overridable like the check above: some nights someone genuinely sits it
  // out, and that is the organiser's call, not the app's.
  const entered = enteredPeopleCount(night);
  const expected = eligibleVoterCount();
  if (entered < expected && !req.body?.force) {
    return res.status(409).json({ error: 'err_not_everyone_entered', entered, expected });
  }
  setSetting(`voting_status_${night}`, 'open');
  setSetting(`voting_started_${night}`, '1');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'open' });
  await broadcast({
    title: { pt: 'snatch', en: 'snatch' },
    body: { pt: `a votação da noite ${NIGHT_LABEL[night]} está aberta!`, en: `voting for ${NIGHT_LABEL[night]} night is open!` },
    tag: 'outfit-voting',
    url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
  });
});

// Closing just stops voting - it does NOT reveal anything yet. The admin
// reveals results in stages afterwards via /reveal-next.
router.post('/admin/voting/:night/close', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'err_invalid_night' });
  // A duo proposal nobody confirmed never counted and never will, so
  // closing quietly strands it. Warn once with the count and let the
  // owner decide (force) rather than either silently dropping them or
  // blocking the close outright - they may well be chasing the last
  // couple around the party, or may not care.
  const pending = pendingVoteCount(night);
  if (pending > 0 && !req.body?.force) {
    return res.status(409).json({ error: 'err_pending_duo_votes', pending });
  }
  setSetting(`voting_status_${night}`, 'closed');
  // Closing a runoff is what records what it decided. Doing it here rather
  // than behind a separate button means an organiser cannot leave a runoff
  // half-finished - closing the vote is the same gesture either way.
  const settled = isRunoffActive(night) ? resolveRunoff(night) : null;
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'closed', ...(settled ? { runoffResolved: true, stillTied: !!settled.stillTied } : {}) });
  await broadcast({
    title: { pt: 'snatch', en: 'snatch' },
    body: { pt: `a votação da noite ${NIGHT_LABEL[night]} fechou, os resultados vêm aí.`, en: `voting for ${NIGHT_LABEL[night]} night is closed, results coming soon.` },
    tag: 'outfit-closed',
    url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
  });
});

const REVEAL_NOTIFY = {
  third: { pt: 'já sabes quem ficou em 3º lugar!', en: 'the 3rd place result is in!' },
  second: { pt: 'já sabes quem ficou em 2º lugar!', en: 'the 2nd place result is in!' },
  first: { pt: 'já sabes quem ficou em 1º lugar!', en: 'the 1st place result is in!' },
  all: { pt: 'já podes ver quem ganhou o snatch!', en: 'you can now see who won snatch!' },
};

// Advances the results reveal one stage: hidden -> third -> second -> first
// -> all. Every stage past 'hidden' is worth telling people about - that's
// the whole point of staging it like an awards countdown.
router.post('/admin/voting/:night/reveal-next', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'err_invalid_night' });
  const phase = advanceResultsPhase(night);
  res.json({ ok: true, night, resultsPhase: phase });
  if (REVEAL_NOTIFY[phase]) {
    await broadcast({
      title: { pt: 'snatch', en: 'snatch' },
      body: REVEAL_NOTIFY[phase],
      tag: 'results',
      url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
    });
  }
});

// Reset voting: wipes this night's votes and reopens voting, but keeps the
// contestant roster - for redoing a vote without making everyone re-enter.
router.post('/admin/voting/:night/reset', (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'err_invalid_night' });
  db.prepare('DELETE FROM votes WHERE night = ?').run(night);
  clearRunoff(night);
  // Congeniality runs off the back of this round, so restarting the round
  // restarts it too - a winner from the previous run-through would
  // otherwise stay revealed against a vote that no longer exists.
  resetCongeniality(night);
  setSetting(`voting_status_${night}`, 'open');
  setSetting(`voting_started_${night}`, '1');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'open' });
});

// Reset all: wipes the contestant roster too (cascades to votes), and
// returns the night to its never-started state - a true blank slate, for
// when the whole night needs redoing from scratch, entries included.
router.post('/admin/voting/:night/reset-all', (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'err_invalid_night' });
  db.prepare('DELETE FROM contestants WHERE night = ?').run(night);
  clearRunoff(night);
  resetCongeniality(night);
  setSetting(`voting_status_${night}`, 'closed');
  setSetting(`voting_started_${night}`, '0');
  resetResultsPhase(night);
  res.json({ ok: true, night, votingStatus: 'closed' });
});

// Tie-breaker: a fresh round of voting scoped to just the contestants tied
// at one place - any place, not only first. Without a `rank` in the body it
// takes the highest unresolved tie, which is what an organiser means when
// they just press the button. See startRunoff() in votes.js for the rule
// (needs voting closed, needs a real tie). Broadcasts the same way opening
// voting normally does, so guests know to come back and vote again.
router.post('/admin/voting/:night/runoff', async (req, res) => {
  const { night } = req.params;
  if (!isNight(night)) return res.status(404).json({ error: 'err_invalid_night' });
  const result = startRunoff(night, req.body?.rank ?? null);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true, night, votingStatus: 'open', rank: result.rank, contestantIds: result.contestantIds });
  await broadcast({
    title: { pt: 'snatch', en: 'snatch' },
    body: {
      pt: `houve um empate na noite ${NIGHT_LABEL[night]}, vota outra vez!`,
      en: `it's a tie on ${NIGHT_LABEL[night]} night, vote again!`,
    },
    tag: 'outfit-voting',
    url: `/?tab=outfit&night=${encodeURIComponent(night)}`,
  });
});

/* ------------------------------- Admin: Memo ------------------------------ */

const memoRecapStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = join(MEMO_DIR, req.params.day);
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `recap${extForMime(file.mimetype)}`),
});
// Video-only - the recap is explicitly a video for everyone to watch/
// download, unlike the guest slots which accept either photo or video.
const memoRecapUpload = multer({
  storage: memoRecapStorage,
  limits: { fileSize: MEMO_MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('video/')),
});

router.get('/admin/memo/days', (req, res) => {
  if (process.env.ENABLE_MEMO !== 'true') return res.status(404).json({ error: 'err_not_found' });
  res.json({ days: listDays() });
});

// Lighter than the outfit photos.zip route above: yazl's addFile() streams
// straight from disk instead of having to pull every BLOB into memory
// first, since these files already live on disk rather than in SQLite.
router.get('/admin/memo/:day/uploads.zip', (req, res) => {
  if (process.env.ENABLE_MEMO !== 'true') return res.status(404).json({ error: 'err_not_found' });
  const uploads = listUploadsForDay(req.params.day);
  if (!uploads.length) return res.status(404).json({ error: 'err_memo_no_uploads' });
  const zip = new ZipFile();
  const usedNames = new Set();
  for (const u of uploads) {
    const abs = join(MEMO_DIR, u.file_path);
    if (!existsSync(abs)) continue;
    const ext = extForMime(u.mime_type);
    // Lowercased for the same reason as the Snatch zip above.
    const base = u.user_name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'sem-nome';
    let filename = `${base}-momento${u.slot_id}${ext.toLowerCase()}`;
    if (usedNames.has(filename)) filename = `${base}-momento${u.slot_id}-${u.id}${ext.toLowerCase()}`;
    usedNames.add(filename);
    zip.addFile(abs, filename);
  }
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="memo-${req.params.day}.zip"`);
  zip.outputStream.pipe(res);
  zip.end();
});

router.post('/admin/memo/:day/recap', (req, res) => {
  if (process.env.ENABLE_MEMO !== 'true') return res.status(404).json({ error: 'err_not_found' });
  memoRecapUpload.single('file')(req, res, (err) => {
    if (err) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 'err_memo_file_too_large' : 'err_memo_upload_failed';
      return res.status(400).json({ error: code });
    }
    if (!req.file) return res.status(400).json({ error: 'err_memo_invalid_type' });
    saveRecap(req.params.day, req.user.id, {
      mimeType: req.file.mimetype,
      filePath: relative(MEMO_DIR, req.file.path),
      fileSize: req.file.size,
    });
    res.status(201).json({ ok: true });
  });
});

// Builds the day's video from its photos (1s each) and stores it as that
// day's recap, which is what the Wall video player already reads (see
// loadWallVideo() in app.js) - so generating it *is* publishing it. Kept
// separate from the manual upload route above rather than replacing it:
// this one takes no file at all.
// Stitching a day's photos into a video is minutes of work, not seconds -
// and it used to happen inside this request. Nothing in the code was wrong;
// the request simply outlived the proxy in front of it, which cuts at 100
// seconds and hands the browser a 524. From the admin's side that is
// indistinguishable from "the button is broken", which is exactly how it
// was reported.
//
// So the encode is started and the request returns immediately. A day with
// a hundred photos is a hundred seconds of video and would never have fit
// inside any HTTP timeout, however fast the machine - this is not a
// workaround for a slow box, it is where the work belongs.
//
// State lives in memory on purpose. A restart loses the fact that a job was
// running, and that is the correct amount of bookkeeping for something whose
// real completion signal is a row in memo_recaps: the days list already
// reports hasRecap, so a lost job shows up as "still no video" and the
// button can simply be pressed again.
const recapJobs = new Map(); // day -> { status: 'running' | 'failed', error }

router.post('/admin/memo/:day/recap/generate', (req, res) => {
  if (process.env.ENABLE_MEMO !== 'true') return res.status(404).json({ error: 'err_not_found' });
  const day = req.params.day;
  if (recapJobs.get(day)?.status === 'running') {
    return res.status(409).json({ error: 'err_memo_recap_running' });
  }
  // The one check worth doing before answering: an empty day is an instant,
  // certain failure, and telling someone "started" only to fail silently a
  // moment later is worse than refusing up front.
  if (!dayHasPhotos(day)) return res.status(400).json({ error: 'err_memo_no_photos' });

  recapJobs.set(day, { status: 'running' });
  res.status(202).json({ started: true });

  const userId = req.user.id;
  buildDayRecapVideo(day)
    .then((built) => {
      if (built.error) {
        recapJobs.set(day, { status: 'failed', error: built.error });
        return;
      }
      saveRecap(day, userId, built);
      // Publishing means it shows up on the Wall as a post, so it can be
      // pinned or removed there like anything else.
      createVideoPost(userId, day);
      recapJobs.delete(day);
    })
    .catch((e) => {
      recapJobs.set(day, { status: 'failed', error: e.message || 'err_memo_recap_failed' });
    });
});

// What the button polls while it waits. 'done' is answered from the stored
// recap rather than from the job map, so a finished video still reports done
// after a restart - the map only ever knows about work in flight.
router.get('/admin/memo/:day/recap/status', (req, res) => {
  if (process.env.ENABLE_MEMO !== 'true') return res.status(404).json({ error: 'err_not_found' });
  const day = req.params.day;
  const job = recapJobs.get(day);
  if (job?.status === 'running') return res.json({ status: 'running' });
  if (getRecap(day)) return res.json({ status: 'done', photoCount: countDayPhotos(day) });
  if (job?.status === 'failed') {
    recapJobs.delete(day);
    return res.json({ status: 'failed', error: job.error });
  }
  res.json({ status: 'idle' });
});

// Owner-only: opens the next scheduled moment right now instead of waiting
// for its random time, notifying exactly as the cron would (see the memo job
// in scheduler.js). Owner-only rather than admin because it pushes to real
// phones - not something to leave a stray tap away for anyone with an admin
// key.
// Any admin, for the same reason they can already reveal a rata
// consequence: both fire a push to everyone and both are the kind of nudge
// a helper gives while the party is running.
router.post('/admin/memo/trigger-next', async (req, res) => {
  if (process.env.ENABLE_MEMO !== 'true') return res.status(404).json({ error: 'err_not_found' });
  const result = triggerNextSlot();
  if (result.error) return res.status(400).json(result);
  res.json(result);

  const payload = {
    title: { pt: 'memo', en: 'memo' },
    body: {
      pt: 'é agora, tens 15 minutos para captar este momento.',
      en: "it's time, you have 15 minutes to capture this moment.",
    },
    tag: 'memo',
    url: '/?tab=memo',
  };
  if (memoOpenToEveryone()) {
    await broadcast(payload);
  } else {
    // Memo is still shut to guests (see memoAvailableTo()), so a broadcast
    // would ping people straight into a tab that 404s for them. Only the
    // admins who can actually open it get the push, which is what makes this
    // usable for testing on prod before the party.
    const admins = db.prepare('SELECT id FROM users WHERE is_admin = 1').all();
    for (const a of admins) await notifyUser(a.id, payload);
  }
});

// Owner-only, same golden rule as every other feature's wipe switch - but
// this one also has to unlink the actual files (see wipeAll() in memo.js),
// unlike the DB-BLOB-based wipes above where deleting the row is enough.
router.post('/admin/memo/wipe', requireOwner, (req, res) => {
  wipeAllMemo();
  res.json({ ok: true });
});

export default router;
