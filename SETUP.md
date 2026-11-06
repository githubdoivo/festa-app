# appdoivo - Setup & Hosting Guide

A small PWA for a private group of friends, with four features:

- **Wall** - the owner/admins post announcements or polls; the group gets
  notified and can vote on polls. Gated behind `ENABLE_PLAZA=true` - off
  by default locally, on in QA and production.
- **Rata** - every 3 hours a random "consequence" (suggested by users) is
  revealed and everyone is notified. The owner can record who's actually
  holding it.
- **Snatch** - per-night outfit voting; the admin controls registration,
  opens/closes each night, and reveals a staged ranking when it closes.
- **Plaza** - an open, anonymous, ephemeral group chat (pseudonyms only;
  the owner alone can see real identities).

This guide explains how to run it locally, how to host it safely for free, and how to buy a domain.

## Push notifications

Automatic notifications are sent to every subscribed device for each
feature, in the recipient's own last-selected app language (PT or EN,
stored per user and synced whenever they switch languages in the app).
Every notification opens the app straight to the tab it's about:

- **Wall:** a new announcement or poll is published.
- **Rata (every 3 hours, 16:00-04:00):** when a new consequence is
  revealed. The consequence itself is not shown in the notification, on
  purpose, so people open the app to see it.
- **Snatch:** registration opens, voting opens, voting closes, and each
  stage of the results reveal (3rd -> 2nd -> 1st -> everyone).
