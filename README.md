# lodge-app

**Lodge**, the party app (first called appdoivo, then Festa; renamed Lodge on 2026-11-06). Try the demo at **[lodge-demo.appdoivo.com](https://lodge-demo.appdoivo.com)**.

A private-party PWA (~50 guests) with four features, all behind one login:

1. **Wall** (internal name `plaza`) - the owner/admins post announcements or
   polls (2-6 options) for everyone to see. Posts can be pinned to the top.
   Publishing sends a push notification to the group.
2. **Rata** - each user suggests one "consequence" per day through a
   free-text form. Every 3 hours (14:00-02:00) a random pending consequence
   is drawn, everyone is notified, and it is removed from the draw. The
   owner can record who's actually holding the rata for the current
   consequence (only knowable by looking around the party).
3. **Snatch** (internal name `outfit`) - per-night outfit voting. This
   edition has two nights, each with its own name and aesthetic: Furnished
   and Swamp. A switch at the top selects the active night; changing it
   re-skins the whole page with that night's look (other tabs stay clean).
   Users can self-register their own persona (solo or as a duo). Each night
   is controlled manually by the admin (open registration, open voting,
   close, then reveal results in stages: 3rd -> 2nd -> 1st -> everyone).
   The nights are fixed per edition - to change year, edit `src/nights.js`
   (names/themes) and the `body.theme-*` classes in `public/css/styles.css`.
4. **Plaza** (internal name `chat`) - an open, ephemeral group chat. Every
   post is anonymous to everyone except the owner (each user gets a stable
   per-device pseudonym; the owner alone can see who's behind it). Keeps
   only the 15 most recent messages, no time-based expiry.

Login is by a unique access key per user (a first-time "find my name"
search flow lets a new guest claim their own key without the owner handing
it out). There are three roles:

- **Owner** - the one account created on first boot. Full access, including
  everyone's plaintext access keys and who's behind each Plaza pseudonym.
- **Admin** - a promoted regular user (only possible where
  `ENABLE_ADMIN_PROMOTION=true`, e.g. QA). Gets the admin panel (post to the
  Wall, run Snatch voting, reveal consequences) but never sees other users'
  access keys or Plaza identities - those stay owner-only regardless.
- **User** - a regular guest: votes, suggests consequences, posts to Plaza,
  reads the Wall.

The interface has a PT/EN language switch everywhere.

> **Status:** built for, and used at, a real private party (~50 guests, two
> nights). The app is now shut down; this repo is kept as a reference.

## Live demo

**[lodge-demo.appdoivo.com](https://lodge-demo.appdoivo.com)**: the app with mock data. The login screen
offers two keys, a **guest** and an **admin**, so no account is needed.

Demo mode (`src/demo.js`) keeps it safe to leave open: photo uploads become a
placeholder, and link posts, the anonymous chat, wipes, deletions and key
changes are turned off. The demo has no persistent storage and sleeps when
idle, so it wakes up fresh, with the demo data, after a quiet spell (the
first load after that takes a few seconds).

## Screenshots

<p align="center">
  <img src="docs/demo.gif" width="260" alt="Walkthrough: logging in, then the Wall, Rata, Snatch and Plaza tabs, the theme toggle and the language switch">
</p>
<p align="center"><a href="docs/demo.mp4">Watch the walkthrough as video</a></p>

| Login | Wall | Rata |
|---|---|---|
| <img src="docs/screenshots/1-login.jpg" width="240" alt="Login screen"> | <img src="docs/screenshots/2-wall.jpg" width="240" alt="Wall with announcements"> | <img src="docs/screenshots/3-rata.jpg" width="240" alt="Rata consequence game"> |
| **Snatch** | **Plaza** | **Admin: voting control** |
| <img src="docs/screenshots/4-outfit.jpg" width="240" alt="Snatch outfit voting"> | <img src="docs/screenshots/5-chat.jpg" width="240" alt="Plaza anonymous chat"> | <img src="docs/screenshots/6-admin.jpg" width="240" alt="Admin voting control"> |

All captured with mock data by `npm run screenshots` (Playwright WebKit,
iPhone 13 profile), so they can be regenerated after any UI change.

## Engineering & quality

This is a side project, but it was built the way I'd want a production
system to be tested: quality gates first, then features.

**Test suite: ~250 automated tests** (Node's built-in `node:test`, no extra
test framework)

| Suite | Tests | What it covers |
|---|---|---|
| `test/api.test.js` | 137 | API and business logic: auth, roles, voting rules, ties and runoffs, duo confirmations, rate limits, wipe/seed flows |
| `test/ui.test.js` | 104 | Real-browser UI tests with Playwright (WebKit, the iOS Safari engine) on iPhone SE / 13 / Pro Max viewports: layout overflow, alignment, end-to-end flows |
| `test/migration.test.js` | 1 | Schema migrations run cleanly against an existing database |
| `test/ci-smoke.test.js`, `test/demoSeed.test.js` | 8 | Boot smoke test and seeded QA data |

Every suite runs against a temporary database and never touches real data.

**End-to-end, from the outside:** a separate BDD suite,
[lodge-app-e2e](https://github.com/githubdoivo/lodge-app-e2e) (Playwright + Cucumber,
TypeScript), runs every day against the [live demo](https://lodge-demo.appdoivo.com):
API scenarios plus UI scenarios on iPhone and desktop, with a
[published report](https://githubdoivo.github.io/lodge-app-e2e/).

**Quality gates**

- **Pre-commit hook** (`.githooks/pre-commit`, plain git hook, no husky) runs
  the full suite and blocks the commit if anything fails.
- **GitHub Actions** (`.github/workflows/test.yml`) runs the same suite on
  every pull request and on `main`. A red check means the branch can't be merged.
- **Branch-per-change workflow**: `feat/`, `fix/`, `test/`, `chore/`; nothing
  goes straight to `main`. ~75 pull requests merged. See
  [CONTRIBUTING.md](CONTRIBUTING.md).
- **Dependabot** keeps dependencies current.

**Environments**

- **QA** (`fly.qa.toml`): ephemeral database that resets on every deploy,
  auto-seeded demo data (`SEED_DEMO`), and QA-only feature flags
  (`ENABLE_ADMIN_PROMOTION`), so every role and flow can be tested from a
  clean state.
- **Production** (`fly.toml`): persistent volume, deployed only from `main`.
- A version badge (`APP_ENV`) shows which environment is open, so QA and
  production can't be confused on a phone.

**Flaky test investigation**

The UI suite started failing about half of its tests on CI, on `main` too.
The cause was the API and UI suites running in parallel on a two-core runner,
which starved the browser. I measured both modes (206 tests: 116s serial vs
120s parallel locally) and switched to serial everywhere. It turned out to be
both faster and deterministic. The reasoning is written up in
`scripts/run-tests.js`.

**Security & privacy by design**

- Access keys are stored hashed (for lookup) and encrypted (`TOKEN_SECRET`),
  never in plaintext.
- Three roles (owner / admin / user) with checks on the server; the
  most sensitive data (other users' keys, who's behind the anonymous
  pseudonyms) is owner-only, even for admins.
- Rate limiting on login and key-claim endpoints (`src/rateLimit.js`).

## Stack

- Node.js 23.4+ (uses the built-in `node:sqlite`, no native build step)
- Express, node-cron, web-push
- Frontend: PWA in plain HTML/CSS/JS (works on iPhone and Android without an app store)

## Running locally

```powershell
npm install
copy .env.example .env      # on macOS/Linux: cp .env.example .env
npm run genkeys             # generates the VAPID keys; copy them into .env
npm start
```

On first start the owner account is created and its token is printed in the
terminal. Keep it safe. To see it again:

```powershell
npm run admin-token
```

Open http://localhost:3001 (or the port set in `.env`), log in with that
token, and go to Settings to:

- Create users (generates a key for each; send it to them).
- Post to the Wall (announcement or poll).
- Pick the night to manage (Furnished / Swamp) and, for that night: register
  contestants, control the vote (registration, open, close, reveal results
  in stages), and see every vote.
- See and reveal consequences, and record who's holding the rata.

Optional local env flags (see `.env.example`):

- `ENABLE_PLAZA=true` - turns on the Wall tab (off by default locally; on in
  both QA and production).
- `ENABLE_ADMIN_PROMOTION=true` - lets the owner promote/revoke other users'
  admin status from Settings.
- `SEED_DEMO=true` - auto-loads demo users/contestants/consequences on every
  boot. Never set this in production; it's meant for QA/local preview
  (equivalent to running `npm run seed-demo` manually).

## Tests

A local suite (Node's built-in `node:test`, no extra dependencies) covering
both the API/logic (`test/api.test.js`) and a real-browser UI suite
(`test/ui.test.js`, Playwright WebKit, same engine as iOS Safari) across
iPhone SE/13/Pro Max viewports. Runs against a temporary database and never
touches the real one. Run it before deploying:

```powershell
npm test
```

A pre-commit hook and CI (GitHub Actions) both run this same suite - see
[CONTRIBUTING.md](CONTRIBUTING.md) for the full process.

## Push notifications

Every feature notifies the group when something happens - a new Wall post,
a revealed consequence, Snatch registration/voting opening or closing and
results being revealed, or a new Plaza post (skipping the poster's own
device). Each notification opens the app straight to the relevant tab. See
`broadcast(` calls in `src/consequences.js`, `src/routes.js`, and
`src/push.js` for the exact copy.

- Android/Chrome: just tap the notifications button inside the app.
- iPhone (iOS 16.4+): first use "Add to Home Screen" (Share > Add to Home
  Screen) and open the app from the icon. Only then does iOS allow enabling
  notifications.
- Push requires HTTPS. It works on `localhost`; in production use a host with
  HTTPS (the ones suggested in [SETUP.md](SETUP.md) provide it automatically).

## Configuration (.env)

- `PORT` - server port (default 3000; this project uses 3001 locally).
- `NODE_ENV` - set to `production` only in the real deployment (fly.toml). Gates
  `ADMIN_TOKEN` below (`mossy` has its own switch, see `ENABLE_DEV_LOGIN`).
- `ADMIN_TOKEN` - pins the owner's access key outside production. If empty (or
  in production), one is generated the same way any user's key is.
- `ENABLE_DEV_LOGIN` - lets a `mossy` login always resolve to the owner
  regardless of their real key (see `findUserByToken` in `src/auth.js`). Dev/QA
  only - deliberately never set in `fly.toml`, so the safe default (off) holds
  even if some other env var fails to propagate correctly.
- `ADMIN_NAME` - the owner's display name.
- `TOKEN_SECRET` - secret used to encrypt and index user tokens. Keep it out of
  the database and never share it. If you change it, nobody can log in.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` - Web Push (`npm run genkeys`).
- `ENABLE_ADMIN_PROMOTION` - lets the owner promote/revoke other users' admin status.
- `ENABLE_PLAZA` - turns on the Wall tab. Off by default locally; on in both QA and production.
- `SEED_DEMO` - auto-loads demo data on boot. QA only, never production.
- `DB_FILE` - (optional) database path; used by the tests (`:memory:` or a temp file).
- `APP_ENV` - (optional) labels the version badge (e.g. `qa`) so it's obvious which environment is open.

## Deploy & hosting

See [SETUP.md](SETUP.md) for the full hosting guide: readiness checklist,
step-by-step Fly.io deploy, free hosting options for the app and database, and
where to buy a domain. A `Dockerfile` and `fly.toml`/`fly.qa.toml` are included.

The database lives in `data/app.sqlite`. On platforms with an ephemeral
filesystem, attach a persistent volume mounted at the database path so votes and
consequences survive each deploy.

## Notes

- The database is stored in `data/app.sqlite` (ignored by Git).
- Demo data (users, contestants and votes per night, consequences) for
  preview: `npm run seed-demo`. Do not use in production.
- Guest names: the repo only ships mock names. For a real event, put the
  guest list in `data/guest-list.txt` (one name per line, gitignored) and the
  "create guest list" button and demo seed use it instead.
- Any CLI script that imports `src/db.js` must load `dotenv` first
  (`import 'dotenv/config';`), otherwise `TOKEN_SECRET` is undefined and the
  token data can be corrupted.
