import { api, fetchMe, getToken, setToken, clearToken, onConnectionChange } from './api.js';
import { registerServiceWorker, refreshNotifButton, wireNotifButton, wireDeepLinks, consumePendingDeepLink } from './push.js';
import { t, applyI18n, getLang, setLang } from './i18n.js';
import { applyMode, toggleMode, syncThemeColor } from './theme.js';
import { wireLogoEasterEgg } from './logoEasterEgg.js';
import { wirePasswordToggle } from './passwordToggle.js';
import { wireVersionBadge } from './version.js';
import { showAlert, showConfirm } from './modal.js';
import { formatHourInZone, formatEuDate } from './time.js';
import { resizePhotoToJpeg } from './photo.js';

// An installed iOS PWA keeps its WKWebView alive in the background rather
// than doing a real fresh load every time you reopen it - the OS restores
// wherever it was left scrolled to, which reads as "the app opens
// somewhere in the middle/bottom instead of the top". Setting this to
// 'manual' stops the browser from doing that restoration on its own;
// boot() below still forces a scroll-to-top itself as a belt-and-braces
// measure, since this alone doesn't cover every case (e.g. iOS resuming a
// suspended tab without a real navigation at all).
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
// Strips accents so "cesar" matches "César" - typing the plain-ASCII form
// of a name should always find it, not just the exact accented spelling.
const foldAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Turns plain-text URLs in an already-escaped string into clickable links -
// matches a scheme (https://...), a www. prefix, or a bare shortlink-style
// domain+path (shorturl.at/xxxx, as admins actually paste them - requiring
// the "/path" part on bare domains avoids linkifying incidental "word.tld"
// look-alikes that aren't followed by anything). Runs on text that's
// already gone through esc(), so it's operating on HTML-safe input; a
// trailing sentence-punctuation character is peeled off the match so
// "check shorturl.at/abc." doesn't swallow the period into the link.
const URL_RE = /\b(?:https?:\/\/[^\s<]+|www\.[^\s<]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<]*)/gi;
function linkify(escapedText) {
  return escapedText.replace(URL_RE, (match) => {
    let trail = '';
    const trailMatch = match.match(/[.,;:!?)\]}]+$/);
    if (trailMatch) {
      trail = trailMatch[0];
      match = match.slice(0, -trail.length);
    }
    const href = /^https?:\/\//i.test(match) ? match : `https://${match}`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${match}</a>${trail}`;
  });
}

let currentTab = 'plaza';
// Set from /me in showApp() - lets the Rata history tell "assigned to
// me" apart from "assigned to someone else" so only the actual assignee
// sees a mark-as-done button on their own entry.
let myUserId = null;
// Set from /me in showApp() - Plaza is mid-rebuild (single note -> real
// posts feed), so it's QA-only until that's done (see ENABLE_PLAZA in
// src/routes.js and fly.qa.toml). Defaults true so nothing flashes/hides
// before /me resolves; showApp() corrects it immediately after.
let plazaEnabled = true;
// Set from /me in showApp() - Memo is QA-only until tested (see
// ENABLE_MEMO in src/routes.js/fly.qa.toml). Defaults false (unlike
// plazaEnabled above) since it's a brand-new feature, not a temporarily-
// hidden existing one - nothing should assume it's on before /me resolves.
let memoEnabled = false;
// Set from /me in showApp() - gates the tutorial's skip button (see
// startTutorial()): only admin/owner accounts can skip, everyone else
// has to read through it.
let isAdmin = false;
let isOwner = false;

/* ------------------------------- Arranque -------------------------------- */

async function boot() {
  window.scrollTo(0, 0);
  applyMode();
  applyI18n();
  updateLangUI();
  wireVersionBadge();
  // applyNight() is deliberately NOT called here: it sets body.theme-rata,
  // and iOS Safari's rubber-band overscroll paints straight from body's
  // background - a region no child element (including #login's own white
  // background) can cover. Only apply it once the app itself is shown
  // (see showApp()), so the login screen never carries a night theme.
  const token = getToken();
  if (!token) {
    showLogin();
    registerPushWorker();
    return;
  }
  try {
    showApp(await fetchMe());
  } catch (err) {
    // Only the server actually refusing the key ends the session. Anything
    // else - a dropped request, the server unreachable for a moment - says
    // nothing about whether the key is still good, and throwing it away
    // costs someone the only way back into their account. Leaving it stored
    // means a reload recovers on its own.
    if (err?.status === 401) clearToken();
    showLogin();
  }
  registerPushWorker();
}

/**
 * Registration is only ever needed for push, and nothing on screen depends
 * on it - so it runs after the first paint and is never awaited. boot() used
 * to await it before doing anything else, which meant a registration that
 * stalled left the app on a blank screen: no login form, no app, a valid
 * session sitting behind it, and no way out but a reload. That is exactly
 * what CI kept hitting - the app never appeared while /me answered 200.
 */
function registerPushWorker() {
  registerServiceWorker().catch(() => {});
}

function showLogin() {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  holdLoginStrip();
}

// While the login shows, the window stays scrolled down by the painted strip
// above it (--above in styles.css), so iPhone Safari shows the painting behind
// the clock instead of a flat band. Only .cover scrolls for the guest.
const LOGIN_ABOVE = 160;
function holdLoginStrip() {
  if ($('login').classList.contains('hidden')) return;
  if (Math.abs(window.scrollY - LOGIN_ABOVE) > 0.5) window.scrollTo(0, LOGIN_ABOVE);
}
['scroll', 'resize', 'pageshow', 'load'].forEach((e) => window.addEventListener(e, holdLoginStrip, { passive: true }));


function showApp(me) {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  window.scrollTo(0, 0);
  myUserId = me.id;
  isAdmin = !!me.isAdmin;
  isOwner = !!me.isOwner;
  plazaEnabled = !!me.plazaEnabled;
  memoEnabled = !!me.memoEnabled;
  document.querySelector('[data-tab="plaza"]').classList.toggle('hidden', !plazaEnabled);
  document.querySelector('[data-tab="memo"]').classList.toggle('hidden', !memoEnabled);
  // Always opens on Wall (the landing tab - see currentTab above), the way
  // an app opens on its home tab, rather than resuming wherever it was
  // last left. The tab someone was on is deliberately NOT remembered: on
  // an installed PWA there's no address bar to refresh from, so "reopening
  // the app" is the only thing that ever happens, and landing somewhere
  // mid-app is disorienting. A notification's own ?tab= is the one thing
  // allowed to override this (see applyDeepLinkParams() below).
  if (!plazaEnabled && currentTab === 'plaza') selectTab('rata');
  applyNight();
  wireLogoEasterEgg(me.name, me.logo_customized);
  // No role badge in the main app's topbar - every tab is open to
  // everyone regardless of role, and it was fighting the logo-swap
  // easter egg for space. Settings still shows a role badge, where it's
  // actually informative (explains which admin tabs are visible).
  $('settings-link').classList.remove('hidden');
  refreshNotifButton();
  // Plaza/Wall is the default landing tab (see currentTab above) - starts
  // polling immediately, same as any other tab does once it's the one
  // showing. A Rata's own load below is just a preload for a smooth first
  // switch, not polling - it isn't the visible tab yet.
  if (plazaEnabled) startPlazaPolling();
  loadConsequences();
  loadRataHistory();
  // Best Look's own data loads when its tab is actually selected (see
  // selectTab()) - not here too. It used to double-load unconditionally,
  // which was harmless when the outfit tab was just static vote buttons,
  // but now that it has a live registration form, a late-resolving response
  // from this redundant call could silently wipe out text someone's mid-
  // typing (the newer selectTab() load re-renders the same DOM nodes).
  // Always opens on the announcements feed (internally "plaza", now
  // labelled "Wall" - see the tab nav comment in index.html) - a
  // notification's own ?tab= (handled right after) is the only thing
  // allowed to land somewhere else.
  applyDeepLinkParams();
  consumePendingDeepLink(followDeepLink);
  if (!me.tutorialSeen) startTutorial();
  startSessionWatcher();
}

// Polls /me every 30s to catch an account being deleted or its key
// regenerated while this session is already open, logging out
// automatically rather than continuing to silently fail every request.
// No role-based UI to sync here (the main app has no role badge - see
// showApp() - and every tab is open to everyone regardless of role), so
// there's nothing else for this to watch for.
let sessionWatchTimer = null;
function startSessionWatcher() {
  if (sessionWatchTimer) return;
  sessionWatchTimer = setInterval(async () => {
    try {
      await api('/me');
    } catch (err) {
      if (err.status === 401) {
        clearToken();
        location.reload();
      }
      // other errors are transient - next poll retries
    }
  }, 30000);
}

/* ------------------------------- Tutorial --------------------------------- */
// First-session walkthrough. Tied to the account (tutorial_seen on the
// user row), not localStorage, so it doesn't repeat on a new device and
// doesn't reappear just because storage got cleared.

// A function, not a fixed array, because the Memo step only belongs in the
// tour while memoEnabled is true (QA-only for now) - showing it on
// production, where the tab itself is hidden, would be a step about a
// feature nobody can actually see.
function tutorialSteps() {
  // The tabs in the order the tab bar shows them - wall, plaza, memo, rata,
  // snatch - so someone can follow the tour with a finger along the row
  // instead of being sent back and forth across it. Mind the naming swap
  // when reading these keys: tutorial_plaza is the page displayed as
  // "wall", tutorial_wall the one displayed as "plaza" (see CLAUDE.md).
  const steps = [
    ['tutorial_1_title', 'tutorial_1_text'],
    ['tutorial_plaza_title', 'tutorial_plaza_text'],
    ['tutorial_wall_title', 'tutorial_wall_text'],
  ];
  if (memoEnabled) steps.push(['tutorial_memo_title', 'tutorial_memo_text']);
  steps.push(
    ['tutorial_2_title', 'tutorial_2_text'],
    ['tutorial_3_title', 'tutorial_3_text'],
    // The three that are not tabs at all come last, whatever the row does.
    ['tutorial_4_title', 'tutorial_4_text'],
    ['tutorial_5_title', 'tutorial_5_text'],
    ['tutorial_6_title', 'tutorial_6_text'],
  );
  return steps;
}
let tutorialStep = 0;

