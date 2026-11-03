import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NIGHTS } from './nights.js';
import { hashToken, encryptToken, decryptToken } from './tokens.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Database path (configurable for tests via DB_FILE).
const DB_FILE = process.env.DB_FILE || join(__dirname, '..', 'data', 'app.sqlite');
if (DB_FILE !== ':memory:') mkdirSync(dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_enc  TEXT NOT NULL,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    tutorial_seen INTEGER NOT NULL DEFAULT 0,
    lang TEXT NOT NULL DEFAULT 'pt',
    wall_pseudonym TEXT,
    key_claimed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS consequences (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    day        TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    revealed_at TEXT,
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    done_at TEXT,
    approved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );
  -- A user can only suggest one consequence per day
  CREATE UNIQUE INDEX IF NOT EXISTS idx_consequence_user_day
    ON consequences(user_id, day);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint     TEXT NOT NULL UNIQUE,
    subscription TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Ephemeral open chat ("the Wall"): only the 20 most recent messages are
  -- ever kept (see src/chat.js). user_id is kept for internal reference
  -- only - the API never exposes the real author, just a random
  -- pseudonym assigned per message (the "pseudonym" column).
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    pseudonym  TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

  -- Every pseudonym a user has ever had on the Wall, oldest first - not
  -- just the current one. The owner's "who's who" view lists all of them,
  -- since a re-rolled pseudonym doesn't erase the old one's messages.
  CREATE TABLE IF NOT EXISTS wall_pseudonym_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pseudonym  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

  -- Plaza feed: owner/admin-authored posts, most-recent-first. 'announcement'
  -- is a plain one (wifi password, house rules, release notes); 'poll' adds
  -- options for everyone to vote on (e.g. picking a dinner spot). Either
  -- type can be pinned (pinned_at set) - owner-only, see pinPlazaPost() in
  -- plaza.js. Pinned ones float to the top of the feed, most-recently-
  -- pinned first; multiple can be pinned at once.
  CREATE TABLE IF NOT EXISTS plaza_posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    pinned_at  TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

  CREATE TABLE IF NOT EXISTS plaza_poll_options (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id  INTEGER NOT NULL REFERENCES plaza_posts(id) ON DELETE CASCADE,
    label    TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

  -- A "links" post is a titled list of pointers out of the app - the form,
  -- the playlist, the shared album. Its own table rather than reusing
  -- plaza_poll_options: an option is a thing you vote for and a link is a
  -- thing you follow, and only one of the two needs a URL.
  CREATE TABLE IF NOT EXISTS plaza_link_items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id  INTEGER NOT NULL REFERENCES plaza_posts(id) ON DELETE CASCADE,
    emoji    TEXT NOT NULL DEFAULT '',
    label    TEXT NOT NULL,
    url      TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

  -- One row per (user, post), enforced below - a vote is final, so
  -- castPlazaVote() in plaza.js rejects any second attempt rather than
  -- moving this row to a new option.
  CREATE TABLE IF NOT EXISTS plaza_poll_votes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL REFERENCES plaza_posts(id) ON DELETE CASCADE,
    option_id  INTEGER NOT NULL REFERENCES plaza_poll_options(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_plaza_vote_user_post
    ON plaza_poll_votes(user_id, post_id);
`);

/** Checks whether a column exists in a table. */
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

// Migration: plain-text tokens -> encrypted/indexed.
// Older databases stored the 'token' column in plain text. We now store
// 'token_hash' (login index) and 'token_enc' (encrypted, so the admin can see
// the key). The table is rebuilt to drop the plain-text column.
if (columnExists('users', 'token') && !columnExists('users', 'token_hash')) {
  const rows = db.prepare('SELECT id, name, token, is_admin, created_at FROM users').all();
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  db.exec(`
    CREATE TABLE users_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_enc  TEXT NOT NULL,
      is_admin   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const ins = db.prepare(
    'INSERT INTO users_new (id, name, token_hash, token_enc, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    ins.run(r.id, r.name, hashToken(r.token), encryptToken(r.token), r.is_admin, r.created_at);
  }
  db.exec('DROP TABLE users');
  db.exec('ALTER TABLE users_new RENAME TO users');
  db.exec('COMMIT');
  db.exec('PRAGMA foreign_keys = ON');
}

// Migration: mark the master admin (owner). Never demotable, unlike admins
// promoted later via the admin panel. For databases seeded before this
// column existed, backfill it onto whichever admin was created first.
if (!columnExists('users', 'is_owner')) {
  db.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0');
  const firstAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1').get();
  if (firstAdmin) {
    db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(firstAdmin.id);
  }
}

// Migration: track when a user's role last changed, so Manage Users can
// surface recently created/promoted users above the rest.
// SQLite forbids a non-constant DEFAULT on ALTER TABLE ADD COLUMN (only
// CREATE TABLE allows one), so this adds it with a constant placeholder
// and backfills real values immediately after. Every INSERT elsewhere sets
// updated_at explicitly, so the column's post-migration default is never
// relied on for new rows.
if (!columnExists('users', 'updated_at')) {
  db.exec("ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
  db.exec('UPDATE users SET updated_at = created_at');
}

// Migration: whether a user has been shown the first-session onboarding
// tutorial yet. 0 is a constant, so a plain ALTER TABLE is fine here.
if (!columnExists('users', 'tutorial_seen')) {
  db.exec('ALTER TABLE users ADD COLUMN tutorial_seen INTEGER NOT NULL DEFAULT 0');
}

// Migration: a photo attached to a Wall post. Stored as a BLOB beside the
// post rather than as a file on the volume, which is the same choice Snatch
// entry photos made and for the same reason: a handful of admin-published
// images is not worth a second storage path to back up, wipe and serve. If
// Wall posts ever become something guests write, revisit that - the volume
// is where a hundred of these would belong.
if (!columnExists('plaza_posts', 'photo')) {
  db.exec('ALTER TABLE plaza_posts ADD COLUMN photo BLOB');
  db.exec('ALTER TABLE plaza_posts ADD COLUMN photo_mime TEXT');
}

// Migration: last language a user selected in the app, so push notifications
// can be sent in their own language instead of a fixed default.
if (!columnExists('users', 'lang')) {
  db.exec("ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'pt'");
}

// Migration: the Wall's per-message pseudonym, replacing the real author
// (mirrors users.wall_pseudonym at post time). Existing (soon-to-be-pruned
// anyway, since the Wall only ever keeps 20 messages) rows just get an
// empty one until they age out.
if (!columnExists('messages', 'pseudonym')) {
  db.exec("ALTER TABLE messages ADD COLUMN pseudonym TEXT NOT NULL DEFAULT ''");
}

// Migration: a stable per-user Wall pseudonym (assigned lazily on first
// post - see getOrAssignPseudonym() in chat.js), replacing what used to
// be a fresh random one on every single message. Nullable: most users
// never post, so there's nothing to assign until they do.
if (!columnExists('users', 'wall_pseudonym')) {
  db.exec('ALTER TABLE users ADD COLUMN wall_pseudonym TEXT');
}

// Migration: the "day" (per time.js's today(), same concept as A Rata's
// one-suggestion-per-day limit) a pseudonym was last deliberately re-rolled
// via POST /admin/users/:id/wall-pseudonym/reset - lets that be limited to
// once a day. It should stay stable most of the time (that's the whole
// point of a Wall pseudonym), just occasionally refreshable.
if (!columnExists('users', 'wall_pseudonym_reset_day')) {
  db.exec('ALTER TABLE users ADD COLUMN wall_pseudonym_reset_day TEXT');
}

// Migration: backfills wall_pseudonym_history for anyone who already had a
// pseudonym before that table existed - otherwise their current one would
// never show up in the owner's "who's who" history. Idempotent: only
// inserts for a user once, safe to run on every boot.
db.exec(`
  INSERT INTO wall_pseudonym_history (user_id, pseudonym, created_at)
  SELECT u.id, u.wall_pseudonym, u.updated_at
  FROM users u
  WHERE u.wall_pseudonym IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM wall_pseudonym_history h WHERE h.user_id = u.id)
`);

// Migration: tracks whether a user has ever retrieved their key - via a
// real login (see authenticate() in auth.js) or via the first-time
// name-search flow (see keyClaim.js). NULL means still eligible for that
// flow. Only the owner is backfilled as already-claimed here (they set
// the app up themselves and must never be searchable) - every other
// pre-existing account is left NULL/searchable rather than assumed
// already-handled, since there's no reliable way to tell who actually
// got their key already vs who's still waiting (a prior version of this
// migration blanket-stamped every user, which silently broke the search
// for guests who'd been pre-created but never actually given their key -
// caught on 2026-07-27 when a whole prod guest list came back unsearchable).
if (!columnExists('users', 'key_claimed_at')) {
  db.exec('ALTER TABLE users ADD COLUMN key_claimed_at TEXT');
  // The owner is no longer stamped as pre-claimed here - they retrieve
  // their key through the same first-time flow as everyone else now.
}

// Migration: per-day voting -> per-night voting.
// Older databases had contestants/votes with a 'day' column. Voting is now per
// night (furnished/swamp), so the old tables are dropped (voting data is
// ephemeral per edition). The new tables are created right after with the
// per-night schema.
if (columnExists('contestants', 'day') && !columnExists('contestants', 'night')) {
  db.exec(`
    DROP TABLE IF EXISTS votes;
    DROP TABLE IF EXISTS contestants;
  `);
}

// Per-night voting tables (created after the migration).
db.exec(`
  -- Contestants per night (Best Look). 'night' identifies the night/theme.
  CREATE TABLE IF NOT EXISTS contestants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    night      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Votes per night. A user votes once per night.
  CREATE TABLE IF NOT EXISTS votes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contestant_id INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
    night         TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_vote_user_night
    ON votes(user_id, night);

  -- Miss Congeniality: a second, separate vote per night, run after the
  -- outfit vote closes. Unlike votes above (cast for a contestant *entry*,
  -- which can be a duo), this one is always cast for an individual person,
  -- so it targets a user directly.
  CREATE TABLE IF NOT EXISTS congeniality_votes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    night          TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_congeniality_user_night
    ON congeniality_votes(user_id, night);
`);

// Migration: self-registered contestants (Best Look). A contestant can
// optionally be linked to the user(s) who entered themselves - solo
// (user_id only) or as a duo (user_id + partner_user_id), so the app can
// stop someone entering twice and can merge a duo's voting rights into one
// shared vote per night (see registerContestant()/castVote() in votes.js).
// Admin-added contestants (the original flow) leave both columns NULL.
if (!columnExists('contestants', 'user_id')) {
  db.exec('ALTER TABLE contestants ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}
if (!columnExists('contestants', 'partner_user_id')) {
  db.exec('ALTER TABLE contestants ADD COLUMN partner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contestant_user_night
    ON contestants(user_id, night) WHERE user_id IS NOT NULL;
`);

// Migration: a duo's single shared vote is now a two-step approval - one
// partner proposes it, the other has to confirm on their own account
// before it counts. NULL confirmed_at means "proposed, waiting on the
// partner" and is excluded from every tally; a solo voter's row is
// confirmed the instant it's cast, so nothing changes for them. Same
// two-nullable-timestamps shape as consequences' done_at/approved_at.
// Rows that predate this were already final by the old rules, so they're
// backfilled as confirmed rather than silently reverting to pending.
if (!columnExists('votes', 'confirmed_at')) {
  db.exec('ALTER TABLE votes ADD COLUMN confirmed_at TEXT');
  db.exec('UPDATE votes SET confirmed_at = created_at');
}

// Migration: same two-step rule for the entry itself - you can't put
// someone in a duo without them agreeing to it, so a self-registered duo
// stays unconfirmed (and out of the voting list) until the named partner
// signs off on their own account. Solo entries, and anything an admin
// creates on someone's behalf, are confirmed on the spot. Existing rows
// predate the rule and were already live entries, so they're backfilled
// as confirmed rather than vanishing from the roster.
if (!columnExists('contestants', 'confirmed_at')) {
  db.exec('ALTER TABLE contestants ADD COLUMN confirmed_at TEXT');
  db.exec('UPDATE contestants SET confirmed_at = created_at');
}

// Migration: a photo of the outfit, attached to the entry (not the user) -
// captured at registration since it has to match the specific night's
// costume, and shared by both halves of a duo rather than doubled up (see
// registerContestant()/replaceContestantPhoto() in votes.js). Required for
// a guest's own self-registration, but existing rows and admin/organiser
// entries can go without one - stored as a plain BLOB since the volume
// (dozens of small JPEGs) doesn't justify external storage.
if (!columnExists('contestants', 'photo')) {
  db.exec('ALTER TABLE contestants ADD COLUMN photo BLOB');
  db.exec('ALTER TABLE contestants ADD COLUMN photo_mime TEXT');
}

// Migration: owner-only pinning for Plaza announcements (renamed from
// "note"). NULL means not pinned; a timestamp both flags it and orders
// multiple pins by most-recently-pinned first.
if (!columnExists('plaza_posts', 'pinned_at')) {
  db.exec('ALTER TABLE plaza_posts ADD COLUMN pinned_at TEXT');
}

// The emoji started out typed into the label; it is its own field now, so
// the picker can offer one and the name stays plain text.
if (!columnExists('plaza_link_items', 'emoji')) {
  db.exec("ALTER TABLE plaza_link_items ADD COLUMN emoji TEXT NOT NULL DEFAULT ''");
}

// Migration: who's actually holding the rata for a given consequence, set
// by the owner after the fact (they have to look around the party and see
// who has it at the moment it's revealed - nothing about this can be
// inferred automatically). Separate from user_id, which is whoever
// suggested the consequence, not who has to do it.
if (!columnExists('consequences', 'assigned_user_id')) {
  db.exec('ALTER TABLE consequences ADD COLUMN assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}

// Migration: two-step completion tracking - done_at is the assigned
// user's own self-report ("I did it"), approved_at is the owner
// confirming it actually happened. Kept as two separate nullable
// timestamps (not a single status enum) to match revealed_at/pinned_at's
// pattern, and because approved_at implies done_at but not vice versa.
if (!columnExists('consequences', 'done_at')) {
  db.exec('ALTER TABLE consequences ADD COLUMN done_at TEXT');
}
if (!columnExists('consequences', 'approved_at')) {
  db.exec('ALTER TABLE consequences ADD COLUMN approved_at TEXT');
}

// Migration: when the assignment last changed. assigned_user_id alone
// records who, never when, so the admin history - which sorts by the most
// recent of these timestamps - had no way to see that a row had just been
// assigned, and a fresh assignment stayed wherever it already was.
// Deliberately not backfilled: there is no honest value for assignments
// made before this column existed, and revealed_at already stands in.
if (!columnExists('consequences', 'assigned_at')) {
  db.exec('ALTER TABLE consequences ADD COLUMN assigned_at TEXT');
}

// Migration: persist the customized logo state (triple-click "appdoivo" to
// swap to "appde<firstname>") across app close/reopen. Defaults to false
// (the vanilla "appdoivo" logo).
if (!columnExists('users', 'logo_customized')) {
  db.exec('ALTER TABLE users ADD COLUMN logo_customized INTEGER NOT NULL DEFAULT 0');
}

/** Strips a name down to the plain-ASCII, lowercase base used by every token. */
function tokenBase(name) {
  return String(name)
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') || 'user';
}

/**
 * Generates a memorable per-user token: their name plus a random 6-digit
 * suffix (e.g. "rito874912"), easier to type/remember than an opaque string.
 * Six digits, not four: a name is easy to know, so the digits are all that
 * stand between a stranger and the account (a million tries, not 10,000).
 * Anyone can change theirs to something easier in Settings.
 * Retries on the rare collision (checked via the token's lookup hash).
 */
// Memo: 5x/day, at the same random moments for every guest (like BeReal), a
// push notification asks everyone to upload a photo/video within a 15-minute
// window ("slot"). The actual file lives on disk (see MEMO_DIR in memo.js),
// not as a BLOB here - at original-size photos/video across every guest,
// that's an entirely different scale than the small resized-JPEG BLOBs the
// outfit-entry photos use, so only metadata (path, size, mime, timestamps)
// is stored in SQLite.
//
// Pre-launch schema change: slots used to be per-user independent
// (UNIQUE(user_id, day, slot_index)) - switched to one shared schedule per
// day (UNIQUE(day, slot_index)) instead, so every guest is notified
// together, same as the real thing. Memo has never shipped to prod and QA's
// DB is ephemeral by design, so old per-user rows are simply dropped rather
// than migrated - nothing real to preserve yet.
if (columnExists('memo_slots', 'user_id')) {
  db.exec('DROP TABLE IF EXISTS memo_uploads; DROP TABLE IF EXISTS memo_slots;');
}
db.exec(`
  -- One message per guest to the birthday person, private to them: nobody
  -- else sees these, not other guests and not other admins, which is the
  -- whole point of writing one. UNIQUE on user_id because it is a message
  -- rather than a thread - people rewrite theirs rather than adding a
  -- second, and one each is what makes the printed collection readable.
  CREATE TABLE IF NOT EXISTS dedications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

  CREATE TABLE IF NOT EXISTS memo_slots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    day          TEXT NOT NULL,
    slot_index   INTEGER NOT NULL,
    scheduled_at TEXT NOT NULL,
    notified_at  TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    UNIQUE(day, slot_index)
  );

  CREATE TABLE IF NOT EXISTS memo_uploads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_id     INTEGER NOT NULL REFERENCES memo_slots(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    kind        TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    file_size   INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    UNIQUE(slot_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS memo_reactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id   INTEGER NOT NULL REFERENCES memo_uploads(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    UNIQUE(upload_id, user_id)
  );

  -- Guest- and admin-written text, rendered in whichever language the
  -- reader picked. One row per (thing, field, language) rather than a pair
  -- of text_pt/text_en columns on each table: the same mechanism then
  -- covers consequences, Wall posts, poll options and link labels, and a
  -- third language is rows rather than another migration.
  --
  -- The status column is how a failure stays quiet. 'ok' has text; 'pending' is
  -- queued; 'failed' has been tried and will not be retried past a couple
  -- of attempts. Only 'ok' is ever shown, and a reader with no usable row
  -- sees the original - so a missing API key, a refusal, or a dead network
  -- degrades to exactly the app's behaviour before this feature existed.
  CREATE TABLE IF NOT EXISTS translations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER NOT NULL,
    field       TEXT NOT NULL,
    lang        TEXT NOT NULL,
    text        TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );

  -- One row per thing-and-language; a re-translation replaces rather than
  -- accumulates (see upsert in translations.js).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_target
    ON translations(entity_type, entity_id, field, lang);

  CREATE TABLE IF NOT EXISTS memo_recaps (
    day         TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    file_size   INTEGER NOT NULL,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
  );
`);

// Migration: which round of voting a ballot belongs to. 0 is the night's
// real vote; 1 and up are tie-breaker runoffs.
//
// Without this a runoff had nowhere to put its ballots, so startRunoff()
// deleted every vote for the night and reopened - which settled the tie and
// destroyed every placing below it in the same stroke. Keeping rounds apart
// means a runoff for 2nd cannot touch who won, and the night's real tally
// survives being tie-broken.
//
// The uniqueness rule moves with it: one vote per person per night becomes
// one vote per person per night PER ROUND, or nobody could vote in a runoff
// having already voted in the night proper.
if (!columnExists('votes', 'round')) {
  db.exec('ALTER TABLE votes ADD COLUMN round INTEGER NOT NULL DEFAULT 0');
  db.exec('DROP INDEX IF EXISTS idx_vote_user_night');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_vote_user_night_round ON votes(user_id, night, round)');
}

// Migration: the same round column for Miss Congeniality, for the same
// reason. That round had no tie-breaker at all - equal votes were sorted by
// name and the alphabet quietly crowned one of them - so it never needed
// somewhere to keep a second ballot. Now that it runs a runoff like the
// outfit vote does, its ballots have to be kept apart by round too, and the
// one-vote-per-person rule becomes one per person per night per round.
if (!columnExists('congeniality_votes', 'round')) {
  db.exec('ALTER TABLE congeniality_votes ADD COLUMN round INTEGER NOT NULL DEFAULT 0');
  db.exec('DROP INDEX IF EXISTS idx_congeniality_user_night');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_congeniality_user_night_round ON congeniality_votes(user_id, night, round)');
}

// Migration: whether a photo should be shown mirrored.
//
// iOS's "Mirror Front Camera" setting applies to the Camera app and NOT to
// a web capture, so a selfie shot through Memo arrives un-mirrored while the
// same shot taken normally sits mirrored in the gallery. Which of the two a
// person wants is genuinely their call, and the file cannot answer it: the
// HEIC->JPEG conversion Safari does on upload strips make, model and lens,
// leaving only orientation. There is no way to tell a selfie from a group
// photo server-side, so there is nothing to detect and this is a choice
// rather than a fix.
//
// Stored as a flag and applied with a CSS transform when rendering, never by
// rewriting pixels - re-encoding a 2.5MB photo on a shared CPU to flip it is
// work this machine should not be doing, and it would be lossy every time
// somebody changed their mind.
if (!columnExists('memo_uploads', 'flipped')) {
  db.exec('ALTER TABLE memo_uploads ADD COLUMN flipped INTEGER NOT NULL DEFAULT 0');
}

// Migration: a fingerprint of the text a translation was made from. Without
// it, re-queueing an entity could not tell "this was edited, translate it
// again" apart from "this is the same sentence it always was", so it
// assumed the former and threw away work already paid for. On QA, where
// seedDemo re-queues the whole demo set on every boot, that meant buying
// the same translations again on every single deploy.
if (!columnExists('translations', 'source_hash')) {
  db.exec('ALTER TABLE translations ADD COLUMN source_hash TEXT');
}


export function generateUserToken(name) {
  const base = tokenBase(name);

  let token;
  do {
    const digits = String(randomInt(0, 1000000)).padStart(6, '0');
    token = `${base}${digits}`;
  } while (db.prepare('SELECT 1 FROM users WHERE token_hash = ?').get(hashToken(token)));

  return token;
}

/**
 * Deterministic variant for QA's demo-seed template (see seedDemo.js): the
 * same name always produces the same token across every reseed, since QA's
 * database resets on every deploy. Without this, a tester's access key
 * would change on every single deploy, forcing a re-send every time -
 * whereas prod's real users don't need this, their DB persists.
 */
export function generateDemoUserToken(name) {
  const base = tokenBase(name);
  let hash = 0;
  for (const ch of base) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const digits = String(hash % 10000).padStart(4, '0');
  return `${base}${digits}`;
}

/** Reads a setting with a default value. */
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

/** Writes/updates a setting. */
export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

/** Seeds settings and the admin (owner) user on first start. */
export function seed({ adminName }) {
  // Per-night voting status (closed by default).
  for (const night of NIGHTS) {
    if (getSetting(`voting_status_${night}`) === null) {
      setSetting(`voting_status_${night}`, 'closed');
    }
  }
  if (getSetting('day_rollover_hour') === null) setSetting('day_rollover_hour', 6);

  let admin = db.prepare('SELECT * FROM users WHERE is_admin = 1').get();
  if (!admin) {
    // Same generateUserToken() every regular user gets via POST /admin/users
    // - in every environment, no exceptions. This used to also accept an
    // ADMIN_TOKEN override outside production, which defeated the whole
    // point on QA (its DB is ephemeral, so it reseeds - and re-pins the
    // owner's real key to ADMIN_TOKEN's literal value - on every deploy):
    // the owner's actual stored key was silently the override's literal
    // value there, not a generated one. The QA quick-login (see
    // devLoginOwner() in auth.js) is a separate thing entirely: it resolves
    // a typed passphrase to the owner at lookup time and never touches what
    // is stored here, so the real key is always generated.
    const token = generateUserToken(adminName || 'Admin');
    // Left unclaimed, exactly like a guest, so the owner can pick their own
    // name out of the first-time key-retrieval flow (keyClaim.js) instead of
    // needing someone to read the key off the server for them. This used to
    // be pre-claimed deliberately, because that flow does zero identity
    // verification beyond a name match - see the security note on
    // searchUnclaimedUsers() for why that's a real trade-off here and why
    // claiming it promptly is what closes the window.
    const info = db.prepare(
      "INSERT INTO users (name, token_hash, token_enc, is_admin, is_owner, updated_at) VALUES (?, ?, ?, 1, 1, strftime('%Y-%m-%d %H:%M:%f', 'now'))"
    ).run(adminName || 'Admin', hashToken(token), encryptToken(token));
    admin = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    return { admin, created: true, token };
  }
  try {
    return { admin, created: false, token: decryptToken(admin.token_enc) };
  } catch {
    throw new Error(
      'TOKEN_SECRET does not match the one used to create the existing admin user, so their ' +
      'token cannot be read. Either restore the previous TOKEN_SECRET, or delete the admin row ' +
      "(DELETE FROM users WHERE is_admin = 1) so a new admin is reseeded."
    );
  }
}

export default db;
