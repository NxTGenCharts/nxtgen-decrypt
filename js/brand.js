/* NxTGen DeCrypt brand mark — scroll behaviour. Styles: /css/brand.css
   - one passive scroll listener, coalesced with requestAnimationFrame
   - writes a single CSS variable (--p, 0..1) on each mark; CSS does the rest
   - no dependencies, no layout reads inside the scroll path */
(function(){
  'use strict';
  var RANGE = 80;       // px of scroll over which the mark goes expanded -> compact
  var DOCK_AT = 140;    // px of scroll before the desktop terminal dock appears
  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches:false };

  function markHTML(extra){
    return '<span class="bm" ' + (extra || '') + '><span class="bm-stage"><span class="bm-glow"></span>' +
      '<span class="bm-p bm-icon"><img src="/assets/brand/icon.png" alt="" width="236" height="225" decoding="async">' +
      '<span class="bm-sheen bm-sheen-teal"></span><span class="bm-sheen bm-sheen-gold"></span></span>' +
      '<span class="bm-p bm-word"><img src="/assets/brand/word.png" alt="" width="671" height="209" decoding="async"></span>' +
      '<span class="bm-p bm-tag"><img src="/assets/brand/tag.png" alt="" width="671" height="20" decoding="async"></span>' +
      '</span></span>';
  }

  // Desktop terminal pages: the big header scrolls away, so a slim dock carries the brand.
  function buildDock(){
    if(!document.querySelector('.term-header')) return null;
    var active = document.querySelector('.navtab.active');
    var el = document.createElement('div');
    el.className = 'brand-dock';
    el.innerHTML = '<div class="brand-dock-in"><a class="brand-dock-link" href="/overview/" aria-label="NxTGen DeCrypt — Crypto Terminal">' +
      markHTML('data-still aria-hidden="true" style="--p:1"') + '</a><span class="brand-dock-page"></span></div>';
    el.querySelector('.brand-dock-page').textContent = active ? active.textContent.replace(/\s+/g, ' ').trim() : '';
    document.body.appendChild(el);
    return { el:el, mark:el.querySelector('.bm') };
  }

  var marks = Array.prototype.slice.call(document.querySelectorAll('.bm[data-bm-scroll]'));
  var dock = buildDock();
  if(!marks.length && !dock) return;

  var ticking = false, lastP = -1, compact = false, dockOn = null, timers = new WeakMap();

  function sheen(el){
    if(mq.matches || !el) return;
    el.classList.remove('sheen');
    void el.offsetWidth;                       // restart the sweep (only on rare events, never per scroll frame)
    el.classList.add('sheen');
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(function(){ el.classList.remove('sheen'); }, 1400));
  }

  function progress(y){
    if(mq.matches) return y > RANGE ? 1 : 0;   // reduced motion: a state switch, not a scrubbed animation
    var p = y / RANGE;
    return p < 0 ? 0 : p > 1 ? 1 : Math.round(p * 50) / 50;
  }

  function update(){
    ticking = false;
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    var p = progress(y), i;
    if(p !== lastP){
      lastP = p;
      for(i = 0; i < marks.length; i++) marks[i].style.setProperty('--p', p);
      var c = compact ? p > 0.4 : p > 0.6;     // hysteresis: no flicker around the threshold
      if(c !== compact){
        compact = c;
        for(i = 0; i < marks.length; i++){ marks[i].classList.toggle('is-compact', c); if(c) sheen(marks[i]); }
      }
    }
    if(dock){
      var on = y > DOCK_AT;
      if(on !== dockOn){ dockOn = on; dock.el.classList.toggle('show', on); if(on) sheen(dock.mark); }
    }
  }

  function onScroll(){ if(!ticking){ ticking = true; window.requestAnimationFrame(update); } }

  window.addEventListener('scroll', onScroll, { passive:true });
  window.addEventListener('resize', onScroll, { passive:true });
  if(mq.addEventListener) mq.addEventListener('change', function(){ lastP = -1; onScroll(); });
  update();                                    // correct state when the page loads already scrolled

  if(!mq.matches) setTimeout(function(){ for(var i = 0; i < marks.length; i++) sheen(marks[i]); }, 950);   // one pass after the reveal
  marks.forEach(function(m){
    var a = m.closest('a');
    if(a) a.addEventListener('pointerenter', function(){ sheen(m); }, { passive:true });
  });
})();
