/* NxTGen DeCrypt — button icons.
   One small script that gives every action button on the site a matching icon from /assets/icons.svg, chosen from the
   button's label. It runs on every page and keeps watching, so buttons the app builds later (bot cards, modals, status
   lines) get their icon too. Styles: /css/buttons.css.
   - Only real action buttons are touched (.primary / .btn / .primary-link / .ac-btn). Segmented toggles (Live / Demo,
     Manual / Auto, date ranges), icon-only buttons and buttons that already carry an icon are left alone.
   - Opt out for one button with data-no-icon; force an icon with data-icon="name".
   - Adds data-bi="danger" | "go" so the icon and hover glow can be tinted red / green for destructive / start actions. */
(function(){
  'use strict';
  var SPRITE = '/assets/icons.svg';
  var SEL = 'button.primary, a.primary, a.primary-link, a.btn, button.btn, button.ac-btn';
  var SKIP_TEXT = /^(live|demo|manual|auto|custom|today|all time|last \d+ days|long|short|show|hide|yes|no|\d+[a-z]*)$/i;
  var SKIP_CLASS = /\b(live-toggle|ac-iconbtn|m-iconbtn|sbf-icon-btn|tertiary)\b/;

  // [pattern, icon, tone]  — first match wins, so order matters.
  var MAP = [
    [/^(sign out|log out|logout)/,                         'log-out'],
    [/^(sign in|go to sign in|log in|login)/,              'log-in'],
    [/^(create (new )?account|register|sign up)/,          'user-plus'],
    [/^(delete my account)/,                               'user-x',   'danger'],
    [/^(delete|remove)/,                                   'trash',    'danger'],
    [/^(terminate|flatten)/,                               'octagon-x','danger'],
    [/^(stop|disarm)/,                                     'square',   'danger'],
    [/^(close position|close pos)/,                        'octagon-x','danger'],
    [/^(pause)/,                                           'pause'],
    [/^(resume|run backtest|start|launch bot|deploy)/,     'play',     'go'],
    [/^(arm)\b/,                                           'target',   'go'],
    [/^(execute)/,                                         'zap',      'go'],
    [/^(\+ ?)?create (new )?bot/,                          'plus',     'go'],
    [/^(copy)/,                                            'copy'],
    [/^(rename|edit)/,                                     'pencil'],
    [/^(save my keys|move my earlier|move to my account)/, 'cloud-upload'],
    [/^(save)/,                                            'save'],
    [/^(sync)/,                                            'refresh-cw'],
    [/^(refresh|reload|reset session|retry|try again)/,    'refresh-cw'],
    [/^(resend|send again|request a new link|send reset|email me)/, 'mail'],
    [/^(reset my password|change password|update password)/, 'lock'],
    [/^(export pdf)/,                                      'file-text'],
    [/^(export (xls|xlsx|excel|csv))/,                     'table'],
    [/^(export|download)/,                                 'download'],
    [/^(import|upload)/,                                   'upload'],
    [/^(share)/,                                           'share'],
    [/^(\u2190 ?|\u25c0 ?)?(back)/,                        'arrow-left'],
    [/^(launch|open) .*terminal|^(open|launch) terminal/,  'terminal'],
    [/^(explore)/,                                         'compass'],
    [/^(smart fill)/,                                      'sparkles'],
    [/^(test)/,                                            'activity'],
    [/^(connect an exchange|connect\b|new key|save new key)/, 'plug'],
    [/^(use account copy|replace key)/,                    'key'],
    [/^(use this|use\b|apply)/,                            'check'],
    [/^(cancel|dismiss|close)/,                            'x'],
    [/^(select all)/,                                      'list-checks'],
    [/^(select none)/,                                     'ban'],
    [/^(advanced filters)/,                                'filter'],
    [/^(details)/,                                         'eye'],
    [/^(home)$/,                                           'house'],
    [/^(account)$/,                                        'user'],
    [/^(exchanges)$/,                                      'key'],
    [/^(contact)/,                                         'mail'],
    [/^(reload top)/,                                      'refresh-cw']
  ];

  function pick(text){
    var t = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if(!t || t.length > 48 || SKIP_TEXT.test(t)) return null;
    for(var i = 0; i < MAP.length; i++) if(MAP[i][0].test(t)) return MAP[i];
    return null;
  }

  window.__nxBiPick = pick;   // exposed for tests/tests/button-icons.test.mjs
  function svg(name){
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'bi'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    var u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', SPRITE + '#i-' + name);
    s.appendChild(u); return s;
  }

  function decorate(el){
    if(el.hasAttribute('data-no-icon') || SKIP_CLASS.test(el.className || '')) return;
    if(el.closest('.seg, .segmented, [role="tablist"]')) return;
    if(el.querySelector(':scope > .bi, svg, .icon, .arr, .btn-chev, img')) return;
    var forced = el.getAttribute('data-icon');
    var hit = forced ? [null, forced, null] : pick(el.textContent || '');
    if(!hit) return;
    // a leading "+ " / "← " in the label is replaced by the icon rather than shown twice
    var first = el.firstChild;
    if(first && first.nodeType === 3) first.nodeValue = first.nodeValue.replace(/^\s*(\+|\u2190|\u25c0)\s*/, '');
    el.insertBefore(svg(hit[1]), el.firstChild);
    el.classList.add('has-bi');
    if(hit[2]) el.setAttribute('data-bi', hit[2]);
  }

  var queued = false;
  function sweep(root){
    var list = (root || document).querySelectorAll ? (root || document).querySelectorAll(SEL) : [];
    for(var i = 0; i < list.length; i++) decorate(list[i]);
    if(root && root.matches && root.matches(SEL)) decorate(root);
  }
  function schedule(){
    if(queued) return; queued = true;
    (window.requestAnimationFrame || setTimeout)(function(){ queued = false; sweep(document); });
  }

  function start(){
    sweep(document);
    if(!window.MutationObserver) return;
    new MutationObserver(function(muts){
      for(var i = 0; i < muts.length; i++){
        var m = muts[i];
        // ignore our own icon insertions so the observer can never loop
        if(m.type === 'childList' && m.addedNodes.length === 1 && m.addedNodes[0].classList && m.addedNodes[0].classList.contains('bi')) continue;
        schedule(); return;
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
