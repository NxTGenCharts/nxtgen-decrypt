// landing.js — behaviour for the public landing page (index.html).
// Deliberately standalone: no imports from the terminal, no network requests.
// Everything on this page that looks like market data is static demo content.
(function(){
  'use strict';
  var d = document, root = d.documentElement;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.remove('no-js');

  // Sticky nav: frosted once scrolled
  var nav = d.getElementById('nav');
  function onScroll(){ nav.classList.toggle('scrolled', window.scrollY > 8); }
  onScroll(); window.addEventListener('scroll', onScroll, { passive:true });

  // Mobile menu
  var burger = d.getElementById('burger'), links = d.getElementById('navLinks');
  function setMenu(open){ links.classList.toggle('open', open); burger.setAttribute('aria-expanded', String(open)); }
  burger.addEventListener('click', function(e){ e.stopPropagation(); setMenu(!links.classList.contains('open')); });
  links.addEventListener('click', function(e){ if(e.target.closest('a')) setMenu(false); });
  d.addEventListener('click', function(e){ if(!nav.contains(e.target)) setMenu(false); });
  d.addEventListener('keydown', function(e){ if(e.key === 'Escape') setMenu(false); });
  window.addEventListener('resize', function(){ if(window.innerWidth > 820) setMenu(false); });

  // Scroll reveal
  var rev = d.querySelectorAll('.reveal');
  if('IntersectionObserver' in window && !reduce){
    var io = new IntersectionObserver(function(es){
      es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold:.12, rootMargin:'0px 0px -6% 0px' });
    rev.forEach(function(el){ io.observe(el); });
  } else rev.forEach(function(el){ el.classList.add('in'); });

  // Active nav link while scrolling
  var map = {}, secs = [];
  links.querySelectorAll('a[href^="#"]').forEach(function(a){
    var s = d.getElementById(a.getAttribute('href').slice(1)); if(s){ map[s.id] = a; secs.push(s); }
  });
  if('IntersectionObserver' in window){
    var spy = new IntersectionObserver(function(es){
      es.forEach(function(e){
        if(!e.isIntersecting) return;
        Object.keys(map).forEach(function(k){ map[k].classList.toggle('active', k === e.target.id); });
      });
    }, { rootMargin:'-45% 0px -50% 0px' });
    secs.forEach(function(s){ spy.observe(s); });
  }

  // FAQ accordion (one open at a time)
  d.querySelectorAll('.q button').forEach(function(b){
    b.addEventListener('click', function(){
      var open = b.getAttribute('aria-expanded') === 'true';
      d.querySelectorAll('.q button').forEach(function(o){ o.setAttribute('aria-expanded', 'false'); });
      b.setAttribute('aria-expanded', String(!open));
    });
  });

  // Hero terminal: subtle DEMO number movement. Static values, no data source.
  var rows = Array.prototype.slice.call(d.querySelectorAll('[data-demo-row]'));
  var cyc = d.getElementById('demoCycles');
  if(rows.length && !reduce){
    var base = rows.map(function(r){ return parseFloat(r.querySelector('.pct').dataset.v); });
    var cycles = 122, timer = null, visible = true;
    function tick(){
      var i = Math.floor(Math.random() * rows.length), el = rows[i].querySelector('.pct');
      var v = Math.max(.05, base[i] + (Math.random() - .5) * .08);
      el.textContent = '+' + v.toFixed(2) + '%';
      el.classList.add('flash'); setTimeout(function(){ el.classList.remove('flash'); }, 700);
      cycles += 1 + Math.floor(Math.random() * 3);
      if(cyc) cyc.textContent = cycles;
    }
    function start(){ if(!timer && visible && !d.hidden) timer = setInterval(tick, 1800); }
    function stop(){ clearInterval(timer); timer = null; }
    var heroTerm = d.getElementById('heroTerm');
    if('IntersectionObserver' in window && heroTerm){
      new IntersectionObserver(function(es){ visible = es[0].isIntersecting; visible ? start() : stop(); }).observe(heroTerm);
    } else start();
    d.addEventListener('visibilitychange', function(){ d.hidden ? stop() : start(); });
  }
})();