function renderTutorialStep() {
  const steps = tutorialSteps();
  const [titleKey, textKey] = steps[tutorialStep];
  $('tutorial-title').textContent = t(titleKey);
  // One sentence per line. These are two short sentences more often than
  // not, and letting them wrap freely puts the end of one and the start of
  // the next on the same line, which reads as a wall rather than as two
  // beats. Split rather than styled, because no amount of text-wrap makes a
  // sentence boundary land where a line break should be.
  const el = $('tutorial-text');
  el.textContent = '';
  const sentences = t(textKey).split(/(?<=\.)\s+/).filter(Boolean);
  sentences.forEach((line, i) => {
    if (i) el.appendChild(document.createElement('br'));
    el.appendChild(document.createTextNode(line));
  });
  $('tutorial-next').textContent = tutorialStep === steps.length - 1 ? t('tutorial_done') : t('tutorial_next');
  $('tutorial-dots').innerHTML = steps
    .map((_, i) => `<span class="dot${i === tutorialStep ? ' active' : ''}"></span>`)
    .join('');
}

function startTutorial() {
  // Ask for the app's language first (not just the tour's) - it becomes
  // the app-wide preselected language and can still be changed later.
  $('tutorial-lang-step').classList.remove('hidden');
  $('tutorial-content-step').classList.add('hidden');
  $('tutorial-overlay').classList.remove('hidden');
  // Regular users read through the whole thing (no skip) - admin/owner
  // accounts already know the app, so they can jump straight past it.
  $('tutorial-skip').classList.toggle('hidden', !(isAdmin || isOwner));
}

function beginTutorialContent(lang) {
  setLang(lang);
  applyI18n();
  updateLangUI();
  $('tutorial-lang-step').classList.add('hidden');
  $('tutorial-content-step').classList.remove('hidden');
  tutorialStep = 0;
  renderTutorialStep();
}

async function endTutorial() {
  $('tutorial-overlay').classList.add('hidden');
  try { await api('/me/tutorial-seen', { method: 'POST' }); } catch { /* not critical */ }
}

$('tutorial-lang-pt').addEventListener('click', () => beginTutorialContent('pt'));
$('tutorial-lang-en').addEventListener('click', () => beginTutorialContent('en'));
$('tutorial-skip').addEventListener('click', () => endTutorial());

$('tutorial-next').addEventListener('click', () => {
  if (tutorialStep < tutorialSteps().length - 1) {
    tutorialStep++;
    renderTutorialStep();
  } else {
    endTutorial();
  }
});

/* -------------------------------- Idioma --------------------------------- */
// Single square button, like the theme toggle: shows the language that's
// currently active, not the one it switches to (that read as confusing -
// "en" showing while the app was in Portuguese).

function updateLangUI() {
  $('lang-toggle').textContent = getLang();
  // Also present (discreetly) on the login screen, pre-auth - see
  // login-lang-toggle in index.html/styles.css. getLang()/setLang() are
  // pure localStorage, no login required.
  $('login-lang-toggle').textContent = getLang();
}

$('lang-toggle').addEventListener('click', () => {
  setLang(getLang() === 'pt' ? 'en' : 'pt');
  // applyI18n() only rewrites nodes that carry data-i18n in the HTML.
  // Anything a render function bakes into innerHTML - the empty-feed lines,
  // the vote options, the memo checklist - is invisible to it, and used to
  // sit in the old language until that view's next poll came round, which
  // is seconds. Every such view is redrawn here instead.
  applyI18n();
  updateLangUI();
  applyNight();
  refreshNotifButton();
  loadConsequences();
  loadRataHistory();
  loadVotes();
  loadPlaza();
  loadChat();
  loadDedication();
  if (memoEnabled) loadMemo();
});

$('login-lang-toggle').addEventListener('click', () => {
  setLang(getLang() === 'pt' ? 'en' : 'pt');
  applyI18n();
  updateLangUI();
});

$('theme-toggle').addEventListener('click', () => toggleMode());

/* -------------------------------- Login ---------------------------------- */

wirePasswordToggle('token-input', 'token-toggle');

// Public demo only: offer the shared keys (GET /api/demo is empty anywhere
// else, so this stays hidden). Tapping one logs straight in with it.
(async () => {
  try {
    const { keys } = await (await fetch('/api/demo')).json();
    if (!keys?.length) return;
    const list = $('demo-keys-list');
    list.innerHTML = '';
    for (const k of keys) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'find-key-result';
      btn.innerHTML = `<span data-i18n="demo_role_${esc(k.role)}">${esc(t(`demo_role_${k.role}`))}</span><small>${esc(k.key)}</small>`;
      btn.addEventListener('click', () => {
        $('token-input').value = k.key;
        $('login-form').requestSubmit();
      });
      list.appendChild(btn);
    }
    $('demo-keys').classList.remove('hidden');
  } catch {
    // No demo on this server - nothing to show.
  }
})();

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (findKeyMode) return;
  const token = $('token-input').value.trim();
  $('login-error').textContent = '';
  try {
    setToken(token);
    const me = await api('/me');
    // Naming the account before leaving the page is what lets iCloud
    // Keychain store a real username/key pair rather than a stray password
    // with nothing attached.
    $('login-username').value = me.name || '';
    // Deliberately a navigation, not showApp(me). iOS only offers to save a
    // password when a form carrying one is submitted *and* the page then
    // changes - an SPA that quietly swaps a section for another never gives
    // it that signal, so the key was never saved and every guest had to keep
    // typing it. Boot re-reads the token from storage and calls /me again,
    // so the reload costs one request and changes nothing else.
    location.replace('/');
  } catch (err) {
    clearToken();
    $('login-error').textContent = err.message;
  }
});

// First-time key retrieval: for someone who's never logged in, find their
// own account by name (see GET /auth/unclaimed-users) and claim its key
// (see POST /auth/claim-key). Once claimed - by this flow or by ever
// logging in for real - the account no longer shows up here.
// Reuses the same #token-input slot in place (placeholder + type swap)
// instead of revealing a separate area below it, so clicking the link
// never shifts the page layout.
let findKeyMode = false;

function setFindKeyMode(on) {
  findKeyMode = on;
  const input = $('token-input');
  $('login-error').textContent = '';
  // Find-key mode never uses this line (no password to reject) - its
  // reserved empty-line height was pushing the results away from the
  // search bar they belong to.
  $('login-error').classList.toggle('hidden', on);
  $('find-key-results').innerHTML = '';
  input.value = '';
  input.type = on ? 'text' : 'password';
  // In find-key mode this same box is a name search, not a key - leaving
  // current-password on it would have the password manager offering to fill
  // a key into a field looking someone up by name.
  input.setAttribute('autocomplete', on ? 'off' : 'current-password');
  input.setAttribute('data-i18n-ph', on ? 'find_key_ph' : 'access_key');
  input.placeholder = t(on ? 'find_key_ph' : 'access_key');
  $('token-toggle').classList.toggle('hidden', on);
  $('token-toggle').classList.remove('visible');
  $('login-submit-btn').classList.toggle('hidden', on);
  $('find-key-link').setAttribute('data-i18n', on ? 'find_key_back' : 'find_key_link');
  $('find-key-link').textContent = t(on ? 'find_key_back' : 'find_key_link');
  if (on) input.focus();
}

$('find-key-link').addEventListener('click', () => setFindKeyMode(!findKeyMode));

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* best effort */ }
    document.body.removeChild(ta);
  }
}

let findKeyTimer = null;
$('token-input').addEventListener('input', () => {
  if (!findKeyMode) return;
  clearTimeout(findKeyTimer);
  const name = $('token-input').value.trim();
  if (name.length < 3) {
    $('find-key-results').innerHTML = '';
    return;
  }
  findKeyTimer = setTimeout(async () => {
    try {
      const { users } = await api(`/auth/unclaimed-users?name=${encodeURIComponent(name)}`);
      $('find-key-results').innerHTML = users.length
        ? users.map((u) => `<button type="button" class="find-key-result" data-claim-user="${u.id}">${esc(u.name)}</button>`).join('')
        : `<p class="muted">${t('find_key_no_match')}</p>`;
      $('find-key-results').querySelectorAll('[data-claim-user]').forEach((b) => {
        b.addEventListener('click', async () => {
          try {
            const r = await api('/auth/claim-key', { method: 'POST', body: { userId: Number(b.dataset.claimUser) } });
            await copyToClipboard(r.token);
            setFindKeyMode(false); // reset back to the normal login form for next time
            await showAlert(t('find_key_revealed_msg', { name: r.name, token: r.token }));
            setToken(r.token);
            const me = await api('/me');
            showApp(me);
          } catch (err) {
            await showAlert(err.message);
          }
        });
      });
    } catch { /* transient network hiccup - next keystroke retries */ }
  }, 300);
});

// Logout itself lives on the Settings page now (settings.js) - it's rare
// enough not to need a permanent topbar icon slot on every page.

/* --------------------------------- Tabs ---------------------------------- */

function selectTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  currentTab = tab;
  $('tab-plaza').classList.toggle('hidden', currentTab !== 'plaza');
  $('tab-rata').classList.toggle('hidden', currentTab !== 'rata');
  $('tab-outfit').classList.toggle('hidden', currentTab !== 'outfit');
  $('tab-chat').classList.toggle('hidden', currentTab !== 'chat');
  $('tab-memo').classList.toggle('hidden', currentTab !== 'memo');
  applyNight();
  if (currentTab === 'plaza') startPlazaPolling(); else stopPlazaPolling();
  if (currentTab === 'rata') startRataPolling(); else stopRataPolling();
  if (currentTab === 'outfit') startOutfitPolling(); else stopOutfitPolling();
  if (currentTab === 'chat') { startChatPolling(); loadDedication(); } else stopChatPolling();
  if (currentTab === 'memo') startMemoPolling(); else stopMemoPolling();
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => selectTab(btn.dataset.tab));
});

document.querySelectorAll('[data-goto-tab]').forEach((btn) => {
  btn.addEventListener('click', () => selectTab(btn.dataset.gotoTab));
});

// Logo doubles as a "go home" shortcut, one click from anywhere - lands
// on Wall, or Rata when Wall is disabled (matches the landing-tab choice
// showApp() already makes for that same case).
document.querySelector('.brand-name').addEventListener('click', () => {
  selectTab(plazaEnabled ? 'plaza' : 'rata');
});

/* --------------------------------- Chat ----------------------------------- */
// Open, ephemeral group chat. Polled (not real-time/websocket) - simplest
// fit for this app's minimal-stack style. Messages expire server-side.

let chatPollTimer = null;

function startChatPolling() {
  loadChat();
  if (chatPollTimer) return;
  chatPollTimer = setInterval(loadChat, 3000);
}

function stopChatPolling() {
  if (chatPollTimer) {
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }
}

