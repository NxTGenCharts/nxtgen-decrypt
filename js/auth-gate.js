/* =============================================================
   auth-gate.js — first line of the dashboard pages' login guard. A classic (non-module) script in <head> so it runs before the
   page paints.

   IMPORTANT — what this is and is not. This site is static files; anyone can fetch the HTML/JS of a page without logging in, so
   this guard cannot be a security boundary. It exists so a signed-out visitor lands on the login page instead of an empty
   dashboard. The REAL protection is on the server: bots, trades, saved exchange keys and (with PROXY_REQUIRES_LOGIN=true) the
   key-bearing proxy routes all refuse a request that has no valid account session (server/auth.js).

   Rule: no stored session -> /login/ (remembering where the visitor was headed). A stored session is trusted for the first
   paint; js/account.js then refreshes it and sends the visitor to /login/ if it turns out to be dead. If accounts are switched
   off on the server, the login page says so and lets the visitor through (the pre-accounts behaviour).
   ============================================================= */
(function(){
  'use strict';
  window.__nxtgenProtected = true;                       // read by js/account.js (expiry redirect + header chip)
  var KEY = 'nxtgen-acct-session';
  function stored(){
    var stores = [function(){ return window.localStorage; }, function(){ return window.sessionStorage; }];
    for(var i = 0; i < stores.length; i++){
      try{
        var s = JSON.parse(stores[i]().getItem(KEY) || 'null');
        if(s && s.access_token && s.refresh_token) return true;
      }catch(e){ /* unreadable: treat as signed out */ }
    }
    return false;
  }
  if(stored()) return;
  // Hide the page while the browser navigates, so there is no flash of dashboard content.
  var st = document.createElement('style'); st.textContent = 'html{visibility:hidden}';
  document.head.appendChild(st);
  var next = location.pathname + location.search + location.hash;
  location.replace('/login/?reason=required&next=' + encodeURIComponent(next));
})();
