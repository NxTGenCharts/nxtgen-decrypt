// =============================================================
// nav.js — mobile hamburger menu for .term-nav.
// Imported on every page (same pattern as the other init modules in
// app.js). Desktop keeps the existing horizontal nav untouched — this
// only does anything once the CSS in responsive.css actually shows the
// button, at <=768px — so it's a harmless no-op above that width.
// =============================================================
export function initMobileNav(){
  const toggle = document.getElementById('navToggleBtn');
  const nav = document.getElementById('termNav');
  if(!toggle || !nav) return; // guarded like every other wire-up in app.js — should always both exist, but never assume

  const MOBILE_BREAKPOINT = 768;

  function isOpen(){ return nav.classList.contains('open'); }
  function close(){
    if(!isOpen()) return;
    nav.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }
  function open(){
    nav.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let the immediate document-level "click outside" listener below see this same click and re-close it
    isOpen() ? close() : open();
  });

  // Close the instant a nav link is chosen — the browser is about to
  // navigate to a new page anyway (this is a multi-page site, not an
  // SPA), but closing first avoids a one-frame flash of the panel still
  // open mid-navigation, and matters for the back/forward cache case.
  nav.addEventListener('click', (e) => {
    if(e.target.closest('a')) close();
  });

  // Tap/click anywhere outside the open panel (and outside the toggle
  // itself, already handled above) closes it.
  document.addEventListener('click', (e) => {
    if(!isOpen()) return;
    if(nav.contains(e.target) || toggle.contains(e.target)) return;
    close();
  });

  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape') close();
  });

  // Rotating a phone or resizing past the mobile breakpoint with the
  // panel open would otherwise leave it stuck open (display:none only
  // applies without .open — see responsive.css) underneath the desktop
  // horizontal nav once it reappears.
  window.addEventListener('resize', () => {
    if(window.innerWidth > MOBILE_BREAKPOINT) close();
  });
}
