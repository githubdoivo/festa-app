// Easter egg: triple-click the "lodge" logo (any page) to swap it for
// "lodge de <firstname>", e.g. "lodge de diogo". Click three more
// times to revert. Shared between app.js and settings.js since both have
// their own .brand-name logo.
//
// The swapped state persists across app close/reopen via a per-user database
// boolean (logo_customized), loaded from /me on boot.
let wired = false;

export function wireLogoEasterEgg(name, initialCustomized = false) {
  const firstName = String(name || '').trim().split(/\s+/)[0] || '';
  const slug = firstName
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase().replace(/[^a-z]/g, '');
  if (!slug || wired) return;
  wired = true;

  const logo = document.querySelector('.brand-name');
  if (!logo) return;

  let isCustomized = initialCustomized;
  if (isCustomized) {
    logo.textContent = `lodge de ${slug}`;
  }

  let clicks = 0;
  let timer = null;
  logo.addEventListener('click', async () => {
    clicks++;
    clearTimeout(timer);
    timer = setTimeout(() => { clicks = 0; }, 600);
    if (clicks === 3) {
      clicks = 0;
      isCustomized = !isCustomized;
      logo.textContent = isCustomized ? `lodge de ${slug}` : 'lodge';
      try {
        await fetch('/api/me/logo-customized', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('appivo_token')}` },
          body: JSON.stringify({ customized: isCustomized }),
        });
      } catch (e) {
        console.warn('Failed to save logo customization state:', e.message);
      }
    }
  });
}