async function loadChat() {
  try {
    const { messages } = await api('/chat/messages');
    const el = $('chat-messages');
    const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    el.innerHTML = messages.length
      ? messages.map((m) => `
        <div class="chat-msg">
          <div class="chat-msg-head">
            <span class="chat-msg-author">${esc(m.author)}</span>
            <span class="chat-msg-time">${esc(m.time)}</span>
          </div>
          <div class="chat-msg-text">${esc(m.text)}</div>
        </div>`).join('')
      : `<p class="chat-empty">${t('chat_empty')}</p>`;
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  } catch { /* transient network hiccup - the next poll will retry */ }
}

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-text');
  const text = input.value.trim();
  if (!text) return;
  try {
    await api('/chat/messages', { method: 'POST', body: { text } });
    input.value = '';
    await loadChat();
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
  } catch (err) {
    await showAlert(err.message);
  }
});

/* --------------------------------- Memo ----------------------------------- */
// 5x/day, at a random moment (different for every guest), a push
// notification asks for a photo/video within 15 minutes ("slot"). Polled
// every 15s for the server's own state (a new slot notified, an upload
// landing from elsewhere) plus a 1s local ticker that just counts an open
// slot's remaining time down without hitting the server every second.

let memoPollTimer = null;
let memoTickTimer = null;
let memoSlotsCache = [];
let memoFeedCache = [];
let memoFeedLocked = false;
// Set while a slot's upload request is in flight - both the poll and the
// ticker skip re-rendering while this is set, so a fetch already in
// progress doesn't get its dot clobbered mid-upload.
let memoUploadingSlotId = null;

function startMemoPolling() {
  loadMemo();
  if (!memoPollTimer) memoPollTimer = setInterval(loadMemo, 15000);
  if (!memoTickTimer) memoTickTimer = setInterval(tickMemoCountdowns, 1000);
}

function stopMemoPolling() {
  if (memoPollTimer) { clearInterval(memoPollTimer); memoPollTimer = null; }
  if (memoTickTimer) { clearInterval(memoTickTimer); memoTickTimer = null; }
}

/**
 * The capture attribute, but only where there is a camera to capture from.
 *
 * On a phone it is the point of Memo: the dot opens the camera rather than
 * the photo library, so a moment is shot now and not dug out of last
 * August. On a desktop there is no camera app to hand off to, and the
 * attribute only narrows what the file picker will offer - which is why
 * uploading from a laptop did nothing at all.
 *
 * Accept covers video as well as stills. The server has always taken both
 * (see the fileFilter on the upload route) and the feed renders a <video>
 * for them, but the input asked for image/* only - so the video half of a
 * supported feature was unreachable from every device.
 */
function memoCaptureAttr() {
  const hasCamera = window.matchMedia?.('(pointer: coarse)')?.matches;
  return hasCamera ? ' capture="environment"' : '';
}

// Your own uploads from this visit are shown from this device (instant, and in
// the public demo the server only holds a placeholder for them).
const memoLocal = new Map();
function memoUploadUrl(uploadId) {
  if (memoLocal.has(Number(uploadId))) return memoLocal.get(Number(uploadId));
  return `/api/memo/uploads/${uploadId}?token=${encodeURIComponent(getToken())}`;
}

async function loadMemo() {
  if (memoUploadingSlotId) return;
  try {
    const { slots } = await api('/memo/today');
    memoSlotsCache = slots;
    renderMemoDots();
  } catch { /* transient network hiccup - the next poll retries */ }
  loadMemoFeed();
}

function tickMemoCountdowns() {
  if (memoUploadingSlotId) return;
  let changed = false;
  memoSlotsCache.forEach((s) => {
    if (s.status === 'open') {
      s.secondsLeft -= 1;
      if (s.secondsLeft <= 0) { s.status = 'missed'; changed = true; }
    }
  });
  if (changed) renderMemoDots();
}

const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

// Demure by design: 5 small dots instead of a detailed row-per-slot list -
// filled in as they're completed, no times or countdowns cluttering it.
// The dots are read-only status, never controls: tapping a circle to open a
// The open moment IS the button. A separate "shoot" control below five
// dots asked you to read the dots, work out which one was live, and then
// press something else - when the live one is already the thing pulsing at
// you. The other four stay plain spans, so only the actionable one is
// pressable and the row still reads as progress rather than as a toolbar.
function renderMemoDots() {
  // Fixed left-to-right chronological order (slot_index, as returned by the
  // API) - not reordered by status. The dots are meant to read like a
  // progress bar ("2 of 5 done so far"), which only works if position
  // means something stable instead of shuffling completed ones around.
  $('memo-dots').innerHTML = memoSlotsCache.map((s) => {
    const label = t('memo_slot_label', { n: ROMAN_NUMERALS[s.slotIndex] ?? s.slotIndex + 1 });
    if (s.status !== 'open') {
      return `<span class="memo-dot memo-dot-${s.status}" role="img" aria-label="${esc(label)}"></span>`;
    }
    return `<button type="button" class="memo-dot memo-dot-open" data-memo-upload-btn="${s.id}"
              aria-label="${esc(t('memo_shoot_btn'))}"></button>
            <input type="file" accept="image/*,video/*"${memoCaptureAttr()}
              class="file-input-visually-hidden" data-memo-file-input="${s.id}" />`;
  }).join('');

  // Kept as the place the per-slot message lands, but it no longer carries
  // a button of its own.
  $('memo-shoot').innerHTML = '';
  $('memo-shoot').classList.add('hidden');
}

// Must stay in step with MEMO_REACTION_EMOJI in src/memo.js, which is what
// the server validates against - a value listed only here renders a button
// the API then rejects, and one listed only there can never be sent.
const MEMO_REACTION_EMOJI = ['❤️', '💦', '👎'];

// Hand-drawn-style FILLED icons instead of the OS's own emoji glyphs - a
// native emoji renders as whatever the platform's font happens to look
// like (very "iPhone"), which clashes with the app's own drawn-icon
// language used elsewhere (sun/moon toggle, eye/eye-off, bell - see
// index.html), themselves stroke-only. These are filled instead of
// stroked specifically so they stay visible at the small size a reaction
// button needs - a thin outline nearly disappears there. currentColor
// still ties them to each theme's accent.
// Every one of these is drawn symmetrical about x=12 and boxed so its
// bounding box centres on 12,12. The heart used to be neither: its left
// lobe reached x=4 and its right x=22, and the bottom "point" was a flat
// two-unit segment rather than a tip, so the whole glyph sat right and low
// inside a button that was centring it perfectly well. Anything added here
// has to keep that property or it will look misaligned for the same reason.
const MEMO_REACTION_ICON = {
  '\u2764\uFE0F': '<path d="M12 20.4C12 20.4 3.6 15 3.6 9C3.6 5.9 6 3.7 8.6 3.7C10.2 3.7 11.3 4.6 12 5.8C12.7 4.6 13.8 3.7 15.4 3.7C18 3.7 20.4 5.9 20.4 9C20.4 15 12 20.4 12 20.4Z"/>',
  // Thumb down. Cuff on the left, hand falling to the right, so it reads at
  // 19px without needing an outline - same filled treatment as the other two.
  '\u{1F44E}': '<rect x="2.8" y="4.2" width="3.8" height="10.4" rx="1.1"/><path d="M8 4.2h8.9c1.1 0 2.1.7 2.4 1.7l1.9 5.4c.5 1.4-.5 2.9-2 2.9h-4.7l.7 3.2c.2 1-.2 2-1 2.5-.5.3-1.2.2-1.6-.3L8 13.6V4.2z"/>',
  // Three teardrops falling on a diagonal, tips up-left - the previous pair
  // sat upright and read as two plain blobs rather than splashing water.
  '\u{1F4A6}': '<path transform="rotate(-14 8.4 15.9)" d="M8.4 5.24C9.71 9.72 12.75 11.33 12.75 15.9A4.35 4.35 0 0 1 4.05 15.9C4.05 11.33 7.1 9.72 8.4 5.24Z"/><path transform="rotate(-52 17.2 7)" d="M17.2 -1.21C18.2 2.24 20.55 3.48 20.55 7A3.35 3.35 0 0 1 13.85 7C13.85 3.48 16.2 2.24 17.2 -1.21Z"/><path transform="rotate(-42 18.3 17.7)" d="M18.3 10.96C19.13 13.79 21.05 14.81 21.05 17.7A2.75 2.75 0 0 1 15.55 17.7C15.55 14.81 17.48 13.79 18.3 10.96Z"/>',
};


function memoReactionIcon(emoji) {
  return `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">${MEMO_REACTION_ICON[emoji]}</svg>`;
}

// The current moment's feed - what everyone else posted for the slot that
// is live now, with a light row of quick-tap emoji reactions per photo
// instead of a comment thread. Sealed until this guest has posted theirs.
async function loadMemoFeed() {
  try {
    const { uploads, locked } = await api('/memo/feed');
    memoFeedCache = uploads;
    memoFeedLocked = locked;
    renderMemoFeed();
  } catch { /* transient network hiccup - the next poll retries */ }
}

function renderMemoFeed() {
  // Nothing at all until you have posted - not even a card saying you have
  // to. Open Memo mid-moment and all there is to see is the five dots and
  // the live one waiting to be pressed; the moment's board appears only
  // once you have put yours in, and then it holds everyone's, your own
  // included. That is the whole shape of the feature (BeReal's), and a
  // "yours first" placeholder standing where the board goes gave away that
  // there was something behind it before it had been earned.
  $('memo-feed-card').classList.toggle('hidden', memoFeedLocked || memoFeedCache.length === 0);
  $('memo-feed-help').dataset.i18n = 'memo_feed_help';
  $('memo-feed-help').textContent = t('memo_feed_help');
  if (memoFeedLocked || !memoFeedCache.length) {
    $('memo-feed').innerHTML = '';
    return;
  }
  $('memo-feed').innerHTML = memoFeedCache.map((u) => {
    const preview = u.kind === 'video'
      ? `<video class="memo-feed-thumb" src="${memoUploadUrl(u.id)}" muted controls></video>`
      : `<img class="memo-feed-thumb${u.flipped ? ' flipped' : ''}" src="${memoUploadUrl(u.id)}" alt="" />`;
    // Your own photo only. iOS mirrors the front camera in its own Camera
    // app but not in a web capture, so a selfie shot here arrives the
    // opposite way round to the one in your gallery - and nothing in the
    // file says which camera took it, so this is a choice rather than
    // something that can be detected. Photos only: a video carries its
    // rotation elsewhere and flipping one is a different job.
    const flipBtn = u.mine && u.kind === 'photo'
      ? `<button type="button" class="memo-flip${u.flipped ? ' active' : ''}" data-memo-flip="${u.id}" data-flipped="${u.flipped ? '1' : '0'}" aria-label="${esc(t('memo_flip'))}" title="${esc(t('memo_flip'))}">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <path d="M12 3v18"/><path d="M8 7 3 12l5 5V7Z"/><path d="M16 7l5 5-5 5V7Z"/>
           </svg>
         </button>`
      : '';
    // Your own moment is here so you can see what you captured, but the
    // reaction row is not: reacting to your own photo is not a thing, and
    // the counts on it are other people's business anyway.
    const reactionBar = u.mine ? '' : MEMO_REACTION_EMOJI.map((emoji) => {
      const count = u.reactions[emoji] || 0;
      const mine = u.myReaction === emoji;
      return `<button type="button" class="memo-reaction${mine ? ' active' : ''}" data-memo-react="${u.id}" data-emoji="${emoji}">${memoReactionIcon(emoji)}${count ? `<span>${count}</span>` : ''}</button>`;
    }).join('');
    const name = u.mine ? t('memo_feed_mine') : esc(u.userName);
    return `
      <div class="memo-feed-item${u.mine ? ' memo-feed-item-mine' : ''}">
        ${preview}
        <div class="memo-feed-meta">
          <span class="memo-feed-name">${name}</span>
          <div class="memo-reaction-bar">${reactionBar}${flipBtn}</div>
        </div>
      </div>`;
  }).join('');
}

