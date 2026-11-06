# Development & deploy process

## Branches

Every change happens on its own branch off `main`, named by type:

- `feat/<description>` - new features
- `fix/<description>` - bug fixes
- `test/<description>` - test-only changes
- `chore/<description>` - config, docs, tooling (no app behaviour change)

Never commit straight to `main`.

## Environments

- **QA** (`lodge-qa`, https://lodge-qa.appdoivo.com) - manual preview target.
  Stops when idle (`min_machines_running = 0`), so it costs next to nothing
  between tests. The first visit after a pause takes a few seconds, and
  the database starts fresh (seeded) each time it wakes, like after a deploy.
  No persistent volume: the database is ephemeral and resets on every deploy.
  Same admin login as production, but its own `TOKEN_SECRET`/VAPID keys.
  Deployed manually, on demand, from whatever branch is being tested - never
  automatically. Use throwaway test users here, not real ones.
- **Production** (`appdoivo`, https://lodge.appdoivo.com) - the real app, real data,
  persistent volume. Only ever deployed from `main`. Suspended between parties.
- **Demo** (`lodge-demo`, https://lodge-demo.appdoivo.com) - public, for
  anyone to try (the README links it). Mock data only, `DEMO_MODE=true` (see
  `src/demo.js`), no volume, stops when idle. Deployed from `main` with
  `scripts/deploy.sh demo`, using `FLY_API_TOKEN_DEMO` from `.env`.

Databases are intentionally isolated between all three - QA is for testing
behaviour safely, not for managing real users.

## Process for a change

Changes are batched: a work session typically covers several features/fixes
on one branch, tested and deployed together rather than one-change-per-branch
and one-deploy-per-change. Don't deploy after every small feature - batch the
session's work and deploy once at the end.

1. Branch off `main` with the right prefix (one branch can carry the whole
   session's worth of work).
2. Implement each change. `npm test` covers both API/logic tests
   (`test/api.test.js`) and a real-browser UI/UX suite (`test/ui.test.js`)
   that drives the app with Playwright's WebKit engine (same engine as iOS
   Safari) across iPhone SE/13/Pro Max viewports, catching layout overflow,
   misalignment, and regressions on real device sizes before they reach QA.
   One-time setup: `npx playwright install webkit chromium`. Run just the UI
   suite with `npm run test:ui`.
3. Commit. A pre-commit hook (`.githooks/pre-commit`, wired up automatically
   via `npm install`'s `postinstall` - no husky, plain git hook) runs
   `npm test` and blocks the commit if anything fails, so this doesn't rely
   on remembering to run it manually.
4. Push the branch. Once a PR is open, every push to it also runs the same
   suite via GitHub Actions (`.github/workflows/test.yml`) - a red check
   there means the branch isn't safe to deploy or merge. Plain pushes
   without an open PR don't trigger CI, to avoid noise on WIP commits that
   aren't close to main yet.
5. Deploy the branch straight to QA with `scripts/deploy.sh qa` (wraps
   `npm test` + `fly deploy -a lodge-qa --config fly.qa.toml` - refuses
   to deploy if tests fail) so it can be checked live at
   https://lodge-qa.appdoivo.com before it's even merged. Bump the version in
   `package.json` before each QA deploy, so the version badge makes it
   obvious which build is live.
6. Once it's confirmed working on QA, open a PR and merge it into `main`
   (delete the branch on merge - `gh pr merge --merge --delete-branch`).
7. Only after merging: deploy `main` to production with
   `scripts/deploy.sh prod`. Fly's GitHub integration is connected but has
   not reliably auto-deployed on push in practice, so treat this script as
   the real deploy step, not the integration.
8. Verify production directly (HTTP check, login, and whatever the batch
   actually touched) before considering the session's work done.

### The app is closed (23 September 2026)

**Both apps are scaled to zero machines** - `fly scale count 0` on
`appdoivo` and `lodge-qa`. The party is over and nothing needs to be
running; neither domain answers, and nothing can wake them, which is the
difference between this and stopping a machine (`auto_start_machines` is
on, so any stray request would have restarted a stopped one and started
charging again).

**The production volume was destroyed the same day** - `appdoivo_data`,
`vol_v8ep3d82yoxxg65v`, 20GB, gone. Ivo had already downloaded the photos
and chose to delete it rather than keep paying ~$3/month for storage that
volumes are charged for whether or not a machine is attached. That was the
only remaining cost; nothing else here is billed.

So there is **no production data left on Fly** - not the photos, and not
`/data/app.sqlite`, which held the guest accounts and their access keys,
Wall, Plaza, Rata, the dedications, and the night results. Whatever was
saved off the app before this is the only copy there is.

What does still exist: both apps, their secrets, and their IPs. The apps
themselves cost nothing with no machines running, and the app makes no
Claude API calls with nothing running.

To bring it back:

```
scripts/deploy.sh prod      # creates a machine and a new, empty volume
```

**It comes back empty**, and that is the part to know before promising
anyone their account still works. The deploy provisions a fresh volume from
the `[[mounts]]` block in `fly.toml` and the app builds a new database on
first boot, with a new owner token from `ADMIN_TOKEN`. Every guest key is
gone, so everybody would have to be re-created and re-invited. Same story
for QA with `scripts/deploy.sh qa`, which never had a volume and always
came back empty anyway.

### The production volume (extended 12 Sept 2026, deleted 23 Sept 2026)

**This volume no longer exists** - see the section above. What follows is
kept as the record of why it was sized the way it was, and is worth reading
before provisioning another one for a second party.

**`appdoivo_data` was extended to 20GB on 12 September 2026.** Fly extended
it in place, with no restart and no downtime.

**The party is 18-20 September 2026.** Memo stores every uploaded photo
and video, plus the generated day videos, as real files on the production
volume (`/data/memo-uploads`) - not as rows in SQLite. At its original
**1GB** Memo would have filled it on day one, and a full disk means uploads
start failing mid-party. Memo opens itself on **17 September** (see
`MEMO_START_DATE` in `fly.toml`), the day before the party - enough margin
to catch a problem while it is still fixable, without a week of
notifications first.

Sizing: ~50 guests x 5 slots/day at a realistic ~12MB average is ~3GB a
day, so 20GB covers the whole weekend with room to spare.

```
fly volumes extend vol_v8ep3d82yoxxg65v -s 20 -a appdoivo
```

Two things that shaped the timing, and that matter if this ever comes up
again:

- Fly bills volumes on **provisioned** size, not bytes used - 20GB costs
  ~$3/month from the moment you extend, whether or not it's full. That is
  why it was left until days before the party rather than done up front.
- A volume can be **extended but never shrunk**, so this was one-way.

## Before the party: clear the test data

Ivo and friends tested on production from 13 September, on the real
accounts - which was the right call, because QA has no real accounts and
so cannot exercise the one thing that matters most: a guest finding their
name, claiming their key, and getting in.

What that leaves behind is test content, and the party should not open on
it. Settings has a wipe per feature; run all five, ideally on the 17th:

- Wall (posts, polls, links, votes)
- Rata (consequences)
- Plaza (chat)
- Snatch (contestants and votes)
- Memo (uploads, moments, and the files on the volume)

**None of them touch accounts.** Guest rows, keys and claimed status all
survive every wipe, which is the point: anyone who claimed their key while
testing stays claimed, and nobody has to do it twice on the day.

Translations of wiped content go with it - the wipes clear those rows too,
so nothing is left pointing at a post that no longer exists.

## The golden rule stops at the guests' own words

`body { text-transform: lowercase }` makes the app lowercase everywhere, and
that is the house style - it applies to every string the app itself writes.
It does not apply to what guests write.

The dedications PDF is where the two meet, and the split there is
deliberate (Ivo's call, 12 Sept 2026): the heading and the signature line
are the app talking, so they are lowercased in code, because a PDF is the
one artefact no stylesheet reaches. The **messages** are printed exactly as
they were typed, capitals and all - they are his friends' voices, written
to him, and the book should read the way they wrote it.

This looks like an oversight and is not. There is an assertion pinning it
in `test/api.test.js`; read the note beside it before changing anything.

## Domain and email

`security.txt` is **not** served from this repo. `public/.well-known/security.txt`
exists as a fallback, but Cloudflare's Security Center serves its own copy at
the edge and that is what the world (and Cloudflare's own scanner) sees - the
scanner will keep flagging the domain as unconfigured however correct the file
in here is. Edit it via the zone's `security-center/securitytxt` API, or under
Security -> Settings in the dashboard.

It names `mail@appdoivo.com` (one address per domain, all routed to the same Gmail; it used to be `security@appdoivo.com`, retired
with the app), which is a Cloudflare Email Routing address, not a real
mailbox. Two things about that:

- **Failure is silent.** DNS being right (MX, SPF, the DMARC `rua`) is not
  enough; if the routing destination has never been verified, mail is accepted
  and dropped, with no bounce to tell you. This is exactly what happened when
  it was first set up.
- **It cannot be checked remotely.** Cloudflare's MX rejects senders without
  reverse DNS, so an SMTP probe never gets far enough to ask. The only real
  test is to send the address an email and see whether it arrives.

The same address receives DMARC aggregate reports, so if it breaks, those are
lost too - not just vulnerability reports.

## Version numbering

Step the patch by **5** (`1.5.0`, `1.5.5`, ... `1.5.95`, then bump the
minor). Briefly tried stepping by 1 and reverted - the gaps are the point,
they make one build obviously different from the next at a glance in the
badge, which is all the number is for. Prod and QA carry the same version
for a given release: bump once, deploy both.

**The number was wound back from `1.9.50` to `1.5.0` on 10 August 2026** -
stepping by 5 was eating the minor far faster than the app was actually
changing, and 2.0 was going to arrive for no reason. Nothing reads the
version except the badge and `/api/version` (this package is never
published, and no client checks it), so going backwards costs nothing.
Carry on from `1.5.0`; don't "correct" it back up to the 1.9.x line.

## Secrets

- `.env` (local) and `fly secrets` (per app) are the only place secrets
  live - never in a committed file.
- Production and QA have distinct `TOKEN_SECRET` and VAPID keys. The admin
  password is intentionally shared across environments for convenience.