- **Plaza:** a new message is posted (skipping the poster's own device).

The exact title/body strings live in `src/consequences.js`, `src/routes.js`
and `src/push.js` (search for `broadcast(`) - update this doc if you change them.

Notes:

- Push requires HTTPS. It works on `localhost`; in production you need a host with HTTPS (all the recommended hosts below provide it automatically).
- Android/Chrome: tap the notifications button inside the app.
- iPhone (iOS 16.4+): first use "Add to Home Screen", open the app from that icon, then enable notifications.

## Running locally

Requires Node.js 23.4 or newer (the app uses the built-in `node:sqlite`, so no native build step is needed).

```powershell
npm install
copy .env.example .env      # on macOS/Linux: cp .env.example .env
npm run genkeys             # generates the VAPID keys; copy them into .env
npm start
```

On the first start the owner account is created and its token is printed in the terminal. Keep it safe. To see it again:

```powershell
npm run admin-token
```

Open http://localhost:3001 (or the port set in `.env`), log in with the owner token, and go to Settings to create users, post to the Wall, manage nights, and reveal consequences.

Feature flags worth knowing about locally (see `.env.example`):

- `ENABLE_PLAZA=true` - turns on the Wall tab (matches QA/production; off by default locally).
- `ENABLE_ADMIN_PROMOTION=true` - lets the owner promote/revoke other users' admin status.
- `SEED_DEMO=true` - loads demo users/contestants/consequences on every boot, instead of running `npm run seed-demo` by hand.

Run the test suite before deploying (it never runs in the cloud):

```powershell
npm test
```

## Is the app ready to host?

Yes, with one caveat. The app keeps no in-memory state - it only depends on a single SQLite file. A `Dockerfile` (node:24-slim) and both `fly.toml` (production) and `fly.qa.toml` (QA) are already provided.

The only requirement is a **persistent disk** for the SQLite database. If the host uses an ephemeral filesystem, the database is wiped on every deploy or restart, so a persistent volume is configured in `fly.toml`. QA is the deliberate exception - see [CONTRIBUTING.md](CONTRIBUTING.md) for why its database is ephemeral on purpose.

## Deploying (Fly.io, recommended)

1. Install `flyctl` and sign in: `fly auth login`
2. Create the app: `fly apps create appdoivo`
3. Create the persistent volume in the same region:
   `fly volumes create appdoivo_data --region cdg --size 1`
4. Set the secrets (these are never committed to the repository):
   ```
   fly secrets set TOKEN_SECRET=<32-byte hex> ADMIN_NAME=Ivo `
     VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@yourdomain
   ```
   No `ADMIN_TOKEN` here on purpose - `fly.toml` sets `NODE_ENV=production`, which
   makes the owner's real key generate the same random way any user's does. Look
   it up after deploying with `npm run admin-token` (or `fly ssh console -C
   'node scripts/print-admin-token.js'`).
5. Deploy: `fly deploy` (or, from a branch already checked out, `scripts/deploy.sh prod` - runs the test suite first and refuses to deploy if it fails)

`min_machines_running` is set to 1 in `fly.toml` so the Rata reveal (every 3 hours) fires even with no traffic. Outside events you may set it to 0 to save resources (the cron then only runs when there is a visit).

QA (`lodge-qa`) is deployed the same way but with `scripts/deploy.sh qa` (or `fly deploy -a lodge-qa --config fly.qa.toml`) - see [CONTRIBUTING.md](CONTRIBUTING.md) for the full branch -> QA -> prod process.

## Free hosting recommendations (app + database), securely

- **Fly.io (recommended):** hosts the app and a persistent volume for SQLite together, with free HTTPS and a small free allowance that is plenty for ~50 people. Best fit because the database lives next to the app.
- **Railway:** monthly free credit, persistent volumes, very simple deploys. Good alternative.
- **Render:** free web service, but the free plan sleeps and its persistent disk is paid. Only suitable if you host the database separately.
- **Turso (managed database):** cloud SQLite with a generous free tier; pairs with any app host. This requires swapping the `node:sqlite` client for theirs. A good option if you want to separate app and database.

Security checklist:

- Always set secrets through the host's "secrets" mechanism, never in `fly.toml` or the repository.
- Keep HTTPS enforced (already set in `fly.toml`/`fly.qa.toml`).
- Keep `.env` in `.gitignore` (already done).
- User tokens are stored encrypted in the database (HMAC index plus AES-256-GCM), so a database leak alone does not expose them - as long as `TOKEN_SECRET` stays out of the database.

## Buying a domain

- **Cloudflare Registrar:** cheapest (at-cost, no mark-up or inflated renewals). Ideal if your chosen TLD is supported.
- **Porkbun:** cheap and simple, good for `.com` / `.app` / `.fun`.
- **Namecheap:** reliable and inexpensive.
- **`.pt` domains:** registered via dns.pt through registrars such as PTisp, Amen or 3domain.

Avoid GoDaddy (up-sells and expensive renewals). Suggested names: `appdoivo.com`, `appdoivo.fun` or `appdoivo.pt`. After deploying, point the DNS at Fly - `fly deploy` tells you which records to create.

## Environment variables (.env)

- `PORT` - server port (default 3000; this project uses 3001 locally).
- `NODE_ENV` - set to `production` only in the real deployment (`fly.toml`). Gates
  `ADMIN_TOKEN` below (`mossy` has its own switch, see `ENABLE_DEV_LOGIN`).
- `ADMIN_TOKEN` - pins the owner's access key outside production. If empty (or
  in production), one is generated the same way any user's key is.
- `ADMIN_NAME` - the owner's display name.
- `TOKEN_SECRET` - secret used to encrypt and index user tokens. Keep it out of the database and never share it. If you change it, nobody can log in (the stored hashes no longer match).
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` - Web Push keys (generate with `npm run genkeys`).
- `ENABLE_ADMIN_PROMOTION` - lets the owner promote/revoke other users' admin status from Settings. On in QA, off in production.
- `ENABLE_DEV_LOGIN` - lets a `mossy` login always resolve to the owner
  regardless of their real key (see `findUserByToken` in `src/auth.js`). Dev/QA
  only - deliberately never set in `fly.toml`, so the safe default (off) holds
  even if some other env var fails to propagate correctly.
- `ENABLE_PLAZA` - turns on the Wall tab. Off by default locally; on in both QA and production.
- `ANTHROPIC_API_KEY` - translates what guests write (Rata consequences, Wall
  posts) into whichever language each person is reading in. **Entirely
  optional**: with no key the app shows every message exactly as written,
  which is how it behaved before the feature existed. The test suite never
  calls the API, so it is not needed to run `npm test`.
- `SEED_DEMO` - auto-loads demo users/contestants/consequences on every boot. QA only - never set in production.
- `DB_FILE` - (optional) database path; used by the tests and to point production/QA at their mounted volume.
- `APP_ENV` - (optional) labels the version badge (e.g. `qa`), so it's obvious at a glance which environment is open.

## Moving the project to another computer

The project contains no sensitive third-party or employer data - only the app's own secrets (in `.env`) and the friends' names/keys (in the local SQLite file under `data/`, which is git-ignored).

1. Copy the `appdoivo` folder, excluding `node_modules` (and optionally `data/` if you want to start with an empty database).
2. On the new machine run `npm install`.
3. Either bring the existing `.env`, or regenerate a fresh `TOKEN_SECRET` and new VAPID keys (`npm run genkeys`) and reset the owner.

## Important operational notes

- Any command-line script that imports `src/db.js` must load `dotenv` first (`import 'dotenv/config';`), otherwise it runs without `TOKEN_SECRET` and can corrupt the token data.
- Never commit `.env` or the `data/` folder.