// Delegated (not one listener per dot) since the whole thing is rebuilt on
// every render - a tap just forwards to its own hidden file input, same
// pattern as the outfit registration photo picker (see #register-photo-btn
// in settings.js) but scoped to this container.
$('memo-dots').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-memo-upload-btn]');
  if (!btn) return;
  $('memo-dots').querySelector(`[data-memo-file-input="${btn.dataset.memoUploadBtn}"]`)?.click();
});

$('memo-dots').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-memo-file-input]');
  const file = input?.files?.[0];
  if (!file) return;
  const slotId = input.dataset.memoFileInput;
  const btn = $('memo-shoot').querySelector('[data-memo-upload-btn]');
  memoUploadingSlotId = slotId;
  if (btn) { btn.disabled = true; btn.textContent = t('memo_uploading'); }
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`/api/memo/slots/${slotId}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ? t(data.error) : `Error ${res.status}`);
    }
    const made = await res.json().catch(() => ({}));
    if (made.id && file.type.startsWith('image/')) memoLocal.set(Number(made.id), URL.createObjectURL(file));
  } catch (err) {
    await showAlert(err.message);
  } finally {
    memoUploadingSlotId = null;
    loadMemo();
  }
});

// Tapping your own already-active reaction clears it (toggle) - see
// toggleReaction() in memo.js, which mirrors that same rule server-side.
$('memo-feed').addEventListener('click', async (e) => {
  const flip = e.target.closest('[data-memo-flip]');
  if (flip) {
    const next = flip.dataset.flipped !== '1';
    // Turned on the image before the request lands. The whole point of this
    // control is judging how the photo looks, and a mirror that waits for a
    // round trip is a mirror you cannot judge against.
    const img = flip.closest('.memo-feed-item')?.querySelector('.memo-feed-thumb');
    img?.classList.toggle('flipped', next);
    flip.classList.toggle('active', next);
    flip.dataset.flipped = next ? '1' : '0';
    flip.disabled = true;
    try {
      await api(`/memo/uploads/${flip.dataset.memoFlip}/flip`, { method: 'POST', body: { flipped: next } });
    } catch {
      // Put it back rather than leave the screen disagreeing with the server.
      img?.classList.toggle('flipped', !next);
      flip.classList.toggle('active', !next);
      flip.dataset.flipped = next ? '0' : '1';
    } finally { flip.disabled = false; }
    return;
  }

  const btn = e.target.closest('[data-memo-react]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await api(`/memo/uploads/${btn.dataset.memoReact}/react`, { method: 'POST', body: { emoji: btn.dataset.emoji } });
    loadMemoFeed();
  } catch { /* transient - next poll reconciles */ }
  finally { btn.disabled = false; }
});

// Shared by both deep-link paths below: a fresh page load reads its own
// ?tab=&night=, and the service worker message listener reads the same
// params out of a notification's url without a real navigation.
function applyTabAndNight(params) {
  const tab = params.get('tab');
  const night = params.get('night');
  if (!tab && !night) return;

  if (night && NIGHTS.includes(night)) {
    localStorage.setItem(NIGHT_KEY, night);
  }
  if (TABS.includes(tab) && (tab !== 'plaza' || plazaEnabled)) {
    selectTab(tab);
  }
}

// Notification taps land here with ?tab=&night= so the app opens straight
// on the result being announced, instead of just wherever it was left.
function applyDeepLinkParams() {
  applyTabAndNight(new URLSearchParams(location.search));
  history.replaceState({}, '', location.pathname);
}

// Taps that arrive while this page is already open, and the cold-start
// leftovers - both shared with Settings, see wireDeepLinks() in push.js.
const followDeepLink = wireDeepLinks(applyTabAndNight);

/* ----------------------------- Notificacoes ------------------------------ */

wireNotifButton('notif-btn');

/* --------------------------------- Plaza ---------------------------------- */
// Landing tab: a feed of owner/admin-authored posts (announcements + polls),
// pinned ones first. See renderPlazaPost() below.

// "5 seconds ago" style, from a raw "YYYY-MM-DD HH:MM:SS[.mmm]" UTC
// timestamp (see formatTimeInZone() server-side for the equivalent
// HH:MM version - this one needs the actual elapsed time instead).
function timeAgo(dbTimestamp) {
  const iso = `${String(dbTimestamp).replace(' ', 'T')}Z`;
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 5) return t('time_just_now');
  if (sec < 60) return t('time_ago_seconds', { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t(min === 1 ? 'time_ago_minute' : 'time_ago_minutes', { n: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t(hr === 1 ? 'time_ago_hour' : 'time_ago_hours', { n: hr });
  const day = Math.round(hr / 24);
  return t(day === 1 ? 'time_ago_day' : 'time_ago_days', { n: day });
}

// Renders one post as either a plain-announcement "torn column" or a poll
// "magazine card" (see .plaza-post-announcement/.plaza-post-poll in
// styles.css) - the two banner styles so a glance tells announcements and
// polls apart by shape (a poll's options make that obvious on their own),
// without needing a type label spelling it out. Pinned announcements
// (owner-only, see the admin Plaza page) already sort first from the API -
// this just marks them visually so a pin doesn't blend into the rest of
// the feed.
const PLAZA_TYPE_LABEL = {
  poll: 'plaza_type_poll',
  links: 'plaza_type_links',
  announcement: 'plaza_type_announcement',
  podium: 'plaza_type_podium',
  video: 'plaza_type_video',
};

/**
 * Renders text the server may have translated. There is deliberately no
 * control to see the original: the app's own language toggle already is
 * that control, and a second one under every message was clutter on a
 * screen that is mostly other people's messages.
 */
function translatedText(text, _original, { className = '', linkified = false } = {}) {
  const body = linkified ? linkify(esc(text)) : esc(text);
  return `<p class="${className}">${body}</p>`;
}

function renderPlazaPost(post) {
  const byline = t('plaza_post_byline', { author: post.author, time: timeAgo(post.created_at) });
  const pinnedBadge = post.pinnedAt ? `<span class="plaza-pinned-badge">${esc(t('plaza_post_pinned_label'))}</span>` : '';
  // Same "poll"/"announcement" labels the admin's own type picker already
  // uses, just surfaced here too - at a glance in a mixed feed, nothing
  // else says which kind of post this is before you start reading it.
  const typeLabel = `<h2 class="plaza-post-type">${esc(t(PLAZA_TYPE_LABEL[post.type] ?? 'plaza_type_announcement'))}</h2>`;

  // The post's photo, when it has one. The key travels in the query string
  // because an <img> cannot send an Authorization header - the same reason
  // memoUploadUrl() does it. Sits under the type label and above the words,
  // so the picture introduces the message instead of trailing it.
  const photoHtml = post.hasPhoto
    ? `<img class="plaza-post-photo" src="/api/plaza-posts/${post.id}/photo?token=${encodeURIComponent(getToken())}" alt="" loading="lazy" />`
    : '';

  // A published Snatch result. Its text is a JSON snapshot taken at publish
  // time (see createPodiumPost() in plaza.js), not a live lookup - so what
  // the party saw announced stays exactly that, even if the night is later
  // re-run or reset.
  if (post.type === 'podium') {
    let snap;
    try { snap = JSON.parse(post.text); } catch { return ''; }
    const rows = (snap.podium ?? []).map((r) => `
      <li class="podium-row">
        <span class="podium-medal" aria-hidden="true">${MEDAL_EMOJI[r.rank] ?? ''}</span>
        ${r.hasPhoto ? `<img class="podium-photo" src="${photoUrl(r.id)}" alt="" />` : '<span class="podium-photo podium-photo-empty"></span>'}
        <span class="podium-name">${esc(contestantLabel(r))}</span>
        <span class="votes">${r.votes} ${t(r.votes === 1 ? 'vote_one' : 'votes_short')}</span>
      </li>`).join('');
    const cong = snap.congeniality
      ? `<div class="podium-congeniality">
           <h3>${esc(t('congeniality_title'))}</h3>
           <p class="congeniality-winner">👑 ${esc(snap.congeniality.name)}</p>
         </div>`
      : '';
    return `
      <article class="plaza-post plaza-post-podium${post.pinnedAt ? ' pinned' : ''}">
        ${typeLabel}
        ${pinnedBadge}
        ${photoHtml}
        <p class="podium-night">${esc(t(`theme_${snap.night}`))}</p>
        <ol class="podium-list">${rows}</ol>
        ${cong}
        <p class="plaza-byline">${esc(byline)}</p>
      </article>`;
  }

  // The Memo day video. Its text is just the day; the file is served by
  // GET /memo/recaps/:day (see createVideoPost() in plaza.js).
  if (post.type === 'video') {
    return `
      <article class="plaza-post plaza-post-video${post.pinnedAt ? ' pinned' : ''}">
        ${typeLabel}
        ${pinnedBadge}
        ${photoHtml}
        <p class="podium-night">${esc(formatEuDate(post.text))}</p>
        <video class="wall-video-player" controls preload="none" src="${memoRecapUrl(post.text)}"></video>
        <p class="plaza-byline">${esc(byline)}</p>
      </article>`;
  }

  // A list of pointers out of the app - the form, the playlist, the album.
  // The name itself is the link, with its emoji beside it; there is no
  // trailing arrow, because a row where only the far edge looks tappable
  // invites aiming at the edge. rel="noopener" on every one: these open in a
  // new tab, and without it the page opened gets a handle back on this one.
  // A links post reads as a note with the addresses tucked underneath, not
  // as a stack of boxed rows. Each link used to be its own bordered card,
  // which turned a short list into a piece of furniture heavier than the
  // announcement it sat next to. They stay one per line so a thumb can
  // still tell them apart - just quiet: no box, no fill, only the name.
  if (post.type === 'links') {
    // The emoji sits outside the anchor: inside it, the underline ran along
    // under the emoji too, which looked like the picture was part of the
    // link. Only the words are the link, and only the words are underlined.
    const rows = (post.links ?? []).map((l) => `
      <li>
        ${l.emoji ? `<span class="plaza-link-emoji" aria-hidden="true">${esc(l.emoji)}</span>` : ''}
        <a class="plaza-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>
      </li>`).join('');
    return `
      <article class="plaza-post plaza-post-links${post.pinnedAt ? ' pinned' : ''}">
        ${typeLabel}
        ${pinnedBadge}
        ${photoHtml}
        ${translatedText(post.text, post.originalText, { className: 'plaza-post-text plaza-links-intro', linkified: true })}
        <ul class="plaza-links">${rows}</ul>
        <p class="plaza-byline">${esc(byline)}</p>
      </article>`;
  }

  // An announcement is the one post type that is purely words, so it gets
  // the highlight treatment the rest of the app uses for the thing you are
  // meant to read - the tinted box with the theme's own motif down its
  // side. It was the only place on the Wall that never used it.
  if (post.type !== 'poll') {
    return `
      <article class="plaza-post plaza-post-announcement${post.pinnedAt ? ' pinned' : ''}">
        ${typeLabel}
        ${pinnedBadge}
        ${photoHtml}
        ${translatedText(post.text, post.originalText, { className: `plaza-post-text highlight${post.text.length > 140 ? ' is-long' : ''}`, linkified: true })}
        <p class="plaza-byline">${esc(byline)}</p>
      </article>`;
  }

  const totalVotes = post.options.reduce((sum, o) => sum + o.votes, 0);
  const alreadyVoted = post.myOptionId != null;
  // A vote is final the instant it lands (see castPlazaVote() server-side),
  // so tapping an option asks first rather than staging it behind a separate
  // "votar" button - one tap plus a yes/no, instead of two taps with no
  // safety net at the end of them.
  const pendingOptionId = pendingPollSelections.get(post.id);
  const optionsHtml = post.options.map((o) => {
    const pct = totalVotes ? Math.round((o.votes / totalVotes) * 100) : 0;
    const isMine = post.myOptionId === o.id;
    const isPending = !alreadyVoted && pendingOptionId === o.id;
    const classes = `plaza-poll-option${isMine ? ' voted' : ''}${isPending ? ' pending' : ''}${alreadyVoted ? ' readonly' : ''}`;
    const body = `
        <span class="plaza-poll-option-fill" style="width:${pct}%"></span>
        <span class="plaza-poll-option-label">${esc(o.label)}</span>
        <span class="plaza-poll-option-pct">${pct}%</span>`;
    // Once you've voted, the choice is locked - render plain divs instead of
    // buttons so there's nothing left to click, rather than disabling a
    // button and having to fight its default styles.
    return alreadyVoted
      ? `<div class="${classes}">${body}</div>`
      : `<button type="button" class="${classes}" data-select-post="${post.id}" data-select-option="${o.id}">${body}</button>`;
  }).join('');

  const submitHtml = '';

  return `
    <article class="plaza-post plaza-post-poll${post.pinnedAt ? ' pinned' : ''}">
      ${typeLabel}
      ${pinnedBadge}
      ${translatedText(post.text, post.originalText, { className: 'plaza-post-text', linkified: true })}
      <div class="plaza-poll-options">${optionsHtml}</div>
      ${submitHtml}
      <p class="plaza-byline">${esc(byline)} · ${t(totalVotes === 1 ? 'plaza_post_vote_count_one' : 'plaza_post_vote_count_other', { n: totalVotes })}</p>
    </article>`;
}

// Poll option picked but not yet submitted, per post id - local-only until
// "votar" is pressed (see renderPlazaPost()). Cleared once the vote lands.
const pendingPollSelections = new Map();
// Last feed rendered, so picking an option can re-render locally (just
// updating pendingPollSelections) without a round-trip to the server.
let lastPlazaPosts = [];

function renderPlazaFeed(posts) {
  lastPlazaPosts = posts;
  $('plaza-feed').innerHTML = posts.map(renderPlazaPost).join('');
  $('plaza-feed-empty').classList.toggle('hidden', posts.length > 0);

  $('plaza-feed').querySelectorAll('[data-select-post]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const postId = Number(btn.dataset.selectPost);
      const optionId = Number(btn.dataset.selectOption);
      const label = btn.querySelector('.plaza-poll-option-label')?.textContent ?? '';
      // The confirm is the whole safety net now - a poll vote cannot be
      // changed once cast, so name the option being chosen rather than
      // asking a generic "are you sure".
      if (!(await showConfirm(t('plaza_confirm_vote', { option: label })))) return;
      try {
        const { posts: updated } = await api(`/plaza-posts/${postId}/vote`, {
          method: 'POST',
          body: { optionId },
        });
        pendingPollSelections.delete(postId);
        renderPlazaFeed(updated);
      } catch (err) {
        await showAlert(err.message);
        pendingPollSelections.delete(postId);
        // A second tab/click can lose the race against the vote that just
        // landed - resync from the server so the UI locks to read-only
        // instead of leaving stale, still-selectable options on screen.
        loadPlaza();
      }
    });
  });
}

// Polled while the tab is open, same as chat, so a new/pinned post or a
// poll's live tally shows up without a manual reload.
let plazaPollTimer = null;

function startPlazaPolling() {
  loadPlaza();
  if (plazaPollTimer) return;
  plazaPollTimer = setInterval(loadPlaza, 4000);
}

function stopPlazaPolling() {
  if (plazaPollTimer) {
    clearInterval(plazaPollTimer);
    plazaPollTimer = null;
  }
}

async function loadPlaza() {
  try {
    const { posts } = await api('/plaza-posts');
    renderPlazaFeed(posts);
  } catch { /* transient - leaves whatever was last shown */ }
}

function memoRecapUrl(day) {
  return `/api/memo/recaps/${encodeURIComponent(day)}?token=${encodeURIComponent(getToken())}`;
}

/* ------------------------------- Rata Game ------------------------------- */
// Polled while the tab is open, so a consequence revealed by the
// scheduled cron (or an admin's manual reveal) shows up without a manual reload.
let rataPollTimer = null;

async function loadRataHistory() {
  try {
    const { consequences } = await api('/consequences/revealed');
    // Nothing revealed yet (very start of the party) is the one time this
    // would show - hidden entirely instead of an empty-state message, same
    // as Memo's recap card.
    $('rata-history-card').classList.toggle('hidden', consequences.length === 0);
    if (consequences.length) {
      $('rata-history').innerHTML = consequences.map((c) => {
        // No status tags/assign jargon here (that's admin-only, see
        // renderConsequenceCard() in settings.js) - just plain "done by X"
        // / "pending by X", or bare "pending" if nobody's confirmed
        // holding it yet (revealed but unassigned).
        const line = c.approved_at
          ? t('rata_public_done_by', { name: esc(c.assignedName) })
          : c.assignedName
            ? t('rata_public_pending_by', { name: esc(c.assignedName) })
            : t('rata_public_pending_unassigned');
        const canMarkDone = c.assigned_user_id === myUserId && !c.done_at;
        // Just the hour here (this is the guest-facing view) - the admin
        // side shows hours and minutes, this one only needs to say
        // roughly when.
        const hour = c.revealed_at ? `${formatHourInZone(c.revealed_at)}h` : '';
        return `<div class="rata-history-item">
          ${translatedText(c.text, c.originalText, { className: 'rata-history-text' })}
          <div class="rata-history-meta">
            <span class="muted">${line}${hour ? ` · ${hour}` : ''}</span>
          </div>
          ${canMarkDone ? `<button type="button" class="small" data-mark-done="${c.id}" style="margin-top:8px">${t('rata_mark_done_btn')}</button>` : ''}
        </div>`;
      }).join('');
    }
  } catch { /* transient - leaves whatever was last shown */ }
}

$('rata-history').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-mark-done]');
  if (!btn) return;
  if (!(await showConfirm(t('rata_mark_done_confirm')))) return;
  try {
    await api(`/consequences/${btn.dataset.markDone}/mark-done`, { method: 'POST' });
    loadRataHistory();
  } catch (err) {
    await showAlert(err.message);
  }
});

function startRataPolling() {
  loadConsequences();
  loadRataHistory();
  if (rataPollTimer) return;
  rataPollTimer = setInterval(() => { loadConsequences(); loadRataHistory(); }, 5000);
}

function stopRataPolling() {
  if (rataPollTimer) {
    clearInterval(rataPollTimer);
    rataPollTimer = null;
  }
}

async function loadConsequences() {
  try {
    const data = await api('/consequences/current');
    $('current-consequence').textContent = data.current ? data.current.text : t('rata_none');
    $('pending-line').textContent = t('rata_pending', { n: data.pending });

    if (data.mySuggestion) {
      $('suggest-area').innerHTML =
        `<p class="highlight${data.mySuggestion.text.length > 140 ? ' is-long' : ''}">${t('rata_my')}<br><em>&ldquo;${esc(data.mySuggestion.text)}&rdquo;</em></p>`;
      $('suggest-msg').textContent = t('rata_one_per_day');
    } else {
      $('suggest-msg').textContent = '';
    }
  } catch {
    // Never surface a raw error/status code here - it used to leak "Erro
    // 500" straight into the card on a server-side crash (see app.js's
    // new global error handler + the timezone validation that caused it).
    $('current-consequence').textContent = t('rata_load_error');
  }
}

const SUGGEST_MAX = Number($('suggest-text').getAttribute('maxlength'));
function updateSuggestCount() {
  const used = $('suggest-text').value.length;
  $('suggest-count').textContent = `${used}/${SUGGEST_MAX}`;
  // Only call it out once it actually matters - a permanently coloured
  // counter reads as an error state on an empty field.
  $('suggest-count').classList.toggle('at-limit', used >= SUGGEST_MAX);
}
$('suggest-text').addEventListener('input', updateSuggestCount);
updateSuggestCount();

$('suggest-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('suggest-text').value.trim();
  if (!text) return;
  // One suggestion per day, and it's spent the moment this lands - same
  // "no take-backs" prompt Snatch voting gets, for the same reason.
  if (!(await showConfirm(t('rata_suggest_confirm')))) return;
  try {
    await api('/consequences', { method: 'POST', body: { text } });
    $('suggest-text').value = '';
    updateSuggestCount();
    loadConsequences();
  } catch (err) {
    $('suggest-msg').textContent = err.message;
  }
});

/* ----------------------- Mensagem para o aniversariante ------------------ */
// Written on Plaza, read only by the person it is for. One each, rewritable
// until the party ends - people redraft these, and being told you already
// used yours up would be a mean way to find that out.

// Two states, one card. Written: the message sits in a highlight box, the
// way the app shows anything it wants read rather than filled in, and the
// button offers to edit. Editing: a plain box and a save button. No cap -
// this is the one place someone might write at length, and a keepsake cut
// off mid-sentence is worse than a long one.
let dedicationEditing = false;

async function loadDedication() {
  let data;
  try {
    data = await api('/dedications/mine');
  } catch {
    return; // transient - the card stays as it was
  }
  const written = data.dedication?.text ?? '';
  const area = $('dedication-area');
  const editing = dedicationEditing || !written;

  area.innerHTML = editing
    ? `<textarea id="dedication-text" rows="4" placeholder="${esc(t('dedication_ph'))}">${esc(written)}</textarea>
       <div class="actions-right">
         <button type="button" id="dedication-save-btn" class="small">${esc(t('dedication_save_btn'))}</button>
       </div>
       <p id="dedication-msg" class="muted" style="margin-top:8px"></p>`
    : `<p class="highlight dedication-written${written.length > 140 ? ' is-long' : ''}">${esc(written)}</p>
       <div class="actions-right">
         <button type="button" id="dedication-edit-btn" class="small ghost">${esc(t('dedication_update_btn'))}</button>
       </div>
       <p id="dedication-msg" class="muted" style="margin-top:8px">${esc(t('dedication_saved_note'))}</p>`;

  if (!editing) {
    $('dedication-edit-btn').addEventListener('click', () => {
      dedicationEditing = true;
      loadDedication();
    });
    return;
  }

  $('dedication-save-btn').addEventListener('click', async () => {
    const text = $('dedication-text').value.trim();
    if (!text) return;
    const msg = $('dedication-msg');
    msg.classList.remove('error');
    try {
      await api('/dedications/mine', { method: 'PUT', body: { text } });
      dedicationEditing = false;
      loadDedication();
    } catch (err) {
      msg.classList.add('error');
      msg.textContent = err.message;
    }
  });
}

/* ------------------------------ Best Look ------------------------------- */

// Voting is per NIGHT. Each night has its own aesthetic (theme) and its own
// independent vote. The selector below picks the active night, re-skins the
// WHOLE page and shows that night's vote. Nights this edition: furnished | swamp.
const NIGHTS = ['furnished', 'swamp'];
const NIGHT_KEY = 'appivo_night';
const TABS = ['plaza', 'chat', 'memo', 'rata', 'outfit'];

function getNight() {
  const n = localStorage.getItem(NIGHT_KEY);
  return NIGHTS.includes(n) ? n : NIGHTS[0];
}

function applyNight() {
  const night = getNight();
  // The night's theme re-skins the WHOLE page, but only when Best Look is active.
  const onOutfit = currentTab === 'outfit';
  NIGHTS.forEach((n) => {
    document.body.classList.toggle(`theme-${n}`, onOutfit && night === n);
  });
  document.body.classList.toggle('theme-rata', currentTab === 'rata');
  // Theme classes follow the DISPLAYED name, not the internal tab id: the
  // chat feature is now labelled "Plaza" and gets the plaza-motif
  // background (city-square/agora), while the old plaza/announcements
  // feature is now labelled "Wall" and gets the mural texture that used to
  // belong to the chat tab - swapped on purpose, see index.html's tab nav
  // comment for the full "plaza"/"chat" internal-vs-displayed mapping.
  document.body.classList.toggle('theme-mural', currentTab === 'plaza');
  document.body.classList.toggle('theme-plaza', currentTab === 'chat');
  document.body.classList.toggle('theme-memo', currentTab === 'memo');
  // The switch's own highlighted half already names the night, so there's
  // no separate "noite · swamp" line to keep in sync any more.
  document.querySelectorAll('#theme-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === night);
  });
  // Every tab re-skins the whole page, so the status bar has to follow.
  syncThemeColor();
}

document.querySelectorAll('#theme-switch button').forEach((b) => {
  b.addEventListener('click', () => {
    localStorage.setItem(NIGHT_KEY, b.dataset.theme);
    applyNight();
    // A different night has its own separate registration state - force a
    // fresh render instead of leaving the other night's blank form up (see
    // registerFormReady in renderRegistration()).
    registerFormReady = false;
    // Draw whatever this night looked like last time straight away, so the
    // colours and the content change together. The fetch below corrects it
    // a moment later, and almost never has anything to correct - nothing
    // about a night changes while you are looking at the other one.
    const cached = votesByNight[b.dataset.theme];
    if (cached) renderVotes(cached, b.dataset.theme);
    loadVotes();
  });
});

/* ---------------------------- Candidatura (Best Look) -------------------- */
// Self-registration, only shown while the admin has this night in the
// 'registration' phase (see nightStatus() in src/time.js). Solo or teamed up
// with another user picked from /users/basic - a duo shares one contestant
// entry and one combined vote for the night (see castVote() server-side).

let registerMode = 'solo';
let registerPartnerId = null;
let registerPhotoDataUrl = null;
let usersCache = null;

// Best Look polls for updates every few seconds (see outfitPollTimer
// below), which re-renders this whole area - fine while nothing's in
// progress, destructive while it is. Picking a photo hands control to the
// OS camera/library picker for as long as the user takes, which both
// blurs focus (defeating the activeElement check in renderRegistration())
// and, if a re-render lands mid-pick, would swap out the very <input> the
// native picker is bound to - its eventual change event would then fire on
// a detached element with no listener, silently doing nothing. Set the
// moment a picker is opened. Cleared as soon as a file is actually chosen
// (the input's own change event - see openPhotoPicker() below), which is
// the one unambiguous signal available; focus/visibility firing on return
// is a backup for the "dismissed without choosing anything" case, since
// there's no picker-cancelled event to rely on instead. A stuck-true flag
// would silently freeze every future poll update on this tab, so a hard
// timeout backs both of those up regardless - worth a few seconds of
// missed polling in the worst case, not an indefinitely frozen tab.
let photoPickerOpen = false;
let photoPickerOpenTimer = null;
function openPhotoPicker(input) {
  photoPickerOpen = true;
  clearTimeout(photoPickerOpenTimer);
  photoPickerOpenTimer = setTimeout(() => { photoPickerOpen = false; }, 60000);
  input.click();
}
window.addEventListener('focus', () => { photoPickerOpen = false; });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') photoPickerOpen = false;
});
// True once the blank "you haven't registered yet" form has been built for
// the current not-registered state - skip rebuilding it on every poll tick
// past that point. Unlike the registered/confirmed view below, nothing
// about this state changes from the outside while it's showing, so there's
// no legitimate reason to redraw it - only reasons that would wipe
// whatever the user has typed/attached so far, including the gap right
// after returning from the photo picker but before refocusing the name
// field, which photoPickerOpen alone doesn't cover.
let registerFormReady = false;

async function ensureUsersCache() {
  if (!usersCache) usersCache = await api('/users/basic');
  return usersCache;
}

// Resizes/re-encodes a picked photo client-side before upload - a phone
// camera photo can easily be 5-10MB at full resolution, and the request
// (base64, in a JSON body) needs to stay small. This is a courtesy, not
// the enforcement - the server has its own hard cap (see decodePhoto() in
// src/votes.js) since a client-side limit alone can't be trusted.
// Builds an <img> src for a contestant's photo. The endpoint needs a
// Bearer token like every other request, but an <img> tag can't send
// custom headers - authenticate() also accepts ?token= for exactly this
// (see auth.js, originally added for the service worker).
function photoUrl(contestantId) {
  return `/api/outfit/contestants/${contestantId}/photo?token=${encodeURIComponent(getToken())}`;
}

function renderRegistration(data) {
  const card = $('register-card');
  const area = $('register-area');
  if (data.status !== 'registration') {
    card.classList.add('hidden');
    registerFormReady = false;
    return;
  }
  card.classList.remove('hidden');

  // A native photo picker is open over this area (see photoPickerOpen
  // above) - rebuilding the controls underneath it would pull the file
  // input out from under the pick in progress, whatever is being shown.
  if (photoPickerOpen) return;

  if (data.myContestant) {
    registerFormReady = false;
    const mine = data.myContestant;
    // A duo entry isn't live until the named partner agrees to it (see
    // registerContestant() server-side), so the two of them see different
    // things until then: whoever entered it can only wait or pull it, and
    // the partner is the only one who can make it real.
    // Either half of the pair can swap the photo any time before voting
    // opens (see replaceContestantPhoto() server-side) - it belongs to the
    // entry, not to whoever happened to upload it first.
    const photoPreview = mine.hasPhoto ? `<img class="entry-photo-preview" src="${photoUrl(mine.id)}" alt="" />` : '';
    const changePhotoControls = `
      <button type="button" class="small ghost" id="change-photo-btn">${esc(t('outfit_change_photo_btn'))}</button>
      <input type="file" accept="image/*" id="change-photo-input" class="file-input-visually-hidden" />`;
    if (!mine.confirmed) {
      const msg = mine.registeredByMe
        ? t('outfit_entry_waiting_partner', { name: esc(mine.name), partner: esc(mine.partnerName || '') })
        : t('outfit_entry_needs_confirm', { name: esc(mine.name), partner: esc(mine.partnerName || '') });
      const confirmBtn = mine.registeredByMe
        ? ''
        : `<button type="button" class="small" id="confirm-entry-btn">${esc(t('outfit_entry_confirm_btn'))}</button>`;
      area.innerHTML = `
        <p class="highlight">${msg}</p>
        ${photoPreview}
        <div class="inline" style="margin-top:10px">
          ${confirmBtn}
          <button type="button" class="small ghost" id="cancel-entry-btn">${esc(t('outfit_entry_cancel_btn'))}</button>
          ${changePhotoControls}
        </div>`;
      $('confirm-entry-btn')?.addEventListener('click', confirmEntry);
      $('cancel-entry-btn').addEventListener('click', cancelEntry);
      wireChangePhotoInput();
      return;
    }
    const msg = mine.partnerName
      ? t('outfit_registered_with', { name: esc(mine.name), partner: esc(mine.partnerName) })
      : t('outfit_registered_as', { name: esc(mine.name) });
    area.innerHTML = `
      <p class="highlight">${msg}</p>
      ${photoPreview}
      <div class="inline" style="margin-top:10px">${changePhotoControls}</div>`;
    wireChangePhotoInput();
    return;
  }

  // Below here only the blank entry form gets built, so this is where the
  // mid-keystroke guard belongs: a poll landing while someone is typing
  // their name would wipe the field. It deliberately does NOT cover the
  // entry above - the submit button lives inside this area, and on any
  // platform that leaves a clicked button focused (Linux/CI WebKit does,
  // macOS does not) guarding the whole function meant a successful
  // registration was stored server-side and never shown: the form just sat
  // there, every 4s poll skipped by the same focus, with no way back short
  // of a reload.
  if (area.contains(document.activeElement)) return;

  // Already showing the blank form and nothing external could have changed
  // about it - skip rebuilding (see registerFormReady above). Without this,
  // a poll landing in the gap after the user returns from the photo picker
  // but before they've refocused a field (photoPickerOpen alone only
  // covers while the picker is actually open) would still wipe the name
  // they'd typed and the photo they just attached.
  if (registerFormReady) return;
  registerFormReady = true;

  registerMode = 'solo';
  registerPartnerId = null;
  registerPhotoDataUrl = null;
  area.innerHTML = `
    <form id="register-form">
      <div class="theme-switch" id="register-mode-switch">
        <button type="button" data-mode="solo" class="active">${t('outfit_register_solo')}</button>
        <button type="button" data-mode="duo">${t('outfit_register_duo')}</button>
      </div>
      <div id="register-partner-wrap" class="hidden" style="margin-top:10px">
        <input id="register-partner-search" type="text" placeholder="${esc(t('outfit_register_partner_ph'))}" autocomplete="off" />
        <div id="register-partner-results" class="partner-results"></div>
      </div>
      <input id="register-name" type="text" maxlength="60" placeholder="${esc(t('outfit_register_ph'))}" style="margin-top:10px" autocomplete="off" />
      <p class="help" style="margin-top:10px">${esc(t('outfit_register_photo_help'))}</p>
      <input type="file" accept="image/*" id="register-photo-input" class="file-input-visually-hidden" />
      <div id="register-photo-preview" class="hidden" style="margin-top:10px">
        <img class="entry-photo-preview" alt="" />
        <span class="photo-attached-label">${esc(t('outfit_photo_attached'))}</span>
      </div>
      <!-- Both on one row at the right edge, like every other card's
           actions. They were stacked and left-aligned, which read as two
           unrelated controls rather than the two halves of finishing an
           entry - the same pairing the admin form already uses. -->
      <div class="actions-right">
        <button type="button" class="small ghost" id="register-photo-btn">${esc(t('outfit_choose_photo_btn'))}</button>
        <button type="submit" class="small">${t('outfit_register_btn')}</button>
      </div>
    </form>`;

  const modeButtons = area.querySelectorAll('#register-mode-switch button');
  modeButtons.forEach((b) => {
    b.addEventListener('click', () => {
      registerMode = b.dataset.mode;
      modeButtons.forEach((x) => x.classList.toggle('active', x === b));
      $('register-partner-wrap').classList.toggle('hidden', registerMode !== 'duo');
      // Duo entries register both people under one name, so the field asks
      // for "your (both's)" name instead of "your" name.
      $('register-name').placeholder = t(registerMode === 'duo' ? 'outfit_register_ph_duo' : 'outfit_register_ph');
      if (registerMode === 'solo') {
        registerPartnerId = null;
        $('register-partner-search').value = '';
        $('register-partner-results').innerHTML = '';
      }
    });
  });

  const searchInput = $('register-partner-search');
  const resultsEl = $('register-partner-results');
  searchInput.addEventListener('input', async () => {
    registerPartnerId = null;
    const term = foldAccents(searchInput.value.trim().toLowerCase());
    if (term.length < 2) { resultsEl.innerHTML = ''; return; }
    const users = await ensureUsersCache();
    const matches = users.filter((u) => foldAccents(u.name.toLowerCase()).includes(term)).slice(0, 6);
    resultsEl.innerHTML = matches.map((u) => `<button type="button" class="small ghost" data-partner-id="${u.id}">${esc(u.name)}</button>`).join('');
    resultsEl.querySelectorAll('[data-partner-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        registerPartnerId = Number(btn.dataset.partnerId);
        searchInput.value = btn.textContent;
        resultsEl.innerHTML = '';
      });
    });
  });

  // A styled button standing in for the raw file input (hidden) - a bare
  // <input type=file> renders as the browser's own unstyled control,
  // clashing with the rest of the app. Deliberately no `capture` attribute:
  // that would skip iOS's native picker sheet (photo library / take photo /
  // browse) and jump straight into the camera, which is less useful here
  // than the choice.
  $('register-photo-btn').addEventListener('click', () => openPhotoPicker($('register-photo-input')));
  $('register-photo-input').addEventListener('change', async () => {
    photoPickerOpen = false;
    const file = $('register-photo-input').files[0];
    const preview = $('register-photo-preview');
    if (!file) {
      registerPhotoDataUrl = null;
      preview.classList.add('hidden');
      return;
    }
    try {
      registerPhotoDataUrl = await resizePhotoToJpeg(file);
      preview.querySelector('img').src = registerPhotoDataUrl;
      preview.classList.remove('hidden');
    } catch (err) {
      registerPhotoDataUrl = null;
      preview.classList.add('hidden');
      await showAlert(err.message);
    }
  });

  $('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('register-name').value.trim();
    // Silent no-ops here read as a dead/disabled button - say what's
    // missing instead, same wording the server itself would use for the
    // same rule (see err_persona_name_required in votes.js).
    if (!name) {
      await showAlert(t('err_persona_name_required'));
      return;
    }
    if (registerMode === 'duo' && !registerPartnerId) {
      await showAlert(t('outfit_register_partner_required'));
      return;
    }
    // A photo is required to complete an entry (see registerContestant()'s
    // requirePhoto server-side) - checked here too so the error shows up
    // right by the field instead of only after a round-trip.
    if (!registerPhotoDataUrl) {
      await showAlert(t('outfit_register_photo_required'));
      return;
    }
    // Entering as a pair puts someone else's name on it, so say plainly
    // that it's on them to agree before it's a real entry.
    if (registerMode === 'duo') {
      const partner = $('register-partner-search').value.trim();
      if (!(await showConfirm(t('outfit_confirm_register_duo', { name, partner })))) return;
    }
    try {
      await api('/outfit/register', {
        method: 'POST',
        body: {
          name,
          night: getNight(),
          partnerUserId: registerMode === 'duo' ? registerPartnerId : null,
          photoBase64: registerPhotoDataUrl,
        },
      });
      loadVotes();
    } catch (err) {
      await showAlert(err.message);
    }
  });
}

// Polled while the tab is open, so the admin opening/closing voting or
// advancing the results reveal shows up without a manual reload. Skips
// clobbering an in-progress registration entry - see the activeElement
// guard in renderRegistration().
let outfitPollTimer = null;

function startOutfitPolling() {
  loadVotes();
  if (outfitPollTimer) return;
  outfitPollTimer = setInterval(loadVotes, 4000);
}

function stopOutfitPolling() {
  if (outfitPollTimer) {
    clearInterval(outfitPollTimer);
    outfitPollTimer = null;
  }
}

// Character names are often improvised at submission time, so pairing the
// real registrant's name alongside it is the only way a voter can actually
// tell who they're voting for. Admin-added contestants have no registrant,
// so they just show the bare character name.
function contestantLabel(c) {
  if (!c.registeredBy) return c.name;
  const who = c.partnerName ? `${c.registeredBy} & ${c.partnerName}` : c.registeredBy;
  return `${c.name} (${who})`;
}

// Podium flourish for the results reveal - requested explicitly, unlike the
// rest of the app which stays emoji-free by default.
const MEDAL_EMOJI = { 1: '🥇', 2: '🥈', 3: '🥉' };

// Last response per night. Switching nights repaints the theme instantly
// and then waits on the network for the cards, so for a beat you saw the
// previous night's content already wearing the new night's colours. With
// the other night's last state kept here, the switch can draw it at once
// and let the fetch correct it a moment later - which is almost always a
// no-op, since nothing about a night changes while you are looking at the
// other one.
const votesByNight = {};

async function loadVotes() {
  const area = $('vote-area');
  const night = getNight();
  try {
    const data = await api(`/votes/status?night=${encodeURIComponent(night)}`);
    votesByNight[night] = data;
    renderVotes(data, night);
  } catch (err) {
    $('voting-status').textContent = err.message;
  }
}

function renderVotes(data, night) {
  const area = $('vote-area');
  {
    void night;
    const results = Array.isArray(data.results) ? data.results : [];

    renderRegistration(data);

    // Status controlled by the admin: registration / open / closed-pending-reveal / closed.
    let statusKey;
    if (data.status === 'registration') statusKey = 'outfit_registration_open';
    else if (data.status === 'open' && data.runoffActive) statusKey = 'outfit_runoff_open';
    else if (data.status === 'open') statusKey = 'outfit_open';
    else if (!data.started) statusKey = 'outfit_wait';
    else if (data.status === 'closed' && data.resultsPhase === 'hidden') statusKey = 'outfit_results_pending';
    else statusKey = 'outfit_closed';
    $('voting-status').textContent = t(statusKey);

    // A duo shares one vote and it takes both of them to spend it, so
    // there's a middle state solo voters never see: proposed by one,
    // waiting on the other (see castVote()/confirmDuoVote() server-side).
    const isDuo = !!data.myContestant?.partnerName;
    const pending = data.myVote && !data.myVote.confirmed;
    const revealing = data.status === 'closed' && data.resultsPhase && data.resultsPhase !== 'hidden';

    if (data.status === 'open' && !data.myVote) {
      // You can't vote for your own entry (see castVote() server-side) -
      // left out of the list entirely rather than shown and then rejected
      // on click, same as you'd never see yourself in a "vote for the best"
      // list elsewhere.
      const votable = data.contestants.filter((c) => c.id !== data.myContestant?.id);
      const help = isDuo ? `<p class="help">${esc(t('outfit_duo_help'))}</p>` : '';
      area.innerHTML = votable.length
        ? help + votable.map((c) => `<button class="vote-option" data-id="${c.id}" data-label="${esc(contestantLabel(c))}">${esc(contestantLabel(c))}</button>`).join('')
        : `<p class="muted">${t('outfit_no_contestants')}</p>`;
      area.querySelectorAll('.vote-option').forEach((b) => {
        b.addEventListener('click', () => vote(Number(b.dataset.id), b.dataset.label, isDuo));
      });
    } else if (pending && data.status === 'open') {
      const chosen = data.contestants.find((c) => c.id === data.myVote.contestant_id);
      const name = chosen ? contestantLabel(chosen) : '';
      const partner = data.myVote.partnerName || '';
      // Whoever proposed it can only wait or take it back; the other one
      // is the only person who can actually make it count.
      const msg = data.myVote.proposedByMe
        ? t('outfit_vote_waiting_partner', { name: esc(name), partner: esc(partner) })
        : t('outfit_vote_needs_confirm', { name: esc(name), partner: esc(partner) });
      const confirmBtn = data.myVote.proposedByMe
        ? ''
        : `<button type="button" class="small" id="confirm-vote-btn">${esc(t('outfit_vote_confirm_btn'))}</button>`;
      area.innerHTML = `
        <p class="highlight">${msg}</p>
        <div class="inline" style="margin-top:10px">
          ${confirmBtn}
          <button type="button" class="small ghost" id="change-vote-btn">${esc(t('outfit_vote_change_btn'))}</button>
        </div>`;
      $('confirm-vote-btn')?.addEventListener('click', confirmVote);
      $('change-vote-btn').addEventListener('click', changeVote);
    } else if (data.myVote && !revealing) {
      // Once confirmed, a vote is final (see castVote() server-side) and
      // this stays the vote area's content through "closed, not revealed
      // yet" - once the results themselves start showing below, repeating
      // "you voted for X" here is just clutter on top of them, so this
      // clears instead (see the results-card block below).
      const chosen = data.contestants.find((c) => c.id === data.myVote.contestant_id);
      const msg = chosen ? t('outfit_voted_name', { name: esc(contestantLabel(chosen)) }) : t('outfit_voted');
      area.innerHTML = `<p class="highlight">${msg}</p>`;
    } else {
      area.innerHTML = '';
    }

    // Best Outfit hides whenever it has nothing of its own to say. The
    // night switch is not in here - it sits above every card, since it
    // governs the tab rather than any one component - so hiding this costs
    // nothing. Three cases: the round
    // never started (no point announcing a vote the organiser has not
    // opened, especially with Miss Congeniality stacked below it); the
    // results are already showing below, which makes the status text and
    // leftover vote area redundant; and during registration, where its only
    // line would be "entries are open, put yours in" directly above the
    // entry card that says exactly that and takes the entry.
    const roundStarted = !!data.started;
    const bestOutfitQuiet = !roundStarted
      || data.status === 'registration'
      || (revealing && results.length > 0);
    $('voting-card').classList.toggle('hidden', bestOutfitQuiet);

    if (revealing && results.length) {
      $('results-card').classList.remove('hidden');
      const list = $('results-list');
      // Before "all", show just what's been revealed so far, labelled by its
      // actual rank (not the tier list's auto-numbering, which would be
      // wrong for a partial set) - e.g. "3rd place" appearing alone first.
      list.classList.toggle('podium-reveal', data.resultsPhase !== 'all');
      // Photos are a reveal-night surprise, not shown during voting - this
      // is the first time they can appear at all (the server only serves
      // a photo once its contestant is actually in this results array, see
      // GET /outfit/contestants/:id/photo).
      list.innerHTML = results.map((r) => {
        const medal = MEDAL_EMOJI[r.rank] ? `${MEDAL_EMOJI[r.rank]} ` : '';
        const name = esc(contestantLabel(r));
        const label = data.resultsPhase === 'all' ? `${medal}${name}` : `${medal}${t(`rank_${r.rank}`)} · ${name}`;
        const photo = r.hasPhoto ? `<img class="entry-photo-preview" src="${photoUrl(r.id)}" alt="" />` : '';
        return `<li>${photo}<span class="name" title="${name}">${label}</span><span class="votes">${r.votes} ${t(r.votes === 1 ? 'vote_one' : 'votes_short')}</span></li>`;
      }).join('');
    } else {
      $('results-card').classList.add('hidden');
    }

    renderCongeniality(data.congeniality);

    // With every component hidden the tab would be a hero line over empty
    // space, which reads as broken rather than "nothing yet" - so the empty
    // state gets a titled card of its own instead.
    const nothingOpen = bestOutfitQuiet
      && $('results-card').classList.contains('hidden')
      && $('congeniality-card').classList.contains('hidden')
      && $('register-card').classList.contains('hidden');
    $('outfit-idle-card').classList.toggle('hidden', !nothingOpen);
  }
}

// Miss Congeniality: a separate, simpler round than the outfit vote above -
// one vote for a person (never a duo entry), and a single winner instead of
// a staged podium. Hidden entirely while the admin hasn't opened it, so it
// doesn't sit there as an empty card all night.
function renderCongeniality(c) {
  const card = $('congeniality-card');
  if (!c || c.status === 'closed') {
    // Still worth showing once it's over, if there's a winner to show.
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const area = $('congeniality-area');

  if (c.status === 'revealed') {
    area.innerHTML = c.winner
      ? `<p class="congeniality-winner">👑 ${esc(c.winner.name)}</p>
         <p class="muted">${c.winner.votes} ${t(c.winner.votes === 1 ? 'vote_one' : 'votes_short')}</p>`
      : `<p class="muted">${t('congeniality_no_winner')}</p>`;
    return;
  }

  // status === 'open'
  if (c.myVote !== null) {
    const voted = c.candidates.find((x) => x.id === c.myVote);
    // Same treatment as Best Outfit's own "you voted for X" right above it
    // (see the vote block earlier in this file) - the two say the same kind
    // of thing about the same night, and one of them was plain grey text.
    area.innerHTML = `<p class="highlight">${t('congeniality_voted', { name: voted ? voted.name : '' })}</p>`;
    return;
  }
  // You don't get to crown yourself (castCongenialityVote() refuses it
  // server-side), so you are left out of the list entirely rather than
  // shown and then rejected on tap - same as the outfit round already does.
  const votable = c.candidates.filter((x) => x.id !== myUserId);
  // Mid-runoff the list is only whoever tied (congenialityCandidates()
  // server-side). Said out loud, like the outfit vote's own runoff line -
  // otherwise the card just comes back with two names on it and no reason.
  const lead = c.runoffActive ? `<p class="highlight">${t('congeniality_runoff_open')}</p>` : '';
  area.innerHTML = votable.length
    ? lead + votable.map((x) => `<button type="button" class="vote-option" data-congeniality-vote="${x.id}">${esc(x.name)}</button>`).join('')
    : `<p class="muted">${t('congeniality_no_candidates')}</p>`;
}

$('congeniality-area').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-congeniality-vote]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await api('/congeniality/vote', {
      method: 'POST',
      body: { night: getNight(), targetUserId: Number(btn.dataset.congenialityVote) },
    });
    loadVotes();
  } catch (err) {
    await showAlert(err.message);
    btn.disabled = false;
  }
});

// The named partner agreeing to a duo entry - the click that puts the
// pair on the voting list. No extra prompt: what they're agreeing to is
// already spelled out on screen.
async function confirmEntry() {
  try {
    await api('/outfit/register/confirm', { method: 'POST', body: { night: getNight() } });
    loadVotes();
  } catch (err) {
    await showAlert(err.message);
  }
}

// Pulls an unconfirmed duo entry, freeing both to enter again - same
// action whether the partner refused or the registrant changed their mind.
async function cancelEntry() {
  if (!(await showConfirm(t('outfit_confirm_cancel_entry')))) return;
  try {
    await api('/outfit/register/pending', { method: 'DELETE', body: { night: getNight() } });
    loadVotes();
  } catch (err) {
    await showAlert(err.message);
  }
}

// Wires the "change photo" button next to an existing entry (pending or
// confirmed) - either half of a duo can use it (see replaceContestantPhoto()
// server-side). Re-rendered every time renderRegistration() redraws the
// card, so this re-wires the fresh elements each call.
function wireChangePhotoInput() {
  const input = $('change-photo-input');
  input.addEventListener('change', async () => {
    photoPickerOpen = false;
    const file = input.files[0];
    if (!file) return;
    try {
      const photoBase64 = await resizePhotoToJpeg(file);
      await api('/outfit/register/photo', { method: 'PUT', body: { night: getNight(), photoBase64 } });
      loadVotes();
    } catch (err) {
      await showAlert(err.message);
    }
  });
  $('change-photo-btn').addEventListener('click', () => openPhotoPicker(input));
}

async function vote(contestantId, name, isDuo) {
  // Solo, a vote is final the moment it's submitted (see castVote()
  // server-side, same rule as Plaza polls) - so confirm first, there's no
  // changing your mind after. In a duo this only proposes it and the
  // partner still has to sign off, so the wording promises less.
  const key = isDuo ? 'outfit_confirm_propose' : 'outfit_confirm_vote';
  if (!(await showConfirm(t(key, { name })))) return;
  try {
    await api('/votes', { method: 'POST', body: { contestantId, night: getNight() } });
    loadVotes();
  } catch (err) {
    await showAlert(err.message);
  }
}

// The partner's half of a duo vote - this is the click that actually makes
// it count, so it's the one that gets no second-guessing prompt (they're
// confirming something already spelled out on screen).
async function confirmVote() {
  try {
    await api('/votes/confirm', { method: 'POST', body: { night: getNight() } });
    loadVotes();
  } catch (err) {
    await showAlert(err.message);
  }
}

// Drops the pair's unconfirmed proposal so they can pick someone else -
// same action whether the proposer changed their mind or the partner
// disagreed, since nothing counted either way.
async function changeVote() {
  if (!(await showConfirm(t('outfit_confirm_change_vote')))) return;
  try {
    await api('/votes/pending', { method: 'DELETE', body: { night: getNight() } });
    loadVotes();
  } catch (err) {
    await showAlert(err.message);
  }
}

boot();

// One subscriber for the whole page - see onConnectionChange() in api.js for
// why the signal is centralised there rather than in each poller.
onConnectionChange((isOffline) => {
  document.getElementById('offline-banner')?.classList.toggle('hidden', !isOffline);
});
